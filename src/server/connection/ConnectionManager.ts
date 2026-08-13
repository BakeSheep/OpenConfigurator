import { EventEmitter } from 'events'
import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import {
  SerialConnection,
  type SerialWritePriority,
  type SerialWriteQueueTag,
} from './SerialConnection'
import { BluetoothConnection } from './BluetoothConnection'
import {
  BluetoothWorker,
  type ReconnectProgress,
  type ReconnectTerminalReason,
} from './BluetoothWorker'
import type { ConnectionConfig, ConnectionStatus, PortInfo } from '../../shared/types'

const DEFAULT_SERIAL_SOFT_HEARTBEAT_TIMEOUT_MS = 5000
const DEFAULT_BLUETOOTH_SOFT_HEARTBEAT_TIMEOUT_MS = 20000
const DEFAULT_ACTIVITY_GRACE_MS = 8000
const DEFAULT_SERIAL_HARD_HEARTBEAT_TIMEOUT_MS = 15000
const DEFAULT_BLUETOOTH_HARD_HEARTBEAT_TIMEOUT_MS = 30000
const DEFAULT_HEARTBEAT_CHECK_INTERVAL_MS = 1000
const DEFAULT_REBOOT_RECONNECT_DELAY_MS = 1000
const DEFAULT_REBOOT_RECONNECT_GRACE_MS = 45_000
const DEFAULT_REBOOT_RECONNECT_MAX_ATTEMPTS = 12
const REBOOT_STALE_HEARTBEAT_GUARD_MS = 750
const MAX_PRE_TRANSPORT_DATA_BYTES = 256 * 1024

export type ConnectionErrorPhase =
  | 'connect'
  | 'runtime'
  | 'disconnect'
  | 'heartbeat'
  | 'reconnect'

export interface ConnectionErrorDetail {
  phase: ConnectionErrorPhase
  message: string
  code?: string
  timestamp: number
}

interface ManagedLink extends EventEmitter {
  readonly connected: boolean
  disconnect(timeoutMs?: number): Promise<void>
  write(
    data: Buffer,
    priority?: SerialWritePriority,
    queueTag?: SerialWriteQueueTag,
  ): boolean | void
  cancelQueuedWrites?(queueTag: SerialWriteQueueTag): number
}

/**
 * Exclusive raw byte channel over the live serial link (ADR-002/003). While
 * held, the MAVLink heartbeat monitor is suspended and inbound bytes are
 * routed to this handle instead of the 'data' event. Used by the ArduPilot
 * ESC passthrough transport.
 */
export interface RawSessionHandle {
  write(data: Buffer): boolean
  onData(listener: (data: Buffer) => void): () => void
  onAborted(listener: (reason: string) => void): () => void
  release(): void
}

interface RawSessionState {
  generation: number
  active: boolean
  dataListeners: Set<(data: Buffer) => void>
  abortedListeners: Set<(reason: string) => void>
  handle: RawSessionHandle
}

interface ManagedSerialLink extends ManagedLink {
  connect(path: string, baudRate: number, timeoutMs?: number): Promise<void>
}

interface ManagedBluetoothLink extends ManagedLink {
  readonly resolvedPort: string
  readonly terminalReason: ReconnectTerminalReason | null
  connect(): Promise<void>
  confirmVehicleHeartbeat(): void
  forceReconnect(reason?: string): void
}

export interface ConnectionManagerOptions {
  serialFactory?: () => ManagedSerialLink
  bluetoothFactory?: (config: ConnectionConfig) => ManagedBluetoothLink
  listSerialPorts?: () => Promise<PortInfo[]>
  listBluetoothPorts?: () => Promise<PortInfo[]>
  monotonicNow?: () => number
  wallClock?: () => number
  setIntervalFn?: (
    callback: () => void,
    delayMs: number,
  ) => ReturnType<typeof setInterval>
  clearIntervalFn?: (timer: ReturnType<typeof setInterval>) => void
  heartbeatCheckIntervalMs?: number
  serialSoftHeartbeatTimeoutMs?: number
  bluetoothSoftHeartbeatTimeoutMs?: number
  activityGraceMs?: number
  serialHardHeartbeatTimeoutMs?: number
  bluetoothHardHeartbeatTimeoutMs?: number
  rebootReconnectDelayMs?: number
  rebootReconnectGraceMs?: number
  rebootReconnectMaxAttempts?: number
}

interface LinkHandlers {
  link: ManagedLink
  generation: number
  onData: (data: Buffer) => void
  onDataSent: (count: number) => void
  onOverflow: (details: unknown) => void
  onDisconnected: () => void
  onError: (error: Error) => void
  onDiagnostic: (details: unknown) => void
  onConnected?: (details?: unknown) => void
  onTransportConnected?: (details?: unknown) => void
  onTransportDisconnected?: (details?: unknown) => void
  onReconnecting?: (progress: ReconnectProgress) => void
  onTerminal?: (reason: ReconnectTerminalReason) => void
  onVehicleReadyChange?: (ready: boolean) => void
}

