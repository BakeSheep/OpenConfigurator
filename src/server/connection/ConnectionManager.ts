import { EventEmitter } from 'events'
import { SerialConnection } from './SerialConnection'
import { BluetoothConnection } from './BluetoothConnection'
import type { ConnectionConfig, ConnectionStatus, PortInfo } from '../../shared/types'

// USB serial can use a tight heartbeat timeout. Bluetooth SPP at 57600 baud
// needs substantially more headroom: a ~1000-entry PARAM_VALUE stream alone
// occupies more than six seconds of wire time and may delay HEARTBEAT packets.
const SERIAL_HEARTBEAT_TIMEOUT_MS = 5000
const BLUETOOTH_HEARTBEAT_TIMEOUT_MS = 20000
const BLUETOOTH_ACTIVITY_TIMEOUT_MS = 8000
const HEARTBEAT_CHECK_INTERVAL_MS = 1000

export class ConnectionManager extends EventEmitter {
  private serialConn: SerialConnection | null = null
  private _status: ConnectionStatus = 'disconnected'
  private _config: ConnectionConfig | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private lastHeartbeat = 0
  private lastMavlinkActivity = 0
  // Guard against the timeout firing more than once per drop. Cleared on every
  // fresh connect so the next drop can fire again.
  private heartbeatTimeoutFired = false
  // Serialize connect/disconnect so concurrent browser requests cannot race
  // on serialConn assignment or COM-port ownership.
  private pendingOp: Promise<void> = Promise.resolve()

  get status() {
    return this._status
  }

  get config() {
    return this._config
  }

  private setStatus(status: ConnectionStatus) {
    this._status = status
    this.emit('statusChange', status)
  }

  async scanPorts(): Promise<{ serial: PortInfo[]; bluetooth: PortInfo[] }> {
    const serial = await SerialConnection.listPorts()
    const bluetooth = await BluetoothConnection.scanDevices()
    return { serial, bluetooth }
  }

  async connect(config: ConnectionConfig): Promise<void> {
    // Serialize: wait for any in-flight connect/disconnect to settle first.
    const run = async () => {
      // A failed/opening connection may still own the COM port. Always dispose
      // the previous instance before another attempt.
      if (this.serialConn) {
        // We are already executing inside pendingOp. Calling disconnect() here
        // would enqueue behind this connect() and then wait for itself forever.
        await this.cleanup()
      }

      this.setStatus('connecting')
      this._config = config
      let portPath = config.port

      try {
        // For Bluetooth, resolve the device chosen via the browser-side Web
        // Serial chooser back to a Windows SPP COM port before opening.
        if (config.type === 'bluetooth') {
          const resolved = await BluetoothConnection.findPortByIds({
            vendorId: config.vendorId,
            productId: config.productId,
            bluetoothServiceClassId: config.bluetoothServiceClassId,
            label: config.port,
          })
          if (!resolved) {
            throw new Error(`未找到蓝牙设备 "${config.port}" 对应的 SPP 串口。请确认设备已配对并启用 SPP 服务。`)
          }
          portPath = resolved
          // Store the resolved COM port so the UI shows it after connecting
          this._config = { ...config, port: portPath }
        }

        this.serialConn = new SerialConnection()

        this.serialConn.on('data', (data: Buffer) => {
          // NOTE: lastHeartbeat is now driven by autopilot HEARTBEAT msg #0
          // (see notifyAutopilotHeartbeat), NOT by raw serial bytes. A FC that
          // stops emitting heartbeats but still streams ATTITUDE will now be
          // correctly detected as a stale link.
          this.emit('data', data)
        })

        this.serialConn.on('disconnected', () => {
          void this.cleanup()
          this.setStatus('disconnected')
        })

        this.serialConn.on('error', (err: Error) => {
          void this.cleanup()
          this.setStatus('error')
          this.emit('connectionError', err)
        })

        await this.serialConn.connect(portPath, config.baudRate, config.type === 'bluetooth' ? 20000 : 5000)
        this.heartbeatTimeoutFired = false
        this.setStatus('connected')
        this.startHeartbeatMonitor()
      } catch (err) {
        await this.cleanup()
        this.setStatus('error')
        if (config.type === 'bluetooth' && err instanceof Error && /(?:code 121|semaphore timeout)/i.test(err.message)) {
          throw new Error(`蓝牙设备未响应（${portPath}）。请确认选择的是飞控对应端口、飞控已上电且未被其他软件连接。`)
        }
        throw err
      }
    }

    this.pendingOp = this.pendingOp.then(run, run)
    return this.pendingOp
  }

