import { SerialPort } from 'serialport'
import { EventEmitter } from 'events'
import type { PortInfo } from '../../shared/types'

export class SerialConnection extends EventEmitter {
  private port: SerialPort | null = null
  private _connected = false

  get connected() {
    return this._connected
  }

  static async listPorts(): Promise<PortInfo[]> {
    const ports = await SerialPort.list()
    return ports.map((p) => ({
      path: p.path,
      manufacturer: p.manufacturer,
      productId: p.productId,
      vendorId: p.vendorId,
      pnpId: p.pnpId,
    }))
  }

  async connect(path: string, baudRate: number, timeoutMs = 5000): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false
      const timeout = setTimeout(() => {
        if (settled) return
        settled = true
        try { this.port?.close(() => {}) } catch { /* ignore */ }
        this.port = null
        reject(new Error(`打开串口 ${path} 超时（${Math.round(timeoutMs / 1000)}s）。端口可能被占用或设备无响应。`))
      }, timeoutMs)

      try {
        this.port = new SerialPort({
          path,
          baudRate,
          autoOpen: false,
        })

        this.port.on('open', () => {
          if (settled) return
          settled = true
          clearTimeout(timeout)
          this._connected = true
          this.emit('connected', { path, baudRate })
          resolve()
        })

        this.port.on('data', (data: Buffer) => {
          this.emit('data', data)
        })

        this.port.on('close', () => {
          this._connected = false
          this.emit('disconnected')
        })

        this.port.on('error', (err: Error) => {
          if (settled) {
            this._connected = false
            this.emit('error', err)
            return
          }
          settled = true
          clearTimeout(timeout)
          this._connected = false
          this.emit('error', err)
          reject(err)
        })

        this.port.open()
      } catch (err) {
        if (!settled) {
          settled = true
          clearTimeout(timeout)
        }
        reject(err)
      }
    })
  }

  async disconnect(): Promise<void> {
    return new Promise((resolve) => {
      if (this.port && this._connected) {
        this.port.close(() => {
          this._connected = false
          this.port = null
          resolve()
        })
      } else {
        this.port = null
        resolve()
      }
    })
  }

  write(data: Buffer): void {
    if (this.port && this._connected) {
      this.port.write(data)
    }
  }
}
