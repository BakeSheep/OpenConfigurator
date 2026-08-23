import { EventEmitter } from 'events'
import {
  SerialConnection,
  type SerialWritePriority,
  type SerialWriteQueueTag,
} from './SerialConnection'
import { ConnectionResolutionError } from './ConnectionDiscoveryService'
import type { ReconnectProgress, ReconnectTerminalReason } from './workerLifecycle'
import type { ConnectionConfig, PortInfo } from '../../shared/types'

export type { ReconnectProgress, ReconnectTerminalReason } from './workerLifecycle'

/**
 * Self-recovering serial link (connection compatibility plan §Phase 4).
 *
 * Mirrors BluetoothWorker's event protocol so ConnectionManager can treat both
 * as one "managed, self-recovering link" family:
 *
 * - ordinary USB drop → bounded retries (default 5: 1s/2s/3s/5s/5s) with the
 *   target re-resolved from its stable identity before every attempt, so a
 *   path change (ttyACM0 → ttyACM1, COM7 → COM9) is followed safely;
 * - confirmed flight-controller reboot → retries throughout the longer
 *   ~45s grace window (with a minimum attempt budget), sharing this single
 *   state machine with ordinary drops so the two never race;
 * - explicit disconnect, identity ambiguity and permission-class errors end
 *   recovery immediately (fail closed, never guess between twin devices).
 */

const DEFAULT_MAX_RECONNECT_ATTEMPTS = 5
const DEFAULT_RECONNECT_BACKOFF_SCHEDULE_MS = [1000, 2000, 3000, 5000, 5000]
const DEFAULT_REBOOT_MAX_ATTEMPTS = 12
const DEFAULT_REBOOT_DELAY_MS = 1000
const DEFAULT_REBOOT_GRACE_MS = 45_000
const DEFAULT_OPEN_TIMEOUT_MS = 5000
const DEFAULT_DISCONNECT_TIMEOUT_MS = 15_000

export interface SerialWorkerLink extends EventEmitter {
  readonly connected: boolean
  connect(path: string, baudRate: number, timeoutMs?: number): Promise<void>
  disconnect(timeoutMs?: number): Promise<void>
  write(
    data: Buffer,
    priority?: SerialWritePriority,
    queueTag?: SerialWriteQueueTag,
  ): boolean | void
  cancelQueuedWrites?(queueTag: SerialWriteQueueTag): number
}

export interface SerialTargetResolution {
  path: string
  identity: PortInfo | null
}

export interface SerialWorkerOptions {
  serialFactory?: () => SerialWorkerLink
  resolveTarget?: (config: ConnectionConfig) => Promise<SerialTargetResolution>
  maxReconnectAttempts?: number
  reconnectBackoffScheduleMs?: readonly number[]
  rebootMaxAttempts?: number
  rebootDelayMs?: number
  rebootGraceMs?: number
  openTimeoutMs?: number
  disconnectTimeoutMs?: number
  monotonicNow?: () => number
  wallClock?: () => number
}

interface LinkHandlers {
  conn: SerialWorkerLink
  generation: number
  onData: (data: Buffer) => void
  onDataSent: (count: number) => void
  onOverflow: (details: unknown) => void
  onDisconnected: () => void
  onError: (error: Error) => void
  onDiagnostic: (details: unknown) => void
}

class OperationCancelledError extends Error {
  constructor() {
    super('串口连接操作已取消。')
    this.name = 'OperationCancelledError'
  }
}

export class SerialWorker extends EventEmitter {
  private readonly config: ConnectionConfig
  private currentPort: string
  private conn: SerialWorkerLink | null = null
  private handlers: LinkHandlers | null = null
  private _transportOpen = false
  private _vehicleReady = false
  private intentionalDisconnect = true
  private lifecycleGeneration = 0
  private reconnectAttempts = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private cancelActiveResolution: (() => void) | null = null
  private activeAttempt: Promise<void> | null = null
  private teardownPromise: Promise<void> | null = null
  private dropPromise: Promise<void> | null = null
  private disconnectPromise: Promise<void> | null = null
  private _lastReconnectError: Error | null = null
  private _terminalReason: ReconnectTerminalReason | null = null
  private expectedRebootUntil = 0
  private expectedRebootInterruption = false
  // True once a reboot window was armed in this lifecycle. If the window
  // expires without recovery, terminate with REBOOT_WINDOW_EXPIRED instead of
  // silently extending into the ordinary retry budget.
  private rebootAwaited = false
  private rebootAttemptLimit = 0