export class ConnectionManager extends EventEmitter {
  private link: ManagedLink | null = null
  private linkKind: ConnectionConfig['type'] | null = null
  private linkHandlers: LinkHandlers | null = null
  private _status: ConnectionStatus = 'disconnected'
  private _config: ConnectionConfig | null = null
  private _transportOpen = false
  private _vehicleReady = false
  private _lastError: ConnectionErrorDetail | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private lastHeartbeat = 0
  private lastMavlinkActivity = 0
  private heartbeatTimeoutFired = false
  private pendingOp: Promise<void> = Promise.resolve()
  private nextConnectRequestId = 0
  private cancelConnectThrough = 0
  private connectionGeneration = 0
  private cleanupGeneration: number | null = null
  private activeCleanup: {
    link: ManagedLink
    generation: number
    promise: Promise<void>
  } | null = null
  private readonly scheduledCleanupGenerations = new Set<number>()
  private preTransportData: Buffer[] = []
  private preTransportDataBytes = 0
  private _bytesReceived = 0
  private _bytesSent = 0
  private _reconnect: ReconnectProgress | null = null
  private _reconnectTerminalReason: ReconnectTerminalReason | null = null
  private rawSession: RawSessionState | null = null
  private scannedPortsCache = new Map<string, { portId: string; path: string; type: 'serial' | 'bluetooth'; expiresAt: number }>()
  private expectedRebootUntil = 0
  private expectedRebootStartedAt = 0
  private rebootInterruptionObserved = false
  private rebootReconnectAttempt = 0
  private rebootReconnectTimer: ReturnType<typeof setTimeout> | null = null
  private rebootReconnectToken = 0

  private readonly serialFactory: () => ManagedSerialLink
  private readonly bluetoothFactory: (config: ConnectionConfig) => ManagedBluetoothLink
  private readonly listSerialPorts: () => Promise<PortInfo[]>
  private readonly listBluetoothPorts: () => Promise<PortInfo[]>
  private readonly monotonicNow: () => number
  private readonly wallClock: () => number
  private readonly setIntervalFn: NonNullable<ConnectionManagerOptions['setIntervalFn']>
  private readonly clearIntervalFn: NonNullable<ConnectionManagerOptions['clearIntervalFn']>
  private readonly heartbeatCheckIntervalMs: number
  private readonly serialSoftHeartbeatTimeoutMs: number
  private readonly bluetoothSoftHeartbeatTimeoutMs: number
  private readonly activityGraceMs: number
  private readonly serialHardHeartbeatTimeoutMs: number
  private readonly bluetoothHardHeartbeatTimeoutMs: number
  private readonly rebootReconnectDelayMs: number
  private readonly rebootReconnectGraceMs: number
  private readonly rebootReconnectMaxAttempts: number

  constructor(options: ConnectionManagerOptions = {}) {
    super()
    this.serialFactory = options.serialFactory ?? (() => new SerialConnection())
    this.bluetoothFactory = options.bluetoothFactory ?? ((config) => new BluetoothWorker(config))
    this.listSerialPorts = options.listSerialPorts ?? (() => SerialConnection.listPorts())
    this.listBluetoothPorts = options.listBluetoothPorts ?? (() => BluetoothConnection.scanDevices())
    this.monotonicNow = options.monotonicNow ?? (() => performance.now())
    this.wallClock = options.wallClock ?? Date.now
    this.setIntervalFn = options.setIntervalFn ?? ((callback, delayMs) => setInterval(callback, delayMs))
    this.clearIntervalFn = options.clearIntervalFn ?? ((timer) => clearInterval(timer))
    this.heartbeatCheckIntervalMs = options.heartbeatCheckIntervalMs
      ?? DEFAULT_HEARTBEAT_CHECK_INTERVAL_MS
    this.serialSoftHeartbeatTimeoutMs = options.serialSoftHeartbeatTimeoutMs
      ?? DEFAULT_SERIAL_SOFT_HEARTBEAT_TIMEOUT_MS
    this.bluetoothSoftHeartbeatTimeoutMs = options.bluetoothSoftHeartbeatTimeoutMs
      ?? DEFAULT_BLUETOOTH_SOFT_HEARTBEAT_TIMEOUT_MS
    this.activityGraceMs = options.activityGraceMs ?? DEFAULT_ACTIVITY_GRACE_MS
    this.serialHardHeartbeatTimeoutMs = options.serialHardHeartbeatTimeoutMs
      ?? DEFAULT_SERIAL_HARD_HEARTBEAT_TIMEOUT_MS
    this.bluetoothHardHeartbeatTimeoutMs = options.bluetoothHardHeartbeatTimeoutMs
      ?? DEFAULT_BLUETOOTH_HARD_HEARTBEAT_TIMEOUT_MS
    this.rebootReconnectDelayMs = options.rebootReconnectDelayMs
      ?? DEFAULT_REBOOT_RECONNECT_DELAY_MS
    this.rebootReconnectGraceMs = options.rebootReconnectGraceMs
      ?? DEFAULT_REBOOT_RECONNECT_GRACE_MS
    this.rebootReconnectMaxAttempts = options.rebootReconnectMaxAttempts
      ?? DEFAULT_REBOOT_RECONNECT_MAX_ATTEMPTS
  }

  get status() {
    return this._status
  }

  get config() {
    return this._config
  }

  get transportOpen() {
    return this._transportOpen
  }

  get vehicleReady() {
    return this._vehicleReady
  }

  get lastError() {
    return this._lastError
  }

  get bytesReceived() {
    return this._bytesReceived
  }

  get bytesSent() {
    return this._bytesSent
  }

  get reconnect() {
    return this._reconnect
  }

  get reconnectTerminalReason() {
    return this._reconnectTerminalReason
  }

  get generation() {
    return this.connectionGeneration
  }

