// Deterministic calibration session state machine.
//
// One instance owns exactly one calibration attempt: it encodes the start
// command, consumes structured protocol inputs (parsed [cal] lines, command
// ACKs and - in later flows - ACCELCAL_VEHICLE_POS / MAG_CAL_* messages),
// enforces command-level send discipline (single-send starts, bounded
// follow-ups) and publishes idempotent (sessionId, seq) snapshots. It never
// touches the Worker boundary; ownership and safety policy live in the manager.
//
// COMMAND_ACK alone never yields a verified outcome: terminal phases are
// 'verified' only with independent protocol evidence, otherwise 'ack_only'.
import { MAVLINK_COMMANDS, ACCELCAL_VEHICLE_POS, MAG_CAL_STATUS } from '../../shared/constants'
import type {
  AccelCalibrationPosition,
  CalibrationKind,
  CalibrationMagInstanceState,
  CalibrationPhase,
  CalibrationSide,
  CalibrationSideState,
  CalibrationSnapshot,
  CalibrationVerification,
} from '../../shared/types'
import { parseCalText, PX4_CAL_PROTOCOL_VERSION } from './calProtocol'

const CMD_PREFLIGHT_CALIBRATION = MAVLINK_COMMANDS.MAV_CMD_PREFLIGHT_CALIBRATION
const CMD_DO_START_MAG_CAL = MAVLINK_COMMANDS.MAV_CMD_DO_START_MAG_CAL
const CMD_DO_ACCEPT_MAG_CAL = MAVLINK_COMMANDS.MAV_CMD_DO_ACCEPT_MAG_CAL
const CMD_ACCELCAL_VEHICLE_POS = MAVLINK_COMMANDS.MAV_CMD_ACCELCAL_VEHICLE_POS

// MAG_CAL_STATUS failure reasons surfaced as stable failure codes.
const MAG_FAILURE_REASONS: Record<number, string> = {
  [MAG_CAL_STATUS.FAILED]: '飞控报告罗盘校准失败',
  [MAG_CAL_STATUS.BAD_ORIENTATION]: '罗盘校准失败：安装方向不正确',
  [MAG_CAL_STATUS.BAD_RADIUS]: '罗盘校准失败：磁场半径异常（可能存在强磁干扰）',
}

// ACCELCAL_VEHICLE_POS position value -> the orientation the vehicle must hold.
const POSITION_SIDE: Record<AccelCalibrationPosition, CalibrationSide> = {
  1: 'down', 2: 'left', 3: 'right', 4: 'front', 5: 'back', 6: 'up',
}

// MAV_RESULT values relevant to the session.
const RESULT_ACCEPTED = 0
const RESULT_IN_PROGRESS = 5

// Timeout policy (section 3.3 of the implementation plan). All values are
// session constants so tests can drive them with an injected clock.
export const START_EVIDENCE_TIMEOUT_MS = 15_000
export const PX4_IDLE_TIMEOUT_MS = 120_000
export const PX4_OVERALL_TIMEOUT_MS = 15 * 60_000
export const AP_ACCEL_IDLE_TIMEOUT_MS = 5 * 60_000
export const AP_ACCEL_OVERALL_TIMEOUT_MS = 20 * 60_000
export const AP_ONESHOT_ACK_TIMEOUT_MS = 30_000
export const AP_MAG_IDLE_TIMEOUT_MS = 120_000
export const AP_MAG_OVERALL_TIMEOUT_MS = 20 * 60_000
export const CANCEL_CONFIRM_TIMEOUT_MS = 30_000
export const PROGRESS_COALESCE_MS = 200
// DO_ACCEPT_MAG_CAL uses this timeout first for its ACK, then (after ACCEPTED)
// for a verifying autosaved MAG_CAL_REPORT from older firmware.
export const MAG_ACCEPT_CONFIRM_TIMEOUT_MS = 5_000

// PX4 CAL_MAG_SIDES bit assignment (QGC SensorsComponentController).
const MAG_SIDE_BITS: Record<CalibrationSide, number> = {
  back: 1 << 0,
  front: 1 << 1,
  left: 1 << 2,
  right: 1 << 3,
  up: 1 << 4,
  down: 1 << 5,
}
const ALL_MAG_SIDES = 0b111111
const ALL_SIDES: readonly CalibrationSide[] = ['down', 'up', 'left', 'right', 'front', 'back']

export type CalibrationActionResult =
  | { ok: true }
  | { ok: false; code: string }

