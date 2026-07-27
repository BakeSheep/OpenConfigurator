// Per-transport MAVLink codec.
//
// node-mavlink owns message layouts, CRCs and the final packet decode. This
// wrapper deliberately owns stream/session concerns that the library does not:
// bounded garbage handling, parser recovery, protocol negotiation, signing,
// replay protection and per-link sequence accounting.
import { EventEmitter } from 'node:events'
import {
  minimal,
  standard,
  common,
  MavLinkProtocolV1,
  MavLinkProtocolV2,
  MavLinkPacketSignature,
  MavLinkPacketSplitter,
  MavLinkPacketParser,
  type MavLinkData,
  type MavLinkDataConstructor,
  type MavLinkPacket,
} from 'node-mavlink'

// AUTOPILOT_VERSION (#148) and GLOBAL_POSITION_INT (#33) live in the modern
// `standard` dialect, so all three registries must remain merged.
export const REGISTRY: Record<number, MavLinkDataConstructor<MavLinkData>> = {
  ...minimal.REGISTRY,
  ...standard.REGISTRY,
  ...common.REGISTRY,
}

export { minimal, standard, common }

export type MavlinkProtocolPreference = 'auto' | 'v1' | 'v2'

export interface MavlinkSigningOptions {
  key: Buffer
  linkId?: number
  /** Reject unsigned inbound packets. Defaults to false for compatibility. */
  requireSigned?: boolean
}

export interface MavlinkCodecSessionOptions {
  protocol?: MavlinkProtocolPreference
  signing?: MavlinkSigningOptions
  maxBufferedBytes?: number
  gcsSystemId?: number
  gcsComponentId?: number
}

export interface MavlinkCodecStats {
  rxPackets: number
  txPackets: number
  rxSequenceLost: number
  rxDuplicates: number
  rxOutOfOrder: number
  crcErrors: number
  garbageBytes: number
  rejectedPackets: number
  parserRebuilds: number
  bufferedBytes: number
  protocol: 1 | 2
}

export interface MavlinkMessage {
  msgId: number
  payload: Buffer
  seq: number
  sysId: number
  compId: number
  version?: 1 | 2
  incompatibilityFlags?: number
  compatibilityFlags?: number
  signed?: boolean
}

const GCS_SYS_ID = 255
const GCS_COMP_ID = 190
const V1_MAGIC = MavLinkProtocolV1.START_BYTE
const V2_MAGIC = MavLinkProtocolV2.START_BYTE
const V1_FRAME_OVERHEAD = MavLinkProtocolV1.PAYLOAD_OFFSET + 2
const V2_FRAME_OVERHEAD = MavLinkProtocolV2.PAYLOAD_OFFSET + 2
const SIGNATURE_LENGTH = MavLinkPacketSignature.SIGNATURE_LENGTH
const SUPPORTED_INCOMPATIBILITY_FLAGS = MavLinkProtocolV2.IFLAG_SIGNED
const DEFAULT_MAX_BUFFERED_BYTES = 4096
const MAX_TRACKED_SOURCES = 256
const SIGNATURE_MAX_AGE_TICKS = 6_000_000

const decodeProtocol = new MavLinkProtocolV2()

/**
 * Decode a MAVLink payload into a typed generated message. MAVLink 2 may trim
 * trailing zeroes, so the payload is padded before fixed-offset field reads.
 */
export function decode<T extends MavLinkData = MavLinkData>(msgId: number, payload: Buffer): T | null {
  const clazz = REGISTRY[msgId] as MavLinkDataConstructor<T> | undefined
  if (!clazz) return null
  const fullLength = (clazz as unknown as { PAYLOAD_LENGTH: number }).PAYLOAD_LENGTH
  const padded = payload.length >= fullLength
    ? payload
    : Buffer.concat([payload, Buffer.alloc(fullLength - payload.length)])
  return decodeProtocol.data(padded, clazz)
}

function envBoolean(value: string | undefined): boolean {
  return value === '1' || value?.toLowerCase() === 'true'
}

function envInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  if (!value) return fallback
  const parsed = Number.parseInt(value, 10)
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback
}

