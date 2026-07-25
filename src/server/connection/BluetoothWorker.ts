import { EventEmitter } from 'events'
import { SerialConnection, type SerialWritePriority } from './SerialConnection'
import {
  BluetoothConnection,
  BluetoothPortResolutionError,
  type BluetoothPortSelector,
} from './BluetoothConnection'
import type { ConnectionConfig } from '../../shared/types'

const DEFAULT_MAX_RECONNECT_ATTEMPTS = 10
const DEFAULT_RECONNECT_BASE_INTERVAL_MS = 5000
const DEFAULT_MAX_RECONNECT_INTERVAL_MS = 15000
const DEFAULT_OPEN_TIMEOUT_MS = 20000
const DEFAULT_VEHICLE_CONFIRM_TIMEOUT_MS = 5000
const DEFAULT_DISCONNECT_TIMEOUT_MS = 30000

export interface ReconnectProgress {
  attempt: number
  maxAttempts: number
  delayMs: number
  lastError?: string
}

export interface ReconnectTerminalReason {
  code: string
  message: string
  attempt: number
  timestamp: number
}

export interface BluetoothSerialLink extends EventEmitter {
  readonly connected: boolean
  connect(path: string, baudRate: number, timeoutMs?: number): Promise<void>
  disconnect(timeoutMs?: number): Promise<void>
  write(data: Buffer, priority?: SerialWritePriority): boolean | void
}

export interface BluetoothWorkerOptions {
  serialFactory?: () => BluetoothSerialLink
  resolvePort?: (selector: BluetoothPortSelector) => Promise<string | null>
  maxReconnectAttempts?: number
  reconnectBaseIntervalMs?: number
  maxReconnectIntervalMs?: number
  openTimeoutMs?: number
  vehicleConfirmTimeoutMs?: number
  disconnectTimeoutMs?: number
  wallClock?: () => number
}

interface LinkHandlers {
  conn: BluetoothSerialLink
  generation: number
  onData: (data: Buffer) => void
  onDataSent: (count: number) => void
  onOverflow: (details: unknown) => void
  onDisconnected: () => void
  onError: (error: Error) => void
  onDiagnostic: (details: unknown) => void
}

type ConfigWithAddress = ConnectionConfig & { bluetoothAddress?: string }

export class BluetoothWorker extends EventEmitter {
  private readonly selectorConfig: ConfigWithAddress
  private currentPort: string
  private conn: BluetoothSerialLink | null = null
  private handlers: LinkHandlers | null = null
  private _transportOpen = false
  private _vehicleReady = false
  private intentionalDisconnect = true
  private lifecycleGeneration = 0
  private reconnectAttempts = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private confirmationTimer: ReturnType<typeof setTimeout> | null = null
  private cancelActiveResolution: (() => void) | null = null
  private activeAttempt: Promise<void> | null = null
  private teardownPromise: Promise<void> | null = null
  private dropPromise: Promise<void> | null = null
  private disconnectPromise: Promise<void> | null = null
  private _lastReconnectError: Error | null = null
  private _terminalReason: ReconnectTerminalReason | null = null

  private readonly serialFactory: NonNullable<BluetoothWorkerOptions['serialFactory']>
  private readonly resolvePort: NonNullable<BluetoothWorkerOptions['resolvePort']>
  private readonly maxReconnectAttempts: number
  private readonly reconnectBaseIntervalMs: number
  private readonly maxReconnectIntervalMs: number
  private readonly openTimeoutMs: number
  private readonly vehicleConfirmTimeoutMs: number
  private readonly disconnectTimeoutMs: number
  private readonly wallClock: () => number

  constructor(config: ConnectionConfig, options: BluetoothWorkerOptions = {}) {
    super()
    this.selectorConfig = { ...config }
    this.currentPort = config.port
    this.serialFactory = options.serialFactory ?? (() => new SerialConnection())
    this.resolvePort = options.resolvePort ?? ((selector) => BluetoothConnection.findPortByIds(selector))
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS
    this.reconnectBaseIntervalMs = options.reconnectBaseIntervalMs ?? DEFAULT_RECONNECT_BASE_INTERVAL_MS
    this.maxReconnectIntervalMs = options.maxReconnectIntervalMs ?? DEFAULT_MAX_RECONNECT_INTERVAL_MS
    this.openTimeoutMs = options.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS
    this.vehicleConfirmTimeoutMs = options.vehicleConfirmTimeoutMs
      ?? DEFAULT_VEHICLE_CONFIRM_TIMEOUT_MS
    this.disconnectTimeoutMs = options.disconnectTimeoutMs ?? DEFAULT_DISCONNECT_TIMEOUT_MS
    this.wallClock = options.wallClock ?? Date.now
  }

