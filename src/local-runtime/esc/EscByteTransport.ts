// Unified byte-channel abstraction between the ESC session/protocol layers
// and the three physical links (ADR-002). Protocol state machines (MSP,
// 4-way, AM32 bootloader) must depend only on this interface, never on
// ConnectionManager, MavlinkBridge or SerialConnection directly.
import type { EscError, EscTransportCapabilities, EscTransportKind } from '../../shared/esc'

/** Mode-specific parameters required to open a transport. */
export type EscTransportTarget =
  | { mode: 'ardupilot_passthrough' }
  | { mode: 'px4_serial_control'; channels: number[] }
  | { mode: 'direct'; port: string; baudRate: 19200 }

export interface EscTransactionOptions {
  /** Overall deadline for the request/response round trip, in ms. */
  timeoutMs: number
  /**
   * Incremental frame detector: receives every byte accumulated so far and
   * returns the byte length of one complete response frame, or null when
   * more bytes are required. Framing is protocol-specific, so the protocol
   * layer supplies this; transports stay protocol-agnostic. Implementations
   * should throw an EscError for prefixes that can never become valid.
   */
  frameLength: (buffered: Uint8Array) => number | null
  /** Short label used in timeout messages and logs. */
  label?: string
}

export interface EscByteTransport {
  readonly kind: EscTransportKind
  /**
   * Capabilities this transport grants before the compatibility matrix is
   * applied; the session intersects them with the matrix gates.
   */
  readonly capabilities: EscTransportCapabilities
  /** Establish the channel. Rejects with EscError on failure or abort. */
  open(target: EscTransportTarget, signal: AbortSignal): Promise<void>
  /**
   * Perform one request/response exchange. Implementations serialize
   * concurrent callers (single in-flight transaction) and handle link
   * specifics such as half-duplex echo consumption internally.
   */
  transact(
    request: Uint8Array,
    options: EscTransactionOptions,
    signal: AbortSignal,
  ): Promise<Uint8Array>
  /** Tear down the channel. Must be idempotent. */
  close(reason: string): Promise<void>
  /**
   * Subscribe to unsolicited channel loss (serial unplug, MAVLink link
   * teardown). Returns an unsubscribe function. Listeners fire at most once
   * per open lifecycle.
   */
  onAborted(listener: (error: EscError) => void): () => void
}