export type CalibrationCancelResult =
  | { ok: true }
  | { ok: false; code: 'not_active' | 'cancel_unsupported' | 'cancel_pending' | 'write_rejected' }

export interface CalibrationSessionOptions {
  sessionId: string
  requestId: string
  family: 'px4' | 'ardupilot'
  kind: CalibrationKind
  /** Single frame write; must bypass the shared pendingCommands machinery. */
  sendCommand: (commandId: number, params: number[]) => boolean
  emitSnapshot: (snapshot: CalibrationSnapshot) => void
  /** PX4 CAL_MAG_SIDES bitmask; defaults to all six sides. */
  magSides?: number
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

type TimerSlot = 'start' | 'idle' | 'overall' | 'cancel' | 'flush' | 'accept'

const TERMINAL_PHASES: ReadonlySet<CalibrationPhase> =
  new Set(['accepted', 'done', 'failed', 'cancelled'])

export class CalibrationSession {
  readonly sessionId: string
  readonly requestId: string
  readonly family: 'px4' | 'ardupilot'
  readonly kind: CalibrationKind

  private readonly sendCommand: (commandId: number, params: number[]) => boolean
  private readonly emitSnapshot: (snapshot: CalibrationSnapshot) => void
  private readonly magSides: number
  private readonly now: () => number
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void

  private readonly timers = new Map<TimerSlot, unknown>()
  private startCommandId: number = CMD_PREFLIGHT_CALIBRATION
  private started = false
  private evidenceSeen = false
  private cancelRequested = false
  // ArduPilot interactive accel: the last position the FC asked us to hold.
  private lastRequestedPosition: AccelCalibrationPosition | null = null

  private seq = 0
  private phase: CalibrationPhase = 'starting'
  private verification: CalibrationVerification = 'not_applicable'
  private progress: number | null = null
  private updatedAt = 0
  private protocolDegraded = false
  private sides: Record<CalibrationSide, CalibrationSideState> | undefined
  private requestedPosition: AccelCalibrationPosition | null | undefined
  private expectedMagMask: number | undefined
  // Per-compass calibration state keyed by compass id (ArduPilot mag flow).
  private readonly magState = new Map<number, CalibrationMagInstanceState>()
  private magAcceptPending = false
  private magAcceptAcked = false
  private failureCode: string | undefined
  private failureReason: string | undefined
  private rebootRequired = false
  private ownerClientId: string | null = null
  private recoverUntil: number | null = null

  constructor(options: CalibrationSessionOptions) {
    this.sessionId = options.sessionId
    this.requestId = options.requestId
    this.family = options.family
    this.kind = options.kind
    this.sendCommand = options.sendCommand
    this.emitSnapshot = options.emitSnapshot
    this.magSides = options.magSides ?? ALL_MAG_SIDES
    this.now = options.now ?? Date.now
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
    this.updatedAt = this.now()
  }

  get terminal(): boolean {
    return TERMINAL_PHASES.has(this.phase)
  }

  get cancelSupported(): boolean {
    if (this.family === 'px4') return true
    // ArduPilot: only the onboard mag flow has a real cancel command (42426).
    // The interactive accel flow cannot be cancelled and one-shots finish on
    // their own ACK; the UI must never fake a cancel for those.
    return this.kind === 'mag'
  }

  /** ArduPilot kinds whose only terminal evidence is the final COMMAND_ACK. */
  private get apOneShot(): boolean {
    return this.family === 'ardupilot'
      && (this.kind === 'accel_simple' || this.kind === 'level'
        || this.kind === 'gyro' || this.kind === 'baro')
  }

  /** ArduPilot six-position interactive accel calibration (42429 exchange). */
  private get apInteractiveAccel(): boolean {
    return this.family === 'ardupilot' && this.kind === 'accel'
  }

  // -- lifecycle ---------------------------------------------------------------