  private readonly serialFactory: NonNullable<SerialWorkerOptions['serialFactory']>
  private readonly resolveTarget: NonNullable<SerialWorkerOptions['resolveTarget']>
  private readonly maxReconnectAttempts: number
  private readonly reconnectBackoffScheduleMs: readonly number[]
  private readonly rebootMaxAttempts: number
  private readonly rebootDelayMs: number
  private readonly rebootGraceMs: number
  private readonly openTimeoutMs: number
  private readonly disconnectTimeoutMs: number
  private readonly monotonicNow: () => number
  private readonly wallClock: () => number

  constructor(config: ConnectionConfig, options: SerialWorkerOptions = {}) {
    super()
    this.config = { ...config }
    this.currentPort = config.port
    this.serialFactory = options.serialFactory ?? (() => new SerialConnection())
    this.resolveTarget = options.resolveTarget
      ?? (async (request) => ({ path: request.port, identity: null }))
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS
    this.reconnectBackoffScheduleMs = options.reconnectBackoffScheduleMs
      ?? DEFAULT_RECONNECT_BACKOFF_SCHEDULE_MS
    this.rebootMaxAttempts = options.rebootMaxAttempts ?? DEFAULT_REBOOT_MAX_ATTEMPTS
    this.rebootDelayMs = options.rebootDelayMs ?? DEFAULT_REBOOT_DELAY_MS
    this.rebootGraceMs = options.rebootGraceMs ?? DEFAULT_REBOOT_GRACE_MS
    this.openTimeoutMs = options.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS
    this.disconnectTimeoutMs = options.disconnectTimeoutMs ?? DEFAULT_DISCONNECT_TIMEOUT_MS
    this.monotonicNow = options.monotonicNow ?? (() => performance.now())
    this.wallClock = options.wallClock ?? Date.now
  }

  get connected(): boolean {
    return this._transportOpen
  }

  get transportOpen(): boolean {
    return this._transportOpen
  }

  get vehicleReady(): boolean {
    return this._vehicleReady
  }

  get resolvedPort(): string {
    return this.currentPort
  }

  get terminalReason(): ReconnectTerminalReason | null {
    return this._terminalReason
  }

  get lastReconnectError(): Error | null {
    return this._lastReconnectError
  }

  /** True while the recovery schedule follows the FC-reboot grace window. */
  get expectedRebootActive(): boolean {
    return this.expectedRebootUntil > this.monotonicNow()
  }

  async connect(): Promise<void> {
    if (this.activeAttempt || this.conn || this._transportOpen) {
      throw new Error('串口连接已在进行或已打开。')
    }
    this.intentionalDisconnect = false
    this._terminalReason = null
    this._lastReconnectError = null
    this.reconnectAttempts = 0
    const generation = ++this.lifecycleGeneration
    await this.runOpenAttempt(generation, false)
  }

  write(
    data: Buffer,
    priority: SerialWritePriority = 'normal',
    queueTag?: SerialWriteQueueTag,
  ): boolean {
    if (!this._transportOpen || !this.conn) return false
    return this.conn.write(data, priority, queueTag) !== false
  }

  cancelQueuedWrites(queueTag: SerialWriteQueueTag): number {
    if (!this._transportOpen || !this.conn) return 0
    return this.conn.cancelQueuedWrites?.(queueTag) ?? 0
  }

  /**
   * Called only after MavlinkBridge validates an autopilot HEARTBEAT for the
   * selected vehicle; resets the bounded recovery budget.
   */
  confirmVehicleHeartbeat(): void {
    if (this.intentionalDisconnect || !this.conn || !this._transportOpen) return
    const generation = this.lifecycleGeneration
    const changed = !this._vehicleReady
    this.setVehicleReady(true)
    this.reconnectAttempts = 0
    this._lastReconnectError = null
    this._terminalReason = null
    if (changed) this.emit('vehicleReady', { port: this.currentPort, generation })
  }

