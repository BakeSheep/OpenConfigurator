import type { BrowserConnectionOptions, BrowserPortDescriptor } from '../../shared/localRuntime'
import type { ConnectionConfig } from '../../shared/types'

type Priority = 'normal' | 'high' | 'critical'
type QueueEntry = { data: Uint8Array; priority: Priority; queueTag?: string; resolve: (accepted: boolean) => void }

const PRIORITY: Record<Priority, number> = { normal: 0, high: 1, critical: 2 }
const MAX_QUEUED_BYTES = 512 * 1024
const STREAM_CLOSE_TIMEOUT_MS = 250

async function settleWithin(promise: Promise<unknown> | undefined, timeoutMs = STREAM_CLOSE_TIMEOUT_MS): Promise<void> {
  if (!promise) return
  await Promise.race([
    promise.catch(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ])
}

function bluetoothId(info: SerialPortInfo): string | undefined {
  const value = info.bluetoothServiceClassId
  return value === undefined ? undefined : String(value)
}

export class WebSerialTransport {
  private readonly descriptorNamespace = crypto.randomUUID()
  private readonly ports = new Map<string, SerialPort>()
  private readonly ids = new WeakMap<SerialPort, string>()
  private nextPortId = 0
  private port: SerialPort | null = null
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null
  private queue: QueueEntry[] = []
  private queuedBytes = 0
  private draining = false
  private closing = false
  private reconnecting = false
  private activeOptions: BrowserConnectionOptions | null = null
  private onBytes: ((data: ArrayBuffer) => void) | null = null
  private onClosed: ((reason: string) => void) | null = null
  private onReopened: ((config: ConnectionConfig) => void) | null = null

  constructor(private readonly reconnectDelayMs = (attempt: number) => Math.min(5_000, 250 * 2 ** attempt)) {}

  get supported(): boolean {
    return typeof navigator !== 'undefined' && 'serial' in navigator
  }

  async listAuthorizedPorts(): Promise<BrowserPortDescriptor[]> {
    const serial = navigator.serial
    if (!this.supported || !serial) return []
    const ports = await serial.getPorts()
    return Promise.all(ports.map((port) => this.describe(port, true)))
  }

  async requestPort(): Promise<BrowserPortDescriptor> {
    const serial = navigator.serial
    if (!this.supported || !serial) throw new Error('当前浏览器不支持 Web Serial')
    const port = await serial.requestPort()
    return this.describe(port, true)
  }

  async open(
    options: BrowserConnectionOptions,
    handlers: {
      onBytes: (data: ArrayBuffer) => void
      onClosed: (reason: string) => void
      onReopened?: (config: ConnectionConfig) => void
    },
  ): Promise<ConnectionConfig> {
    const port = this.ports.get(options.portId)
    if (!port) throw new Error('设备授权已失效，请重新选择串口')
    await this.close(false)
    this.closing = false
    this.port = port
    this.activeOptions = options
    this.onBytes = handlers.onBytes
    this.onClosed = handlers.onClosed
    this.onReopened = handlers.onReopened ?? null
    await port.open({ baudRate: options.baudRate, bufferSize: 65_536 })
    if (!port.readable || !port.writable) {
      await port.close().catch(() => undefined)
      throw new Error('串口没有可用的读写数据流')
    }
    this.reader = port.readable.getReader()
    this.writer = port.writable.getWriter()
    void this.readLoop()
    return this.connectionConfig(port, options)
  }

  write(data: ArrayBuffer, priority: Priority, queueTag?: string): Promise<boolean> {
    const bytes = new Uint8Array(data)
    if (!this.writer || this.closing || this.queuedBytes + bytes.byteLength > MAX_QUEUED_BYTES) {
      return Promise.resolve(false)
    }
    return new Promise((resolve) => {
      this.queue.push({ data: bytes, priority, queueTag, resolve })
      this.queuedBytes += bytes.byteLength
      this.queue.sort((a, b) => PRIORITY[b.priority] - PRIORITY[a.priority])
      void this.drain()
    })
  }

  cancelQueued(queueTag: string): number {
    let cancelled = 0
    this.queue = this.queue.filter((entry) => {
      if (entry.queueTag !== queueTag) return true
      this.queuedBytes -= entry.data.byteLength
      entry.resolve(false)
      cancelled += 1
      return false
    })
    return cancelled
  }

  async close(notify = true): Promise<void> {
    if (this.closing) return
    this.closing = true
    this.rejectQueuedWrites()
    this.reconnecting = false
    await this.closeStreams()
    const notifyClosed = this.onClosed
    this.port = null
    this.activeOptions = null
    if (notify) notifyClosed?.('user_disconnect')
    this.onBytes = null
    this.onClosed = null
    this.onReopened = null
  }

  private async describe(port: SerialPort, granted: boolean): Promise<BrowserPortDescriptor> {
    let id = this.ids.get(port)
    if (!id) {
      id = `local-port-${++this.nextPortId}`
      this.ids.set(port, id)
      this.ports.set(id, port)
    }
    const info = await port.getInfo()
    const bluetoothServiceClassId = bluetoothId(info)
    const usb = info.usbVendorId === undefined
      ? ''
      : `USB ${info.usbVendorId.toString(16).toUpperCase().padStart(4, '0')}:${(info.usbProductId ?? 0).toString(16).toUpperCase().padStart(4, '0')}`
    return {
      id,
      deviceId: `webserial:${this.descriptorNamespace}:${id}`,
      granted,
      usbVendorId: info.usbVendorId,
      usbProductId: info.usbProductId,
      bluetoothServiceClassId,
      label: bluetoothServiceClassId ? `Bluetooth SPP ${bluetoothServiceClassId}` : usb || `Serial ${id}`,
    }
  }

  private async connectionConfig(port: SerialPort, options: BrowserConnectionOptions): Promise<ConnectionConfig> {
    const descriptor = await this.describe(port, true)
    return {
      type: options.type,
      port: descriptor.label,
      baudRate: options.baudRate,
      vendorId: descriptor.usbVendorId?.toString(16).toUpperCase().padStart(4, '0'),
      productId: descriptor.usbProductId?.toString(16).toUpperCase().padStart(4, '0'),
      bluetoothServiceClassId: descriptor.bluetoothServiceClassId,
    }
  }

  private async drain(): Promise<void> {
    if (this.draining) return
    this.draining = true
    try {
      while (this.writer && this.queue.length) {
        const entry = this.queue.shift()!
        this.queuedBytes -= entry.data.byteLength
        try {
          await this.writer.ready
          await this.writer.write(entry.data)
          entry.resolve(true)
        } catch {
          entry.resolve(false)
          await this.fail('serial_write_failed')
          break
        }
      }
    } finally {
      this.draining = false
    }
  }

  private async readLoop(): Promise<void> {
    try {
      while (this.reader && !this.closing) {
        const { value, done } = await this.reader.read()
        if (done) break
        if (!value?.byteLength) continue
        const copy = value.slice().buffer
        this.onBytes?.(copy)
      }
      if (!this.closing) await this.fail('serial_stream_closed')
    } catch (error) {
      if (!this.closing) await this.fail(error instanceof Error ? error.message : 'serial_read_failed')
    }
  }

  private async fail(reason: string): Promise<void> {
    const port = this.port
    const options = this.activeOptions
    const notify = this.onClosed
    // Queued bytes belong to the failed link generation. Replaying them after
    // an in-tab Bluetooth reconnect could execute stale vehicle commands.
    this.rejectQueuedWrites()
    await this.closeStreams()
    notify?.(reason)
    if (!port || options?.type !== 'bluetooth' || this.closing || this.reconnecting) return
    this.reconnecting = true
    for (let attempt = 0; attempt < 6 && this.reconnecting && !this.closing; attempt++) {
      await new Promise<void>((resolve) => setTimeout(resolve, this.reconnectDelayMs(attempt)))
      try {
        await port.open({ baudRate: options.baudRate, bufferSize: 65_536 })
        if (!port.readable || !port.writable) throw new Error('reopened port has no streams')
        this.reader = port.readable.getReader()
        this.writer = port.writable.getWriter()
        this.reconnecting = false
        this.closing = false
        this.onReopened?.(await this.connectionConfig(port, options))
        void this.readLoop()
        return
      } catch {
        await port.close().catch(() => undefined)
      }
    }
    this.reconnecting = false
    this.port = null
    this.activeOptions = null
  }

  private async closeStreams(): Promise<void> {
    const reader = this.reader
    const writer = this.writer
    const port = this.port
    this.reader = null
    this.writer = null
    await Promise.all([
      settleWithin(reader?.cancel()),
      settleWithin(writer?.close()),
    ])
    try { reader?.releaseLock() } catch { /* A timed-out stream still owns its lock. */ }
    try { writer?.releaseLock() } catch { /* A timed-out stream still owns its lock. */ }
    await settleWithin(port?.close())
  }

  private rejectQueuedWrites(): void {
    for (const entry of this.queue.splice(0)) entry.resolve(false)
    this.queuedBytes = 0
  }
}
