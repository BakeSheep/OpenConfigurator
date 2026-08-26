import { randomBase64Url, randomUUID, timingSafeEqual } from '../platform/crypto'
import type { AutotuneSnapshot, RuntimeEvent } from '../../shared/types'
import type { AutotuneAction, AutotuneActionResult } from './AutotuneSession'

export const AUTOTUNE_ORPHAN_GRACE_MS = 30_000
export const AUTOTUNE_TERMINAL_RETENTION_MS = 5 * 60_000

export interface AutotuneSessionHandle {
  readonly sessionId: string
  readonly terminal: boolean
  start(): void
  action(action: AutotuneAction): AutotuneActionResult
  terminate(code: string, reason: string): void
  setOwner(ownerClientId: string | null, recoverUntil: number | null): void
  snapshot(): AutotuneSnapshot
}

export interface AutotuneStartRequest {
  sessionId: string
  requestId: string
  ownerClientId: string
  emitSnapshot: (snapshot: AutotuneSnapshot) => void
}

export type AutotuneSessionFactory =
  (request: AutotuneStartRequest) => AutotuneSessionHandle | null

export interface AutotuneSessionManagerOptions {
  createSession: AutotuneSessionFactory
  broadcast: (message: RuntimeEvent) => void
  emitToClient: (clientId: string, message: RuntimeEvent) => void
  pinController: (clientId: string, sessionId: string) => void
  releaseController: (sessionId: string) => void
  onTerminalSuccess?: (sessionId: string, ownerClientId: string | null) => void
  isLinkBusy?: () => string | null
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  randomToken?: () => string
  logger?: Pick<Console, 'log'>
}

type ActiveState = {
  session: AutotuneSessionHandle
  sessionId: string
  requestId: string
  recoveryToken: string
  ownerClientId: string
  orphaned: boolean
  recoverUntil: number | null
  orphanTimer: unknown
}

export class AutotuneSessionManager {
  private readonly options: AutotuneSessionManagerOptions
  private readonly now: () => number
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void
  private active: ActiveState | null = null
  private retained: AutotuneSnapshot | null = null
  private retentionTimer: unknown = null