  start(): void {
    if (this.started || this.terminal) return
    this.started = true
    const { commandId, params } = this.encodeStart()
    this.startCommandId = commandId
    if (!this.sendCommand(commandId, params)) {
      this.fail('write_rejected', '连接发送队列拒绝校准命令', 'not_applicable')
      return
    }
    this.phase = 'starting'
    this.touch()
    if (this.apInteractiveAccel) {
      // Show all six orientations up front; the FC drives them via 42429.
      this.sides = this.allSidesPending()
    }
    this.emit()
    if (this.apOneShot) {
      this.arm('start', AP_ONESHOT_ACK_TIMEOUT_MS, () =>
        this.fail('ack_timeout', '飞控未在期限内确认校准命令', 'not_applicable'))
    } else {
      this.arm('start', START_EVIDENCE_TIMEOUT_MS, () =>
        this.fail('start_timeout', '飞控未在期限内报告校准启动', 'not_applicable'))
      const overallMs = this.overallTimeoutMs()
      this.arm('overall', overallMs, () =>
        this.fail('overall_timeout', '校准总时长超限，会话已终止', 'not_applicable'))
    }
  }

  /** External termination: link loss, target reset, service shutdown. */
  terminate(code: string, reason: string): void {
    if (this.terminal) return
    this.fail(code, reason, 'not_applicable')
  }

  cancel(): CalibrationCancelResult {
    if (this.terminal) return { ok: false, code: 'not_active' }
    if (!this.cancelSupported) return { ok: false, code: 'cancel_unsupported' }
    if (this.cancelRequested) return { ok: false, code: 'cancel_pending' }
    const cancelFrame = this.family === 'px4'
      ? { commandId: CMD_PREFLIGHT_CALIBRATION, params: [0, 0, 0, 0, 0, 0, 0] }
      : { commandId: MAVLINK_COMMANDS.MAV_CMD_DO_CANCEL_MAG_CAL, params: [0, 0, 0, 0, 0, 0, 0] }
    if (!this.sendCommand(cancelFrame.commandId, cancelFrame.params)) {
      this.fail('write_rejected', '连接发送队列拒绝取消命令', 'not_applicable')
      return { ok: false, code: 'write_rejected' }
    }
    this.cancelRequested = true
    // From here the only interesting evidence is the cancellation itself (or
    // a terminal line); progress watchdogs are replaced by the cancel window.
    this.clearSlot('start')
    this.clearSlot('idle')
    this.clearSlot('overall')
    this.arm('cancel', CANCEL_CONFIRM_TIMEOUT_MS, () => {
      this.phase = 'cancelled'
      this.verification = 'ack_only'
      this.failureCode = 'cancel_unverified'
      this.failureReason = '取消命令已发送，但飞控未确认取消结果'
      this.finishTerminal()
    })
    return { ok: true }
  }

  /** Ownership bookkeeping (manager-driven); re-emits only on change. */
  setOwner(ownerClientId: string | null, recoverUntil: number | null): void {
    if (this.ownerClientId === ownerClientId && this.recoverUntil === recoverUntil) return
    this.ownerClientId = ownerClientId
    this.recoverUntil = recoverUntil
    this.touch()
    this.emit()
  }

  /** Replay snapshot for late joiners; never bumps seq. */
  snapshot(): CalibrationSnapshot {
    return this.build(this.seq)
  }

  // -- protocol inputs -----------------------------------------------------------

  handleCommandAck(commandId: number, result: number): void {
    if (this.terminal) return
    const cancelCommandId = this.family === 'px4'
      ? CMD_PREFLIGHT_CALIBRATION
      : MAVLINK_COMMANDS.MAV_CMD_DO_CANCEL_MAG_CAL
    if (this.cancelRequested && commandId === cancelCommandId) {
      // PX4 uses MAV_CMD_PREFLIGHT_CALIBRATION (241) for both start and
      // cancellation. COMMAND_ACK has no transaction/request discriminator,
      // so an ACCEPTED frame here may be the delayed start ACK. Only the
      // independent [cal] cancellation line (or the explicit unverified
      // timeout) may settle a PX4 cancel request.
      if (this.family === 'px4') return
      if (result === RESULT_IN_PROGRESS) return
      if (result === RESULT_ACCEPTED) {
        this.phase = 'cancelled'
        this.verification = 'ack_only'
        this.finishTerminal()
      } else {
        this.fail('cancel_denied', `飞控拒绝取消校准（result=${result}）`, 'ack_only')
      }
      return
    }
    if (commandId === CMD_DO_ACCEPT_MAG_CAL && this.magAcceptPending) {
      this.handleMagAcceptAck(result)
      return
    }
    if (commandId !== this.startCommandId) return
    if (result === RESULT_ACCEPTED) {
      if (this.apOneShot) {
        // Terminal ACK without independent evidence: accepted, not verified.
        this.phase = 'accepted'
        this.verification = 'ack_only'
        this.finishTerminal()
        return
      }
      this.markEvidence()
      if (this.phase === 'starting') {
        this.phase = 'running'
        this.touch()
        this.emit()
      }
      return
    }
    if (result === RESULT_IN_PROGRESS) {
      if (this.apOneShot) {
        // Long-running one-shot: extend the ACK window once per IN_PROGRESS.
        this.arm('start', AP_ONESHOT_ACK_TIMEOUT_MS, () =>
          this.fail('ack_timeout', '飞控未在期限内确认校准命令', 'not_applicable'))
      } else {
        this.markEvidence()
      }
      if (this.phase === 'starting') {
        this.phase = 'running'
        this.touch()
        this.emit()
      }
      return
    }
    // TEMPORARILY_REJECTED / DENIED / UNSUPPORTED / FAILED all end the attempt.
    this.fail('start_denied', `飞控拒绝校准指令（result=${result}）`, 'not_applicable')
  }

