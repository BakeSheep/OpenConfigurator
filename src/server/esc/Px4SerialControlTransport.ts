// PX4 MAVLink SERIAL_CONTROL ESC transport (ADR-003). Unlike the ArduPilot
// path, MAVLink is NOT paused: ESC bytes are tunneled through SERIAL_CONTROL
// (#126) frames while normal telemetry continues. The transport owns one
// active device (one ESC UART) at a time; the detector switches devices.
import {
  ESC_SERIAL_BAUD_RATE,
  PX4_ESC_SERIAL_CONTROL_DEVICE_MAX,
  PX4_ESC_SERIAL_CONTROL_DEVICE_MIN,
  SERIAL_CONTROL_FLAGS,
  SERIAL_CONTROL_MAX_DATA,
} from '../../shared/constants'
import { EscError, toEscError, type EscTransportCapabilities } from '../../shared/esc'
import type {
  EscByteTransport,
  EscTransactionOptions,
  EscTransportTarget,
} from './EscByteTransport'

/** Minimal SERIAL_CONTROL reply shape the transport consumes. */
export interface SerialControlReply {
  device: number
  flags: number
  count: number
  data: number[] | Uint8Array
}

/** Minimal MavlinkBridge surface this transport depends on. */
export interface SerialControlBridge {
  sendSerialControl(fields: {
    device: number
    flags: number
    timeout: number
    baudrate: number
    count: number
    data: Uint8Array
  }): boolean
  onSerialControl(listener: (message: SerialControlReply) => void): () => void
}

export interface Px4SerialControlTransportOptions {
  bridge: SerialControlBridge
  /**
   * Board/firmware capability preflight. Returns null when PX4 ESC
   * passthrough is available, or an EscError describing what to fix
   * (firmware unsupported, PASSTHRU_EN=0, board unsupported). Injected
   * because it reads parameters that live in higher layers.
   */
  preflight?: () => EscError | null
  /** Delay after device init before the first data frame (PX4 needs ~2s). */
  initSettleMs?: number
  capabilities?: EscTransportCapabilities
  waitFn?: (ms: number, signal: AbortSignal) => Promise<void>
}

const DEFAULT_CAPABILITIES: EscTransportCapabilities = {
  read: true,
  write: false,
}

const DEFAULT_INIT_SETTLE_MS = 2000

