// Server-authoritative safety evidence for ESC sessions (OCSA-002). An ESC
// session borrows the vehicle link (ArduPilot passthrough, PX4 SERIAL_CONTROL)
// or a shared UART (direct), so every operation boundary must re-validate a
// freshly pulled snapshot against the state the session was authorized under:
// strict disarmed evidence, an unchanged target-identity generation and an
// unchanged connection epoch.
//
// ArduPilot passthrough pauses MAVLink, so snapshots cannot refresh while a
// session runs. That is why validation always combines the latest snapshot
// with the generation keys bound at start: a snapshot older than
// ESC_SAFETY_SNAPSHOT_MAX_AGE_MS is treated as unknown and refused instead of
// silently extending the pre-pause disarmed evidence.
import { EscError, type EscSessionMode } from '../../shared/esc'

/** Latest server-side vehicle/link evidence, pulled at validation time. */
export interface EscSafetySnapshot {
  /** Selected-target armed flag; null until a heartbeat classifies it. */
  armed: boolean | null
  /** True when the selected target currently has a validated heartbeat. */
  ready: boolean
  /**
   * Target/identity/safety-generation fingerprint. Any change means the
   * selected target, its identity or the link epoch moved under the session.
   */
  fingerprint: string
  /** Epoch ms of the most recent observation backing this snapshot. */
  observedAt: number
  /**
   * True once the current connection has ever shown flight-controller
   * activity (a ready heartbeat or a classified armed flag). A connection
   * with FC history must never be repurposed in place for direct-ESC mode;
   * it requires an explicit reconnect with the direct-ESC preset.
   */
  fcActivityObserved: boolean
  /** Opaque key summarizing the borrowed connection epoch. */
  connectionKey: string
}

/** Pulls the latest snapshot; null means the context is unavailable. */
export type EscSafetySnapshotProvider = () => EscSafetySnapshot | null

/** The evidence a session was authorized under; bound once at start. */
export interface EscSafetyBaseline {
  fingerprint: string
  connectionKey: string
}

/**
 * How long a frozen snapshot stays trustworthy. Passthrough pauses MAVLink,
 * so disarmed evidence cannot refresh mid-session; past this window the next
 * operation boundary refuses and the session must be re-entered so a live
 * heartbeat re-establishes the evidence. Sized above typical read -> edit ->
 * write cycles (idle timeout 60s, orphan grace 120s) but strictly bounded.
 */
export const ESC_SAFETY_SNAPSHOT_MAX_AGE_MS = 120_000

export interface EscSafetyCheckInput {
  snapshot: EscSafetySnapshot | null
  /** Bound authorization state; null while entering a session. */
  baseline: EscSafetyBaseline | null
  mode: EscSessionMode
  now: number
}

/**
 * Return the EscError that forbids the operation, or null when the snapshot
 * satisfies the mode's safety rules. A missing baseline means "entering":
 * the stricter entry gates apply and no generation comparison is possible.
 */
export function escSafetyViolation(input: EscSafetyCheckInput): EscError | null {
  const { snapshot, baseline, mode, now } = input
  const entering = baseline === null
  if (!snapshot) {
    return new EscError(
      'arming_state_unknown',
      entering ? '无法读取连接安全状态，拒绝进入 ESC 直通' : '无法读取连接安全状态，ESC 会话已中止',
    )
  }
  if (mode === 'direct') {
    // A directly attached ESC has no MAVLink side, so there is no arming
    // evidence to refresh. The only rule: a connection that ever showed
    // flight-controller activity may not be silently repurposed.
    if (snapshot.fcActivityObserved || snapshot.armed !== null || snapshot.ready) {
      return new EscError(
        'precondition_failed',
        '当前连接曾观测到飞控活动；请断开后使用 USB 直连（direct-ESC）预设重新连接',
      )
    }
    if (!entering && snapshot.connectionKey !== baseline.connectionKey) {
      return new EscError('link_unavailable', '底层串口连接已变化，ESC 会话已中止')
    }
    return null
  }
  if (now - snapshot.observedAt > ESC_SAFETY_SNAPSHOT_MAX_AGE_MS) {
    return new EscError(
      'arming_state_unknown',
      entering ? '飞控解锁状态快照已过期，拒绝进入 ESC 直通' : '飞控解锁状态快照已过期，ESC 会话已中止',
    )
  }
  if (snapshot.armed === true) {
    return new EscError('armed', entering ? '飞控已解锁，拒绝进入 ESC 直通' : '检测到飞控已解锁，ESC 会话已中止')
  }
  if (snapshot.armed !== false) {
    return new EscError(
      'arming_state_unknown',
      entering ? '飞控解锁状态未知，拒绝进入 ESC 直通' : '飞控解锁状态未知，ESC 会话已中止',
    )
  }
  if (entering) {
    if (!snapshot.ready) {
      return new EscError('precondition_failed', '飞控心跳未就绪，无法进入 ESC 直通')
    }
    return null
  }
  if (!snapshot.ready) {
    return new EscError('link_unavailable', '飞控心跳未就绪，ESC 会话已中止')
  }
  if (snapshot.fingerprint !== baseline.fingerprint) {
    return new EscError('target_mismatch', '飞控目标或身份已变更，ESC 会话已中止')
  }
  if (snapshot.connectionKey !== baseline.connectionKey) {
    return new EscError('link_unavailable', '底层连接已变化，ESC 会话已中止')
  }
  return null
}
