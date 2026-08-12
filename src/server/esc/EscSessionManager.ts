// Owned ESC session state machine (ADR-004). Exactly one session may exist;
// every command requires the owner client. All exit paths converge on a
// single idempotent finalizeSession() so the transport is closed exactly
// once and MAVLink recovery hooks cannot run twice.
import { EventEmitter } from 'node:events'
import { randomBytes, randomUUID } from 'node:crypto'
import {
  EscError,
  toEscError,
  type EscJobKind,
  type EscSessionSnapshot,
  type EscTransportCapabilities,
} from '../../shared/esc'
import type { EscByteTransport, EscTransportTarget } from './EscByteTransport'

export interface EscSessionManagerOptions {
  /** Factory for the mode-specific transport. May throw EscError. */
  createTransport: (target: EscTransportTarget) => EscByteTransport
  /** Pin the controller lease to the session owner (index.ts hook). */
  pinController?: (ownerClientId: string, sessionId: string) => void
  /** Release the pinned controller lease when the session ends. */
  releaseController?: (sessionId: string) => void
  /** Best-effort protocol-level exit before the physical transport is closed. */
  beforeTransportClose?: (
    transport: EscByteTransport,
    reason: string,
    signal: AbortSignal,
  ) => Promise<void>
  /** Idle watchdog: exit sessions receiving no commands. Suspended by jobs. */
  idleTimeoutMs?: number
  /** How long an orphaned session waits for the owner to reclaim it. */
  orphanGraceMs?: number
  logger?: Pick<Console, 'log' | 'warn' | 'error'>
}

interface ActiveJob {
  jobId: string
  kind: EscJobKind
}

interface InternalSession {
  sessionId: string
  generation: number
  ownerClientId: string
  target: EscTransportTarget
  recoveryToken: string
  /** Bound to the current owner epoch; cleared on disconnect and every terminal path. */
  safetyConfirmed: boolean
  transport: EscByteTransport
  abort: AbortController
  state: 'entering' | 'active' | 'orphaned' | 'exiting'
  activeJob: ActiveJob | null
  recoverUntil: number | null
  /** Set when the orphan grace elapsed while a job was still running. */
  orphanExpired: boolean
  offAborted: () => void
  idleTimer: ReturnType<typeof setTimeout> | null
  orphanTimer: ReturnType<typeof setTimeout> | null
  finalizePromise: Promise<void> | null
}

const DEFAULT_IDLE_TIMEOUT_MS = 60_000
const DEFAULT_ORPHAN_GRACE_MS = 120_000

export class EscSessionManager extends EventEmitter {
  private readonly options: Required<
    Pick<EscSessionManagerOptions, 'idleTimeoutMs' | 'orphanGraceMs'>
  > & EscSessionManagerOptions
  private session: InternalSession | null = null
  private generationCounter = 0
  private destroyed = false

  constructor(options: EscSessionManagerOptions) {
    super()
    this.options = {
      ...options,
      idleTimeoutMs: options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
      orphanGraceMs: options.orphanGraceMs ?? DEFAULT_ORPHAN_GRACE_MS,
    }
  }

  private get logger(): Pick<Console, 'log' | 'warn' | 'error'> {
    return this.options.logger ?? console
  }

  // -- Snapshots ------------------------------------------------------------

  snapshot(): EscSessionSnapshot {
    const session = this.session
    if (!session) {
      return {
        state: 'idle',
        sessionId: null,
        mode: null,
        ownerClientId: null,
        safetyConfirmed: false,
        escCount: 0,
        activeJobId: null,
        recoverUntil: null,
        reason: this.lastReason,
        capabilities: null,
      }
    }
    return {
      state: session.state,
      sessionId: session.sessionId,
      mode: session.target.mode,
      ownerClientId: session.ownerClientId,
      safetyConfirmed: session.safetyConfirmed,
      escCount: 0,
      activeJobId: session.activeJob?.jobId ?? null,
      recoverUntil: session.recoverUntil,
      reason: null,
      capabilities: this.effectiveCapabilities(session.transport.capabilities),
    }
  }

