import { ByteBuffer } from '../platform/ByteBuffer'
import { sha256 } from '@noble/hashes/sha2.js'
import * as ardupilotmega from 'mavlink-mappings/dist/lib/ardupilotmega.js'
import * as common from 'mavlink-mappings/dist/lib/common.js'
import * as minimal from 'mavlink-mappings/dist/lib/minimal.js'
import * as standard from 'mavlink-mappings/dist/lib/standard.js'
import type {
  MavLinkData,
  MavLinkDataConstructor,
  MavLinkPacketField,
} from 'mavlink-mappings/dist/lib/mavlink.js'
import { EventEmitter } from '../platform/EventEmitter'
import { signingKey, timingSafeEqual } from '../platform/crypto'

export { ardupilotmega, common, minimal, standard }
export type { MavLinkData }

export const REGISTRY: Record<number, MavLinkDataConstructor<MavLinkData>> = {
  ...minimal.REGISTRY,
  ...standard.REGISTRY,
  ...common.REGISTRY,
  173: ardupilotmega.REGISTRY[173],
  191: ardupilotmega.REGISTRY[191],
}

export type MavlinkProtocolPreference = 'auto' | 'v1' | 'v2'

export interface MavlinkSigningOptions {
  key: Uint8Array
  linkId?: number
  requireSigned?: boolean
  allowStaleFirstPacket?: boolean
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
  payload: ByteBuffer
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
const V1_MAGIC = 0xfe
const V2_MAGIC = 0xfd
const V1_PAYLOAD_OFFSET = 6
const V2_PAYLOAD_OFFSET = 10
const CHECKSUM_LENGTH = 2
const SIGNATURE_LENGTH = 13
const SUPPORTED_INCOMPATIBILITY_FLAGS = 0x01
const DEFAULT_MAX_BUFFERED_BYTES = 4096
const MAX_TRACKED_SOURCES = 256

function x25crc(buffer: Uint8Array, start = 0, trim = 0, magic: number | null = null): number {
  let crc = 0xffff
  const digest = (byte: number) => {
    let value = (byte & 0xff) ^ (crc & 0xff)
    value ^= value << 4
    value &= 0xff
    crc = ((crc >> 8) ^ (value << 8) ^ (value << 3) ^ (value >> 4)) & 0xffff
  }
  for (let index = start; index < buffer.length - trim; index++) digest(buffer[index])
  if (magic !== null) digest(magic)
  return crc
}
const SIGNATURE_MAX_AGE_TICKS = 6_000_000
// First contact from a (sysid, compid, linkId) must fall inside the window
// [now - SIGNATURE_MAX_AGE_TICKS, now + SIGNATURE_MAX_FUTURE_TICKS]. The
// future bound exists so one far-future timestamp cannot be stored as the
// replay watermark, which would silently reject every legitimate follow-up
// frame from that source as a replay (OCSA-013). Tens of seconds absorbs
// ordinary clock skew without weakening replay protection.
const SIGNATURE_MAX_FUTURE_TICKS = 3_000_000 // 30 s
const SIGNATURE_START_TIME = Date.UTC(2015, 0, 1)

function serializeField(field: MavLinkPacketField, value: unknown, buffer: ByteBuffer, base: number): void {
  const offset = base + field.offset
  const values = field.length > 0
    ? field.type === 'char[]'
      ? Array.from(String(value ?? ''), (char) => char.charCodeAt(0))
      : Array.from((value ?? []) as ArrayLike<number | bigint>)
    : null
  const writeOne = (item: unknown, at: number) => {
    switch (field.type.replace('[]', '')) {
      case 'char':
      case 'uint8_t':
      case 'uint8_t_mavlink_version': buffer.writeUInt8(Number(item ?? 0), at); break
      case 'int8_t': buffer.writeInt8(Number(item ?? 0), at); break
      case 'uint16_t': buffer.writeUInt16LE(Number(item ?? 0), at); break
      case 'int16_t': buffer.writeInt16LE(Number(item ?? 0), at); break
      case 'uint32_t': buffer.writeUInt32LE(Number(item ?? 0), at); break
      case 'int32_t': buffer.writeInt32LE(Number(item ?? 0), at); break
      case 'uint64_t': buffer.writeBigUInt64LE(BigInt((item as bigint | number | undefined) ?? 0), at); break
      case 'int64_t': buffer.writeBigInt64LE(BigInt((item as bigint | number | undefined) ?? 0), at); break
      case 'float': buffer.writeFloatLE(Number(item ?? 0), at); break
      case 'double': buffer.writeDoubleLE(Number(item ?? 0), at); break
      default: throw new Error(`Unknown MAVLink field type ${field.type}`)
    }
  }
  if (!values) {
    writeOne(value, offset)
    return
  }
  for (let index = 0; index < Math.min(field.length, values.length); index++) {
    writeOne(values[index], offset + index * field.size)
  }
}

function deserializeField(field: MavLinkPacketField, buffer: ByteBuffer): unknown {
  const readOne = (offset: number): unknown => {
    switch (field.type.replace('[]', '')) {
      case 'char': return String.fromCharCode(buffer.readUInt8(offset))
      case 'uint8_t':
      case 'uint8_t_mavlink_version': return buffer.readUInt8(offset)
      case 'int8_t': return buffer.readInt8(offset)
      case 'uint16_t': return buffer.readUInt16LE(offset)
      case 'int16_t': return buffer.readInt16LE(offset)
      case 'uint32_t': return buffer.readUInt32LE(offset)
      case 'int32_t': return buffer.readInt32LE(offset)
      case 'uint64_t': return buffer.readBigUInt64LE(offset)
      case 'int64_t': return buffer.readBigInt64LE(offset)
      case 'float': return buffer.readFloatLE(offset)
      case 'double': return buffer.readDoubleLE(offset)
      default: throw new Error(`Unknown MAVLink field type ${field.type}`)
    }
  }
  if (field.length === 0) return readOne(field.offset)
  if (field.type === 'char[]') {
    let result = ''
    for (let index = 0; index < field.length; index++) {
      const code = buffer.readUInt8(field.offset + index)
      if (code === 0) break
      result += String.fromCharCode(code)
    }
    return result
  }
  return Array.from({ length: field.length }, (_, index) => readOne(field.offset + index * field.size))
}

export function decode<T extends MavLinkData = MavLinkData>(msgId: number, payload: ByteBuffer): T | null {
  const clazz = REGISTRY[msgId] as MavLinkDataConstructor<T> | undefined
  if (!clazz) return null
  const padded = payload.length >= clazz.PAYLOAD_LENGTH
    ? payload
    : ByteBuffer.concat([payload, ByteBuffer.alloc(clazz.PAYLOAD_LENGTH - payload.length)])
  const result = new clazz()
  for (const field of clazz.FIELDS) {
    ;(result as unknown as Record<string, unknown>)[field.name] = deserializeField(field, padded)
  }
  return result
}

function serializeMessage(
  message: MavLinkData,
  version: 1 | 2,
  sysId: number,
  compId: number,
  seq: number,
  incompatibilityFlags = 0,
  compatibilityFlags = 0,
): ByteBuffer {
  const definition = message.constructor as MavLinkDataConstructor<MavLinkData>
  const payloadOffset = version === 1 ? V1_PAYLOAD_OFFSET : V2_PAYLOAD_OFFSET
  const full = ByteBuffer.alloc(payloadOffset + definition.PAYLOAD_LENGTH + CHECKSUM_LENGTH)
  if (version === 1) {
    full[0] = V1_MAGIC
    full[1] = definition.PAYLOAD_LENGTH
    full[2] = seq
    full[3] = sysId
    full[4] = compId
    full[5] = definition.MSG_ID
  } else {
    full[0] = V2_MAGIC
    full[2] = incompatibilityFlags
    full[3] = compatibilityFlags
    full[4] = seq
    full[5] = sysId
    full[6] = compId
    full.writeUIntLE(definition.MSG_ID, 7, 3)
  }
  for (const field of definition.FIELDS) {
    serializeField(field, (message as unknown as Record<string, unknown>)[field.name], full, payloadOffset)
  }
  let payloadLength = definition.PAYLOAD_LENGTH
  if (version === 2) {
    while (payloadLength > 1 && full[payloadOffset + payloadLength - 1] === 0) payloadLength--
    full[1] = payloadLength
  }
  const frame = full.subarray(0, payloadOffset + payloadLength + CHECKSUM_LENGTH)
  frame.writeUInt16LE(x25crc(frame, 1, CHECKSUM_LENGTH, definition.MAGIC_NUMBER), frame.length - 2)
  return frame
}

function signingTimestamp(timestampMs: number): number {
  return (timestampMs - SIGNATURE_START_TIME) * 100
}

function writeUInt48LE(buffer: ByteBuffer, value: number, offset: number): void {
  buffer.writeUInt32LE(value % 0x1_0000_0000, offset)
  buffer.writeUInt16LE(Math.floor(value / 0x1_0000_0000), offset + 4)
}

function readUInt48LE(buffer: ByteBuffer, offset: number): number {
  return buffer.readUInt32LE(offset) + buffer.readUInt16LE(offset + 4) * 0x1_0000_0000
}

export class MavLinkPacketSignature {
  static readonly SIGNATURE_LENGTH = SIGNATURE_LENGTH
  static key(passphrase: string): ByteBuffer { return ByteBuffer.from(signingKey(passphrase)) }
  constructor(readonly buffer: ByteBuffer) {}
  private get offset(): number { return this.buffer.length - SIGNATURE_LENGTH }
  get linkId(): number { return this.buffer[this.offset] }
  set linkId(value: number) { this.buffer[this.offset] = value }
  get timestamp(): number { return readUInt48LE(this.buffer, this.offset + 1) }
  set timestamp(value: number) { writeUInt48LE(this.buffer, value, this.offset + 1) }
  get signatureBytes(): ByteBuffer { return this.buffer.subarray(this.offset + 7, this.offset + 13) }
  calculate(key: Uint8Array): ByteBuffer {
    return ByteBuffer.from(sha256(ByteBuffer.concat([
      ByteBuffer.from(key),
      this.buffer.subarray(0, this.buffer.length - 6),
    ])).subarray(0, 6))
  }
  matches(key: Uint8Array): boolean { return timingSafeEqual(this.calculate(key), this.signatureBytes) }
}

export class MavLinkProtocolV1 {
  static readonly START_BYTE = V1_MAGIC
  static readonly PAYLOAD_OFFSET = V1_PAYLOAD_OFFSET
  constructor(readonly sysid = 254, readonly compid = 1) {}
  serialize(message: MavLinkData, seq: number): ByteBuffer {
    return serializeMessage(message, 1, this.sysid, this.compid, seq)
  }
}

export class MavLinkProtocolV2 {
  static readonly START_BYTE = V2_MAGIC
  static readonly PAYLOAD_OFFSET = V2_PAYLOAD_OFFSET
  static readonly IFLAG_SIGNED = 0x01
  static readonly SIGNATURE_START_TIME = SIGNATURE_START_TIME
  constructor(readonly sysid = 254, readonly compid = 1, readonly incompatibilityFlags = 0, readonly compatibilityFlags = 0) {}
  serialize(message: MavLinkData, seq: number): ByteBuffer {
    return serializeMessage(message, 2, this.sysid, this.compid, seq, this.incompatibilityFlags, this.compatibilityFlags)
  }
  sign(frame: ByteBuffer, linkId: number, key: Uint8Array, timestamp = Date.now()): ByteBuffer {
    const result = ByteBuffer.concat([frame, ByteBuffer.alloc(SIGNATURE_LENGTH)])
    const signature = new MavLinkPacketSignature(result)
    signature.linkId = linkId
    signature.timestamp = signingTimestamp(timestamp)
    signature.calculate(key).copy(result, result.length - 6)
    return result
  }
}

function nextMagic(buffer: ByteBuffer, from = 0): number {
  const v1 = buffer.indexOf(V1_MAGIC, from)
  const v2 = buffer.indexOf(V2_MAGIC, from)
  if (v1 < 0) return v2
  if (v2 < 0) return v1
  return Math.min(v1, v2)
}

function frameLength(buffer: ByteBuffer, offset = 0): number | null {
  if (buffer.length - offset < 2) return null
  const version = buffer[offset] === V1_MAGIC ? 1 : buffer[offset] === V2_MAGIC ? 2 : null
  if (!version) return null
  const payloadOffset = version === 1 ? V1_PAYLOAD_OFFSET : V2_PAYLOAD_OFFSET
  if (buffer.length - offset < payloadOffset) return null
  const signed = version === 2 && (buffer[offset + 2] & MavLinkProtocolV2.IFLAG_SIGNED) !== 0
  return payloadOffset + buffer[offset + 1] + CHECKSUM_LENGTH + (signed ? SIGNATURE_LENGTH : 0)
}

function headerOf(frame: ByteBuffer) {
  const version: 1 | 2 = frame[0] === V1_MAGIC ? 1 : 2
  return version === 1
    ? { version, payloadLength: frame[1], seq: frame[2], sysId: frame[3], compId: frame[4], msgId: frame[5], incompatibilityFlags: 0, compatibilityFlags: 0 }
    : { version, payloadLength: frame[1], seq: frame[4], sysId: frame[5], compId: frame[6], msgId: frame.readUIntLE(7, 3), incompatibilityFlags: frame[2], compatibilityFlags: frame[3] }
}

export class MavlinkCodecSession extends EventEmitter {
  private readonly options: Required<Pick<MavlinkCodecSessionOptions, 'protocol' | 'maxBufferedBytes' | 'gcsSystemId' | 'gcsComponentId'>> & Pick<MavlinkCodecSessionOptions, 'signing'>
  private ingress = ByteBuffer.alloc(0)
  private destroyed = false
  private txSeq = 0
  private negotiatedVersion: 1 | 2
  private lastSigningTimestampMs = 0
  private readonly lastRxSeq = new Map<string, number>()
  private readonly replayTimestamps = new Map<string, number>()
  /** Sources (sysid:compid) observed producing at least one valid signature. */
  private readonly signedSources = new Set<string>()
  private counters = { rxPackets: 0, txPackets: 0, rxSequenceLost: 0, rxDuplicates: 0, rxOutOfOrder: 0, crcErrors: 0, garbageBytes: 0, rejectedPackets: 0, parserRebuilds: 0 }

