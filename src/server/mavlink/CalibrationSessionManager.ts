// Calibration session ownership manager.
//
// Exactly one calibration session may exist at a time. This manager owns the
// WebSocket-facing policy around a CalibrationSession: owner identity, the
// owner-only recovery token, the 30s orphan grace after an owner disconnect,
// snapshot replay for late joiners, terminal snapshot retention and the
// controller-lease pin callbacks into src/server/index.ts. It never parses
// MAVLink and never touches sockets directly.
//
// The recovery token is a secret: it is sent only via emitToClient inside
// calibration_session_started and must never be broadcast or logged.
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type {
  CalibrationKind,
  CalibrationSnapshot,
  ServerMessage,
} from '../../shared/types'

export const CALIBRATION_ORPHAN_GRACE_MS = 30_000
export const CALIBRATION_TERMINAL_RETENTION_MS = 5 * 60_000

const TERMINAL_PHASES = new Set(['accepted', 'done', 'failed', 'cancelled'])

/** The slice of CalibrationSession the manager needs (test seam). */
export interface CalibrationSessionHandle {
  readonly sessionId: string
  readonly terminal: boolean
  readonly cancelSupported: boolean
  start(): void
  cancel(): { ok: true } | { ok: false; code: string }
  terminate(code: string, reason: string): void
  setOwner(ownerClientId: string | null, recoverUntil: number | null): void
  snapshot(): CalibrationSnapshot
  /** ArduPilot interactive accel position confirmation (wired in Task 9). */
  confirmPosition?(position: number): { ok: true } | { ok: false; code: string }
  /** ArduPilot compass report acceptance (wired in Task 10). */
  acceptMag?(): { ok: true } | { ok: false; code: string }
}

export interface CalibrationStartRequest {
  sessionId: string
  requestId: string
  kind: CalibrationKind
  ownerClientId: string
  emitSnapshot: (snapshot: CalibrationSnapshot) => void
}

/**
 * Bridge-provided factory. Returns null when the request was rejected before
 * a session could exist (capability/armed/identity gates); in that case the
 * factory itself is responsible for emitting the operation_error.
 */
export type CalibrationSessionFactory =
  (request: CalibrationStartRequest) => CalibrationSessionHandle | null

export interface CalibrationSessionManagerOptions {
  createSession: CalibrationSessionFactory
  broadcast: (message: ServerMessage) => void
  emitToClient: (clientId: string, message: ServerMessage) => void
  /** Pin the controller lease to the session owner (never expires while set). */
  pinController: (clientId: string, sessionId: string) => void
  releaseController: (sessionId: string) => void
  /**
   * Called exactly once when a session reaches a successful terminal phase
   * (done or accepted). Used to trigger the one-shot post-calibration
   * parameter refresh; failed/cancelled never call it.
   */
  onTerminalSuccess?: (sessionId: string, ownerClientId: string | null) => void
  /** Conflicting long-running link operation (e.g. 'parameter_sync'). */
  isLinkBusy?: () => string | null
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  randomToken?: () => string
  logger?: Pick<Console, 'log' | 'warn'>
}

type ActiveState = {
  session: CalibrationSessionHandle
  sessionId: string
  requestId: string
  recoveryToken: string
  ownerClientId: string
  orphaned: boolean
  recoverUntil: number | null
  orphanTimer: unknown
}

export class CalibrationSessionManager {
  private readonly options: CalibrationSessionManagerOptions
  private readonly now: () => number
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void
  private active: ActiveState | null = null
  private retained: CalibrationSnapshot | null = null
  private retentionTimer: unknown = null