  private lastReason: string | null = null

  private emitSnapshot(reason: string | null = null): void {
    if (reason !== null) this.lastReason = reason
    const snapshot = this.snapshot()
    if (reason !== null && snapshot.state === 'idle') snapshot.reason = reason
    this.emit('session', snapshot)
  }

  /**
   * Transport-level capabilities exposed to clients. Per-device signature
   * and layout checks still gate every parameter write in EscService.
   */
  private effectiveCapabilities(base: EscTransportCapabilities): EscTransportCapabilities {
    return { read: base.read, write: base.write }
  }

  // -- Guards ---------------------------------------------------------------

  get hasSession(): boolean {
    return this.session !== null
  }

  /** True while a session exists: release_control must be rejected. */
  blocksControllerRelease(): boolean {
    return this.session !== null
  }

  /** True while a session exists: MAVLink mutations must be rejected. */
  blocksMavlinkMutations(): boolean {
    return this.session !== null
  }

  /**
   * Validate that `clientId` owns the session identified by `sessionId`.
   * Throws EscError('session_not_found' | 'not_owner').
   */
  assertOwner(clientId: string, sessionId: string): InternalSessionView {
    const session = this.session
    if (!session || session.sessionId !== sessionId) {
      throw new EscError('session_not_found', '没有匹配的 ESC 会话')
    }
    if (session.ownerClientId !== clientId) {
      throw new EscError('not_owner', '当前客户端不是 ESC 会话所有者')
    }
    return { sessionId: session.sessionId, mode: session.target.mode }
  }

  /** Settings writes additionally require the session's physical-safety acknowledgement. */
  assertSettingsWriteAllowed(clientId: string, sessionId: string): InternalSessionView {
    const view = this.assertOwner(clientId, sessionId)
    const session = this.session
    if (!session?.safetyConfirmed) {
      throw new EscError(
        'precondition_failed',
        'ESC 安全确认已失效；请退出会话并重新确认已拆桨且供电稳定',
      )
    }
    return view
  }

  /** Owner commands call this to reset the idle watchdog. */
  noteActivity(clientId: string): void {
    const session = this.session
    if (!session || session.ownerClientId !== clientId) return
    this.armIdleTimer(session)
  }

  // -- Lifecycle ------------------------------------------------------------

  async start(
    ownerClientId: string,
    target: EscTransportTarget,
    safetyConfirmed: boolean,
  ): Promise<{ sessionId: string; recoveryToken: string }> {
    if (this.destroyed) throw new EscError('invalid_state', 'ESC 服务已关闭')
    if (this.session) throw new EscError('session_exists', '已存在活动的 ESC 会话')

    const sessionId = randomUUID()
    const generation = ++this.generationCounter
    const transport = this.options.createTransport(target)
    const abort = new AbortController()
    const session: InternalSession = {
      sessionId,
      generation,
      ownerClientId,
      target,
      recoveryToken: randomBytes(24).toString('base64url'),
      safetyConfirmed,
      transport,
      abort,
      state: 'entering',
      activeJob: null,
      recoverUntil: null,
      orphanExpired: false,
      offAborted: () => {},
      idleTimer: null,
      orphanTimer: null,
      finalizePromise: null,
    }
    session.offAborted = transport.onAborted((error) => {
      // Stale callbacks from an old generation must not touch a new session.
      if (this.session?.generation !== generation) return
      this.logger.warn(`[ESC] transport aborted: ${error.message}`)
      void this.finalizeSession(session, error.code === 'link_lost' ? 'link_lost' : error.code)
    })
    this.session = session
    this.lastReason = null
    this.emitSnapshot()

    try {
      this.options.pinController?.(ownerClientId, sessionId)
      await transport.open(target, abort.signal)
      if (this.session?.generation !== generation || session.state !== 'entering') {
        // Finalized while opening (disconnect/destroy). finalize already ran.
        throw new EscError('cancelled', 'ESC 会话在建立期间被终止')
      }
      session.state = 'active'
      this.armIdleTimer(session)
      this.emitSnapshot()
      return { sessionId, recoveryToken: session.recoveryToken }
    } catch (error) {
      const escError = toEscError(error, 'link_unavailable')
      await this.finalizeSession(session, escError.code)
      throw escError
    }
  }