  constructor(options: MavlinkCodecSessionOptions = {}) {
    super()
    const protocol = options.signing ? 'v2' : (options.protocol ?? 'auto')
    if (options.signing && options.protocol === 'v1') throw new Error('MAVLink signing requires protocol v2')
    if (options.signing && options.signing.key.length !== 32) throw new Error('MAVLink signing key must be 32 bytes')
    this.options = { protocol, signing: options.signing, maxBufferedBytes: Math.max(280, options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES), gcsSystemId: options.gcsSystemId ?? GCS_SYS_ID, gcsComponentId: options.gcsComponentId ?? GCS_COMP_ID }
    this.negotiatedVersion = protocol === 'v2' ? 2 : 1
  }

  get protocolVersion(): 1 | 2 { return this.negotiatedVersion }
  get gcsSystemId(): number { return this.options.gcsSystemId }
  get gcsComponentId(): number { return this.options.gcsComponentId }
  get stats(): MavlinkCodecStats { return { ...this.counters, bufferedBytes: this.ingress.length, protocol: this.negotiatedVersion } }
  confirmMavlink2(): void { if (!this.destroyed && this.options.protocol === 'auto') this.negotiatedVersion = 2 }

  write(chunk: ByteBuffer): void {
    if (this.destroyed || chunk.length === 0) return
    this.ingress = this.ingress.length ? ByteBuffer.concat([this.ingress, chunk]) : ByteBuffer.from(chunk)
    this.drain()
    if (this.ingress.length > this.options.maxBufferedBytes) this.discard(this.ingress.length - Math.min(280, this.options.maxBufferedBytes))
  }

