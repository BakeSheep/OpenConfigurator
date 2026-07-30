// 4-way interface codec (BLHeli passthrough). Frame layout:
//   ESC=0x2F cmd addr_hi addr_lo param_len param[...] crc_hi crc_lo
// A param_len of 0 encodes 256 bytes. CRC is CRC16-XMODEM over every byte
// from ESC through the last param byte. Responses append an ACK byte before
// the CRC. Provenance: public 4-way interface spec; see
// docs/ESC-PROTOCOL-SOURCES.md. Independent implementation.
import { crc16Xmodem, EscError } from '../../shared/esc'

export const FOUR_WAY_START = 0x2f

export const FOUR_WAY_COMMANDS = {
  InterfaceTestAlive: 0x30,
  ProtocolGetVersion: 0x31,
  InterfaceGetName: 0x32,
  InterfaceGetVersion: 0x33,
  InterfaceExit: 0x34,
  DeviceReset: 0x35,
  DeviceInitFlash: 0x37,
  DeviceEraseAll: 0x38,
  DevicePageErase: 0x39,
  DeviceRead: 0x3a,
  DeviceWrite: 0x3b,
  DeviceReadEEprom: 0x3d,
  DeviceWriteEEprom: 0x3e,
  DeviceSetBuffer: 0x3f,
} as const

export const FOUR_WAY_ACK = {
  OK: 0x00,
  UnknownError: 0x01,
  InvalidCommand: 0x02,
  InvalidCRC: 0x03,
  VerifyError: 0x04,
  InvalidChannel: 0x08,
  InvalidParam: 0x09,
  Timeout: 0x0a,
} as const

const ACK_MESSAGES: Record<number, string> = {
  [FOUR_WAY_ACK.OK]: 'OK',
  [FOUR_WAY_ACK.UnknownError]: '未知错误',
  [FOUR_WAY_ACK.InvalidCommand]: '无效命令',
  [FOUR_WAY_ACK.InvalidCRC]: 'CRC 错误',
  [FOUR_WAY_ACK.VerifyError]: '校验失败',
  [FOUR_WAY_ACK.InvalidChannel]: '无效通道',
  [FOUR_WAY_ACK.InvalidParam]: '无效参数',
  [FOUR_WAY_ACK.Timeout]: '超时',
}

/** Map a non-OK ACK code to an EscError. */
export function ackToError(ack: number): EscError | null {
  if (ack === FOUR_WAY_ACK.OK) return null
  const message = ACK_MESSAGES[ack] ?? `未知 ACK 0x${ack.toString(16)}`
  const retryable = ack === FOUR_WAY_ACK.Timeout || ack === FOUR_WAY_ACK.UnknownError
  return new EscError('nack', `4-way ACK: ${message}`, { retryable })
}

/**
 * Build a 4-way request frame. `params` carries the payload; for read
 * commands it is typically a single length byte, for writes the data bytes.
 * A params length of 256 is encoded as the wire value 0.
 */
export function encodeFourWay(command: number, address: number, params: Uint8Array = new Uint8Array(0)): Uint8Array {
  if (params.length > 256) {
    throw new EscError('validation_failed', '4-way 参数不能超过 256 字节')
  }
  const paramLen = params.length === 256 ? 0 : params.length
  const frame = new Uint8Array(5 + params.length + 2)
  frame[0] = FOUR_WAY_START
  frame[1] = command & 0xff
  frame[2] = (address >> 8) & 0xff
  frame[3] = address & 0xff
  frame[4] = paramLen & 0xff
  frame.set(params, 5)
  const crc = crc16Xmodem(frame.subarray(0, 5 + params.length))
  frame[5 + params.length] = (crc >> 8) & 0xff
  frame[6 + params.length] = crc & 0xff
  return frame
}

export interface FourWayResponse {
  command: number
  address: number
  params: Uint8Array
  ack: number
}

/**
 * Frame-length probe for a 4-way response buffer. Response layout mirrors the
 * request but with an ACK byte inserted before the CRC:
 *   0x2F cmd addr_hi addr_lo param_len param[...] ack crc_hi crc_lo
 */
export function fourWayFrameLength(buffered: Uint8Array): number | null {
  if (buffered.length < 1) return null
  if (buffered[0] !== FOUR_WAY_START) {
    throw new EscError('crc_mismatch', '4-way 帧起始字节错误')
  }
  if (buffered.length < 5) return null
  const paramLen = buffered[4] === 0 ? 256 : buffered[4]
  return 5 + paramLen + 1 /* ack */ + 2 /* crc */
}

/** Decode and CRC-check a complete 4-way response frame. */
export function decodeFourWay(frame: Uint8Array): FourWayResponse {
  if (frame.length < 8) throw new EscError('crc_mismatch', '4-way 帧过短')
  if (frame[0] !== FOUR_WAY_START) {
    throw new EscError('crc_mismatch', '4-way 帧起始字节错误')
  }
  const command = frame[1]
  const address = (frame[2] << 8) | frame[3]
  const paramLen = frame[4] === 0 ? 256 : frame[4]
  const expectedLength = 5 + paramLen + 1 + 2
  if (frame.length < expectedLength) throw new EscError('crc_mismatch', '4-way 帧长度不足')
  const params = frame.subarray(5, 5 + paramLen)
  const ack = frame[5 + paramLen]
  const crcHi = frame[6 + paramLen]
  const crcLo = frame[7 + paramLen]
  const receivedCrc = (crcHi << 8) | crcLo
  // CRC covers everything up to and including the ACK byte.
  const computed = crc16Xmodem(frame.subarray(0, 5 + paramLen + 1))
  if (computed !== receivedCrc) {
    throw new EscError('crc_mismatch', `4-way CRC 错误：期望 ${computed}，实际 ${receivedCrc}`)
  }
  return { command, address, params: Uint8Array.from(params), ack }
}