  constructor(options: AutotuneSessionManagerOptions) {
    this.options = options
    this.now = options.now ?? Date.now
    this.setTimer = options.setTimer ?? ((fn, ms) => {
      const timer = setTimeout(fn, ms)
      timer.unref?.()
      return timer
    })
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout))
  }

  get sessionActive(): boolean {
    return this.active !== null && !this.active.session.terminal
  }

  blocksControllerRelease(): boolean {
    return this.sessionActive
  }

  blocksMavlinkMutations(): boolean {
    return this.sessionActive
  }

  requestStart(clientId: string, message: { requestId: string }): void {
    if (this.sessionActive) {
      this.operationError(clientId, 'autotune_start', 'autotune_busy',
        '已有自动调参会话进行中', message.requestId)
      return
    }
    const busy = this.options.isLinkBusy?.() ?? null
    if (busy) {
      this.operationError(clientId, 'autotune_start', 'link_busy',
        `链路被其他长时操作占用（${busy}）`, message.requestId)
      return
    }
    const sessionId = randomUUID()
    const recoveryToken = this.options.randomToken?.() ?? randomBase64Url(32)
    const session = this.options.createSession({
      sessionId,
      requestId: message.requestId,
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
    session.setOwner(clientId, null)
    this.clearRetained()
    this.options.pinController(clientId, sessionId)
    this.options.emitToClient(clientId, {
      type: 'autotune_session_started',
      data: { sessionId, requestId: message.requestId, recoveryToken },
    })
    this.options.logger?.log?.(`[Autotune] session ${sessionId} started`)
    session.start()
  }

  handleAction(
    clientId: string,
    message: { requestId: string; data: { sessionId: string; action: AutotuneAction } },
  ): void {
    const active = this.active
    if (!active || active.session.terminal) {
      this.operationError(clientId, 'autotune_action', 'no_active_session',
        '当前没有进行中的自动调参会话', message.requestId)
      return
    }
    if (message.data.sessionId !== active.sessionId) {
      this.operationError(clientId, 'autotune_action', 'session_mismatch',
        '自动调参会话标识不匹配', message.requestId)
      return
    }
    if (active.orphaned || active.ownerClientId !== clientId) {
      this.operationError(clientId, 'autotune_action', 'not_session_owner',
        '只有会话所有者可以执行该操作', message.requestId)
      return
    }
    const result = active.session.action(message.data.action)
    if (!result.ok) {
      this.operationError(clientId, 'autotune_action', result.code,
        '当前阶段不接受该操作', message.requestId)
    }
  }

  handleClientDisconnected(clientId: string): void {
    const active = this.active
    if (!active || active.session.terminal || active.ownerClientId !== clientId || active.orphaned) return
    active.orphaned = true
    active.recoverUntil = this.now() + AUTOTUNE_ORPHAN_GRACE_MS
    active.session.setOwner(null, active.recoverUntil)
    active.orphanTimer = this.setTimer(() => this.onOrphanExpired(), AUTOTUNE_ORPHAN_GRACE_MS)
  }

  reclaim(
    clientId: string,
    data: { sessionId: string; recoveryToken: string },
    requestId: string,
  ): void {
    const active = this.active
    const denied = (): void => this.operationError(
      clientId, 'autotune_reclaim', 'reclaim_denied',
      '自动调参会话回收被拒绝', requestId,
    )
    if (!active || active.session.terminal
      || data.sessionId !== active.sessionId
      || !tokenEquals(data.recoveryToken, active.recoveryToken)
      || !active.orphaned || active.recoverUntil === null
      || this.now() > active.recoverUntil) {
      denied()
      return
    }
    if (active.orphanTimer !== null) this.clearTimer(active.orphanTimer)
    active.orphanTimer = null
    active.ownerClientId = clientId
    active.orphaned = false
    active.recoverUntil = null
    this.options.pinController(clientId, active.sessionId)
    active.session.setOwner(clientId, null)
    this.options.emitToClient(clientId, {
      type: 'autotune_session_started',
      data: {
        sessionId: active.sessionId,
        requestId: active.requestId,
        recoveryToken: active.recoveryToken,
      },
    })
  }

  replayTo(send: (message: RuntimeEvent) => void): void {
    if (this.active) {
      send({ type: 'autotune_update', data: this.active.session.snapshot() })
    } else if (this.retained) {
      send({ type: 'autotune_update', data: this.retained })
    }
  }

  handleLinkDown(): void {
    this.active?.session.terminate('link_lost', '飞控链路已断开，自动调参会话终止')
  }

  notifyEmergencyDisarm(): void {
    this.active?.session.terminate('interrupted_by_disarm', '收到紧急上锁指令，自动调参中断')
  }

  destroy(): void {
    this.active?.session.terminate('service_shutdown', '服务正在关闭')
    this.clearRetained()
  }

  private onSnapshot(snapshot: AutotuneSnapshot): void {
    this.options.broadcast({ type: 'autotune_update', data: snapshot })
    const terminal = snapshot.phase === 'saved'
      || snapshot.phase === 'discarded'
      || snapshot.phase === 'failed'
      || snapshot.phase === 'interrupted'
      || (snapshot.family === 'px4' && snapshot.phase === 'completed')
    if (!terminal) return
    const active = this.active
    if (!active || active.sessionId !== snapshot.sessionId) return
    if (active.orphanTimer !== null) this.clearTimer(active.orphanTimer)
    const ownerClientId = active.ownerClientId
    this.active = null
    this.options.releaseController(active.sessionId)
    this.retain(snapshot)
    if (snapshot.phase === 'saved' || snapshot.phase === 'completed') {
      this.options.onTerminalSuccess?.(snapshot.sessionId, ownerClientId)
    }
  }

  private onOrphanExpired(): void {
    const active = this.active
    if (!active || active.session.terminal) return
    active.orphanTimer = null
    active.recoverUntil = null
    // Losing a browser must never change flight mode in the aircraft.
    active.session.terminate('owner_lost', '会话所有者未在宽限期内重连')
  }

  private retain(snapshot: AutotuneSnapshot): void {
    this.clearRetained()
    this.retained = snapshot
    this.retentionTimer = this.setTimer(() => {
      this.retained = null
      this.retentionTimer = null
    }, AUTOTUNE_TERMINAL_RETENTION_MS)
  }

  private clearRetained(): void {
    if (this.retentionTimer !== null) this.clearTimer(this.retentionTimer)
    this.retentionTimer = null
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
  const encoder = new TextEncoder()
  return timingSafeEqual(encoder.encode(candidate), encoder.encode(expected))
}