  /** Feed one complete reassembled STATUSTEXT line (PX4 [cal] protocol). */
  handleStatustext(text: string): void {
    if (this.terminal || this.family !== 'px4') return
    const event = parseCalText(text)
    if (!event) return
    this.markEvidence()

    switch (event.kind) {
      case 'started': {
        if (event.version !== PX4_CAL_PROTOCOL_VERSION) {
          // Unknown protocol version: keep progress/terminal handling but
          // disable side semantics instead of failing or hanging the session.
          this.protocolDegraded = true
          this.sides = undefined
        } else {
          this.sides = this.initialSides()
        }
        if (this.phase === 'starting') this.phase = 'running'
        this.touch()
        this.emit()
        return
      }
      case 'orientation_detected':
        this.setSideState(event.side, 'active')
        return
      case 'side_done':
        this.setSideState(event.side, 'done')
        return
      case 'side_already_completed':
        // Pure activity: the idle watchdog was already reset above.
        return
      case 'progress': {
        this.progress = event.pct
        this.touch()
        this.markProgressDirty()
        return
      }
      case 'done': {
        this.phase = 'done'
        this.verification = 'verified'
        this.progress = 100
        if (this.sides) {
          for (const side of ALL_SIDES) {
            if (this.sides[side] !== 'hidden') this.sides[side] = 'done'
          }
        }
        this.finishTerminal()
        return
      }
      case 'failed':
        this.fail('calibration_failed', '飞控报告校准失败', 'verified')
        return
      case 'cancelled': {
        this.phase = 'cancelled'
        this.verification = 'verified'
        this.finishTerminal()
        return
      }
    }
  }

  /**
   * ArduPilot ACCELCAL_VEHICLE_POS (42429) message from the FC. param1 is
   * either a position (1..6) to hold or a terminal sentinel (SUCCESS/FAILED).
   * Only the interactive accel flow reacts; other kinds ignore it.
   */
  handlePositionRequest(rawParam1: number): void {
    if (this.terminal || !this.apInteractiveAccel) return
    const value = Math.round(rawParam1)
    if (value === ACCELCAL_VEHICLE_POS.SUCCESS) {
      this.markEvidence()
      this.phase = 'done'
      this.verification = 'verified'
      this.progress = 100
      if (this.sides) {
        for (const side of ALL_SIDES) this.sides[side] = 'done'
      }
      this.requestedPosition = null
      this.finishTerminal()
      return
    }
    if (value === ACCELCAL_VEHICLE_POS.FAILED) {
      this.fail('calibration_failed', '飞控报告加速度计校准失败', 'verified')
      return
    }
    if (value < 1 || value > 6) return
    const position = value as AccelCalibrationPosition
    this.markEvidence()
    // Advancing to a different position means the previous one was accepted.
    if (this.lastRequestedPosition !== null && this.lastRequestedPosition !== position && this.sides) {
      this.sides[POSITION_SIDE[this.lastRequestedPosition]] = 'done'
    }
    if (this.sides) this.sides[POSITION_SIDE[position]] = 'active'
    this.lastRequestedPosition = position
    this.requestedPosition = position
    this.phase = 'waiting_position'
    this.touch()
    this.emit()
  }

