import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type {
  RadioCalibrationChannel,
  RadioCalibrationSnapshot,
  RadioCalibrationStep,
  RcChannelsData,
  ServerMessage,
} from '../../shared/types'

const STEPS: readonly RadioCalibrationStep[] = [
  'center_throttle_low', 'throttle_high', 'throttle_low', 'yaw_right', 'yaw_left',
  'roll_right', 'roll_left', 'pitch_up', 'pitch_down', 'aux_sweep', 'review',
]
const ORPHAN_GRACE_MS = 30_000
const TERMINAL_RETENTION_MS = 5 * 60_000
const ACTION_THRESHOLD = 300
const SETTLE_THRESHOLD = 20
const ENDPOINT_LOW = 1300
const ENDPOINT_HIGH = 1700

type PrimaryFunction = 'roll' | 'pitch' | 'throttle' | 'yaw'

interface ActiveSession {
  sessionId: string
  requestId: string
  recoveryToken: string
  ownerClientId: string
  recoverUntil: number | null
  orphanTimer: ReturnType<typeof setTimeout> | null
  seq: number
  phase: RadioCalibrationSnapshot['phase']
  stepIndex: number
  detectedChannels: number
  center: number[]
  current: number[]
  samples: Array<{ at: number; values: number[] }>
  min: number[]
  max: number[]
  mapped: Partial<Record<PrimaryFunction, number>>
  reversed: Partial<Record<PrimaryFunction, boolean>>
  failureCode?: string
  failureReason?: string
}

export interface RadioCalibrationManagerOptions {
  broadcast: (message: ServerMessage) => void
  emitToClient: (clientId: string, message: ServerMessage) => void
  pinController: (clientId: string, sessionId: string) => void
  releaseController: (sessionId: string) => void
  applyCalibration: (
    requestId: string,
    channels: RadioCalibrationChannel[],
    mapped: Partial<Record<PrimaryFunction, number>>,
    completion: (accepted: boolean, reason?: string, rollbackFailures?: string[]) => void,
  ) => void
  notifyCalibration: (active: boolean) => void
  isLinkBusy?: () => string | null
  now?: () => number
}

export class RadioCalibrationSessionManager {
  private readonly options: RadioCalibrationManagerOptions
  private readonly now: () => number
  private latest: number[] = []
  private active: ActiveSession | null = null
  private retained: RadioCalibrationSnapshot | null = null
  private retentionTimer: ReturnType<typeof setTimeout> | null = null

  constructor(options: RadioCalibrationManagerOptions) {
    this.options = options
    this.now = options.now ?? Date.now
  }

  get sessionActive(): boolean {
    return Boolean(this.active && !['done', 'failed', 'cancelled'].includes(this.active.phase))
  }

  blocksControllerRelease(): boolean { return this.sessionActive }
  blocksMavlinkMutations(): boolean { return this.sessionActive }

  handleRcChannels(data: RcChannelsData): void {
    const values = Array.from({ length: 18 }, (_, index) => {
      const value = data[`ch${index + 1}` as keyof RcChannelsData]
      return typeof value === 'number' && Number.isFinite(value) && value >= 800 && value <= 2200 ? value : 0
    })
    this.latest = values
    const active = this.active
    if (!active || active.phase !== 'sampling') return
    active.current = values
    const at = this.now()
    active.samples.push({ at, values })
    active.samples = active.samples.filter((sample) => at - sample.at <= 500).slice(-20)
    for (let index = 0; index < active.detectedChannels; index += 1) {
      if (!values[index]) continue
      active.min[index] = Math.min(active.min[index], values[index])
      active.max[index] = Math.max(active.max[index], values[index])
    }
    if (STEPS[active.stepIndex] === 'aux_sweep') this.publish(active)
  }

