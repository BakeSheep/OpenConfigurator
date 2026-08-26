import { MAVLINK_COMMANDS } from '../../shared/constants'
import type {
  AutotunePhase,
  AutotuneSnapshot,
  AutotuneVerification,
} from '../../shared/types'

const RESULT_ACCEPTED = 0
const RESULT_IN_PROGRESS = 5
const ARDUCOPTER_AUTOTUNE_MODE = 15

export const AUTOTUNE_POLL_INTERVAL_MS = 1_000
export const PX4_AUTOTUNE_TIMEOUT_MS = 15 * 60_000
export const ARDUPILOT_AUTOTUNE_TIMEOUT_MS = 30 * 60_000
export const ARDUPILOT_SAVE_TIMEOUT_MS = 15_000
/**
 * OCSA-011: ArduPilot abort/test/restore converge through a single
 * fire-and-forget SET_MODE frame. Without a per-action deadline a lost frame
 * used to hold actionPending until the overall timeout, leaving the GCS abort
 * button dead for up to half an hour. Every transmission therefore gets this
 * short per-attempt deadline (deliberately far below the overall timeout) and
 * the frame is resent at most ARDUPILOT_ACTION_MAX_RESENDS times before the
 * action fails with an explicit 'action_timeout'.
 */
export const ARDUPILOT_ACTION_TIMEOUT_MS = 3_000
/** Automatic resends allowed per action before it is failed (OCSA-011). */
export const ARDUPILOT_ACTION_MAX_RESENDS = 2

const TERMINAL_PHASES: ReadonlySet<AutotunePhase> =
  new Set(['saved', 'discarded', 'failed', 'interrupted'])

export type AutotuneAction = 'abort' | 'test_gains' | 'restore_gains'
export type AutotuneActionResult = { ok: true } | { ok: false; code: string }

export interface AutotuneSessionOptions {
  sessionId: string
  requestId: string
  family: 'px4' | 'ardupilot'
  initialModeId: number
  baselineParameters: Record<string, number>
  /** Direct command write. PX4 intentionally re-sends command 212 once a second. */
  sendCommand: (commandId: number, params: number[]) => boolean
  /** Stack-aware SET_MODE write. */
  setMode: (modeId: number) => boolean
  emitSnapshot: (snapshot: AutotuneSnapshot) => void
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

type TimerSlot = 'poll' | 'overall' | 'save' | 'action'

/**
 * Protocol-only in-flight autotune state machine. It never arms, takes off,
 * lands or owns runtime sessions. Browser ownership and controller leases live in
 * AutotuneSessionManager.
 */
export class AutotuneSession {
  readonly sessionId: string
  readonly requestId: string
  readonly family: 'px4' | 'ardupilot'

  private readonly initialModeId: number
  private readonly baselineParameters: Record<string, number>
  private readonly sendCommand: (commandId: number, params: number[]) => boolean
  private readonly setMode: (modeId: number) => boolean
  private readonly emitSnapshot: (snapshot: AutotuneSnapshot) => void
  private readonly now: () => number
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void
  private readonly timers = new Map<TimerSlot, unknown>()

  private started = false
  private seq = 0
  private phase: AutotunePhase = 'starting'
  private verification: AutotuneVerification = 'not_applicable'
  private progress: number | null = null
  private axis: 'roll' | 'pitch' | 'yaw' | null = null
  private updatedAt: number
  private ownerClientId: string | null = null
  private recoverUntil: number | null = null
  private failureCode: string | undefined
  private failureReason: string | undefined
  private actionPending: AutotuneAction | null = null
  private testModeTransition = false
  /**
   * OCSA-011: monotonic tag bumped before every action transmission (first
   * attempt and each resend). Convergence evidence is only ever credited to
   * the pending action, and a finished or failed action retires its slot, so
   * a late mode change or STATUSTEXT answering a retired transmission can
   * never be misattributed as convergence proof of a newer one.
   */
  private actionEpoch = 0
  /** Resends already spent on the pending action. */
  private actionResends = 0