/**
 * Resolve optional protocol/signing configuration without exposing secrets in
 * logs. A 64-character hexadecimal key is used directly; any other non-empty
 * value is treated as a passphrase and SHA-256 derived by node-mavlink.
 */
export function codecOptionsFromEnvironment(): MavlinkCodecSessionOptions {
  const configuredProtocol = process.env.MAVLINK_PROTOCOL?.toLowerCase()
  const protocol: MavlinkProtocolPreference =
    configuredProtocol === 'v1' || configuredProtocol === 'v2'
      ? configuredProtocol
      : 'auto'
  const secret = process.env.MAVLINK_SIGNING_KEY
  if (envBoolean(process.env.MAVLINK_SIGNING_REQUIRE) && !secret) {
    throw new Error('MAVLINK_SIGNING_REQUIRE needs MAVLINK_SIGNING_KEY')
  }
  let signing: MavlinkSigningOptions | undefined
  if (secret) {
    signing = {
      key: /^[0-9a-f]{64}$/i.test(secret)
        ? Buffer.from(secret, 'hex')
        : MavLinkPacketSignature.key(secret),
      linkId: envInteger(process.env.MAVLINK_SIGNING_LINK_ID, 0, 0, 255),
      requireSigned: envBoolean(process.env.MAVLINK_SIGNING_REQUIRE),
    }
  }
  return { protocol, signing }
}

function isMagic(value: number): boolean {
  return value === V1_MAGIC || value === V2_MAGIC
}

function nextMagic(buffer: Buffer, from = 0): number {
  const v1 = buffer.indexOf(V1_MAGIC, from)
  const v2 = buffer.indexOf(V2_MAGIC, from)
  if (v1 < 0) return v2
  if (v2 < 0) return v1
  return Math.min(v1, v2)
}

function expectedFrameLength(buffer: Buffer, offset = 0): number | null {
  if (buffer.length - offset < 2) return null
  const magic = buffer[offset]
  if (!isMagic(magic)) return null
  const payloadLength = buffer[offset + 1]
  if (magic === V1_MAGIC) return V1_FRAME_OVERHEAD + payloadLength
  if (buffer.length - offset < MavLinkProtocolV2.PAYLOAD_OFFSET) return null
  const signed = (buffer[offset + 2] & MavLinkProtocolV2.IFLAG_SIGNED) !== 0
  return V2_FRAME_OVERHEAD + payloadLength + (signed ? SIGNATURE_LENGTH : 0)
}

/** Whether the frame at offset zero advertises a message in our dialect set. */
function startsWithKnownMessage(buffer: Buffer): boolean {
  if (buffer[0] === V1_MAGIC) {
    return buffer.length >= MavLinkProtocolV1.PAYLOAD_OFFSET
      && REGISTRY[buffer[5]] !== undefined
  }
  if (buffer[0] === V2_MAGIC) {
    return buffer.length >= MavLinkProtocolV2.PAYLOAD_OFFSET
      && REGISTRY[buffer.readUIntLE(7, 3)] !== undefined
  }
  return false
}

/**
 * A codec instance belongs to exactly one physical transport session.
 * Reconnecting creates/resets this object so parser state and sequence numbers
 * cannot leak between flight controllers.
 */
export class MavlinkCodecSession extends EventEmitter {
  private readonly options: Required<
    Pick<MavlinkCodecSessionOptions, 'protocol' | 'maxBufferedBytes' | 'gcsSystemId' | 'gcsComponentId'>
  > & Pick<MavlinkCodecSessionOptions, 'signing'>
  private splitter!: MavLinkPacketSplitter
  private parser!: MavLinkPacketParser
  private ingress = Buffer.alloc(0)
  private destroyed = false
  private txSeq = 0
  private negotiatedVersion: 1 | 2
  private lastSigningTimestampMs = 0
  private readonly lastRxSeq = new Map<string, number>()
  private readonly replayTimestamps = new Map<string, number>()
  private counters: Omit<MavlinkCodecStats, 'bufferedBytes' | 'protocol'> = {
    rxPackets: 0,
    txPackets: 0,
    rxSequenceLost: 0,
    rxDuplicates: 0,
    rxOutOfOrder: 0,
    crcErrors: 0,
    garbageBytes: 0,
    rejectedPackets: 0,
    parserRebuilds: 0,
  }