  async scanPorts(options?: { debug?: boolean }): Promise<{ serial: PortInfo[]; bluetooth: PortInfo[] }> {
    const [rawSerial, rawBluetooth] = await Promise.all([
      this.listSerialPorts(),
      this.listBluetoothPorts(),
    ])
    const now = this.wallClock()
    const expiresAt = now + 60_000

    for (const [key, entry] of this.scannedPortsCache.entries()) {
      if (entry.expiresAt <= now) this.scannedPortsCache.delete(key)
    }

    const processPort = (port: PortInfo, type: 'serial' | 'bluetooth'): PortInfo => {
      const existing = [...this.scannedPortsCache.values()].find((e) => e.path === port.path && e.type === type)
      const portId = existing?.portId ?? `port_${randomUUID()}`
      this.scannedPortsCache.set(portId, { portId, path: port.path, type, expiresAt })

      if (options?.debug) {
        return { ...port, portId }
      }
      return {
        path: port.path,
        portId,
        friendlyName: port.friendlyName,
        manufacturer: port.manufacturer,
        recommended: port.recommended,
        vendorId: port.vendorId,
        productId: port.productId,
      }
    }

    const serial = rawSerial.map((p) => processPort(p, 'serial'))
    const bluetooth = rawBluetooth.map((p) => processPort(p, 'bluetooth'))
    return { serial, bluetooth }
  }

  /** Resolve an untrusted REST request through a fresh server-issued scan ticket. */
  prepareConnectionConfig(config: ConnectionConfig): ConnectionConfig {
    if (!config.portId) throw new Error('连接端口票据缺失，请重新扫描端口')
    const entry = this.scannedPortsCache.get(config.portId)
    if (!entry || entry.expiresAt <= this.wallClock()) {
      if (entry) this.scannedPortsCache.delete(config.portId)
      throw new Error('连接端口票据无效或已过期，请重新扫描端口')
    }
    if (entry.type !== config.type) throw new Error('连接端口票据与连接类型不匹配')
    if (this.link && this._status !== 'disconnected') {
      if (config.expectedGeneration === undefined) throw new Error('替换现有连接需要确认当前连接代次')
      if (config.expectedGeneration !== this.connectionGeneration) {
        throw new Error(`连接代次不匹配（预期 ${config.expectedGeneration}，当前 ${this.connectionGeneration}），替换连接已被拒绝`)
      }
    }
    return { ...config, port: entry.path }
  }

  async connect(config: ConnectionConfig, preserveExpectedReboot = false): Promise<void> {
    if (!preserveExpectedReboot) this.cancelExpectedVehicleReboot()
    const resolvedConfig: ConnectionConfig = { ...config }
    const requestId = ++this.nextConnectRequestId
    return this.enqueueOperation(async () => {
      if (this.isConnectRequestCancelled(requestId)) {
        throw this.connectionCancelledError()
      }
      if (this.link) {
        this.prepareForTeardown('connecting')
        try {
          await this.awaitActiveLinkCleanup(this.link, this.connectionGeneration)
        } catch (error) {
          const failure = this.toError(error)
          this.setLastError(this.errorDetail('disconnect', failure.message, failure))
          this.setStatus('error')
          this.emit('connectionError', failure)
          throw failure
        }
      }
      if (this.isConnectRequestCancelled(requestId)) {
        this.setStatus('disconnected')
        throw this.connectionCancelledError()
      }

      const generation = ++this.connectionGeneration
      this._config = { ...resolvedConfig }
      this.linkKind = resolvedConfig.type
      this._bytesReceived = 0
      this._bytesSent = 0
      this._reconnect = null
      this._reconnectTerminalReason = null
      this.clearPreTransportData()
      this.setLastError(null)
      this.setTransportOpen(false)
      this.setVehicleReady(false)
      this.setStatus('connecting')

      try {
        if (resolvedConfig.type === 'bluetooth') {
          const worker = this.bluetoothFactory(resolvedConfig)
          this.link = worker
          this.wireLink(worker, generation, 'bluetooth')
          await worker.connect()
          if (this.isConnectRequestCancelled(requestId)) {
            throw this.connectionCancelledError()
          }
          if (this.isActive(worker, generation) && !this._transportOpen) {
            this.onLinkTransportConnected(worker, generation)
          }
        } else {
          const connection = this.serialFactory()
          this.link = connection
          this.wireLink(connection, generation, 'serial')
          await connection.connect(resolvedConfig.port, resolvedConfig.baudRate, 5000)
          if (this.isConnectRequestCancelled(requestId)) {
            throw this.connectionCancelledError()
          }
          this.onLinkTransportConnected(connection, generation)
        }
      } catch (error) {
        const connectError = this.toError(error)
        const cancelled = this.isConnectRequestCancelled(requestId)
        let cleanupError: Error | null = null
        if (this.link && this.connectionGeneration === generation) {
          try {
            await this.awaitActiveLinkCleanup(this.link, generation)
          } catch (failure) {
            cleanupError = this.toError(failure)
          }
        }
        if (cancelled && !cleanupError) {
          this.setStatus('disconnected')
          throw this.connectionCancelledError()
        }
        const surfaced = this.translateBluetoothOpenError(connectError, resolvedConfig)
        const detailMessage = cleanupError
          ? `${surfaced.message}；同时清理失败：${cleanupError.message}`
          : surfaced.message
        this.setLastError(this.errorDetail('connect', detailMessage, surfaced))
        this.setStatus('error')
        throw surfaced
      }
    })
  }