  /**
   * Mark a deliberate FC reboot: the recovery schedule switches to the longer
   * grace window shared with ordinary drops (one state machine, no racing).
   */
  expectVehicleReboot(graceMs = this.rebootGraceMs): boolean {
    if (!this.conn || !this._transportOpen) return false
    const effectiveGraceMs = Math.max(1, graceMs)
    this.expectedRebootUntil = this.monotonicNow() + effectiveGraceMs
    this.expectedRebootInterruption = false
    this.rebootAwaited = true
    this.rebootAttemptLimit = Math.max(
      this.rebootMaxAttempts,
      Math.ceil(effectiveGraceMs / Math.max(1, this.rebootDelayMs)),
    )
    this.reconnectAttempts = 0
    this.setVehicleReady(false)
    return true
  }

  cancelExpectedVehicleReboot(): void {
    this.expectedRebootUntil = 0
    this.expectedRebootInterruption = false
    // A validated vehicle ended the reboot story; later drops are ordinary.
    this.rebootAwaited = false
    this.rebootAttemptLimit = 0
  }

  /** Drop the current transport and enter recovery (heartbeat loss, FC reboot). */
  forceReconnect(reason = '链路需要重建'): void {
    if (this.intentionalDisconnect) return
    this._lastReconnectError = new Error(reason)
    void this.handleDrop(this.lifecycleGeneration)
  }

  async disconnect(): Promise<void> {
    if (this.disconnectPromise) {
      return this.withTimeout(
        this.disconnectPromise,
        this.disconnectTimeoutMs,
        `等待串口连接任务停止超时（${Math.round(this.disconnectTimeoutMs / 1000)}s）。`,
      )
    }
    const hadLifecycle = !!this.conn
      || !!this.activeAttempt
      || !!this.reconnectTimer
      || this._transportOpen
    this.intentionalDisconnect = true
    ++this.lifecycleGeneration
    this.cancelActiveResolution?.()
    this.clearReconnectTimer()
    this.setVehicleReady(false)
    this.setTransportOpen(false)

    const work = (async () => {
      let teardownError: Error | null = null
      try {
        await this.teardownConnection()
      } catch (error) {
        teardownError = this.toError(error)
      }
      const attempt = this.activeAttempt
      if (attempt) await attempt.catch(() => undefined)
      try {
        await this.teardownConnection()
      } catch (error) {
        teardownError ??= this.toError(error)
      }
      this.reconnectAttempts = 0
      this.dropPromise = null
      if (teardownError) throw teardownError
      if (hadLifecycle) this.emit('disconnected')
    })()

    this.disconnectPromise = work
    void work.finally(() => {
      if (this.disconnectPromise === work) this.disconnectPromise = null
    }).catch(() => undefined)
    return this.withTimeout(
      work,
      this.disconnectTimeoutMs,
      `等待串口连接任务停止超时（${Math.round(this.disconnectTimeoutMs / 1000)}s）。`,
    )
  }

  // -- internals -----------------------------------------------------------

  private runOpenAttempt(generation: number, reconnecting: boolean): Promise<void> {
    if (this.activeAttempt) return this.activeAttempt
    const attempt = this.openOnce(generation, reconnecting)
    this.activeAttempt = attempt
    void attempt.finally(() => {
      if (this.activeAttempt === attempt) this.activeAttempt = null
    }).catch(() => undefined)
    return attempt
  }

  private async openOnce(generation: number, reconnecting: boolean): Promise<void> {
    // Re-resolve the target from its stable identity before every attempt so
    // a re-enumerated device is followed to its new path, never guessed.
    const resolution = await this.resolveTargetCancellable(generation)
    this.assertCurrent(generation)
    this.currentPort = resolution.path

    const conn = this.serialFactory()
    this.conn = conn
    this.attachLink(conn, generation)
    try {
      await conn.connect(resolution.path, this.config.baudRate, this.openTimeoutMs)
      this.assertCurrent(generation, conn)
      this.setTransportOpen(true)
      this.setVehicleReady(false)
      this.emit('transportConnected', {
        port: resolution.path,
        generation,
        reconnecting,
        identity: resolution.identity ?? undefined,
      })
      this.emit('connected', { port: resolution.path, generation, reconnecting })
    } catch (error) {
      const failure = this.toError(error)
      if (!(error instanceof OperationCancelledError)) this._lastReconnectError = failure
      try {
        await this.teardownConnection(conn)
      } catch (closeError) {
        const closeFailure = this.toError(closeError)
        this._lastReconnectError = closeFailure
        if (!this.intentionalDisconnect && generation === this.lifecycleGeneration) {
          this.finishTerminal('CLOSE_FAILED', closeFailure)
        }
        throw closeFailure
      }
      throw failure
    }
  }