  serialize(message: MavLinkData): ByteBuffer {
    if (this.destroyed) throw new Error('MAVLink codec session is destroyed')
    const sequence = this.txSeq
    this.txSeq = (this.txSeq + 1) & 0xff
    let frame: ByteBuffer
    if (this.negotiatedVersion === 2) {
      const signing = this.options.signing
      const protocol = new MavLinkProtocolV2(this.options.gcsSystemId, this.options.gcsComponentId, signing ? MavLinkProtocolV2.IFLAG_SIGNED : 0)
      frame = protocol.serialize(message, sequence)
      if (signing) {
        const timestampMs = Math.max(Date.now(), this.lastSigningTimestampMs + 1)
        this.lastSigningTimestampMs = timestampMs
        frame = protocol.sign(frame, signing.linkId ?? 0, signing.key, timestampMs)
      }
    } else frame = new MavLinkProtocolV1(this.options.gcsSystemId, this.options.gcsComponentId).serialize(message, sequence)
    this.counters.txPackets++
    return frame
  }

  reset(): void {
    if (this.destroyed) throw new Error('Cannot reset a destroyed MAVLink codec session')
    this.ingress = ByteBuffer.alloc(0)
    this.txSeq = 0
    this.lastSigningTimestampMs = 0
    this.lastRxSeq.clear()
    this.counters = { rxPackets: 0, txPackets: 0, rxSequenceLost: 0, rxDuplicates: 0, rxOutOfOrder: 0, crcErrors: 0, garbageBytes: 0, rejectedPackets: 0, parserRebuilds: 0 }
    this.negotiatedVersion = this.options.protocol === 'v2' ? 2 : 1
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.ingress = ByteBuffer.alloc(0)
    this.removeAllListeners()
  }