  constructor(options: AutotuneSessionOptions) {
    this.sessionId = options.sessionId
    this.requestId = options.requestId
    this.family = options.family
    this.initialModeId = options.initialModeId
    this.baselineParameters = { ...options.baselineParameters }
    this.sendCommand = options.sendCommand
    this.setMode = options.setMode
    this.emitSnapshot = options.emitSnapshot
    this.now = options.now ?? Date.now
    this.setTimer = options.setTimer ?? ((fn, ms) => {
      const timer = setTimeout(fn, ms)
      timer.unref?.()
      return timer
    })
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout))
    this.updatedAt = this.now()
  }

  get terminal(): boolean {
    return TERMINAL_PHASES.has(this.phase)
      || (this.family === 'px4' && this.phase === 'completed')
  }

  get cancelSupported(): boolean {
    return this.family === 'ardupilot'
  }

  start(): void {
    if (this.started || this.terminal) return
    this.started = true
    this.phase = 'starting'
    this.emit()
    const sent = this.family === 'px4'
      ? this.sendPx4Poll()
      : this.setMode(ARDUCOPTER_AUTOTUNE_MODE)
    if (!sent) {
      this.fail('write_rejected', '连接发送队列拒绝自动调参指令')
      return
    }
    this.arm(
      'overall',
      this.family === 'px4' ? PX4_AUTOTUNE_TIMEOUT_MS : ARDUPILOT_AUTOTUNE_TIMEOUT_MS,
      () => this.fail('overall_timeout', '自动调参超过最长运行时间'),
    )
    if (this.family === 'px4') this.armPx4Poll()
  }

  terminate(code: string, reason: string): void {
    if (this.terminal) return
    this.phase = 'interrupted'
    this.failureCode = code
    this.failureReason = reason
    this.finishTerminal()
  }

  setOwner(ownerClientId: string | null, recoverUntil: number | null): void {
    if (this.ownerClientId === ownerClientId && this.recoverUntil === recoverUntil) return
    this.ownerClientId = ownerClientId
    this.recoverUntil = recoverUntil
    this.emit()
  }

  snapshot(): AutotuneSnapshot {
    return this.build(this.seq)
  }

  handleCommandAck(commandId: number, result: number, ackProgress?: number): void {
    if (this.terminal || this.family !== 'px4'
      || commandId !== MAVLINK_COMMANDS.MAV_CMD_DO_AUTOTUNE_ENABLE) return
    if (result === RESULT_IN_PROGRESS) {
      if (ackProgress !== undefined && ackProgress !== 0xff) this.applyPx4Progress(ackProgress)
      return
    }
    if (result === RESULT_ACCEPTED) {
      this.progress = 100
      this.axis = null
      this.phase = 'completed'
      this.verification = 'firmware_completed'
      this.finishTerminal()
      return
    }
    this.fail(`command_rejected_${result}`, '飞控拒绝或无法继续自动调参')
  }

  handleStatustext(text: string): void {
    if (this.terminal || this.family !== 'ardupilot') return
    const line = text.trim()
    if (!/^autotune:/i.test(line)) return
    if (/\bstarted\b|\bresumed\b/i.test(line)) {
      this.setRunningPhase('tuning')
    } else if (/paused:\s*pilot override active/i.test(line)) {
      this.setRunningPhase('paused')
    } else if (/\bsuccess\b/i.test(line)) {
      this.actionPending = null
      this.clearSlot('action')
      this.phase = 'completed'
      this.verification = 'firmware_completed'
      this.emit()
    } else if (/pilot testing gains/i.test(line)) {
      this.clearActionLocks()
      this.phase = 'testing'
      this.verification = 'firmware_completed'
      this.emit()
    } else if (/original gains restored/i.test(line)) {
      if (this.actionPending === 'abort' || this.actionPending === 'restore_gains') {
        this.phase = 'discarded'
        this.finishTerminal()
      } else {
        this.phase = 'completed'
        this.verification = 'firmware_completed'
        this.emit()
      }
    } else if (/saved gains/i.test(line)) {
      this.phase = 'saved'
      this.verification = 'parameters_saved'
      this.finishTerminal()
    } else if (/\bfailed\b/i.test(line)) {
      this.fail('firmware_failed', line)
    } else if (/\bstopped\b/i.test(line)) {
      if (this.actionPending === 'abort' || this.actionPending === 'restore_gains') {
        this.phase = 'discarded'
        this.finishTerminal()
      } else {
        this.terminate('firmware_stopped', line)
      }
    }
  }

  handleVehicleStatus(status: { armed: boolean; modeId: number }): void {
    if (this.terminal) return
    if (this.family === 'px4') {
      if (!status.armed && (this.progress ?? 0) < 100) {
        this.terminate('vehicle_disarmed', '自动调参完成前飞行器已上锁')
      }
      return
    }

    if (this.testModeTransition && status.modeId === this.initialModeId) {
      this.testModeTransition = false
      if (!this.setMode(ARDUCOPTER_AUTOTUNE_MODE)) {
        this.fail('write_rejected', '连接发送队列拒绝调参结果测试指令')
      }
      return
    }

    if (!status.armed) {
      if ((this.phase === 'completed' || this.phase === 'testing')
        && status.modeId === ARDUCOPTER_AUTOTUNE_MODE) {
        this.phase = 'save_pending'
        this.emit()
        this.arm('save', ARDUPILOT_SAVE_TIMEOUT_MS, () =>
          this.terminate('save_unverified', '飞控未确认自动调参增益已保存'))
      } else {
        this.terminate('vehicle_disarmed', '飞行器上锁时未处于可保存的 AutoTune 状态')
      }
      return
    }

    if (status.modeId === ARDUCOPTER_AUTOTUNE_MODE) {
      if (this.phase === 'starting') this.setRunningPhase('tuning')
      return
    }

    if (this.actionPending === 'abort' || this.actionPending === 'restore_gains') {
      this.phase = 'discarded'
      this.finishTerminal()
      return
    }
    if (this.phase === 'starting' || this.phase === 'tuning' || this.phase === 'paused') {
      this.terminate('mode_changed', '自动调参进行中飞行模式已改变')
    }
  }

  action(action: AutotuneAction): AutotuneActionResult {
    if (this.terminal) return { ok: false, code: 'not_active' }
    if (this.family !== 'ardupilot') return { ok: false, code: 'action_unsupported' }
    if (this.actionPending !== null || this.testModeTransition) {
      return { ok: false, code: 'action_pending' }
    }
    if (action === 'abort') {
      if (this.phase === 'save_pending') return { ok: false, code: 'save_pending' }
    } else if (action === 'test_gains') {
      if (this.phase !== 'completed') return { ok: false, code: 'invalid_phase' }
      // A rejected write below clears this again via clearActionLocks().
      this.testModeTransition = true
    } else if (this.phase !== 'completed' && this.phase !== 'testing') {
      return { ok: false, code: 'invalid_phase' }
    }
    // Every ArduPilot action converges through the same stack-aware
    // SET_MODE(initialModeId) frame; only the expected evidence differs.
    return this.beginAction(action, () => this.setMode(this.initialModeId))
  }

  /**
   * Sends the first attempt of an action and arms its independent deadline
   * (OCSA-011): a lost frame can no longer hold actionPending until the
   * overall timeout because each transmission is judged on its own.
   */
  private beginAction(
    action: AutotuneAction,
    send: () => boolean,
  ): AutotuneActionResult {
    this.actionPending = action
    this.actionResends = 0
    if (!this.transmitAction(send)) {
      this.clearActionLocks()
      return { ok: false, code: 'write_rejected' }
    }
    return { ok: true }
  }

  /** One epoch-tagged transmission plus its bounded convergence window. */
  private transmitAction(send: () => boolean): boolean {
    // Bump before the write so any evidence observed from now on can only be
    // credited to this epoch, never to a retired attempt or finished action.
    const epoch = this.actionEpoch + 1
    this.actionEpoch = epoch
    if (!send()) return false
    this.arm('action', ARDUPILOT_ACTION_TIMEOUT_MS, () => {
      // A timer only judges its own transmission: a newer attempt re-arms the
      // slot, so a stale firing must not spend a resend or fail an action it
      // never sent.
      if (epoch !== this.actionEpoch) return
      this.onActionTimeout(send)
    })
    return true
  }

  private onActionTimeout(send: () => boolean): void {
    if (this.terminal || this.actionPending === null) return
    if (this.actionResends < ARDUPILOT_ACTION_MAX_RESENDS) {
      this.actionResends += 1
      if (this.transmitAction(send)) return
      this.fail('write_rejected', '连接发送队列拒绝自动调参操作重发指令')
      return
    }
    this.fail('action_timeout', '自动调参操作指令多次发送后仍未获得飞控确认')
  }

  /** Releases the action lock without touching the session phase. */
  private clearActionLocks(): void {
    this.actionPending = null
    this.testModeTransition = false
    this.clearSlot('action')
  }

  private sendPx4Poll(): boolean {
    return this.sendCommand(
      MAVLINK_COMMANDS.MAV_CMD_DO_AUTOTUNE_ENABLE,
      [1, 0, 0, 0, 0, 0, 0],
    )
  }

  private armPx4Poll(): void {
    this.arm('poll', AUTOTUNE_POLL_INTERVAL_MS, () => {
      if (this.terminal) return
      if (!this.sendPx4Poll()) {
        this.fail('write_rejected', '连接发送队列拒绝自动调参状态请求')
        return
      }
      this.armPx4Poll()
    })
  }

  private applyPx4Progress(rawProgress: number): void {
    const next = Math.max(0, Math.min(100, Math.round(rawProgress)))
    if (this.progress !== null && this.progress > 0 && next === 0) {
      this.terminate('progress_reset', '飞控自动调参进度已重置')
      return
    }
    this.progress = next
    this.axis = next >= 60 ? 'yaw' : next >= 40 ? 'pitch' : next >= 20 ? 'roll' : null
    if (next >= 100) {
      this.axis = null
      this.phase = 'completed'
      this.verification = 'firmware_completed'
      this.finishTerminal()
    } else if (next >= 95) {
      this.axis = null
      this.phase = 'awaiting_disarm'
      this.emit()
    } else if (next >= 85) {
      this.axis = null
      this.phase = next < 90 ? 'applying' : 'verifying'
      this.emit()
    } else {
      this.phase = next < 20 ? 'starting' : 'tuning'
      this.emit()
    }
  }

  private setRunningPhase(phase: 'tuning' | 'paused'): void {
    this.phase = phase
    this.emit()
  }

  private fail(code: string, reason: string): void {
    if (this.terminal) return
    this.phase = 'failed'
    this.failureCode = code
    this.failureReason = reason
    this.finishTerminal()
  }

  private finishTerminal(): void {
    this.clearAllTimers()
    this.emit()
  }

  private emit(): void {
    this.updatedAt = this.now()
    this.seq += 1
    this.emitSnapshot(this.build(this.seq))
  }

  private build(seq: number): AutotuneSnapshot {
    return {
      sessionId: this.sessionId,
      seq,
      requestId: this.requestId,
      ownerClientId: this.ownerClientId,
      recoverUntil: this.recoverUntil,
      family: this.family,
      phase: this.phase,
      verification: this.verification,
      progress: this.progress,
      axis: this.axis,
      initialModeId: this.initialModeId,
      updatedAt: this.updatedAt,
      cancelSupported: this.cancelSupported,
      baselineParameters: { ...this.baselineParameters },
      ...(this.failureCode ? { failureCode: this.failureCode } : {}),
      ...(this.failureReason ? { failureReason: this.failureReason } : {}),
    }
  }

  private arm(slot: TimerSlot, ms: number, fn: () => void): void {
    this.clearSlot(slot)
    this.timers.set(slot, this.setTimer(() => {
      this.timers.delete(slot)
      fn()
    }, ms))
  }

  private clearSlot(slot: TimerSlot): void {
    const handle = this.timers.get(slot)
    if (handle === undefined) return
    this.clearTimer(handle)
    this.timers.delete(slot)
  }

  private clearAllTimers(): void {
    for (const handle of this.timers.values()) this.clearTimer(handle)
    this.timers.clear()
  }
}