  requestStart(clientId: string, message: { requestId: string; data: { transmitterMode: 1 | 2 | 3 | 4 } }): void {
    if (this.sessionActive) return this.error(clientId, message.requestId, 'radio_calibration_start', 'radio_calibration_busy', '已有遥控器校准会话进行中')
    const busy = this.options.isLinkBusy?.()
    if (busy) return this.error(clientId, message.requestId, 'radio_calibration_start', 'link_busy', `链路正被 ${busy} 占用`)
    const detectedChannels = this.latest.reduce((count, value, index) => value ? index + 1 : count, 0)
    if (this.latest.filter(Boolean).length < 4) {
      return this.error(clientId, message.requestId, 'radio_calibration_start', 'insufficient_rc_channels', '至少需要四个有效遥控器通道')
    }
    const sessionId = randomUUID()
    this.active = {
      sessionId,
      requestId: message.requestId,
      recoveryToken: randomBytes(32).toString('base64url'),
      ownerClientId: clientId,
      recoverUntil: null,
      orphanTimer: null,
      seq: 0,
      phase: 'sampling',
      stepIndex: 0,
      detectedChannels,
      center: this.latest.slice(0, detectedChannels),
      current: this.latest.slice(0, detectedChannels),
      samples: [],
      min: Array.from({ length: detectedChannels }, () => 2000),
      max: Array.from({ length: detectedChannels }, () => 1000),
      mapped: {},
      reversed: {},
    }
    this.clearRetained()
    this.options.pinController(clientId, sessionId)
    this.options.emitToClient(clientId, {
      type: 'radio_calibration_started',
      data: { sessionId, requestId: message.requestId, recoveryToken: this.active.recoveryToken },
    })
    this.options.notifyCalibration(true)
    this.publish(this.active)
  }

  advance(clientId: string, message: { requestId: string; data: { sessionId: string } }): void {
    const active = this.requireOwner(clientId, message.requestId, 'radio_calibration_advance', message.data.sessionId)
    if (!active) return
    if (active.phase === 'review') {
      active.phase = 'writing'
      this.publish(active)
      this.options.notifyCalibration(false)
      this.options.applyCalibration(message.requestId, this.channels(active), active.mapped, (accepted, reason, rollbackFailures) => {
        if (!this.active || this.active.sessionId !== active.sessionId) return
        active.phase = accepted ? 'done' : 'failed'
        active.failureCode = accepted ? undefined : 'write_failed'
        active.failureReason = accepted ? undefined : `${reason ?? '参数写入失败'}${rollbackFailures?.length ? `；回滚失败：${rollbackFailures.join(', ')}` : ''}`
        this.publish(active)
        this.finish(active)
      })
      return
    }
    if (active.phase !== 'sampling') return
    if (!this.isStable(active)) {
      return this.error(clientId, message.requestId, 'radio_calibration_advance', 'rc_not_stable', `请保持摇杆稳定（波动需 ≤ ${SETTLE_THRESHOLD} µs）`)
    }
    const step = STEPS[active.stepIndex]
    const failure = this.captureStep(active, step)
    if (failure) return this.error(clientId, message.requestId, 'radio_calibration_advance', failure.code, failure.message)
    active.stepIndex += 1
    active.samples = []
    if (STEPS[active.stepIndex] === 'review') active.phase = 'review'
    this.publish(active)
  }

  cancel(clientId: string, message: { requestId: string; data: { sessionId: string } }): void {
    const active = this.requireOwner(clientId, message.requestId, 'radio_calibration_cancel', message.data.sessionId)
    if (!active) return
    if (active.phase === 'writing') return this.error(clientId, message.requestId, 'radio_calibration_cancel', 'write_in_progress', '参数写入中不能取消')
    active.phase = 'cancelled'
    this.options.notifyCalibration(false)
    this.publish(active)
    this.finish(active)
  }

  handleClientDisconnected(clientId: string): void {
    const active = this.active
    if (!active || active.ownerClientId !== clientId || !this.sessionActive) return
    active.ownerClientId = ''
    active.recoverUntil = this.now() + ORPHAN_GRACE_MS
    active.orphanTimer = setTimeout(() => {
      if (!this.active || this.active.sessionId !== active.sessionId || active.ownerClientId) return
      active.phase = 'cancelled'
      active.failureCode = 'owner_lost'
      active.failureReason = '会话所有者未在宽限期内重连'
      this.options.notifyCalibration(false)
      this.publish(active)
      this.finish(active)
    }, ORPHAN_GRACE_MS)
    active.orphanTimer.unref?.()
    this.publish(active)
  }