  private drain(): void {
    while (this.ingress.length) {
      const start = nextMagic(this.ingress)
      if (start < 0) { this.discard(this.ingress.length); return }
      if (start > 0) this.discard(start)
      const expected = frameLength(this.ingress)
      if (expected === null) return
      if (this.ingress.length < expected) {
        const headerLength = this.ingress[0] === V1_MAGIC ? V1_PAYLOAD_OFFSET : V2_PAYLOAD_OFFSET
        if (this.ingress.length < headerLength) return
        const claimed = headerOf(this.ingress)
        // A known outer message may legitimately contain complete MAVLink-like
        // bytes in a fragmented binary payload (notably FILE_TRANSFER_PROTOCOL).
        if (REGISTRY[claimed.msgId]) return
        const nested = this.findCompleteFrame(1)
        if (nested < 0) return
        this.discard(nested)
        continue
      }
      const frame = this.ingress.subarray(0, expected)
      const header = headerOf(frame)
      const definition = REGISTRY[header.msgId]
      if (!definition) {
        this.counters.rejectedPackets++
        this.ingress = this.ingress.subarray(expected)
        continue
      }
      const payloadOffset = header.version === 1 ? V1_PAYLOAD_OFFSET : V2_PAYLOAD_OFFSET
      const crcOffset = payloadOffset + header.payloadLength
      const receivedCrc = frame.readUInt16LE(crcOffset)
      const calculatedCrc = x25crc(frame.subarray(0, crcOffset + CHECKSUM_LENGTH), 1, CHECKSUM_LENGTH, definition.MAGIC_NUMBER)
      if (receivedCrc !== calculatedCrc) {
        this.counters.crcErrors++
        this.emit('crcError')
        this.discard(1)
        continue
      }
      this.ingress = this.ingress.subarray(expected)
      this.handleFrame(frame, header, payloadOffset, crcOffset)
    }
  }