  constructor(options: MavlinkCodecSessionOptions = {}) {
    super()
    const protocol = options.signing ? 'v2' : (options.protocol ?? 'auto')
    if (options.signing && options.protocol === 'v1') {
      throw new Error('MAVLink signing requires protocol v2')
    }
    if (options.signing?.key.length !== undefined && options.signing.key.length !== 32) {
      throw new Error('MAVLink signing key must be 32 bytes')
    }
    this.options = {
      protocol,
      signing: options.signing,
      maxBufferedBytes: Math.max(280, options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES),
      gcsSystemId: options.gcsSystemId ?? GCS_SYS_ID,
      gcsComponentId: options.gcsComponentId ?? GCS_COMP_ID,
    }
    this.negotiatedVersion = protocol === 'v2' ? 2 : 1
    this.buildParser(false)
  }

  get protocolVersion(): 1 | 2 {
    return this.negotiatedVersion
  }

  get stats(): MavlinkCodecStats {
    return {
      ...this.counters,
      bufferedBytes: this.ingress.length,
      protocol: this.negotiatedVersion,
    }
  }

  /**
   * AUTOPILOT_VERSION capability negotiation can upgrade an auto session even
   * before a v2 packet has been observed.
   */
  confirmMavlink2(): void {
    if (this.destroyed) return
    if (this.options.protocol === 'auto') this.negotiatedVersion = 2
  }

  /**
   * Feed arbitrary serial chunks. Bytes without a MAVLink STX are discarded
   * before node-mavlink sees them, preventing its private buffer from growing
   * without bound on a noisy or wrong COM port.
   */
  write(chunk: Buffer): void {
    if (this.destroyed || chunk.length === 0) return
    this.ingress = this.ingress.length === 0
      ? Buffer.from(chunk)
      : Buffer.concat([this.ingress, chunk])
    // A serialport data event can legitimately contain many complete frames.
    // Parse those first; the bound applies only to bytes that cannot yet form
    // a frame (noise or a trailing partial), never to valid burst traffic.
    this.drainIngress()
    this.enforceIngressLimit()
  }

  serialize(message: MavLinkData): Buffer {
    if (this.destroyed) throw new Error('MAVLink codec session is destroyed')
    const sequence = this.txSeq
    this.txSeq = (this.txSeq + 1) & 0xff

    let frame: Buffer
    if (this.negotiatedVersion === 2) {
      const signing = this.options.signing
      const protocol = new MavLinkProtocolV2(
        this.options.gcsSystemId,
        this.options.gcsComponentId,
        signing ? MavLinkProtocolV2.IFLAG_SIGNED : 0,
      )
      frame = protocol.serialize(message, sequence)
      if (signing) {
        // Millisecond resolution still yields 100 signing ticks. Advancing by
        // one millisecond avoids duplicate timestamps during bursty writes.
        const timestampMs = Math.max(Date.now(), this.lastSigningTimestampMs + 1)
        this.lastSigningTimestampMs = timestampMs
        frame = protocol.sign(frame, signing.linkId ?? 0, signing.key, timestampMs)
      }
    } else {
      frame = new MavLinkProtocolV1(
        this.options.gcsSystemId,
        this.options.gcsComponentId,
      ).serialize(message, sequence)
    }
    this.counters.txPackets++
    return frame
  }

  reset(): void {
    if (this.destroyed) throw new Error('Cannot reset a destroyed MAVLink codec session')
    this.ingress = Buffer.alloc(0)
    this.txSeq = 0
    this.lastSigningTimestampMs = 0
    this.lastRxSeq.clear()
    // Replay watermarks are security state, not parser/session framing state.
    // Keep them across a physical reconnect so a recorded signed command or
    // heartbeat cannot become valid again merely because the serial link was
    // reset. destroy() releases the map with the whole codec object.
    this.counters = {
      rxPackets: 0,
      txPackets: 0,
      rxSequenceLost: 0,
      rxDuplicates: 0,
      rxOutOfOrder: 0,
      crcErrors: 0,
      garbageBytes: 0,
      rejectedPackets: 0,
      parserRebuilds: 0,
    }
    this.negotiatedVersion = this.options.protocol === 'v2' ? 2 : 1
    this.buildParser(false)
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.ingress = Buffer.alloc(0)
    this.teardownParser()
    this.removeAllListeners()
  }