  reclaim(clientId: string, message: { requestId: string; data: { sessionId: string; recoveryToken: string } }): void {
    const active = this.active
    if (!active || active.ownerClientId || active.recoverUntil === null || this.now() > active.recoverUntil
      || active.sessionId !== message.data.sessionId || !tokenEquals(message.data.recoveryToken, active.recoveryToken)) {
      return this.error(clientId, message.requestId, 'radio_calibration_reclaim', 'reclaim_denied', '遥控器校准会话回收被拒绝')
    }
    if (active.orphanTimer) clearTimeout(active.orphanTimer)
    active.orphanTimer = null
    active.ownerClientId = clientId
    active.recoverUntil = null
    this.options.pinController(clientId, active.sessionId)
    this.options.emitToClient(clientId, {
      type: 'radio_calibration_started',
      data: { sessionId: active.sessionId, requestId: active.requestId, recoveryToken: active.recoveryToken },
    })
    this.publish(active)
  }

  replayTo(send: (message: ServerMessage) => void): void {
    const snapshot = this.active ? this.snapshot(this.active) : this.retained
    if (snapshot) send({ type: 'radio_calibration_snapshot', data: snapshot })
  }

  handleLinkDown(): void {
    const active = this.active
    if (!active || !this.sessionActive) return
    active.phase = 'failed'
    active.failureCode = 'link_lost'
    active.failureReason = '飞控链路已断开'
    this.publish(active)
    this.finish(active)
  }

  destroy(): void { this.handleLinkDown(); this.clearRetained() }

  private captureStep(active: ActiveSession, step: RadioCalibrationStep): { code: string; message: string } | null {
    if (step === 'center_throttle_low') {
      active.center = active.current.slice()
      for (let index = 0; index < active.detectedChannels; index += 1) {
        active.min[index] = Math.min(active.min[index], active.current[index] || 1500)
        active.max[index] = Math.max(active.max[index], active.current[index] || 1500)
      }
      return null
    }
    if (step === 'aux_sweep') {
      for (let index = 0; index < active.detectedChannels; index += 1) {
        if (active.min[index] > ENDPOINT_LOW || active.max[index] < ENDPOINT_HIGH) {
          return { code: 'aux_endpoints_incomplete', message: `请将 CH${index + 1} 拨到两个端点` }
        }
      }
      return null
    }
    const functionForStep: Partial<Record<RadioCalibrationStep, PrimaryFunction>> = {
      throttle_high: 'throttle', throttle_low: 'throttle', yaw_right: 'yaw', yaw_left: 'yaw',
      roll_right: 'roll', roll_left: 'roll', pitch_up: 'pitch', pitch_down: 'pitch',
    }
    const fn = functionForStep[step]!
    const firstDirection = /(?:high|right|up)$/.test(step)
    const already = active.mapped[fn]
    const index = already ? already - 1 : this.mostMovedChannel(active, new Set(Object.values(active.mapped).map((channel) => channel! - 1)))
    const throttleReturnedLow = step === 'throttle_low' && index >= 0 && active.current[index] <= ENDPOINT_LOW
    if (index < 0 || (!throttleReturnedLow && Math.abs((active.current[index] || 0) - (active.center[index] || 1500)) < ACTION_THRESHOLD)) {
      return { code: 'rc_movement_insufficient', message: `动作幅度需至少 ${ACTION_THRESHOLD} µs` }
    }
    if (!already) {
      active.mapped[fn] = index + 1
      active.reversed[fn] = firstDirection && active.current[index] < active.center[index]
    }
    active.min[index] = Math.min(active.min[index], active.current[index])
    active.max[index] = Math.max(active.max[index], active.current[index])
    return null
  }

