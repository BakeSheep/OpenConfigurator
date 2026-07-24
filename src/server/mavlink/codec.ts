// node-mavlink codec.
//
// Wraps the node-mavlink library so MavlinkBridge keeps a single, framework-
// agnostic MAVLink boundary. This replaces the previous hand-rolled
// MavlinkParser (manual v1/v2 framing, CRC16, CRC_EXTRA table, and per-message
// byte-offset reads). Framing/CRC and field offsets now come from the
// library's generated message definitions.
import {
  minimal,
  standard,
  common,
  MavLinkProtocolV2,
  MavLinkPacketSplitter,
  MavLinkPacketParser,
  type MavLinkData,
  type MavLinkDataConstructor,
} from 'node-mavlink'

// Merge the dialects this GCS needs. AUTOPILOT_VERSION (#148) and
// GLOBAL_POSITION_INT (#33) moved to the modern `standard` dialect and are NOT
// in `common`; without `standard` the splitter would treat #148 as an unknown
// id and drop it (breaking param-encoding capability negotiation).
export const REGISTRY: Record<number, MavLinkDataConstructor<MavLinkData>> = {
  ...minimal.REGISTRY,
  ...standard.REGISTRY,
  ...common.REGISTRY,
}

export { minimal, standard, common }

// Internal message shape handed to MavlinkBridge.handleMessage. Mirrors the old
// MavlinkParser.MavlinkMessage so the protocol test can keep injecting raw
// payloads without change.
export interface MavlinkMessage {
  msgId: number
  payload: Buffer
  seq: number
  sysId: number
  compId: number
}

// GCS identity stamped on every outbound frame (was 255/190 in the hand-rolled
// encoder). data() ignores sysid/compid so one shared instance decodes; a
// second instance carries the GCS identity for serialization.
const GCS_SYS_ID = 255
const GCS_COMP_ID = 190
const decodeProtocol = new MavLinkProtocolV2()
const encodeProtocol = new MavLinkProtocolV2(GCS_SYS_ID, GCS_COMP_ID)

let txSeq = 0

/**
 * Decode a raw MAVLink payload into a typed message object. MAVLink v2 trims
 * trailing zero bytes, so short payloads are zero-padded to the message's full
 * declared length before fixed-offset field reads. Returns null for ids that
 * are not in the merged registry.
 */
export function decode<T extends MavLinkData = MavLinkData>(msgId: number, payload: Buffer): T | null {
  const clazz = REGISTRY[msgId] as MavLinkDataConstructor<T> | undefined
  if (!clazz) return null
  const full = (clazz as unknown as { PAYLOAD_LENGTH: number }).PAYLOAD_LENGTH
  const buf = payload.length >= full
    ? payload
    : Buffer.concat([payload, Buffer.alloc(full - payload.length)])
  return decodeProtocol.data(buf, clazz)
}

/**
 * Serialize a message object into a full MAVLink v2 frame stamped with the GCS
 * system/component id and an auto-incrementing sequence number.
 */
export function serialize(message: MavLinkData): Buffer {
  const frame = encodeProtocol.serialize(message, txSeq & 0xff)
  txSeq = (txSeq + 1) & 0xff
  return frame
}

/**
 * Build a splitter+parser pipeline. Bytes written to `splitter` emit fully
 * framed, CRC-validated MavLinkPacket objects on `parser`. The splitter uses
 * the library's global magic-number table (which includes #148) so all handled
 * messages validate. `onCrcError` surfaces link corruption for diagnostics.
 */
export function createPacketStream(onCrcError?: (buffer: Buffer) => void) {
  const splitter = new MavLinkPacketSplitter({}, onCrcError ? { onCrcError } : {})
  const parser = new MavLinkPacketParser()
  splitter.pipe(parser)
  return { splitter, parser }
}