  private drainIngress(): void {
    // The loop is bounded by input size: each pass either removes at least one
    // byte or waits for a partial frame.
    while (!this.destroyed && this.ingress.length > 0) {
      const start = nextMagic(this.ingress)
      if (start < 0) {
        this.discardIngress(this.ingress.length)
        return
      }
      if (start > 0) this.discardIngress(start)

      const expected = expectedFrameLength(this.ingress)
      if (expected === null) return
      if (this.ingress.length < expected) {
        // A fragmented, known MAVLink frame may contain arbitrary 0xFD/0xFE
        // bytes in its payload (ULog data does frequently). Never scan inside
        // that valid partial frame for another apparent STX: doing so corrupts
        // binary FILE_TRANSFER_PROTOCOL packets at data-dependent offsets.
        if (startsWithKnownMessage(this.ingress)) return
        // A false STX with a bogus length must not block a valid complete frame
        // already present later in the buffer.
        const recoverable = this.findCompleteFrameAfter(1)
        if (recoverable > 0) {
          this.discardIngress(recoverable)
          continue
        }
        return
      }

      const frame = this.ingress.subarray(0, expected)
      this.ingress = this.ingress.subarray(expected)
      try {
        this.splitter.write(frame)
        if (this.destroyed) return
      } catch (error) {
        this.counters.rejectedPackets++
        this.emit('parserError', error)
        this.buildParser(true)
      }
    }
  }

  private findCompleteFrameAfter(from: number): number {
    let candidate = nextMagic(this.ingress, from)
    while (candidate >= 0) {
      const length = expectedFrameLength(this.ingress, candidate)
      if (length !== null && this.ingress.length - candidate >= length) return candidate
      candidate = nextMagic(this.ingress, candidate + 1)
    }
    return -1
  }

  private enforceIngressLimit(): void {
    const overflow = this.ingress.length - this.options.maxBufferedBytes
    if (overflow <= 0) return

    // Preserve at most one possible partial frame at the tail. A MAVLink frame
    // is no larger than 280 bytes, so retaining more cannot help recovery.
    const tailStart = Math.max(0, this.ingress.length - 280)
    const candidate = nextMagic(this.ingress, tailStart)
    const keepFrom = candidate >= 0 ? candidate : this.ingress.length
    const minimumDiscard = Math.max(overflow, keepFrom)
    this.discardIngress(minimumDiscard)
  }

  private discardIngress(bytes: number): void {
    if (bytes <= 0) return
    const discard = Math.min(bytes, this.ingress.length)
    this.counters.garbageBytes += discard
    this.ingress = this.ingress.subarray(discard)
  }

  private buildParser(countRebuild: boolean): void {
    if (this.destroyed) return
    this.teardownParser()
    if (countRebuild) this.counters.parserRebuilds++

    this.splitter = new MavLinkPacketSplitter({}, {
      onCrcError: () => {
        this.counters.crcErrors++
        this.emit('crcError')
      },
    })
    this.parser = new MavLinkPacketParser()
    this.splitter.on('error', (error) => this.recoverParser(error))
    this.parser.on('error', (error) => this.recoverParser(error))
    this.parser.on('data', (packet: MavLinkPacket) => this.handlePacket(packet))
    this.splitter.pipe(this.parser)
  }

  private teardownParser(): void {
    if (this.splitter) {
      this.splitter.unpipe(this.parser)
      this.splitter.removeAllListeners()
      this.splitter.destroy()
    }
    if (this.parser) {
      this.parser.removeAllListeners()
      this.parser.destroy()
    }
  }

  private recoverParser(error: unknown): void {
    if (this.destroyed) return
    this.counters.rejectedPackets++
    this.emit('parserError', error)
    if (this.destroyed) return
    this.buildParser(true)
    // Keep only the bounded pre-parser partial. node-mavlink's private state is
    // intentionally thrown away.
    queueMicrotask(() => {
      if (!this.destroyed) this.drainIngress()
    })
  }