  private mostMovedChannel(active: ActiveSession, excluded: Set<number>): number {
    let selected = -1
    let movement = 0
    for (let index = 0; index < active.detectedChannels; index += 1) {
      if (excluded.has(index) || !active.current[index]) continue
      const delta = Math.abs(active.current[index] - (active.center[index] || 1500))
      if (delta > movement) { movement = delta; selected = index }
    }
    return selected
  }

  private isStable(active: ActiveSession): boolean {
    if (active.samples.length < 3) return false
    for (let index = 0; index < active.detectedChannels; index += 1) {
      const values = active.samples.map((sample) => sample.values[index]).filter(Boolean)
      if (values.length && Math.max(...values) - Math.min(...values) > SETTLE_THRESHOLD) return false
    }
    return true
  }

  private channels(active: ActiveSession): RadioCalibrationChannel[] {
    return Array.from({ length: active.detectedChannels }, (_, index) => {
      const fn = (Object.entries(active.mapped).find(([, channel]) => channel === index + 1)?.[0] as PrimaryFunction | undefined) ?? null
      return {
        channel: index + 1,
        min: Math.min(active.min[index], active.center[index] || 1500),
        max: Math.max(active.max[index], active.center[index] || 1500),
        trim: fn === 'throttle' ? active.min[index] : active.center[index] || 1500,
        reversed: fn ? Boolean(active.reversed[fn]) : false,
        function: fn ?? 'aux',
      }
    })
  }

  private snapshot(active: ActiveSession): RadioCalibrationSnapshot {
    return {
      sessionId: active.sessionId,
      seq: active.seq,
      ownerClientId: active.ownerClientId || null,
      recoverUntil: active.recoverUntil,
      phase: active.phase,
      step: STEPS[Math.min(active.stepIndex, STEPS.length - 1)],
      stepIndex: active.stepIndex,
      stepCount: STEPS.length,
      detectedChannels: active.detectedChannels,
      channels: this.channels(active),
      mapped: { ...active.mapped },
      updatedAt: this.now(),
      failureCode: active.failureCode,
      failureReason: active.failureReason,
    }
  }

  private publish(active: ActiveSession): void {
    active.seq += 1
    this.options.broadcast({ type: 'radio_calibration_snapshot', data: this.snapshot(active) })
  }

  private finish(active: ActiveSession): void {
    if (!this.active || this.active.sessionId !== active.sessionId) return
    if (active.orphanTimer) clearTimeout(active.orphanTimer)
    this.retained = this.snapshot(active)
    this.active = null
    this.options.releaseController(active.sessionId)
    this.clearRetentionTimer()
    this.retentionTimer = setTimeout(() => { this.retained = null; this.retentionTimer = null }, TERMINAL_RETENTION_MS)
    this.retentionTimer.unref?.()
  }

  private requireOwner(clientId: string, requestId: string, operation: string, sessionId: string): ActiveSession | null {
    const active = this.active
    if (!active || active.sessionId !== sessionId) {
      this.error(clientId, requestId, operation, 'session_mismatch', '遥控器校准会话不存在或已替换')
      return null
    }
    if (active.ownerClientId !== clientId) {
      this.error(clientId, requestId, operation, 'not_session_owner', '只有会话所有者可以执行该操作')
      return null
    }
    return active
  }

  private error(clientId: string, requestId: string, operation: string, code: string, message: string): void {
    this.options.emitToClient(clientId, { type: 'operation_error', data: { requestId, operation, code, message, retryable: false } })
  }

  private clearRetentionTimer(): void {
    if (this.retentionTimer) clearTimeout(this.retentionTimer)
    this.retentionTimer = null
  }

  private clearRetained(): void { this.clearRetentionTimer(); this.retained = null }
}

function tokenEquals(candidate: string, expected: string): boolean {
  const candidateBuffer = Buffer.from(candidate)
  const expectedBuffer = Buffer.from(expected)
  return candidateBuffer.length === expectedBuffer.length && timingSafeEqual(candidateBuffer, expectedBuffer)
}