  async disconnect(): Promise<void> {
    this.cancelExpectedVehicleReboot()
    // Cancellation must reach a provisional SerialConnection/BluetoothWorker
    // immediately. Waiting behind connect() in pendingOp makes their explicit
    // cancellation support unreachable when native open/discovery stalls.
    this.cancelConnectThrough = this.nextConnectRequestId
    const provisionalLink = this.link
    const provisionalGeneration = this.connectionGeneration
    if (provisionalLink) {
      this.prepareForTeardown('disconnected')
      void this.beginActiveLinkCleanup(provisionalLink, provisionalGeneration).catch(() => undefined)
    }

    return this.enqueueOperation(async () => {
      const link = this.link
      const generation = this.connectionGeneration
      if (link) {
        this.prepareForTeardown('disconnected')
        try {
          await this.awaitActiveLinkCleanup(link, generation)
        } catch (error) {
          const failure = this.toError(error)
          this.setLastError(this.errorDetail('disconnect', failure.message, failure))
          this.setStatus('error')
          this.emit('connectionError', failure)
          throw failure
        }
      } else {
        this.stopHeartbeatMonitor()
        this.setTransportOpen(false)
        this.setVehicleReady(false)
      }

      ++this.connectionGeneration
      this._config = null
      this.linkKind = null
      this._reconnect = null
      this._reconnectTerminalReason = null
      this.clearPreTransportData()
      this.setLastError(null)
      // Publish a final snapshot after config/error/reconnect fields are
      // cleared. The early disconnected event intentionally stops writes,
      // while this forced event lets WS clients discard all stale metadata.
      this.setStatus('disconnected', true)
    })
  }

  write(
    data: Buffer,
    priority: SerialWritePriority = 'normal',
    queueTag?: SerialWriteQueueTag,
  ): boolean {
    if (!this.link || !this._transportOpen || this._status !== 'connected') return false
    return this.link.write(data, priority, queueTag) !== false
  }

  /** Cancel only frames still waiting in the active link's write queue. */
  cancelQueuedWrites(queueTag: SerialWriteQueueTag): number {
    if (!this.link || !this._transportOpen || this._status !== 'connected') return 0
    return this.link.cancelQueuedWrites?.(queueTag) ?? 0
  }

  /** True while an exclusive raw ESC session holds the serial link. */
  get rawSessionActive(): boolean {
    return this.rawSession?.active ?? false
  }

  /**
   * Take exclusive control of the live serial link for a raw ESC session
   * (ADR-003 ArduPilot passthrough). Suspends the heartbeat monitor, drops
   * vehicleReady to false and routes inbound bytes to the returned handle.
   * Only a connected serial link qualifies; Bluetooth is rejected because its
   * reconnect/latency semantics are unsafe for half-duplex flashing.
   */
  beginRawSession(): RawSessionHandle {
    if (this.rawSession) {
      throw new Error('已存在一个原始会话')
    }
    if (!this.link || !this._transportOpen || this._status !== 'connected') {
      throw new Error('原始会话需要处于已连接状态的链路')
    }
    if (this.linkKind !== 'serial') {
      throw new Error('原始会话仅支持串口链路')
    }

    const generation = this.connectionGeneration
    const state: RawSessionState = {
      generation,
      active: true,
      dataListeners: new Set(),
      abortedListeners: new Set(),
      handle: undefined as unknown as RawSessionHandle,
    }
    const handle: RawSessionHandle = {
      write: (data: Buffer): boolean => {
        if (!state.active || this.rawSession !== state) return false
        if (!this.link || this._status !== 'connected') return false
        return this.link.write(data, 'high') !== false
      },
      onData: (listener: (data: Buffer) => void): (() => void) => {
        state.dataListeners.add(listener)
        return () => state.dataListeners.delete(listener)
      },
      onAborted: (listener: (reason: string) => void): (() => void) => {
        state.abortedListeners.add(listener)
        return () => state.abortedListeners.delete(listener)
      },
      release: (): void => {
        if (this.rawSession !== state || !state.active) return
        state.active = false
        this.rawSession = null
        this.emit('rawSessionChange', false)
        // Restore the MAVLink heartbeat monitor but keep vehicleReady false:
        // only a freshly validated autopilot heartbeat may raise it (ADR-005).
        if (this.link && this._transportOpen && this._status === 'connected') {
          this.startHeartbeatMonitor(false)
        }
      },
    }
    state.handle = handle
    this.rawSession = state
    this.stopHeartbeatMonitor()
    this.setVehicleReady(false)
    this.emit('rawSessionChange', true)
    return handle
  }

  private deliverRawData(data: Buffer): void {
    const state = this.rawSession
    if (!state) return
    for (const listener of [...state.dataListeners]) {
      try {
        listener(data)
      } catch (error) {
        console.error('[Connection] raw session data listener threw:', error)
      }
    }
  }

  /**
   * Invalidate a raw session when the underlying link goes away. Fires
   * onAborted so the ESC transport can finalize; teardown owns the monitor,
   * so unlike release() this does not restart the heartbeat monitor.
   */
  private abortRawSession(reason: string): void {
    const state = this.rawSession
    if (!state || !state.active) return
    state.active = false
    this.rawSession = null
    this.emit('rawSessionChange', false)
    for (const listener of [...state.abortedListeners]) {
      try {
        listener(reason)
      } catch (error) {
        console.error('[Connection] raw session aborted listener threw:', error)
      }
    }
  }