  constructor(options: CalibrationSessionManagerOptions) {
    this.options = options
    this.now = options.now ?? Date.now
    this.setTimer = options.setTimer ?? ((fn, ms) => {
      const timer = setTimeout(fn, ms)
      timer.unref?.()
      return timer
    })
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout))
  }

  /** True while a non-terminal session exists. */
  get sessionActive(): boolean {
    return this.active !== null && !this.active.session.terminal
  }

  blocksControllerRelease(): boolean {
    return this.sessionActive
  }

  blocksMavlinkMutations(): boolean {
    return this.sessionActive
  }

  // -- start ---------------------------------------------------------------------

  requestStart(
    clientId: string,
    message: { requestId: string; data: { kind: CalibrationKind } },
  ): void {
    if (this.sessionActive) {
      this.operationError(clientId, 'start_calibration', 'calibration_busy',
        '已有校准会话进行中，同一时间只允许一个校准', message.requestId)
      return
    }
    const busy = this.options.isLinkBusy?.() ?? null
    if (busy) {
      this.operationError(clientId, 'start_calibration', 'link_busy',
        `链路被其他长时操作占用（${busy}），暂不能开始校准`, message.requestId)
      return
    }
    const sessionId = randomUUID()
    const recoveryToken = this.options.randomToken?.() ?? randomBytes(32).toString('base64url')
    const session = this.options.createSession({
      sessionId,
      requestId: message.requestId,
      kind: message.data.kind,
      ownerClientId: clientId,
      emitSnapshot: (snapshot) => this.onSnapshot(snapshot),
    })
    if (!session) return
    this.active = {
      session,
      sessionId,
      requestId: message.requestId,
      recoveryToken,
      ownerClientId: clientId,
      orphaned: false,
      recoverUntil: null,
      orphanTimer: null,
    }
    // CalibrationSession owns the snapshot fields. Initialize its owner before
    // start() can publish the first protocol snapshot; manager-only metadata is
    // not visible to clients and would make the initiator appear as an observer.
    session.setOwner(clientId, null)
    this.clearRetained()
    this.options.pinController(clientId, sessionId)
    // Owner-only secret: never broadcast, never log.
    this.options.emitToClient(clientId, {
      type: 'calibration_session_started',
      data: { sessionId, requestId: message.requestId, recoveryToken },
    })
    this.options.logger?.log?.(`[Calibration] session ${sessionId} started (${message.data.kind})`)
    session.start()
  }

  // -- owner actions ---------------------------------------------------------------

  handleAction(
    clientId: string,
    message: {
      requestId: string
      data:
        | { sessionId: string; action: 'cancel' }
        | { sessionId: string; action: 'confirm_position'; position: number }
        | { sessionId: string; action: 'accept_mag' }
    },
  ): void {
    const active = this.active
    if (!active || active.session.terminal) {
      this.operationError(clientId, 'calibration_action', 'no_active_session',
        '当前没有进行中的校准会话', message.requestId)
      return
    }
    if (message.data.sessionId !== active.sessionId) {
      this.operationError(clientId, 'calibration_action', 'session_mismatch',
        '校准会话标识不匹配（会话可能已被替换）', message.requestId)
      return
    }
    if (active.orphaned || active.ownerClientId !== clientId) {
      this.operationError(clientId, 'calibration_action', 'not_session_owner',
        '只有校准会话所有者可以执行该操作', message.requestId)
      return
    }
    if (message.data.action === 'cancel') {
      const result = active.session.cancel()
      if (!result.ok) {
        this.operationError(clientId, 'calibration_action', result.code,
          '校准会话无法取消', message.requestId)
      }
      return
    }
    if (message.data.action === 'confirm_position') {
      const confirm = active.session.confirmPosition?.(message.data.position)
        ?? { ok: false as const, code: 'unsupported_action' }
      if (!confirm.ok) {
        this.operationError(clientId, 'calibration_action', confirm.code,
          '当前会话不接受该位置确认', message.requestId)
      }
      return
    }
    const accept = active.session.acceptMag?.()
      ?? { ok: false as const, code: 'unsupported_action' }
    if (!accept.ok) {
      this.operationError(clientId, 'calibration_action', accept.code,
        '当前会话不接受罗盘校准结果确认', message.requestId)
    }
  }

  // -- reconnect / reclaim ------------------------------------------------------------

  handleClientDisconnected(clientId: string): void {
    const active = this.active
    if (!active || active.session.terminal || active.ownerClientId !== clientId) return
    if (active.orphaned) return
    active.orphaned = true
    active.recoverUntil = this.now() + CALIBRATION_ORPHAN_GRACE_MS
    active.session.setOwner(null, active.recoverUntil)
    active.orphanTimer = this.setTimer(() => this.onOrphanExpired(), CALIBRATION_ORPHAN_GRACE_MS)
    this.options.logger?.log?.(
      `[Calibration] owner disconnected; session ${active.sessionId} recoverable for ${CALIBRATION_ORPHAN_GRACE_MS}ms`,
    )
  }

  reclaim(
    clientId: string,
    data: { sessionId: string; recoveryToken: string },
    requestId: string,
  ): void {
    const active = this.active
    const denied = (): void => this.operationError(
      clientId,
      'calibration_reclaim',
      'reclaim_denied',
      '校准会话回收被拒绝（会话、令牌或时限无效）',
      requestId,
    )
    if (!active || active.session.terminal) {
      denied()
      return
    }
    if (data.sessionId !== active.sessionId || !tokenEquals(data.recoveryToken, active.recoveryToken)) {
      denied()
      return
    }
    if (!active.orphaned || active.recoverUntil === null || this.now() > active.recoverUntil) {
      denied()
      return
    }
    if (active.orphanTimer !== null) {
      this.clearTimer(active.orphanTimer)
      active.orphanTimer = null
    }
    active.ownerClientId = clientId
    active.orphaned = false
    active.recoverUntil = null
    this.options.pinController(clientId, active.sessionId)
    active.session.setOwner(clientId, null)
    this.options.emitToClient(clientId, {
      type: 'calibration_session_started',
      data: {
        sessionId: active.sessionId,
        requestId: active.requestId,
        recoveryToken: active.recoveryToken,
      },
    })
    this.options.logger?.log?.(`[Calibration] session ${active.sessionId} reclaimed`)
  }

  // -- external lifecycle -----------------------------------------------------------

  /** Replay the active (or retained terminal) snapshot to one client. */
  replayTo(send: (message: ServerMessage) => void): void {
    if (this.active) {
      send({ type: 'calibration_update', data: this.active.session.snapshot() })
      return
    }
    if (this.retained) {
      send({ type: 'calibration_update', data: this.retained })
    }
  }

  /** MAVLink link left the connected state: the session cannot continue. */
  handleLinkDown(): void {
    this.active?.session.terminate('link_lost', '飞控链路已断开，校准会话终止')
  }

  /** Emergency disarm passed through the boundary: mark the run interrupted. */
  notifyEmergencyDisarm(): void {
    this.active?.session.terminate('interrupted_by_disarm', '收到紧急上锁命令，校准会话中断')
  }

  /** Vehicle reboot passed through the boundary: it is also a real calibration exit. */
  notifyVehicleReboot(): void {
    this.active?.session.terminate('interrupted_by_reboot', '飞控重启命令已发送，校准会话中断')
  }

  destroy(): void {
    this.active?.session.terminate('service_shutdown', '服务正在关闭')
    this.clearRetained()
  }

  // -- internals ---------------------------------------------------------------------

  private onSnapshot(snapshot: CalibrationSnapshot): void {
    this.options.broadcast({ type: 'calibration_update', data: snapshot })
    if (!TERMINAL_PHASES.has(snapshot.phase)) return
    const active = this.active
    if (!active || active.sessionId !== snapshot.sessionId) return
    if (active.orphanTimer !== null) {
      this.clearTimer(active.orphanTimer)
      active.orphanTimer = null
    }
    const ownerClientId = active.ownerClientId
    this.active = null
    this.options.releaseController(active.sessionId)
    this.retain(snapshot)
    this.options.logger?.log?.(
      `[Calibration] session ${active.sessionId} terminal (${snapshot.phase})`,
    )
    // Fire the one-shot post-calibration parameter refresh only on success;
    // failed/cancelled must not re-read parameters.
    if (snapshot.phase === 'done' || snapshot.phase === 'accepted') {
      this.options.onTerminalSuccess?.(active.sessionId, ownerClientId)
    }
  }

  private onOrphanExpired(): void {
    const active = this.active
    if (!active || active.session.terminal) return
    active.orphanTimer = null
    // The recovery window is closed for good; late reclaims must be denied
    // even while a cancel is still settling.
    active.recoverUntil = null
    // Safety exit without an owner: prefer a real FC-side cancel; sessions
    // that cannot cancel are marked lost so the UI never pretends otherwise.
    if (active.session.cancelSupported) {
      const result = active.session.cancel()
      if (result.ok) return
    }
    active.session.terminate('owner_lost', '会话所有者未在宽限期内重连，校准已终止')
  }

  private retain(snapshot: CalibrationSnapshot): void {
    this.clearRetained()
    this.retained = snapshot
    this.retentionTimer = this.setTimer(() => {
      this.retained = null
      this.retentionTimer = null
    }, CALIBRATION_TERMINAL_RETENTION_MS)
  }

  private clearRetained(): void {
    if (this.retentionTimer !== null) {
      this.clearTimer(this.retentionTimer)
      this.retentionTimer = null
    }
    this.retained = null
  }

  private operationError(
    clientId: string,
    operation: string,
    code: string,
    message: string,
    requestId: string,
  ): void {
    this.options.emitToClient(clientId, {
      type: 'operation_error',
      data: { requestId, operation, code, message, retryable: false },
    })
  }
}

function tokenEquals(candidate: string, expected: string): boolean {
  const candidateBuffer = Buffer.from(candidate)
  const expectedBuffer = Buffer.from(expected)
  return candidateBuffer.length === expectedBuffer.length
    && timingSafeEqual(candidateBuffer, expectedBuffer)
}