  /** Compatibility alias: connected means the serial/RFCOMM transport is open. */
  get connected() {
    return this._transportOpen
  }

  get transportOpen() {
    return this._transportOpen
  }

  get vehicleReady() {
    return this._vehicleReady
  }

  get resolvedPort(): string {
    return this.currentPort
  }

  get lastReconnectError(): Error | null {
    return this._lastReconnectError
  }

  get terminalReason(): ReconnectTerminalReason | null {
    return this._terminalReason
  }

  async connect(): Promise<void> {
    if (this.activeAttempt || this.conn || this._transportOpen) {
      throw new Error('蓝牙连接已在进行或已打开。')
    }
    this.intentionalDisconnect = false
    this._terminalReason = null
    this._lastReconnectError = null
    this.reconnectAttempts = 0
    const generation = ++this.lifecycleGeneration
    await this.runOpenAttempt(generation, false)
  }

  write(data: Buffer, priority: SerialWritePriority = 'normal'): boolean {
    if (!this._transportOpen || !this.conn) return false
    return this.conn.write(data, priority) !== false
  }

  /**
   * Called only after MavlinkBridge validates an autopilot HEARTBEAT for the
   * selected vehicle. Raw serial bytes never invoke this method.
   */
  confirmVehicleHeartbeat(): void {
    if (this.intentionalDisconnect || !this.conn || !this._transportOpen) return
    const generation = this.lifecycleGeneration
    this.clearConfirmationTimer()
    const changed = !this._vehicleReady
    this.setVehicleReady(true)
    this.reconnectAttempts = 0
    this._lastReconnectError = null
    this._terminalReason = null
    if (changed) this.emit('vehicleReady', { port: this.currentPort, generation })
  }