  private findCompleteFrame(from: number): number {
    let offset = nextMagic(this.ingress, from)
    while (offset >= 0) {
      const length = frameLength(this.ingress, offset)
      if (length !== null && offset + length <= this.ingress.length) {
        const frame = this.ingress.subarray(offset, offset + length)
        const header = headerOf(frame)
        const definition = REGISTRY[header.msgId]
        if (definition) {
          const payloadOffset = header.version === 1 ? V1_PAYLOAD_OFFSET : V2_PAYLOAD_OFFSET
          const crcOffset = payloadOffset + header.payloadLength
          if (frame.readUInt16LE(crcOffset) === x25crc(frame.subarray(0, crcOffset + CHECKSUM_LENGTH), 1, CHECKSUM_LENGTH, definition.MAGIC_NUMBER)) {
            return offset
          }
        }
      }
      offset = nextMagic(this.ingress, offset + 1)
    }
    return -1
  }

  private handleFrame(frame: ByteBuffer, header: ReturnType<typeof headerOf>, payloadOffset: number, crcOffset: number): void {
    if (header.version === 2 && (header.incompatibilityFlags & ~SUPPORTED_INCOMPATIBILITY_FLAGS) !== 0) {
      this.counters.rejectedPackets++
      this.emit('packetRejected', 'unsupported_incompatibility_flags')
      return
    }
    const signed = header.version === 2 && (header.incompatibilityFlags & MavLinkProtocolV2.IFLAG_SIGNED) !== 0
    const signing = this.options.signing
    if (signing) {
      if (!signed) {
        const sourceKey = `${header.sysId}:${header.compId}`
        // Global enforcement, or graceful per-source enforcement: once a
        // source has proven it signs its frames, a signature-less frame from
        // it is a downgrade attempt (signature stripping plus injection), not
        // legacy traffic, and is refused.
        if (signing.requireSigned || this.signedSources.has(sourceKey)) {
          this.counters.rejectedPackets++
          this.emit(
            'packetRejected',
            signing.requireSigned ? 'unsigned_packet' : 'unsigned_packet_downgrade',
          )
          return
        }
      } else {
        const signature = new MavLinkPacketSignature(frame)
        if (!signature.matches(signing.key)) {
          this.counters.rejectedPackets++
          this.emit('packetRejected', 'invalid_signature')
          return
        }
        // The signature is cryptographically valid, so an active attacker
        // cannot have forged this observation: arm per-source enforcement even
        // if the timestamp checks below still reject the frame itself.
        this.learnSignedSource(`${header.sysId}:${header.compId}`)
        const replayKey = `${header.sysId}:${header.compId}:${signature.linkId}`
        const previous = this.replayTimestamps.get(replayKey)
        const localTimestamp = signingTimestamp(Date.now())
        if (previous === undefined && !signing.allowStaleFirstPacket && signature.timestamp < localTimestamp - SIGNATURE_MAX_AGE_TICKS) {
          this.counters.rejectedPackets++
          this.emit('packetRejected', 'signature_stale')
          return
        }
        // Apply the future bound to every accepted packet, not only first
        // contact. Otherwise a source can establish a normal watermark and
        // poison it with a later far-future signed timestamp.
        if (signature.timestamp > localTimestamp + SIGNATURE_MAX_FUTURE_TICKS) {
          this.counters.rejectedPackets++
          this.emit('packetRejected', 'signature_future')
          return
        }
        if (previous !== undefined && signature.timestamp <= previous) {
          this.counters.rejectedPackets++
          this.emit('packetRejected', 'signature_replay')
          return
        }
        if (previous !== undefined) this.replayTimestamps.delete(replayKey)
        while (this.replayTimestamps.size >= MAX_TRACKED_SOURCES) {
          const oldest = this.replayTimestamps.keys().next().value as string | undefined
          if (!oldest) break
          this.replayTimestamps.delete(oldest)
        }
        this.replayTimestamps.set(replayKey, signature.timestamp)
      }
    }
    if (header.version === 2 && this.options.protocol === 'auto') this.negotiatedVersion = 2
    this.accountSequence(header.sysId, header.compId, header.seq)
    this.counters.rxPackets++
    this.emit('message', { msgId: header.msgId, payload: frame.subarray(payloadOffset, crcOffset), seq: header.seq, sysId: header.sysId, compId: header.compId, version: header.version, incompatibilityFlags: header.incompatibilityFlags, compatibilityFlags: header.compatibilityFlags, signed } satisfies MavlinkMessage)
  }