  /**
   * User-confirmed vehicle placement for the current 42429 position request.
   * Echoes the same COMMAND_LONG(42429) back to the FC. Rejects a stale or
   * mismatched position so a late button press cannot advance the wrong side.
   */
  confirmPosition(position: number): CalibrationActionResult {
    if (this.terminal || !this.apInteractiveAccel) {
      return { ok: false, code: 'no_active_position' }
    }
    if (this.phase !== 'waiting_position' || this.requestedPosition !== position) {
      return { ok: false, code: 'stale_position' }
    }
    if (!this.sendCommand(CMD_ACCELCAL_VEHICLE_POS, [position, 0, 0, 0, 0, 0, 0])) {
      this.fail('write_rejected', '连接发送队列拒绝位置确认命令', 'not_applicable')
      return { ok: false, code: 'write_rejected' }
    }
    // The FC now samples this orientation; wait for the next request or the
    // success/failure sentinel. The side stays 'active' until the FC moves on.
    this.requestedPosition = null
    this.phase = 'running'
    this.markEvidence()
    this.touch()
    this.emit()
    return { ok: true }
  }

  /** ArduPilot MAG_CAL_PROGRESS (191): per-compass progress aggregation. */
  handleMagProgress(data: {
    compassId: number
    calMask: number
    calStatus: number
    attempt: number
    completionPct: number
  }): void {
    if (this.terminal || this.family !== 'ardupilot' || this.kind !== 'mag') return
    this.markEvidence()
    this.ensureMagExpectedMask(data.calMask, data.compassId)
    const failed = this.magFailure(data.calStatus)
    const existing = this.magState.get(data.compassId)
    const isNew = existing === undefined
    const statusChanged = existing?.status !== data.calStatus
    this.magState.set(data.compassId, {
      id: data.compassId,
      pct: data.completionPct,
      status: data.calStatus,
      attempt: data.attempt,
      ...(existing?.report ? { report: existing.report } : {}),
    })
    if (failed) {
      this.fail(failed.code, failed.reason, 'verified')
      return
    }
    if (this.phase === 'starting') this.phase = 'running'
    this.updateMagProgress()
    // A new compass or a status change is structural; pure pct updates coalesce.
    if (isNew || statusChanged || this.phase === 'running') this.touch()
    if (isNew || statusChanged) this.emit()
    else this.markProgressDirty()
  }

  /** ArduPilot MAG_CAL_REPORT (192): per-compass result and accept gating. */
  handleMagReport(data: {
    compassId: number
    calMask: number
    calStatus: number
    autosaved: number
    fitness: number
    ofs: [number, number, number]
  }): void {
    if (this.terminal || this.family !== 'ardupilot' || this.kind !== 'mag') return
    this.markEvidence()
    this.ensureMagExpectedMask(data.calMask, data.compassId)
    const failed = this.magFailure(data.calStatus)
    const existing = this.magState.get(data.compassId)
    const autosaved = data.autosaved === 1
    this.magState.set(data.compassId, {
      id: data.compassId,
      pct: existing?.pct ?? 100,
      status: data.calStatus,
      attempt: existing?.attempt ?? 0,
      report: {
        status: data.calStatus,
        fitness: data.fitness,
        ofs: data.ofs,
        autosaved,
      },
    })
    if (failed) {
      this.fail(failed.code, failed.reason, 'verified')
      return
    }
    this.updateMagProgress()
    // Post-accept: complete once every expected compass has an autosaved report.
    if (this.magAcceptPending) {
      if (this.allExpectedMag((instance) => instance.report?.autosaved === true)) {
        this.phase = 'done'
        this.verification = 'verified'
        this.progress = 100
        this.rebootRequired = true
        this.finishTerminal()
        return
      }
      this.touch()
      this.emit()
      return
    }
    // Pre-accept (autosave=0 flow): every expected compass reporting SUCCESS
    // moves to awaiting_accept so the operator can review the quality first.
    if (this.allExpectedMag((instance) => instance.report?.status === MAG_CAL_STATUS.SUCCESS)) {
      this.phase = 'awaiting_accept'
    }
    this.touch()
    this.emit()
  }

