// Direct USB half-duplex serial ESC transport (ADR-003). Talks to an AM32
// ESC over a single-wire adapter at 19200 baud with its own SerialConnection
// instance -- deliberately outside ConnectionManager, whose heartbeat/
// reconnect semantics are MAVLink-specific and would only cause spurious
// disconnects here. Single-wire means the ESC echoes back everything we send,
// so each transaction consumes its own echo before framing the response.
import { EventEmitter } from 'node:events'
import { ESC_SERIAL_BAUD_RATE } from '../../shared/constants'
import { EscError, toEscError, type EscTransportCapabilities } from '../../shared/esc'
import { SerialConnection } from '../connection/SerialConnection'
import type {
  EscByteTransport,
  EscTransactionOptions,
  EscTransportTarget,
} from './EscByteTransport'

/** Minimal serial-link surface (satisfied by SerialConnection). */
export interface DirectSerialLink extends EventEmitter {
  readonly connected: boolean
  connect(path: string, baudRate: number, timeoutMs?: number): Promise<void>
  disconnect(timeoutMs?: number): Promise<void>
  write(data: Buffer, priority?: 'normal' | 'high' | 'critical'): boolean
}

export interface DirectSerialTransportOptions {
  serialFactory?: () => DirectSerialLink
  /**
   * Port currently owned by the MAVLink ConnectionManager, or null. The
   * direct transport refuses to open the same port to avoid two owners on
   * one device. Injected because it lives in index.ts.
   */
  getBusyMavlinkPort?: () => string | null
  /** Max attempts per transaction before failing (>=1). */
  maxAttempts?: number
  /** Whether the wire echoes sent bytes back (single-wire => true). */
  consumeEcho?: boolean
  capabilities?: EscTransportCapabilities
}

const DEFAULT_CAPABILITIES: EscTransportCapabilities = {
  read: true,
  write: false,
}

const DEFAULT_MAX_ATTEMPTS = 3

/** Windows COM ports are case-insensitive; normalize before comparing. */
function normalizePort(port: string): string {
  return port.trim().toLowerCase()
}

export class DirectSerialTransport implements EscByteTransport {
  readonly kind = 'direct' as const
  readonly capabilities: EscTransportCapabilities

  private readonly serialFactory: () => DirectSerialLink
  private readonly getBusyMavlinkPort: () => string | null
  private readonly maxAttempts: number
  private readonly consumeEcho: boolean
  private link: DirectSerialLink | null = null
  private closed = false
  private inFlight = false
  private rxChunks: Uint8Array[] = []
  private pump: (() => void) | null = null
  private readonly abortedListeners = new Set<(error: EscError) => void>()
  private onLinkData = (data: Buffer) => {
    if (!this.inFlight) return
    this.rxChunks.push(Uint8Array.from(data))
    this.pump?.()
  }
  private onLinkLost = () => {
    this.notifyAborted(new EscError('link_lost', '直连串口已断开'))
  }