  /**
   * Called only for a validated HEARTBEAT from the selected autopilot.
   * Transport readiness remains separate so Bridge can parse before this point.
   */
  notifyAutopilotHeartbeat(): void {
    if (
      !this.link
      || this.cleanupGeneration === this.connectionGeneration
      || !this._transportOpen
      || this._status !== 'connected'
    ) return

    const now = this.monotonicNow()
    this.lastHeartbeat = now
    this.lastMavlinkActivity = now
    this.heartbeatTimeoutFired = false
    const staleRebootHeartbeat = this.isExpectedVehicleReboot()
      && !this.rebootInterruptionObserved
      && now - this.expectedRebootStartedAt < REBOOT_STALE_HEARTBEAT_GUARD_MS
    if (
      !this.isExpectedVehicleReboot()
      || this.rebootInterruptionObserved
      || now - this.expectedRebootStartedAt >= REBOOT_STALE_HEARTBEAT_GUARD_MS
    ) {
      this.cancelExpectedVehicleReboot()
    }
    if (this._lastError?.phase === 'heartbeat' || this._lastError?.phase === 'reconnect') {
      this.setLastError(null)
    }
    // A final heartbeat can arrive after the reboot command has already been
    // queued. Keep readiness down during the short guard window so that stale
    // pre-reboot traffic cannot make the UI look live again prematurely.
    if (!staleRebootHeartbeat) {
      this.setVehicleReady(true)
      if (this.linkKind === 'bluetooth') {
        ;(this.link as ManagedBluetoothLink).confirmVehicleHeartbeat()
      }
    }
  }

  /**
   * Mark a deliberate FC reboot so a transient USB/serial disappearance is
   * recovered without user interaction. The window is finite and an explicit
   * disconnect or manual connect cancels it.
   */
  expectVehicleReboot(graceMs = this.rebootReconnectGraceMs): boolean {
    if (!this.link || !this._config || !this._transportOpen || this._status !== 'connected') {
      return false
    }
    this.cancelExpectedVehicleReboot()
    const now = this.monotonicNow()
    this.expectedRebootStartedAt = now
    this.expectedRebootUntil = now + Math.max(1, graceMs)
    this.rebootInterruptionObserved = false
    this.rebootReconnectAttempt = 0
    this.rebootReconnectToken += 1
    // The reboot command itself is sufficient to invalidate physical vehicle
    // readiness even if USB keeps the COM port open throughout the restart.
    // A fresh heartbeat after the stale-heartbeat guard raises it again.
    this.setVehicleReady(false)
    return true
  }

  /** Called for every valid frame from the selected autopilot. */
  notifyAutopilotActivity(): void {
    if (
      !this.link
      || this.cleanupGeneration === this.connectionGeneration
      || !this._transportOpen
      || this._status !== 'connected'
    ) return
    this.lastMavlinkActivity = this.monotonicNow()
  }

  private wireLink(
    link: ManagedLink,
    generation: number,
    kind: ConnectionConfig['type'],
  ): void {
    const handlers: LinkHandlers = {
      link,
      generation,
      onData: (data: Buffer) => {
        if (!this.isActive(link, generation)) return
        this._bytesReceived += data.length
        if (this.cleanupGeneration === generation) return
        if (!this._transportOpen || this._status !== 'connected') {
          if (this._status === 'connecting' || this._status === 'reconnecting') {
            this.bufferPreTransportData(data)
          }
          return
        }
        // In a raw ESC session, bytes belong to the ESC protocol, not MAVLink.
        if (this.rawSession?.active && this.rawSession.generation === generation) {
          this.deliverRawData(data)
          return
        }
        this.emit('data', data)
      },
      onDataSent: (count: number) => {
        if (this.isActive(link, generation)) this._bytesSent += count
      },
      onOverflow: (details: unknown) => {
        if (this.isActive(link, generation)) this.emit('writeOverflow', details)
      },
      onDisconnected: () => {
        if (!this.isActive(link, generation) || this.cleanupGeneration === generation) return
        this.scheduleSpontaneousCleanup(link, generation, 'disconnected')
      },
      onError: (error: Error) => {
        if (!this.isActive(link, generation) || this.cleanupGeneration === generation) return
        if (kind === 'bluetooth') {
          if (!this._reconnectTerminalReason) {
            this.setLastError(this.errorDetail('reconnect', error.message, error))
          }
          this.emit('connectionError', error)
          return
        }
        this.scheduleSpontaneousCleanup(link, generation, 'error', error)
      },
      onDiagnostic: (details: unknown) => {
        if (this.isActive(link, generation)) this.emit('diagnostic', details)
      },
    }

    if (kind === 'bluetooth') {
      const bluetooth = link as ManagedBluetoothLink
      handlers.onTransportConnected = () => this.onLinkTransportConnected(link, generation)
      handlers.onConnected = () => this.onLinkTransportConnected(link, generation)
      handlers.onTransportDisconnected = () => {
        if (!this.isActive(link, generation) || this.cleanupGeneration === generation) return
        this.stopHeartbeatMonitor()
        this.clearPreTransportData()
        this.setVehicleReady(false)
        this.setTransportOpen(false)
        this.setStatus('reconnecting')
      }
      handlers.onReconnecting = (progress) => {
        if (!this.isActive(link, generation) || this.cleanupGeneration === generation) return
        this._reconnect = progress
        this.stopHeartbeatMonitor()
        this.clearPreTransportData()
        this.setVehicleReady(false)
        this.setTransportOpen(false)
        this.setStatus('reconnecting')
      }
      handlers.onTerminal = (reason) => {
        if (!this.isActive(link, generation) || this.cleanupGeneration === generation) return
        this._reconnectTerminalReason = reason
        this.setLastError(this.errorDetail('reconnect', reason.message, { code: reason.code }))
        this.stopHeartbeatMonitor()
        this.clearPreTransportData()
        this.setTransportOpen(false)
        this.scheduleSpontaneousCleanup(link, generation, 'error')
      }
      handlers.onVehicleReadyChange = (ready) => {
        if (!this.isActive(link, generation) || this.cleanupGeneration === generation) return
        if (ready && (!this._transportOpen || this._status !== 'connected')) return
        this.setVehicleReady(ready)
      }
      bluetooth.on('transportConnected', handlers.onTransportConnected)
      bluetooth.on('connected', handlers.onConnected)
      bluetooth.on('transportDisconnected', handlers.onTransportDisconnected)
      bluetooth.on('reconnecting', handlers.onReconnecting)
      bluetooth.on('terminal', handlers.onTerminal)
      bluetooth.on('vehicleReadyChange', handlers.onVehicleReadyChange)
    }

    link.on('data', handlers.onData)
    link.on('dataSent', handlers.onDataSent)
    link.on('overflow', handlers.onOverflow)
    link.on('disconnected', handlers.onDisconnected)
    link.on('error', handlers.onError)
    link.on('diagnostic', handlers.onDiagnostic)
    this.linkHandlers = handlers
  }