  /**
   * Accept a successful compass calibration (autosave=0 flow). Sends
   * DO_ACCEPT_MAG_CAL for the expected mask, requires an ACCEPTED ACK, then
   * waits for autosaved reports. Only an accepted-but-unverified command may
   * settle as accepted/ack_only.
   */
  acceptMag(): CalibrationActionResult {
    if (this.terminal || this.family !== 'ardupilot' || this.kind !== 'mag') {
      return { ok: false, code: 'no_active_session' }
    }
    if (this.phase !== 'awaiting_accept') {
      return { ok: false, code: 'not_awaiting_accept' }
    }
    if (this.magAcceptPending) return { ok: false, code: 'accept_pending' }
    const mask = this.expectedMagMask ?? 0
    if (!this.sendCommand(CMD_DO_ACCEPT_MAG_CAL, [mask, 0, 0, 0, 0, 0, 0])) {
      this.fail('write_rejected', '连接发送队列拒绝罗盘校准接受命令', 'not_applicable')
      return { ok: false, code: 'write_rejected' }
    }
    this.magAcceptPending = true
    this.magAcceptAcked = false
    this.arm('accept', MAG_ACCEPT_CONFIRM_TIMEOUT_MS, () => {
      this.fail('accept_ack_timeout', '飞控未在期限内确认罗盘校准接受命令', 'not_applicable')
    })
    this.touch()
    this.emit()
    return { ok: true }
  }

  // -- ArduPilot mag helpers -----------------------------------------------------

  private handleMagAcceptAck(result: number): void {
    if (result === RESULT_ACCEPTED) {
      if (this.magAcceptAcked) return
      this.magAcceptAcked = true
      // The ACK proves only command acceptance. Give firmware a separate
      // window to publish the autosaved report that verifies persisted state.
      this.arm('accept', MAG_ACCEPT_CONFIRM_TIMEOUT_MS, () => {
        this.phase = 'accepted'
        this.verification = 'ack_only'
        this.rebootRequired = true
        this.finishTerminal()
      })
      return
    }
    if (result === RESULT_IN_PROGRESS) {
      // Still not accepted: extend the ACK deadline without claiming success.
      this.arm('accept', MAG_ACCEPT_CONFIRM_TIMEOUT_MS, () =>
        this.fail('accept_ack_timeout', '飞控未在期限内确认罗盘校准接受命令', 'not_applicable'))
      return
    }
    this.fail('accept_denied', `飞控拒绝罗盘校准接受命令（result=${result}）`, 'not_applicable')
  }

  /** Latch the expected compass mask from the first meaningful frame. */
  private ensureMagExpectedMask(calMask: number, compassId: number): void {
    if (this.expectedMagMask !== undefined) return
    this.expectedMagMask = calMask > 0 ? calMask : (1 << compassId)
  }

  private magFailure(calStatus: number): { code: string; reason: string } | null {
    if (calStatus < MAG_CAL_STATUS.FAILED) return null
    if (calStatus === MAG_CAL_STATUS.SUCCESS) return null
    return {
      code: `mag_failed_${calStatus}`,
      reason: MAG_FAILURE_REASONS[calStatus] ?? '飞控报告罗盘校准失败',
    }
  }

  /** True when every expected compass instance satisfies the predicate. */
  private allExpectedMag(predicate: (instance: CalibrationMagInstanceState) => boolean): boolean {
    const mask = this.expectedMagMask ?? 0
    if (mask === 0) return false
    for (let id = 0; id < 8; id++) {
      if ((mask & (1 << id)) === 0) continue
      const instance = this.magState.get(id)
      if (!instance || !predicate(instance)) return false
    }
    return true
  }

  private updateMagProgress(): void {
    const mask = this.expectedMagMask ?? 0
    const ids: number[] = []
    for (let id = 0; id < 8; id++) if (mask & (1 << id)) ids.push(id)
    if (ids.length === 0) return
    const total = ids.reduce((sum, id) => sum + (this.magState.get(id)?.pct ?? 0), 0)
    this.progress = Math.round(total / ids.length)
  }

  // -- internals -----------------------------------------------------------------

  private encodeStart(): { commandId: number; params: number[] } {
    const params = [0, 0, 0, 0, 0, 0, 0]
    if (this.family === 'ardupilot' && this.kind === 'mag') {
      // MAV_CMD_DO_START_MAG_CAL: mask=0 (all), retry=0, autosave=0 (report
      // first, accept explicitly), delay=0, autoreboot=0.
      return { commandId: CMD_DO_START_MAG_CAL, params }
    }
    // MAV_CMD_PREFLIGHT_CALIBRATION param order:
    // [gyro, mag, groundPressure, radio, accel/level/simple, esc/airspeed, -]
    switch (this.kind) {
      case 'gyro': params[0] = 1; break
      case 'mag': params[1] = 1; break
      case 'baro': params[2] = 1; break
      case 'accel': params[4] = 1; break
      case 'level': params[4] = 2; break
      case 'accel_simple': params[4] = 4; break
    }
    return { commandId: CMD_PREFLIGHT_CALIBRATION, params }
  }

