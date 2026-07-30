// ArduPilot raw ESC transport (ADR-003). Borrows the live serial link by
// pausing the MAVLink bridge and taking an exclusive raw session from the
// ConnectionManager. Stays protocol-agnostic: the MSP -> 4-way handshake is
// driven by the protocol/detector layer through transact(); this module only
// owns the safe channel lifecycle and framed request/response plumbing.
import { EscError, toEscError, type EscTransportCapabilities } from '../../shared/esc'
import type { RawSessionHandle } from '../connection/ConnectionManager'
import type {
  EscByteTransport,
  EscTransactionOptions,
  EscTransportTarget,
} from './EscByteTransport'

/** Minimal ConnectionManager surface this transport depends on. */
export interface RawSessionProvider {
  readonly status: string
  readonly vehicleReady?: boolean
  readonly rawSessionActive?: boolean
  beginRawSession(): RawSessionHandle
}

/** Minimal MavlinkBridge surface this transport depends on. */
export interface ProtocolPauseController {
  readonly armedState: boolean | null
  pauseProtocol(reason: string): void
  resumeProtocol(): void
}

export interface ArduPilotRawTransportOptions {
  connManager: RawSessionProvider
  bridge: ProtocolPauseController
  /**
   * Returns a machine-readable reason string when the link is busy with a
   * conflicting MAVLink operation (param sync, FTP, log transfer, pending
   * command), or null when idle. Injected because those live in index.ts.
   */
  checkBusy?: () => string | null
  capabilities?: EscTransportCapabilities
}

const DEFAULT_CAPABILITIES: EscTransportCapabilities = {
  read: true,
  write: true,
  flash: true,
  melody: true,
}

export class ArduPilotRawTransport implements EscByteTransport {
  readonly kind = 'ardupilot_raw' as const
  readonly capabilities: EscTransportCapabilities

  private readonly connManager: RawSessionProvider
  private readonly bridge: ProtocolPauseController
  private readonly checkBusy: () => string | null
  private handle: RawSessionHandle | null = null
  private offData: (() => void) | null = null
  private offAborted: (() => void) | null = null
  private closed = false
  private paused = false
  private readonly abortedListeners = new Set<(error: EscError) => void>()
  private inFlight = false
  private rxChunks: Uint8Array[] = []

  constructor(options: ArduPilotRawTransportOptions) {
    this.connManager = options.connManager
    this.bridge = options.bridge
    this.checkBusy = options.checkBusy ?? (() => null)
    this.capabilities = options.capabilities ?? DEFAULT_CAPABILITIES
  }

  async open(target: EscTransportTarget, signal: AbortSignal): Promise<void> {
    if (target.mode !== 'ardupilot_passthrough') {
      throw new EscError('invalid_state', 'ArduPilot 传输不支持该模式')
    }
    // ADR-003 preconditions: never enter passthrough on an armed vehicle or
    // when the arming state is unknown/stale.
    if (this.bridge.armedState === null) {
      throw new EscError('arming_state_unknown', '飞控解锁状态未知，拒绝进入 ESC 直通')
    }
    if (this.bridge.armedState === true) {
      throw new EscError('armed', '飞控已解锁，拒绝进入 ESC 直通')
    }
    if (this.connManager.vehicleReady !== true) {
      throw new EscError('precondition_failed', '飞控心跳未就绪，无法进入 ESC 直通')
    }
    const busy = this.checkBusy()
    if (busy) {
      throw new EscError('busy', `链路正忙（${busy}），无法进入 ESC 直通`)
    }
    if (signal.aborted) throw new EscError('cancelled', 'ESC 会话在建立期间被取消')

    // Pause MAVLink first so no GCS heartbeat or parser touches the raw stream,
    // then borrow the link. Any failure here rolls back the pause.
    this.bridge.pauseProtocol('esc_session')
    this.paused = true
    try {
      const handle = this.connManager.beginRawSession()
      this.handle = handle
      this.offData = handle.onData((data) => {
        if (!this.inFlight) return
        this.rxChunks.push(Uint8Array.from(data))
        this.feed()
      })
      this.offAborted = handle.onAborted((reason) => {
        this.notifyAborted(new EscError('link_lost', `ESC 链路已断开：${reason}`))
      })
    } catch (error) {
      // Roll back the pause so MAVLink recovers even if we never took the link.
      this.bridge.resumeProtocol()
      this.paused = false
      throw toEscError(error, 'link_unavailable')
    }
  }

  async transact(
    request: Uint8Array,
    options: EscTransactionOptions,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    if (this.closed || !this.handle) {
      throw new EscError('link_lost', 'ESC 传输已关闭')
    }
    if (this.inFlight) {
      throw new EscError('busy', 'ESC 传输已有请求在执行')
    }
    if (signal.aborted) throw new EscError('cancelled', 'ESC 请求已取消')

    this.inFlight = true
    this.rxChunks = []
    const handle = this.handle
    try {
      return await new Promise<Uint8Array>((resolve, reject) => {
        let settled = false
        const cleanup = () => {
          clearTimeout(timer)
          signal.removeEventListener('abort', onAbort)
          this.pump = null
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
        // Re-evaluate framing whenever new bytes arrive (and once for any
        // bytes buffered before the pump was installed).
        this.pump = () => {
          const buffered = concatChunks(this.rxChunks)
          let length: number | null
          try {
            length = options.frameLength(buffered)
          } catch (error) {
            fail(toEscError(error, 'crc_mismatch'))
            return
          }
          if (length === null) return
          finish(buffered.subarray(0, length))
        }
        if (!handle.write(Buffer.from(request))) {
          fail(new EscError('link_lost', 'ESC 写入失败'))
          return
        }
        this.pump()
      })
    } finally {
      this.inFlight = false
      this.pump = null
      this.rxChunks = []
    }
  }

  /** Invoked by the onData listener via rxChunks; re-frames on each chunk. */
  private pump: (() => void) | null = null

  private feed(): void {
    this.pump?.()
  }

  async close(reason: string): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.offData?.()
    this.offData = null
    this.offAborted?.()
    this.offAborted = null
    try {
      this.handle?.release()
    } finally {
      this.handle = null
      // Always restore MAVLink so a real heartbeat can re-establish readiness.
      if (this.paused) {
        this.bridge.resumeProtocol()
        this.paused = false
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
        console.error('[ESC] ArduPilot transport aborted listener threw:', err)
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
