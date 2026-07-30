// MSP v1 codec (MultiWii Serial Protocol). Frame layout:
//   '$' 'M' <dir> <size> <cmd> <payload...> <crc>
// where dir is '<' (to FC) or '>' (from FC) and crc is XOR of size, cmd and
// every payload byte. Provenance: public protocol; see
// docs/ESC-PROTOCOL-SOURCES.md. Independent implementation.
import { EscError } from '../../shared/esc'

export const MSP_COMMANDS = {
  API_VERSION: 1,
  FC_VARIANT: 2,
  BATTERY_STATE: 130,
  MOTOR_CONFIG: 131,
  SET_MOTOR: 214,
  SET_PASSTHROUGH: 245,
} as const

const DOLLAR = 0x24 // '$'
const M = 0x4d // 'M'
const DIR_TO_FC = 0x3c // '<'
const DIR_FROM_FC = 0x3e // '>'
const DIR_ERROR = 0x21 // '!'

/** XOR checksum over size, cmd and payload bytes. */
export function mspChecksum(command: number, payload: Uint8Array): number {
  let crc = payload.length & 0xff
  crc ^= command & 0xff
  for (let i = 0; i < payload.length; i++) crc ^= payload[i]
  return crc & 0xff
}

/** Build an MSP v1 request frame (`$M<`). */
export function encodeMspRequest(command: number, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
  if (payload.length > 0xff) {
    throw new EscError('validation_failed', 'MSP v1 载荷不能超过 255 字节')
  }
  const frame = new Uint8Array(6 + payload.length)
  frame[0] = DOLLAR
  frame[1] = M
  frame[2] = DIR_TO_FC
  frame[3] = payload.length & 0xff
  frame[4] = command & 0xff
  frame.set(payload, 5)
  frame[5 + payload.length] = mspChecksum(command, payload)
  return frame
}

export interface MspResponse {
  command: number
  payload: Uint8Array
  /** True when the FC signalled an error direction ('!'). */
  isError: boolean
}

/**
 * Frame-length probe for a response buffer, suitable for
 * EscTransactionOptions.frameLength. Returns the total frame length once a
 * complete `$M>`/`$M!` frame is present, null when more bytes are needed, or
 * throws EscError for an impossible prefix.
 */
export function mspFrameLength(buffered: Uint8Array): number | null {
  if (buffered.length < 1) return null
  if (buffered[0] !== DOLLAR) throw new EscError('crc_mismatch', 'MSP 帧起始字节错误')
  if (buffered.length < 2) return null
  if (buffered[1] !== M) throw new EscError('crc_mismatch', 'MSP 帧头错误')
  if (buffered.length < 3) return null
  const dir = buffered[2]
  if (dir !== DIR_FROM_FC && dir !== DIR_ERROR) {
    throw new EscError('crc_mismatch', 'MSP 帧方向错误')
  }
  if (buffered.length < 4) return null
  const size = buffered[3]
  return 6 + size
}

/** Decode a complete MSP v1 response frame and verify its checksum. */
export function decodeMspResponse(frame: Uint8Array): MspResponse {
  if (frame.length < 6) throw new EscError('crc_mismatch', 'MSP 帧过短')
  if (frame[0] !== DOLLAR || frame[1] !== M) {
    throw new EscError('crc_mismatch', 'MSP 帧头错误')
  }
  const dir = frame[2]
  if (dir !== DIR_FROM_FC && dir !== DIR_ERROR) {
    throw new EscError('crc_mismatch', 'MSP 帧方向错误')
  }
  const size = frame[3]
  const command = frame[4]
  if (frame.length < 6 + size) throw new EscError('crc_mismatch', 'MSP 帧长度不足')
  const payload = frame.subarray(5, 5 + size)
  const expected = mspChecksum(command, payload)
  const actual = frame[5 + size]
  if (expected !== actual) {
    throw new EscError('crc_mismatch', `MSP 校验和错误：期望 ${expected}，实际 ${actual}`)
  }
  return { command, payload: Uint8Array.from(payload), isError: dir === DIR_ERROR }
}
