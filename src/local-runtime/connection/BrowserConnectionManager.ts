import { ByteBuffer } from '../platform/ByteBuffer'
import type { ConnectionConfig, ConnectionStatus } from '../../shared/types'
import { EventEmitter } from '../platform/EventEmitter'

export type SerialWritePriority = 'normal' | 'high' | 'critical'
export type SerialWriteQueueTag = string

export interface RawSessionHandle {
  write(data: ByteBuffer): boolean
  onData(listener: (data: ByteBuffer) => void): () => void
  onAborted(listener: (reason: string) => void): () => void
  release(): void
}

export interface BrowserConnectionManagerOptions {
  write: (data: Uint8Array, priority: SerialWritePriority, queueTag?: string) => boolean
  cancelQueuedWrites: (queueTag: string) => number
}

type RawSessionState = {
  active: boolean
  dataListeners: Set<(data: ByteBuffer) => void>
  abortedListeners: Set<(reason: string) => void>
}

const HEARTBEAT_TIMEOUT_MS = 15_000

/**
 * Worker-side connection state. The main thread owns the native SerialPort;
 * this class owns only the protocol-visible lifecycle and byte routing.
 */
export class BrowserConnectionManager extends EventEmitter {
  status: ConnectionStatus = 'disconnected'
  config: ConnectionConfig | null = null
  transportOpen = false
  vehicleReady = false
  bytesReceived = 0
  bytesSent = 0
  reconnect: null = null
  reconnectTerminalReason: null = null
  lastError: null | { phase: 'runtime' | 'disconnect'; message: string; timestamp: number; retryable?: boolean } = null

  private readonly options: BrowserConnectionManagerOptions
  private rawSession: RawSessionState | null = null
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null
  private expectedRebootUntil = 0

  constructor(options: BrowserConnectionManagerOptions) {
    super()
    this.options = options
  }

  attach(config: ConnectionConfig): void {
    this.abortRawSession('connection_changed')
    this.clearHeartbeatTimer()
    this.config = config
    this.transportOpen = true
    this.vehicleReady = false
    this.bytesReceived = 0
    this.bytesSent = 0
    this.lastError = null
    this.setStatus('connected')
    this.emit('connectionStateDetail')
  }

  detach(reason = 'disconnected', error?: string): void {
    this.abortRawSession(reason)
    this.clearHeartbeatTimer()
    this.transportOpen = false
    this.vehicleReady = false
    this.config = null
    this.lastError = error
      ? { phase: 'disconnect', message: error, timestamp: Date.now(), retryable: true }
      : null
    this.setStatus(error ? 'error' : 'disconnected')
    if (error) this.emit('connectionError', new Error(error))
    this.emit('connectionStateDetail')
  }

  receive(data: Uint8Array): void {
    if (!this.transportOpen || this.status !== 'connected') return
    const chunk = ByteBuffer.from(data)
    this.bytesReceived += chunk.length
    if (this.rawSession?.active) {
      for (const listener of [...this.rawSession.dataListeners]) listener(chunk)
      return
    }
    this.emit('data', chunk)
  }

  write(
    data: ByteBuffer,
    priority: SerialWritePriority = 'normal',
    queueTag?: SerialWriteQueueTag,
  ): boolean {
    if (!this.transportOpen || this.status !== 'connected') return false
    const accepted = this.options.write(Uint8Array.from(data), priority, queueTag)
    if (accepted) this.bytesSent += data.length
    return accepted
  }

  cancelQueuedWrites(queueTag: SerialWriteQueueTag): number {
    return this.options.cancelQueuedWrites(queueTag)
  }

  get rawSessionActive(): boolean {
    return this.rawSession?.active ?? false
  }

  beginRawSession(): RawSessionHandle {
    if (this.rawSession) throw new Error('已存在一个原始会话')
    if (!this.transportOpen || this.status !== 'connected') {
      throw new Error('原始会话需要处于已连接状态的链路')
    }
    if (this.config?.type !== 'serial') throw new Error('原始会话仅支持串口链路')

    const state: RawSessionState = {
      active: true,
      dataListeners: new Set(),
      abortedListeners: new Set(),
    }
    this.rawSession = state
    this.setVehicleReady(false)
    this.emit('rawSessionChange', true)
    return {
      write: (data) => state.active && this.write(data, 'high'),
      onData: (listener) => {
        state.dataListeners.add(listener)
        return () => state.dataListeners.delete(listener)
      },
      onAborted: (listener) => {
        state.abortedListeners.add(listener)
        return () => state.abortedListeners.delete(listener)
      },
      release: () => {
        if (this.rawSession !== state || !state.active) return
        state.active = false
        this.rawSession = null
        this.emit('rawSessionChange', false)
      },
    }
  }

  notifyAutopilotActivity(): void {
    // Valid MAVLink activity is useful diagnostically, but only a selected
    // HEARTBEAT may raise vehicleReady.
  }

  notifyAutopilotHeartbeat(): void {
    if (!this.transportOpen || this.status !== 'connected') return
    if (performance.now() < this.expectedRebootUntil) return
    this.setVehicleReady(true)
    this.clearHeartbeatTimer()
    this.heartbeatTimer = setTimeout(() => this.setVehicleReady(false), HEARTBEAT_TIMEOUT_MS)
  }

  expectVehicleReboot(graceMs = 45_000): boolean {
    if (!this.transportOpen || this.status !== 'connected') return false
    this.expectedRebootUntil = performance.now() + Math.max(750, graceMs)
    this.setVehicleReady(false)
    return true
  }

  private setVehicleReady(ready: boolean): void {
    if (this.vehicleReady === ready) return
    this.vehicleReady = ready
    this.emit('vehicleReadyChange', ready)
    this.emit('connectionStateDetail')
  }

  private setStatus(status: ConnectionStatus): void {
    if (this.status === status) return
    this.status = status
    this.emit('statusChange', status)
  }

  private clearHeartbeatTimer(): void {
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer)
    this.heartbeatTimer = null
  }

  private abortRawSession(reason: string): void {
    const state = this.rawSession
    if (!state?.active) return
    state.active = false
    this.rawSession = null
    this.emit('rawSessionChange', false)
    for (const listener of [...state.abortedListeners]) listener(reason)
  }
}