  async disconnect(): Promise<void> {
    const run = async () => {
      await this.cleanup()
      this._config = null
      if (this._status !== 'disconnected') {
        this.setStatus('disconnected')
      }
    }
    this.pendingOp = this.pendingOp.then(run, run)
    return this.pendingOp
  }

  // Shared teardown for both explicit disconnect and error/drop paths. Stops
  // the heartbeat monitor (so the timer stops firing into the void), nulls
  // serialConn so write() becomes a no-op, and closes the underlying port.
  private async cleanup(): Promise<void> {
    this.stopHeartbeatMonitor()
    const connection = this.serialConn
    if (!connection) return
    // Detach first so the port's close event cannot recursively enter cleanup
    // or overwrite the status of a newer connection attempt.
    this.serialConn = null
    connection.removeAllListeners()
    await connection.disconnect().catch(() => undefined)
  }

  write(data: Buffer): void {
    if (this.serialConn && this._status === 'connected') {
      this.serialConn.write(data)
    }
  }

  // Called by MavlinkBridge.handleHeartbeat whenever an autopilot HEARTBEAT
  // (msg #0) is received. This is the true application-layer liveness signal;
  // raw serial bytes are NOT sufficient because a FC can stall mid-stream.
  notifyAutopilotHeartbeat(): void {
    this.lastHeartbeat = Date.now()
    this.lastMavlinkActivity = this.lastHeartbeat
    this.heartbeatTimeoutFired = false
  }

  // Called for every successfully parsed MAVLink frame. On Bluetooth this is a
  // secondary liveness signal while a large parameter stream queues ahead of
  // the next HEARTBEAT. Invalid/raw serial noise never reaches this method.
  notifyAutopilotActivity(): void {
    this.lastMavlinkActivity = Date.now()
  }

  private startHeartbeatMonitor() {
    this.lastHeartbeat = Date.now()
    this.lastMavlinkActivity = this.lastHeartbeat
    this.heartbeatTimeoutFired = false
    this.heartbeatTimer = setInterval(() => {
      if (this._status !== 'connected') return
      const now = Date.now()
      const bluetooth = this._config?.type === 'bluetooth'
      const heartbeatTimeout = bluetooth
        ? BLUETOOTH_HEARTBEAT_TIMEOUT_MS
        : SERIAL_HEARTBEAT_TIMEOUT_MS
      const heartbeatStale = now - this.lastHeartbeat > heartbeatTimeout
      const activityStale = now - this.lastMavlinkActivity > BLUETOOTH_ACTIVITY_TIMEOUT_MS
      if (heartbeatStale && (!bluetooth || activityStale)) {
        if (this.heartbeatTimeoutFired) return
        this.heartbeatTimeoutFired = true
        console.warn(
          `[Connection] MAVLink timeout: heartbeat=${now - this.lastHeartbeat}ms`
          + ` activity=${now - this.lastMavlinkActivity}ms type=${this._config?.type ?? 'unknown'}`,
        )
        this.emit('heartbeatTimeout')
        // Auto-disconnect so the frontend is notified via the standard
        // statusChange('disconnected') -> WebSocket broadcast path.
        void this.disconnect().catch((err) => {
          console.error('[Connection] auto-disconnect after heartbeat timeout failed:', err)
        })
      }
    }, HEARTBEAT_CHECK_INTERVAL_MS)
  }

  private stopHeartbeatMonitor() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }
}