function defaultWait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new EscError('cancelled', 'ESC 会话已取消'))
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      reject(new EscError('cancelled', 'ESC 会话已取消'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export const MAX_RX_BUFFER_BYTES = 4096

export class Px4SerialControlTransport implements EscByteTransport {
  readonly kind = 'px4_serial_control' as const
  readonly capabilities: EscTransportCapabilities

  private readonly bridge: SerialControlBridge
  private readonly preflight: () => EscError | null
  private readonly initSettleMs: number
  private readonly waitFn: (ms: number, signal: AbortSignal) => Promise<void>
  private channels: number[] = []
  private activeDevice: number | null = null
  private offReply: (() => void) | null = null
  private closed = false
  private inFlight = false
  private readonly rxBuffer = new Uint8Array(MAX_RX_BUFFER_BYTES)
  private rxOffset = 0
  private failCurrent: ((error: EscError) => void) | null = null
  private pump: (() => void) | null = null
  private readonly abortedListeners = new Set<(error: EscError) => void>()

  constructor(options: Px4SerialControlTransportOptions) {
    this.bridge = options.bridge
    this.preflight = options.preflight ?? (() => null)
    this.initSettleMs = options.initSettleMs ?? DEFAULT_INIT_SETTLE_MS
    this.waitFn = options.waitFn ?? defaultWait
    this.capabilities = options.capabilities ?? DEFAULT_CAPABILITIES
  }

  /** Devices this transport may address (validated ESC channel range). */
  get availableChannels(): number[] {
    return [...this.channels]
  }

  /** Switch the ESC UART the next transact() talks to. */
  setActiveDevice(device: number): void {
    if (!this.channels.includes(device)) {
      throw new EscError('invalid_state', `设备 ${device} 不在本会话通道内`)
    }
    this.activeDevice = device
  }

  async open(target: EscTransportTarget, signal: AbortSignal): Promise<void> {
    if (target.mode !== 'px4_serial_control') {
      throw new EscError('invalid_state', 'PX4 传输不支持该模式')
    }
    if (target.channels.length === 0) {
      throw new EscError('validation_failed', '未指定 ESC 通道')
    }
    if (new Set(target.channels).size !== target.channels.length) {
      throw new EscError('validation_failed', 'ESC 通道包含重复项')
    }
    for (const device of target.channels) {
      if (
        !Number.isInteger(device)
        || device < PX4_ESC_SERIAL_CONTROL_DEVICE_MIN
        || device > PX4_ESC_SERIAL_CONTROL_DEVICE_MAX
      ) {
        throw new EscError(
          'validation_failed',
          `ESC 通道 ${device} 超出允许范围 `
          + `${PX4_ESC_SERIAL_CONTROL_DEVICE_MIN}-${PX4_ESC_SERIAL_CONTROL_DEVICE_MAX}`,
        )
      }
    }
    const preflightError = this.preflight()
    if (preflightError) throw preflightError
    if (signal.aborted) throw new EscError('cancelled', 'ESC 会话在建立期间被取消')

    this.channels = [...target.channels]
    this.activeDevice = this.channels[0]
    this.offReply = this.bridge.onSerialControl((reply) => {
      if (!this.inFlight || reply.device !== this.activeDevice) return
      // Only accept vehicle-originated data (REPLY flag set).
      if ((reply.flags & SERIAL_CONTROL_FLAGS.Reply) === 0) return
      const count = Math.min(reply.count, SERIAL_CONTROL_MAX_DATA)
      if (this.rxOffset + count > MAX_RX_BUFFER_BYTES) {
        this.failCurrent?.(new EscError('rx_overflow', '接收缓冲区溢出'))
        return
      }
      const data = reply.data
      for (let i = 0; i < count; i++) {
        this.rxBuffer[this.rxOffset + i] = data[i]
      }
      this.rxOffset += count
      this.pump?.()
    })

    // Initialize the target UART: count=0 opens the device at the ESC baud
    // rate and claims it exclusively.
    const initialized = this.bridge.sendSerialControl({
      device: this.activeDevice,
      flags: SERIAL_CONTROL_FLAGS.Respond | SERIAL_CONTROL_FLAGS.Exclusive,
      timeout: 0,
      baudrate: ESC_SERIAL_BAUD_RATE,
      count: 0,
      data: new Uint8Array(0),
    })
    if (!initialized) {
      this.offReply?.()
      this.offReply = null
      throw new EscError('link_unavailable', 'SERIAL_CONTROL 初始化发送失败')
    }
    await this.waitFn(this.initSettleMs, signal)
  }

  async transact(
    request: Uint8Array,
    options: EscTransactionOptions,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    if (this.closed) throw new EscError('link_lost', 'ESC 传输已关闭')
    if (this.activeDevice === null) throw new EscError('invalid_state', '未选择 ESC 设备')
    if (this.inFlight) throw new EscError('busy', 'ESC 传输已有请求在执行')
    if (signal.aborted) throw new EscError('cancelled', 'ESC 请求已取消')

    this.inFlight = true
    this.rxOffset = 0
    const device = this.activeDevice
    try {
      return await new Promise<Uint8Array>((resolve, reject) => {
        let settled = false
        const cleanup = () => {
          clearTimeout(timer)
          signal.removeEventListener('abort', onAbort)
          this.pump = null
          this.failCurrent = null
        }
        const finish = (value: Uint8Array) => {
          if (settled) return
          settled = true
          cleanup()
          resolve(value)
        }
        const fail = (error: EscError) => {
          if (settled) return
          settled = true
          cleanup()
          reject(error)
        }
        this.failCurrent = fail
        const onAbort = () => fail(new EscError('cancelled', 'ESC 请求已取消'))
        const timer = setTimeout(() => {
          fail(new EscError('timeout', `ESC 请求超时（${options.label ?? 'transact'}）`))
        }, options.timeoutMs)
        signal.addEventListener('abort', onAbort, { once: true })
        this.pump = () => {
          const buffered = this.rxBuffer.subarray(0, this.rxOffset)
          let length: number | null
          try {
            length = options.frameLength(buffered)
          } catch (error) {
            fail(toEscError(error, 'crc_mismatch'))
            return
          }
          if (length === null) return
          if (buffered.length < length) return
          finish(buffered.slice(0, length))
        }
        // Send the request in <=70-byte chunks; each asks for a response.
        for (let offset = 0; offset < request.length; offset += SERIAL_CONTROL_MAX_DATA) {
          const chunk = request.subarray(offset, offset + SERIAL_CONTROL_MAX_DATA)
          const ok = this.bridge.sendSerialControl({
            device,
            flags: SERIAL_CONTROL_FLAGS.Respond | SERIAL_CONTROL_FLAGS.Exclusive,
            timeout: 0,
            baudrate: ESC_SERIAL_BAUD_RATE,
            count: chunk.length,
            data: Uint8Array.from(chunk),
          })
          if (!ok) {
            fail(new EscError('link_lost', 'SERIAL_CONTROL 写入失败'))
            return
          }
        }
        if (request.length === 0) {
          // Poll for a response when there is nothing to send.
          this.bridge.sendSerialControl({
            device,
            flags: SERIAL_CONTROL_FLAGS.Respond | SERIAL_CONTROL_FLAGS.Exclusive,
            timeout: 0,
            baudrate: ESC_SERIAL_BAUD_RATE,
            count: 0,
            data: new Uint8Array(0),
          })
        }
        this.pump()
      })
    } finally {
      this.inFlight = false
      this.pump = null
      this.failCurrent = null
      this.rxOffset = 0
    }
  }

  async close(reason: string): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.offReply?.()
    this.offReply = null
    // SERIAL_CONTROL_FLAG_EXCLUSIVE is released only by sending a request
    // without that flag. Return every channel the session may have claimed.
    for (const device of this.channels) {
      this.bridge.sendSerialControl({
        device,
        flags: 0,
        timeout: 0,
        baudrate: ESC_SERIAL_BAUD_RATE,
        count: 0,
        data: new Uint8Array(0),
      })
    }
    this.channels = []
    this.activeDevice = null
    void reason
  }

  onAborted(listener: (error: EscError) => void): () => void {
    this.abortedListeners.add(listener)
    return () => this.abortedListeners.delete(listener)
  }

  /** Fire the aborted listeners (used when the MAVLink link is lost). */
  notifyAborted(error: EscError): void {
    for (const listener of [...this.abortedListeners]) {
      try {
        listener(error)
      } catch (err) {
        console.error('[ESC] PX4 transport aborted listener threw:', err)
      }
    }
  }
}