  private detachLinkHandlers(handlers: LinkHandlers): void {
    const { link } = handlers
    link.off('data', handlers.onData)
    link.off('dataSent', handlers.onDataSent)
    link.off('overflow', handlers.onOverflow)
    link.off('disconnected', handlers.onDisconnected)
    link.off('error', handlers.onError)
    link.off('diagnostic', handlers.onDiagnostic)
    if (handlers.onTransportConnected) {
      link.off('transportConnected', handlers.onTransportConnected)
    }
    if (handlers.onConnected) link.off('connected', handlers.onConnected)
    if (handlers.onTransportDisconnected) {
      link.off('transportDisconnected', handlers.onTransportDisconnected)
    }
    if (handlers.onReconnecting) link.off('reconnecting', handlers.onReconnecting)
    if (handlers.onTerminal) link.off('terminal', handlers.onTerminal)
    if (handlers.onVehicleReadyChange) {
      link.off('vehicleReadyChange', handlers.onVehicleReadyChange)
    }
    if (this.linkHandlers === handlers) this.linkHandlers = null
  }

  private onLinkTransportConnected(link: ManagedLink, generation: number): void {
    if (!this.isActive(link, generation) || this.cleanupGeneration === generation) return
    if (this._transportOpen && this._status === 'connected') return
    if (this.linkKind === 'bluetooth' && this._config) {
      this._config = {
        ...this._config,
        port: (link as ManagedBluetoothLink).resolvedPort,
      }
    }

    this._reconnect = null
    this._reconnectTerminalReason = null
    this.heartbeatTimeoutFired = false
    this.setTransportOpen(true)
    this.setVehicleReady(false)
    this.setStatus('connected')
    this.startHeartbeatMonitor(this._vehicleReady)
    this.flushPreTransportData(link, generation)
  }

  /**
   * A native serial binding may deliver bytes immediately before its connect
   * promise resumes. Hold those bytes until statusChange('connected') has
   * synchronously reset the MAVLink session, then replay them in order.
   */
  private bufferPreTransportData(data: Buffer): void {
    const chunk = Buffer.from(data)
    let droppedBytes = 0

    if (chunk.length >= MAX_PRE_TRANSPORT_DATA_BYTES) {
      droppedBytes = this.preTransportDataBytes
        + chunk.length
        - MAX_PRE_TRANSPORT_DATA_BYTES
      this.preTransportData = [
        Buffer.from(chunk.subarray(chunk.length - MAX_PRE_TRANSPORT_DATA_BYTES)),
      ]
      this.preTransportDataBytes = MAX_PRE_TRANSPORT_DATA_BYTES
    } else {
      while (
        this.preTransportData.length > 0
        && this.preTransportDataBytes + chunk.length > MAX_PRE_TRANSPORT_DATA_BYTES
      ) {
        const dropped = this.preTransportData.shift()
        if (dropped) {
          this.preTransportDataBytes -= dropped.length
          droppedBytes += dropped.length
        }
      }
      this.preTransportData.push(chunk)
      this.preTransportDataBytes += chunk.length
    }

    if (droppedBytes > 0) {
      this.emit('diagnostic', {
        kind: 'preTransportDataOverflow',
        droppedBytes,
        bufferedBytes: this.preTransportDataBytes,
      })
    }
  }

  private clearPreTransportData(): void {
    this.preTransportData = []
    this.preTransportDataBytes = 0
  }

  private flushPreTransportData(link: ManagedLink, generation: number): void {
    const buffered = this.preTransportData
    this.clearPreTransportData()
    for (const data of buffered) {
      if (
        !this.isActive(link, generation)
        || !this._transportOpen
        || this._status !== 'connected'
      ) return
      this.emit('data', data)
    }
  }