  async exit(clientId: string, sessionId: string): Promise<void> {
    this.assertOwner(clientId, sessionId)
    const session = this.session
    if (!session) throw new EscError('session_not_found', '没有匹配的 ESC 会话')
    if (session.activeJob) throw new EscError('busy', 'ESC 任务执行期间不能退出会话')
    await this.finalizeSession(session, 'owner_exit')
  }

  async reclaim(clientId: string, sessionId: string, recoveryToken: string): Promise<void> {
    const session = this.session
    if (!session || session.sessionId !== sessionId) {
      throw new EscError('session_not_found', '没有匹配的 ESC 会话')
    }
    if (session.state !== 'orphaned') {
      throw new EscError('invalid_state', 'ESC 会话当前不可恢复')
    }
    if (!timingSafeStringEqual(session.recoveryToken, recoveryToken)) {
      throw new EscError('invalid_recovery_token', '恢复令牌无效')
    }
    session.ownerClientId = clientId
    session.state = 'active'
    session.recoverUntil = null
    session.orphanExpired = false
    if (session.orphanTimer) {
      clearTimeout(session.orphanTimer)
      session.orphanTimer = null
    }
    this.options.pinController?.(clientId, sessionId)
    if (!session.activeJob) this.armIdleTimer(session)
    this.emitSnapshot()
  }

  /** WS close hook: owner loss decides between exit and orphaned wait. */
  handleClientDisconnected(clientId: string): void {
    const session = this.session
    if (!session || session.ownerClientId !== clientId) return
    if (session.state === 'exiting') return
    if (!session.activeJob) {
      void this.finalizeSession(session, 'owner_disconnected')
      return
    }
    // A job is running: never interrupt the current safe atomic unit. Wait
    // for reclaim within the grace window; the job continues meanwhile.
    // The physical acknowledgement belongs to the owner/control epoch. The
    // in-flight atomic unit may finish, but a reclaimed session cannot start
    // another settings write until the operator exits and confirms again.
    session.safetyConfirmed = false
    session.state = 'orphaned'
    session.recoverUntil = Date.now() + this.options.orphanGraceMs
    this.clearIdleTimer(session)
    if (session.orphanTimer) clearTimeout(session.orphanTimer)
    session.orphanTimer = setTimeout(() => {
      session.orphanTimer = null
      if (this.session?.generation !== session.generation) return
      if (session.state !== 'orphaned') return
      session.orphanExpired = true
      // Only tear down between jobs; runExclusiveJob checks this flag when
      // the in-flight job finishes.
      if (!session.activeJob) void this.finalizeSession(session, 'orphan_timeout')
    }, this.options.orphanGraceMs)
    this.emitSnapshot()
  }

  // -- Jobs -----------------------------------------------------------------