  private async resolveTargetCancellable(
    generation: number,
  ): Promise<SerialTargetResolution> {
    const work = this.resolveTarget(this.config)
    const timeoutMs = this.openTimeoutMs
    return new Promise<SerialTargetResolution>((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        finish(() => reject(new Error(
          `解析串口设备 ${this.config.port} 超时（${Math.round(timeoutMs / 1000)}s）。`,
        )))
      }, timeoutMs)
      const finish = (callback: () => void) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (this.cancelActiveResolution === cancel) this.cancelActiveResolution = null
        callback()
      }
      const cancel = () => finish(() => reject(new OperationCancelledError()))
      this.cancelActiveResolution = cancel
      work.then(
        (resolution) => finish(() => resolve(resolution)),
        (error) => finish(() => reject(this.toError(error))),
      )
      if (generation !== this.lifecycleGeneration || this.intentionalDisconnect) {
        cancel()
      }
    })
  }

  private attachLink(conn: SerialWorkerLink, generation: number): void {
    const handlers: LinkHandlers = {
      conn,
      generation,
      onData: (data: Buffer) => {
        if (!this.isCurrent(generation, conn)) return
        this.emit('data', data)
      },
      onDataSent: (count: number) => {
        if (this.isCurrent(generation, conn)) this.emit('dataSent', count)
      },
      onOverflow: (details: unknown) => {
        if (this.isCurrent(generation, conn)) this.emit('overflow', details)
      },
      onDisconnected: () => {
        if (this.isCurrent(generation, conn) && !this.intentionalDisconnect) {
          void this.handleDrop(generation)
        }
      },
      onError: (error: Error) => {
        if (!this.isCurrent(generation, conn) || this.intentionalDisconnect) return
        this._lastReconnectError = error
        this.emitPublicError(error)
        void this.handleDrop(generation)
      },
      onDiagnostic: (details: unknown) => {
        if (this.isCurrent(generation, conn)) this.emit('diagnostic', details)
      },
    }
    this.handlers = handlers
    conn.on('data', handlers.onData)
    conn.on('dataSent', handlers.onDataSent)
    conn.on('overflow', handlers.onOverflow)
    conn.on('disconnected', handlers.onDisconnected)
    conn.on('error', handlers.onError)
    conn.on('diagnostic', handlers.onDiagnostic)
  }

  private detachLink(handlers: LinkHandlers): void {
    handlers.conn.off('data', handlers.onData)
    handlers.conn.off('dataSent', handlers.onDataSent)
    handlers.conn.off('overflow', handlers.onOverflow)
    handlers.conn.off('disconnected', handlers.onDisconnected)
    handlers.conn.off('error', handlers.onError)
    handlers.conn.off('diagnostic', handlers.onDiagnostic)
    if (this.handlers === handlers) this.handlers = null
  }

  private handleDrop(generation: number): Promise<void> {
    if (this.intentionalDisconnect || generation !== this.lifecycleGeneration) {
      return Promise.resolve()
    }
    if (this.dropPromise) return this.dropPromise

    if (this.expectedRebootActive) this.expectedRebootInterruption = true
    this.setVehicleReady(false)
    this.setTransportOpen(false)
    this.emit('transportDisconnected', {
      generation,
      error: this._lastReconnectError?.message,
    })

    const drop = Promise.resolve().then(async () => {
      try {
        await this.teardownConnection()
      } catch (error) {
        const closeError = this.toError(error)
        this._lastReconnectError = closeError
        if (!this.intentionalDisconnect && generation === this.lifecycleGeneration) {
          this.finishTerminal('CLOSE_FAILED', closeError)
        }
        return
      }
      if (!this.intentionalDisconnect && generation === this.lifecycleGeneration) {
        this.scheduleReconnect(generation)
      }
    })
    this.dropPromise = drop
    void drop.finally(() => {
      if (this.dropPromise === drop) this.dropPromise = null
    })
    return drop
  }

  private scheduleReconnect(generation: number): void {
    if (
      this.reconnectTimer
      || this.intentionalDisconnect
      || generation !== this.lifecycleGeneration
    ) return

    const rebootSchedule = this.expectedRebootActive
    if (this.rebootAwaited && !rebootSchedule) {
      // The FC was expected to restart but never came back inside the grace
      // window; extending into ordinary retries would mislead the operator.
      this.finishTerminal(
        'REBOOT_WINDOW_EXPIRED',
        this._lastReconnectError ?? new Error('飞控重启后设备未在等待窗口内重新出现。'),
      )
      return
    }
    const maxAttempts = rebootSchedule ? this.rebootAttemptLimit : this.maxReconnectAttempts
    if (this.reconnectAttempts >= maxAttempts) {
      this.finishTerminal(
        'MAX_ATTEMPTS',
        this._lastReconnectError
          ?? new Error(`串口重连已达最大次数（${maxAttempts}）。`),
      )
      return
    }

    this.reconnectAttempts += 1
    const delayMs = rebootSchedule
      ? this.rebootDelayMs
      : this.reconnectBackoffScheduleMs[
        Math.min(this.reconnectAttempts - 1, this.reconnectBackoffScheduleMs.length - 1)
      ]
    const progress: ReconnectProgress = {
      attempt: this.reconnectAttempts,
      maxAttempts,
      delayMs,
      ...(this._lastReconnectError ? { lastError: this._lastReconnectError.message } : {}),
    }
    this.emit('reconnecting', progress)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (this.intentionalDisconnect || generation !== this.lifecycleGeneration) return
      void this.runOpenAttempt(generation, true).catch((error) => {
        if (this.intentionalDisconnect || generation !== this.lifecycleGeneration) return
        this._lastReconnectError = this.toError(error)
        // Ambiguous identity can never be cured by retrying: fail closed
        // instead of guessing between twin devices. A vanished device
        // (DEVICE_NOT_FOUND) keeps its bounded retry budget.
        if (error instanceof ConnectionResolutionError && error.code === 'IDENTITY_AMBIGUOUS') {
          this.finishTerminal(error.code, error)
          return
        }
        this.scheduleReconnect(generation)
      })
    }, delayMs)
    this.reconnectTimer.unref?.()
  }

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) return
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
  }

  private async teardownConnection(expected?: SerialWorkerLink): Promise<void> {
    if (this.teardownPromise) return this.teardownPromise
    const conn = expected ?? this.conn
    if (!conn) return
    if (expected && this.conn !== expected) return
    const handlers = this.handlers?.conn === conn ? this.handlers : null

    const teardown = Promise.resolve().then(async () => {
      await conn.disconnect()
      if (handlers) this.detachLink(handlers)
      if (this.conn === conn) this.conn = null
    })
    this.teardownPromise = teardown
    try {
      await teardown
    } finally {
      if (this.teardownPromise === teardown) this.teardownPromise = null
    }
  }

  private setTransportOpen(value: boolean): void {
    if (!value) this.setVehicleReady(false)
    if (this._transportOpen === value) return
    this._transportOpen = value
    this.emit('transportChange', value)
  }

  private setVehicleReady(value: boolean): void {
    const effectiveValue = value && this._transportOpen
    if (this._vehicleReady === effectiveValue) return
    this._vehicleReady = effectiveValue
    this.emit('vehicleReadyChange', effectiveValue)
  }

  private finishTerminal(code: string, error: Error): void {
    this.intentionalDisconnect = true
    this.clearReconnectTimer()
    this.cancelExpectedVehicleReboot()
    this.setVehicleReady(false)
    this.setTransportOpen(false)
    this._terminalReason = {
      code,
      message: error.message,
      attempt: this.reconnectAttempts,
      timestamp: this.wallClock(),
    }
    this.emit('terminal', this._terminalReason)
    this.emitPublicError(error)
    this.emit('disconnected')
  }

  private isCurrent(generation: number, conn?: SerialWorkerLink): boolean {
    return (
      !this.intentionalDisconnect
      && generation === this.lifecycleGeneration
      && (!conn || conn === this.conn)
    )
  }

  private assertCurrent(generation: number, conn?: SerialWorkerLink): void {
    if (!this.isCurrent(generation, conn)) throw new OperationCancelledError()
  }

  private emitPublicError(error: Error): void {
    if (this.listenerCount('error') > 0) this.emit('error', error)
    else this.emit('diagnostic', { kind: 'unhandledLinkError', error })
  }

  private withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        reject(new Error(message))
      }, timeoutMs)
      promise.then(
        (value) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve(value)
        },
        (error) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          reject(error)
        },
      )
    })
  }

  private toError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error))
  }
}
