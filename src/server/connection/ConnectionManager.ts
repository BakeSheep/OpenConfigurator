import { EventEmitter } from 'events'
import { SerialConnection } from './SerialConnection'
import { BluetoothConnection } from './BluetoothConnection'
import type { ConnectionConfig, ConnectionStatus, PortInfo } from '../../shared/types'

export class ConnectionManager extends EventEmitter {
  private serialConn: SerialConnection | null = null
  private btConn: BluetoothConnection | null = null
  private _status: ConnectionStatus = 'disconnected'
  private _config: ConnectionConfig | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private lastHeartbeat = 0

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
    if (this._status === 'connected') {
      await this.disconnect()
    }

    this.setStatus('connecting')
    this._config = config

    try {
      // For Bluetooth, resolve the device chosen via the browser-side Web
      // Serial chooser back to a Windows SPP COM port before opening.
      let portPath = config.port
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
        this.lastHeartbeat = Date.now()
        this.emit('data', data)
      })

      this.serialConn.on('disconnected', () => {
        this.setStatus('disconnected')
        this.stopHeartbeatMonitor()
      })

      this.serialConn.on('error', (err: Error) => {
        this.setStatus('error')
        this.emit('error', err)
      })

      await this.serialConn.connect(portPath, config.baudRate)
      this.setStatus('connected')
      this.startHeartbeatMonitor()
    } catch (err) {
      this.setStatus('error')
      throw err
    }
  }

  async disconnect(): Promise<void> {
    this.stopHeartbeatMonitor()
    if (this.serialConn) {
      await this.serialConn.disconnect()
      this.serialConn = null
    }
    this._config = null
    this.setStatus('disconnected')
  }

  write(data: Buffer): void {
    if (this.serialConn && this._status === 'connected') {
      this.serialConn.write(data)
    }
  }

  private startHeartbeatMonitor() {
    this.lastHeartbeat = Date.now()
    this.heartbeatTimer = setInterval(() => {
      if (Date.now() - this.lastHeartbeat > 5000) {
        this.emit('heartbeatTimeout')
      }
    }, 2000)
  }

  private stopHeartbeatMonitor() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }
}