  async disconnect(): Promise<void> {
    if (this.disconnectPromise) {
      return this.withTimeout(
        this.disconnectPromise,
        this.disconnectTimeoutMs,
        `等待蓝牙连接任务停止超时（${Math.round(this.disconnectTimeoutMs / 1000)}s）。`,
      )
    }
    const hadLifecycle = !!this.conn || !!this.activeAttempt || !!this.reconnectTimer || this._transportOpen
    this.intentionalDisconnect = true
    ++this.lifecycleGeneration
    this.cancelActiveResolution?.()
    this.clearReconnectTimer()
    this.clearConfirmationTimer()
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
      if (attempt) {
        await attempt.catch(() => undefined)
      }

      // An attempt can publish its provisional connection immediately before
      // noticing the invalidated generation. Sweep once more after it settles.
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
      `等待蓝牙连接任务停止超时（${Math.round(this.disconnectTimeoutMs / 1000)}s）。`,
    )
  }

  forceReconnect(reason = '飞控心跳超时'): void {
    if (this.intentionalDisconnect) return
    this._lastReconnectError = new Error(reason)
    void this.handleDrop(this.lifecycleGeneration)
  }

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
    let resolved: string | null
    try {
      resolved = await this.resolvePortCancellable(generation)
    } catch (error) {
      this._lastReconnectError = this.toError(error)
      throw error
    }
    this.assertCurrent(generation)
    if (!resolved) {
      const error = new Error(
        `未找到蓝牙设备 "${this.selectorConfig.port}" 对应的 SPP 串口。`
        + ' 请确认设备已配对并启用 SPP 服务。',
      )
      this._lastReconnectError = error
      throw error
    }
    this.currentPort = resolved

    const conn = this.serialFactory()
    this.conn = conn
    this.attachLink(conn, generation)
    try {
      await conn.connect(resolved, this.selectorConfig.baudRate, this.openTimeoutMs)
      this.assertCurrent(generation, conn)
      this.setTransportOpen(true)
      this.setVehicleReady(false)
      this.emit('transportConnected', { port: resolved, generation, reconnecting })
      // Compatibility event: physical transport is available, so Bridge may
      // reset its parser and start the GCS heartbeat needed for validation.
      this.emit('connected', { port: resolved, generation, reconnecting })
      if (!this._vehicleReady) this.startConfirmationTimer(generation)
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

  private attachLink(conn: BluetoothSerialLink, generation: number): void {
    const handlers: LinkHandlers = {
      conn,
      generation,
      onData: (data: Buffer) => {
        if (!this.isCurrent(generation, conn)) return
        // Data must reach Bridge even before vehicle confirmation so it can
        // validate the heartbeat that completes readiness.
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

    this.clearConfirmationTimer()
    this.setVehicleReady(false)
    this.setTransportOpen(false)
    this.emit('transportDisconnected', { generation, error: this._lastReconnectError?.message })

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
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.finishTerminal(
        'MAX_ATTEMPTS',
        this._lastReconnectError
          ?? new Error(`蓝牙重连已达最大次数（${this.maxReconnectAttempts}）。`),
      )
      return
    }

    this.reconnectAttempts += 1
    const delayMs = Math.min(
      this.reconnectBaseIntervalMs * (2 ** (this.reconnectAttempts - 1)),
      this.maxReconnectIntervalMs,
    )
    const progress: ReconnectProgress = {
      attempt: this.reconnectAttempts,
      maxAttempts: this.maxReconnectAttempts,
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
        this.scheduleReconnect(generation)
      })
    }, delayMs)
  }

  private startConfirmationTimer(generation: number): void {
    this.clearConfirmationTimer()
    this.confirmationTimer = setTimeout(() => {
      this.confirmationTimer = null
      if (
        this.intentionalDisconnect
        || generation !== this.lifecycleGeneration
        || this._vehicleReady
      ) return
      this._lastReconnectError = new Error('蓝牙传输已打开，但未收到经过验证的飞控心跳。')
      void this.handleDrop(generation)
    }, this.vehicleConfirmTimeoutMs)
  }

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) return
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
  }

  private clearConfirmationTimer(): void {
    if (!this.confirmationTimer) return
    clearTimeout(this.confirmationTimer)
    this.confirmationTimer = null
  }

  private async teardownConnection(expected?: BluetoothSerialLink): Promise<void> {
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
    this.clearConfirmationTimer()
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

  private isCurrent(generation: number, conn?: BluetoothSerialLink): boolean {
    return (
      !this.intentionalDisconnect
      && generation === this.lifecycleGeneration
      && (!conn || conn === this.conn)
    )
  }

  private assertCurrent(generation: number, conn?: BluetoothSerialLink): void {
    if (!this.isCurrent(generation, conn)) throw new OperationCancelledError()
  }

  private resolvePortCancellable(generation: number): Promise<string | null> {
    const work = this.resolvePort({
      vendorId: this.selectorConfig.vendorId,
      productId: this.selectorConfig.productId,
      bluetoothServiceClassId: this.selectorConfig.bluetoothServiceClassId,
      bluetoothAddress: this.selectorConfig.bluetoothAddress,
      label: this.currentPort,
    })

    return new Promise<string | null>((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        finish(() => reject(new Error(
          `解析蓝牙 SPP 串口超时（${Math.round(this.openTimeoutMs / 1000)}s）。`,
        )))
      }, this.openTimeoutMs)
      const finish = (callback: () => void) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (this.cancelActiveResolution === cancel) this.cancelActiveResolution = null
        callback()
      }
      const cancel = () => finish(() => reject(new OperationCancelledError()))
      this.cancelActiveResolution = cancel
      if (generation !== this.lifecycleGeneration || this.intentionalDisconnect) {
        cancel()
        return
      }
      work.then(
        (port) => finish(() => resolve(port)),
        (error) => finish(() => reject(error)),
      )
    })
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
    if (error instanceof BluetoothPortResolutionError) return error
    return error instanceof Error ? error : new Error(String(error))
  }
}

class OperationCancelledError extends Error {
  constructor() {
    super('蓝牙连接操作已取消。')
    this.name = 'OperationCancelledError'
  }
}