  /**
   * Eviction merely returns that source to lenient handling until it signs
   * again. Like the replay watermarks this is security state and survives
   * reset().
   */
  private learnSignedSource(sourceKey: string): void {
    if (this.signedSources.has(sourceKey)) return
    while (this.signedSources.size >= MAX_TRACKED_SOURCES) {
      const oldest = this.signedSources.values().next().value as string | undefined
      if (oldest === undefined) break
      this.signedSources.delete(oldest)
    }
    this.signedSources.add(sourceKey)
  }

  private accountSequence(sysId: number, compId: number, sequence: number): void {
    const key = `${sysId}:${compId}`
    const previous = this.lastRxSeq.get(key)
    if (previous === undefined) {
      while (this.lastRxSeq.size >= MAX_TRACKED_SOURCES) {
        const oldest = this.lastRxSeq.keys().next().value as string | undefined
        if (!oldest) break
        this.lastRxSeq.delete(oldest)
      }
      this.lastRxSeq.set(key, sequence)
      return
    }
    const distance = (sequence - previous + 256) & 0xff
    if (distance === 0) this.counters.rxDuplicates++
    else if (distance < 128) {
      if (distance > 1) this.counters.rxSequenceLost += distance - 1
      this.lastRxSeq.set(key, sequence)
    } else {
      this.counters.rxOutOfOrder++
      // A flight controller reboot commonly resets its sequence to zero.
      // Resynchronise after accounting for the boundary so following packets
      // are not all misclassified as out of order.
      this.lastRxSeq.set(key, sequence)
    }
  }

  private discard(bytes: number): void {
    const count = Math.min(bytes, this.ingress.length)
    this.counters.garbageBytes += count
    this.ingress = this.ingress.subarray(count)
  }
}

export function codecOptionsFromEnvironment(): MavlinkCodecSessionOptions {
  return { protocol: 'auto' }
}