  private overallTimeoutMs(): number {
    if (this.family === 'px4') return PX4_OVERALL_TIMEOUT_MS
    return this.kind === 'mag' ? AP_MAG_OVERALL_TIMEOUT_MS : AP_ACCEL_OVERALL_TIMEOUT_MS
  }

  private idleTimeoutMs(): number {
    if (this.family === 'px4') return PX4_IDLE_TIMEOUT_MS
    return this.kind === 'mag' ? AP_MAG_IDLE_TIMEOUT_MS : AP_ACCEL_IDLE_TIMEOUT_MS
  }

  /** First protocol evidence: stop the start watchdog, run the idle watchdog. */
  private markEvidence(): void {
    if (this.cancelRequested) return
    this.evidenceSeen = true
    this.clearSlot('start')
    this.arm('idle', this.idleTimeoutMs(), () =>
      this.fail('idle_timeout', '校准长时间无进度反馈，会话已终止', 'not_applicable'))
  }

  private initialSides(): Record<CalibrationSide, CalibrationSideState> | undefined {
    if (this.kind === 'accel') {
      return this.allSidesPending()
    }
    if (this.kind === 'mag') {
      const sides = {} as Record<CalibrationSide, CalibrationSideState>
      for (const side of ALL_SIDES) {
        sides[side] = (this.magSides & MAG_SIDE_BITS[side]) !== 0 ? 'pending' : 'hidden'
      }
      return sides
    }
    if (this.kind === 'gyro') {
      return {
        down: 'pending', up: 'hidden', left: 'hidden',
        right: 'hidden', front: 'hidden', back: 'hidden',
      }
    }
    return undefined
  }

  private allSidesPending(): Record<CalibrationSide, CalibrationSideState> {
    return {
      down: 'pending', up: 'pending', left: 'pending',
      right: 'pending', front: 'pending', back: 'pending',
    }
  }

  private setSideState(side: CalibrationSide, state: CalibrationSideState): void {
    if (!this.sides || this.sides[side] === 'hidden' || this.sides[side] === state) return
    this.sides[side] = state
    this.touch()
    this.emit()
  }

  private fail(code: string, reason: string, verification: CalibrationVerification): void {
    if (this.terminal) return
    this.phase = 'failed'
    this.failureCode = code
    this.failureReason = reason
    this.verification = verification
    this.finishTerminal()
  }

  private finishTerminal(): void {
    this.clearAllTimers()
    this.touch()
    this.emit()
  }

  private markProgressDirty(): void {
    if (this.terminal || this.timers.has('flush')) return
    this.arm('flush', PROGRESS_COALESCE_MS, () => this.emit())
  }

  private touch(): void {
    this.updatedAt = this.now()
  }

  private emit(): void {
    this.clearSlot('flush')
    this.seq += 1
    this.emitSnapshot(this.build(this.seq))
  }

  private build(seq: number): CalibrationSnapshot {
    return {
      sessionId: this.sessionId,
      seq,
      ownerClientId: this.ownerClientId,
      recoverUntil: this.recoverUntil,
      requestId: this.requestId,
      family: this.family,
      kind: this.kind,
      phase: this.phase,
      verification: this.verification,
      progress: this.progress,
      updatedAt: this.updatedAt,
      ...(this.protocolDegraded ? { protocolDegraded: true } : {}),
      ...(this.sides ? { sides: { ...this.sides } } : {}),
      ...(this.requestedPosition !== undefined ? { requestedPosition: this.requestedPosition } : {}),
      ...(this.expectedMagMask !== undefined ? { expectedMagMask: this.expectedMagMask } : {}),
      ...(this.magState.size > 0
        ? {
          magInstances: [...this.magState.values()]
            .sort((a, b) => a.id - b.id)
            .map((instance) => structuredClone(instance)),
        }
        : {}),
      ...(this.failureCode !== undefined ? { failureCode: this.failureCode } : {}),
      ...(this.failureReason !== undefined ? { failureReason: this.failureReason } : {}),
      rebootRequired: this.rebootRequired,
      cancelSupported: this.cancelSupported,
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
    this.timers.delete(slot)
    this.clearTimer(handle)
  }

  private clearAllTimers(): void {
    for (const slot of [...this.timers.keys()]) this.clearSlot(slot)
  }
}