  constructor(options: DirectSerialTransportOptions = {}) {
    this.serialFactory = options.serialFactory ?? (() => new SerialConnection() as DirectSerialLink)
    this.getBusyMavlinkPort = options.getBusyMavlinkPort ?? (() => null)
    this.maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)
    this.consumeEcho = options.consumeEcho ?? true
    this.capabilities = options.capabilities ?? DEFAULT_CAPABILITIES
  }

  async open(target: EscTransportTarget, signal: AbortSignal): Promise<void> {
    if (target.mode !== 'direct') {
      throw new EscError('invalid_state', '直连传输不支持该模式')
    }
    if (target.baudRate !== ESC_SERIAL_BAUD_RATE) {
      throw new EscError('validation_failed', `直连仅支持 ${ESC_SERIAL_BAUD_RATE} 波特`)
    }
    const busyPort = this.getBusyMavlinkPort()
    if (busyPort && normalizePort(busyPort) === normalizePort(target.port)) {
      throw new EscError('busy', '目标端口正被 MAVLink 连接占用')
    }
    if (signal.aborted) throw new EscError('cancelled', 'ESC 会话在建立期间被取消')

    const link = this.serialFactory()
    this.link = link
    link.on('data', this.onLinkData)
    link.on('disconnected', this.onLinkLost)
    link.on('error', this.onLinkLost)
    try {
      await link.connect(target.port, ESC_SERIAL_BAUD_RATE)
    } catch (error) {
      link.off('data', this.onLinkData)
      link.off('disconnected', this.onLinkLost)
      link.off('error', this.onLinkLost)
      this.link = null
      throw toEscError(error, 'link_unavailable')
    }
  }

  async transact(
    request: Uint8Array,
    options: EscTransactionOptions,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    if (this.closed || !this.link) throw new EscError('link_lost', '直连传输已关闭')
    if (this.inFlight) throw new EscError('busy', '直连传输已有请求在执行')
    if (signal.aborted) throw new EscError('cancelled', 'ESC 请求已取消')

    let lastError: EscError = new EscError('timeout', 'ESC 请求超时')
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        return await this.attempt(request, options, signal)
      } catch (error) {
        lastError = toEscError(error)
        // Cancellation is terminal; only resync-retry on transient failures.
        if (lastError.code === 'cancelled' || lastError.code === 'link_lost') throw lastError
        if (attempt < this.maxAttempts) {
          // Re-sync: drop any stale RX bytes before the next attempt.
          this.rxChunks = []
        }
      }
    }
    throw lastError
  }

  private attempt(
    request: Uint8Array,
    options: EscTransactionOptions,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    const link = this.link
    if (!link) return Promise.reject(new EscError('link_lost', '直连传输已关闭'))
    this.inFlight = true
    this.rxChunks = []
    return new Promise<Uint8Array>((resolve, reject) => {
      let settled = false
      const cleanup = () => {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        this.pump = null
        this.inFlight = false
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
      const onAbort = () => fail(new EscError('cancelled', 'ESC 请求已取消'))
      const timer = setTimeout(() => {
        fail(new EscError('timeout', `ESC 请求超时（${options.label ?? 'transact'}）`))
      }, options.timeoutMs)
      signal.addEventListener('abort', onAbort)
      this.pump = () => {
        const buffered = concatChunks(this.rxChunks)
        // Single-wire echo: the first request.length bytes mirror what we
        // sent. Wait for and discard them, verifying they match.
        let bodyStart = 0
        if (this.consumeEcho) {
          if (buffered.length < request.length) return
          for (let i = 0; i < request.length; i++) {
            if (buffered[i] !== request[i]) {
              fail(new EscError('echo_mismatch', '单线回显与发送内容不一致'))
              return
            }
          }
          bodyStart = request.length
        }
        const body = buffered.subarray(bodyStart)
        let length: number | null
        try {
          length = options.frameLength(body)
        } catch (error) {
          fail(toEscError(error, 'crc_mismatch'))
          return
        }
        if (length === null) return
        finish(body.subarray(0, length))
      }
      if (!link.write(Buffer.from(request), 'high')) {
        fail(new EscError('link_lost', '直连串口写入失败'))
        return
      }
      this.pump()
    })
  }

  async close(reason: string): Promise<void> {
    if (this.closed) return
    this.closed = true
    const link = this.link
    this.link = null
    if (link) {
      link.off('data', this.onLinkData)
      link.off('disconnected', this.onLinkLost)
      link.off('error', this.onLinkLost)
      try {
        await link.disconnect()
      } catch (error) {
        console.warn('[ESC] direct serial disconnect failed:', error)
      }
    }
    void reason
  }

  onAborted(listener: (error: EscError) => void): () => void {
    this.abortedListeners.add(listener)
    return () => this.abortedListeners.delete(listener)
  }

  private notifyAborted(error: EscError): void {
    for (const listener of [...this.abortedListeners]) {
      try {
        listener(error)
      } catch (err) {
        console.error('[ESC] direct transport aborted listener threw:', err)
      }
    }
  }
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0]
  let total = 0
  for (const chunk of chunks) total += chunk.length
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}