  /**
   * Run a single exclusive job. Rejects when another job is in flight or the
   * caller does not own the session. The idle watchdog is suspended for the
   * duration (ADR-004).
   */
  async runExclusiveJob<T>(
    clientId: string,
    kind: EscJobKind,
    fn: (context: { jobId: string; signal: AbortSignal }) => Promise<T>,
  ): Promise<T> {
    const session = this.session
    if (!session) throw new EscError('session_not_found', '没有匹配的 ESC 会话')
    if (session.ownerClientId !== clientId) {
      throw new EscError('not_owner', '当前客户端不是 ESC 会话所有者')
    }
    if (session.state !== 'active') {
      throw new EscError('invalid_state', `ESC 会话状态 ${session.state} 不接受任务`)
    }
    if (session.activeJob) throw new EscError('busy', '已有 ESC 任务正在执行')

    const job: ActiveJob = { jobId: randomUUID(), kind }
    session.activeJob = job
    this.clearIdleTimer(session)
    this.emitSnapshot()
    try {
      return await fn({ jobId: job.jobId, signal: session.abort.signal })
    } finally {
      if (session.activeJob?.jobId === job.jobId) session.activeJob = null
      if (this.session?.generation === session.generation) {
        // The state may have changed across the await (disconnect/orphan);
        // read through a cast because control-flow analysis cannot see the
        // cross-method mutations that happen while awaiting.
        const stateNow = session.state as InternalSession['state']
        if (stateNow === 'orphaned' && session.orphanExpired) {
          void this.finalizeSession(session, 'orphan_timeout')
        } else if (stateNow === 'active') {
          this.armIdleTimer(session)
          this.emitSnapshot()
        } else {
          this.emitSnapshot()
        }
      }
    }
  }

  // -- Teardown -------------------------------------------------------------

  /**
   * Idempotent, exactly-once teardown. Every exit path (owner exit, owner
   * disconnect, orphan timeout, idle timeout, transport abort, failed open,
   * destroy) converges here.
   */
  private finalizeSession(session: InternalSession, reason: string): Promise<void> {
    if (session.finalizePromise) return session.finalizePromise
    session.finalizePromise = (async () => {
      session.state = 'exiting'
      session.safetyConfirmed = false
      this.clearIdleTimer(session)
      if (session.orphanTimer) {
        clearTimeout(session.orphanTimer)
        session.orphanTimer = null
      }
      this.emitSnapshot()
      session.offAborted()
      try {
        await this.options.beforeTransportClose?.(
          session.transport,
          reason,
          session.abort.signal,
        )
      } catch (error) {
        this.logger.warn('[ESC] protocol exit failed:', error)
      }
      session.abort.abort()
      try {
        await session.transport.close(reason)
      } catch (error) {
        this.logger.warn('[ESC] transport close failed:', error)
      }
      try {
        this.options.releaseController?.(session.sessionId)
      } catch (error) {
        this.logger.warn('[ESC] controller release hook failed:', error)
      }
      if (this.session?.generation === session.generation) this.session = null
      this.emitSnapshot(reason)
    })()
    return session.finalizePromise
  }

  /** End a MAVLink-backed session when its underlying vehicle link disappears. */
  handleExternalLinkLost(): void {
    const session = this.session
    if (session) void this.finalizeSession(session, 'link_lost')
  }

  async destroy(): Promise<void> {
    this.destroyed = true
    const session = this.session
    if (session) await this.finalizeSession(session, 'shutdown')
  }

  // -- Timers ---------------------------------------------------------------

  private armIdleTimer(session: InternalSession): void {
    this.clearIdleTimer(session)
    session.idleTimer = setTimeout(() => {
      session.idleTimer = null
      if (this.session?.generation !== session.generation) return
      if (session.state !== 'active' || session.activeJob) return
      void this.finalizeSession(session, 'idle_timeout')
    }, this.options.idleTimeoutMs)
  }

  private clearIdleTimer(session: InternalSession): void {
    if (session.idleTimer) {
      clearTimeout(session.idleTimer)
      session.idleTimer = null
    }
  }
}

export interface InternalSessionView {
  sessionId: string
  mode: EscTransportTarget['mode']
}

/** Constant-time comparison to keep recovery tokens non-guessable. */
function timingSafeStringEqual(expected: string, candidate: string): boolean {
  if (expected.length !== candidate.length) return false
  let diff = 0
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ candidate.charCodeAt(i)
  }
  return diff === 0
}