  private scheduleSpontaneousCleanup(
    link: ManagedLink,
    generation: number,
    terminalStatus: 'disconnected' | 'error',
    error?: Error,
  ): void {
    if (this.scheduledCleanupGenerations.has(generation)) return
    const rebootToken = this.rebootReconnectToken
    const rebootConfig = this.isExpectedVehicleReboot()
      && this.linkKind === 'serial'
      && this._config
      ? { ...this._config }
      : null
    if (rebootConfig) this.rebootInterruptionObserved = true
    this.scheduledCleanupGenerations.add(generation)
    if (error) {
      this.setLastError(this.errorDetail('runtime', error.message, error))
      this.emit('connectionError', error)
    }
    this.prepareForTeardown(terminalStatus)
    void this.enqueueOperation(async () => {
      try {
        if (!this.isActive(link, generation)) return
        await this.awaitActiveLinkCleanup(link, generation)
      } catch (cleanupError) {
        const failure = this.toError(cleanupError)
        this.setLastError(this.errorDetail('disconnect', failure.message, failure))
        this.setStatus('error')
        this.emit('connectionError', failure)
      } finally {
        this.scheduledCleanupGenerations.delete(generation)
      }
    }).then(() => {
      if (rebootConfig) this.scheduleVehicleRebootReconnect(rebootConfig, rebootToken)
    }).catch((queueError) => {
      this.scheduledCleanupGenerations.delete(generation)
      this.emit('connectionError', this.toError(queueError))
    })
  }

  private async cleanupActiveLink(link: ManagedLink, generation: number): Promise<void> {
    if (!this.isActive(link, generation)) return
    this.cleanupGeneration = generation
    this.abortRawSession('link_lost')
    this.stopHeartbeatMonitor()
    this.clearPreTransportData()
    this.setVehicleReady(false)
    this.setTransportOpen(false)
    this._reconnect = null
    try {
      await link.disconnect()
    } catch (error) {
      throw this.toError(error)
    } finally {
      this.cleanupGeneration = null
    }

    if (!this.isActive(link, generation)) return
    if (this.linkHandlers?.link === link) this.detachLinkHandlers(this.linkHandlers)
    this.link = null
  }

  private beginActiveLinkCleanup(link: ManagedLink, generation: number): Promise<void> {
    if (
      this.activeCleanup?.link === link
      && this.activeCleanup.generation === generation
    ) return this.activeCleanup.promise

    const promise = this.cleanupActiveLink(link, generation)
    this.activeCleanup = { link, generation, promise }
    void promise.then(
      () => {
        if (this.activeCleanup?.promise === promise) this.activeCleanup = null
      },
      () => undefined,
    )
    return promise
  }

  private async awaitActiveLinkCleanup(link: ManagedLink, generation: number): Promise<void> {
    const promise = this.beginActiveLinkCleanup(link, generation)
    try {
      await promise
    } finally {
      if (
        this.activeCleanup?.link === link
        && this.activeCleanup.generation === generation
        && this.activeCleanup.promise === promise
      ) this.activeCleanup = null
    }
  }

  private startHeartbeatMonitor(preserveHeartbeat: boolean): void {
    this.stopHeartbeatMonitor()
    const now = this.monotonicNow()
    if (!preserveHeartbeat) this.lastHeartbeat = now
    this.lastMavlinkActivity = preserveHeartbeat ? this.lastMavlinkActivity : now
    this.heartbeatTimeoutFired = false
    this.heartbeatTimer = this.setIntervalFn(
      () => this.checkHeartbeatLiveness(),
      this.heartbeatCheckIntervalMs,
    )
  }

  private checkHeartbeatLiveness(): void {
    if (!this._transportOpen || this._status !== 'connected') return
    const now = this.monotonicNow()
    const bluetooth = this.linkKind === 'bluetooth'
    const softDeadline = bluetooth
      ? this.bluetoothSoftHeartbeatTimeoutMs
      : this.serialSoftHeartbeatTimeoutMs
    const hardDeadline = bluetooth
      ? this.bluetoothHardHeartbeatTimeoutMs
      : this.serialHardHeartbeatTimeoutMs
    const heartbeatAge = now - this.lastHeartbeat
    const activityAge = now - this.lastMavlinkActivity
    const softExpiredWithoutActivity = heartbeatAge > softDeadline
      && activityAge > this.activityGraceMs
    const hardExpired = heartbeatAge > hardDeadline
    if (!softExpiredWithoutActivity && !hardExpired) return
    if (this.heartbeatTimeoutFired) return

    if (this.isExpectedVehicleReboot() && this.link) {
      this.heartbeatTimeoutFired = true
      this.rebootInterruptionObserved = true
      this.setVehicleReady(false)
      if (bluetooth) {
        ;(this.link as ManagedBluetoothLink).forceReconnect('飞控重启后等待重新连接')
      } else {
        this.scheduleSpontaneousCleanup(
          this.link,
          this.connectionGeneration,
          'disconnected',
        )
      }
      return
    }

    this.heartbeatTimeoutFired = true
    this.setVehicleReady(false)
    const reason = hardExpired
      ? `飞控心跳超过硬期限 ${Math.round(hardDeadline)}ms`
      : `飞控心跳超时且 ${Math.round(activityAge)}ms 内无有效 MAVLink 活动`
    const error = new Error(reason)
    this.setLastError(this.errorDetail('heartbeat', reason, error))
    console.warn(
      `[Connection] MAVLink timeout: heartbeat=${Math.round(heartbeatAge)}ms`
      + ` activity=${Math.round(activityAge)}ms type=${this.linkKind ?? 'unknown'}`
      + ` hard=${hardExpired}`,
    )
    this.emit('heartbeatTimeout', {
      heartbeatAge,
      activityAge,
      hardExpired,
    })

    if (bluetooth && this.link) {
      ;(this.link as ManagedBluetoothLink).forceReconnect(reason)
    } else if (this.link) {
      this.emit('connectionError', error)
      this.scheduleSpontaneousCleanup(
        this.link,
        this.connectionGeneration,
        'disconnected',
      )
    }
  }