  private handlePacket(packet: MavLinkPacket): void {
    if (this.destroyed) return
    const header = packet.header
    const version: 1 | 2 = packet.protocol.name === MavLinkProtocolV2.NAME ? 2 : 1
    if (version === 2 && (header.incompatibilityFlags & ~SUPPORTED_INCOMPATIBILITY_FLAGS) !== 0) {
      this.counters.rejectedPackets++
      this.emit('packetRejected', 'unsupported_incompatibility_flags')
      return
    }

    const signed = packet.signature !== null
    const signing = this.options.signing
    if (signing) {
      if (!signed) {
        if (signing.requireSigned) {
          this.counters.rejectedPackets++
          this.emit('packetRejected', 'unsigned_packet')
          return
        }
      } else {
        if (!packet.signature!.matches(signing.key)) {
          this.counters.rejectedPackets++
          this.emit('packetRejected', 'invalid_signature')
          return
        }
        const replayKey = `${header.sysid}:${header.compid}:${packet.signature!.linkId}`
        const timestamp = packet.signature!.timestamp
        const previous = this.replayTimestamps.get(replayKey)
        const localTimestamp = (Date.now() - MavLinkProtocolV2.SIGNATURE_START_TIME) * 100
        if (
          previous === undefined
          && timestamp < localTimestamp - SIGNATURE_MAX_AGE_TICKS
        ) {
          this.counters.rejectedPackets++
          this.emit('packetRejected', 'signature_stale')
          return
        }
        if (previous !== undefined && timestamp <= previous) {
          this.counters.rejectedPackets++
          this.emit('packetRejected', 'signature_replay')
          return
        }
        if (previous !== undefined) this.replayTimestamps.delete(replayKey)
        while (this.replayTimestamps.size >= MAX_TRACKED_SOURCES) {
          const oldest = this.replayTimestamps.keys().next().value as string | undefined
          if (oldest === undefined) break
          this.replayTimestamps.delete(oldest)
        }
        this.replayTimestamps.set(replayKey, timestamp)
      }
    }

    if (version === 2 && this.options.protocol === 'auto') this.negotiatedVersion = 2
    this.accountSequence(header.sysid, header.compid, header.seq)
    this.counters.rxPackets++
    this.emit('message', {
      msgId: header.msgid,
      // node-mavlink pads packet.payload to 255 bytes. Preserve the actual
      // wire length because extension/sentinel handling depends on whether a
      // field was transmitted; decode() performs message-specific padding.
      payload: packet.buffer.subarray(
        version === 2 ? MavLinkProtocolV2.PAYLOAD_OFFSET : MavLinkProtocolV1.PAYLOAD_OFFSET,
        (version === 2 ? MavLinkProtocolV2.PAYLOAD_OFFSET : MavLinkProtocolV1.PAYLOAD_OFFSET)
          + header.payloadLength,
      ),
      seq: header.seq,
      sysId: header.sysid,
      compId: header.compid,
      version,
      incompatibilityFlags: header.incompatibilityFlags,
      compatibilityFlags: header.compatibilityFlags,
      signed,
    } satisfies MavlinkMessage)
  }

  private accountSequence(sysId: number, compId: number, sequence: number): void {
    const key = `${sysId}:${compId}`
    const previous = this.lastRxSeq.get(key)
    if (previous === undefined) {
      while (this.lastRxSeq.size >= MAX_TRACKED_SOURCES) {
        const oldest = this.lastRxSeq.keys().next().value as string | undefined
        if (oldest === undefined) break
        this.lastRxSeq.delete(oldest)
      }
      this.lastRxSeq.set(key, sequence)
      return
    }
    const delta = (sequence - previous + 256) & 0xff
    if (delta === 0) {
      this.counters.rxDuplicates++
      return
    }
    // Large backwards deltas are stale/out-of-order traffic, not packet loss.
    if (delta > 128) {
      this.counters.rxOutOfOrder++
      // Serial links preserve order, so this is commonly a source reboot or
      // sequence reset. Resynchronize immediately instead of classifying the
      // next ~128 packets as out-of-order.
      this.lastRxSeq.delete(key)
      this.lastRxSeq.set(key, sequence)
      return
    }
    if (delta > 1) this.counters.rxSequenceLost += delta - 1
    this.lastRxSeq.delete(key)
    this.lastRxSeq.set(key, sequence)
  }
}