  private stopHeartbeatMonitor(): void {
    if (!this.heartbeatTimer) return
    this.clearIntervalFn(this.heartbeatTimer)
    this.heartbeatTimer = null
  }

  private isExpectedVehicleReboot(): boolean {
    return this.expectedRebootUntil > this.monotonicNow()
  }

  private scheduleVehicleRebootReconnect(config: ConnectionConfig, token: number): void {
    if (token !== this.rebootReconnectToken || !this.isExpectedVehicleReboot()) return
    if (this.rebootReconnectTimer) return
    if (this.rebootReconnectAttempt >= this.rebootReconnectMaxAttempts) {
      this.cancelExpectedVehicleReboot()
      return
    }
    this.rebootReconnectAttempt += 1
    const delayMs = this.rebootReconnectDelayMs
    this._reconnect = {
      attempt: this.rebootReconnectAttempt,
      maxAttempts: this.rebootReconnectMaxAttempts,
      delayMs,
      ...(this._lastError?.message ? { lastError: this._lastError.message } : {}),
    }
    this.setStatus('reconnecting')
    this.rebootReconnectTimer = setTimeout(() => {
      this.rebootReconnectTimer = null
      if (token !== this.rebootReconnectToken || !this.isExpectedVehicleReboot()) return
      void this.connect(config, true).catch(() => {
        if (token === this.rebootReconnectToken && this.isExpectedVehicleReboot()) {
          this.scheduleVehicleRebootReconnect(config, token)
        }
      })
    }, delayMs)
    this.rebootReconnectTimer.unref?.()
  }

  private cancelExpectedVehicleReboot(): void {
    if (this.rebootReconnectTimer) {
      clearTimeout(this.rebootReconnectTimer)
      this.rebootReconnectTimer = null
    }
    this.expectedRebootUntil = 0
    this.expectedRebootStartedAt = 0
    this.rebootInterruptionObserved = false
    this.rebootReconnectAttempt = 0
    this.rebootReconnectToken += 1
    this._reconnect = null
  }

  private prepareForTeardown(status: ConnectionStatus): void {
    this.abortRawSession('link_lost')
    this.stopHeartbeatMonitor()
    this.clearPreTransportData()
    this.setVehicleReady(false)
    this.setTransportOpen(false)
    this._reconnect = null
    this.setStatus(status)
  }

  private setStatus(status: ConnectionStatus, force = false): void {
    if (this._status === status && !force) return
    this._status = status
    this.emit('statusChange', status)
  }

  private setTransportOpen(open: boolean): void {
    if (!open) this.setVehicleReady(false)
    if (this._transportOpen === open) return
    this._transportOpen = open
    this.emit('transportChange', open)
  }

  private setVehicleReady(ready: boolean): void {
    const effectiveReady = ready && this._transportOpen
    if (this._vehicleReady === effectiveReady) return
    this._vehicleReady = effectiveReady
    this.emit('vehicleReadyChange', effectiveReady)
  }

  private setLastError(error: ConnectionErrorDetail | null): void {
    this._lastError = error
    this.emit('errorDetailChange', error)
  }

  private enqueueOperation(operation: () => Promise<void>): Promise<void> {
    const queued = this.pendingOp.then(operation, operation)
    this.pendingOp = queued
    return queued
  }

  private isActive(link: ManagedLink, generation: number): boolean {
    return this.link === link && this.connectionGeneration === generation
  }

  private isConnectRequestCancelled(requestId: number): boolean {
    return requestId <= this.cancelConnectThrough
  }

  private connectionCancelledError(): Error {
    const error = new Error('连接请求已取消') as Error & { code?: string }
    error.code = 'ECANCELED'
    return error
  }

  private errorDetail(
    phase: ConnectionErrorPhase,
    message: string,
    error?: unknown,
  ): ConnectionErrorDetail {
    const possibleCode = typeof error === 'object'
      && error !== null
      && 'code' in error
      ? (error as { code?: unknown }).code
      : undefined
    const code = typeof possibleCode === 'string' ? possibleCode : undefined
    return {
      phase,
      message,
      ...(code ? { code } : {}),
      timestamp: this.wallClock(),
    }
  }

  private translateBluetoothOpenError(
    error: Error,
    config: ConnectionConfig,
  ): Error {
    if (
      config.type === 'bluetooth'
      && /(?:code 121|semaphore timeout)/i.test(error.message)
    ) {
      return new Error(
        `蓝牙设备未响应（${this._config?.port ?? config.port}）。`
        + '请确认选择的是飞控对应端口、飞控已上电且未被其他软件连接。',
      )
    }
    return error
  }

  private toError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error))
  }
}
