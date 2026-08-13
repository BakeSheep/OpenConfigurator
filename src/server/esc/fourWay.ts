// 4-way interface codec (BLHeli passthrough). Frame layout:
//   ESC=0x2F cmd addr_hi addr_lo param_len param[...] crc_hi crc_lo
// A param_len of 0 encodes 256 bytes. CRC is CRC16-XMODEM over every byte
// from ESC through the last param byte. Responses append an ACK byte before
// the CRC. Provenance: public 4-way interface spec; see
// docs/ESC-PROTOCOL-SOURCES.md. Independent implementation.
import { crc16Xmodem, EscError } from '../../shared/esc'

/** Host-to-interface request marker (`cmd_Local_Escape`, '/'). */
export const FOUR_WAY_REQUEST_START = 0x2f
/** Interface-to-host response marker (`cmd_Remote_Escape`, '.'). */
export const FOUR_WAY_RESPONSE_START = 0x2e

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
  GeneralError: 0x0f,
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
  [FOUR_WAY_ACK.GeneralError]: 'ESC 设备通讯失败',
}

/** Map a non-OK ACK code to an EscError. */
export function ackToError(ack: number): EscError | null {
  if (ack === FOUR_WAY_ACK.OK) return null
  const message = ACK_MESSAGES[ack] ?? `未知 ACK 0x${ack.toString(16)}`
  const retryable = ack === FOUR_WAY_ACK.Timeout
    || ack === FOUR_WAY_ACK.UnknownError
    || ack === FOUR_WAY_ACK.GeneralError
  return new EscError('nack', `4-way ACK: ${message}`, { retryable })
}

/**
 * Build a 4-way request frame. `params` carries the payload; for read
 * commands it is typically a single length byte, for writes the data bytes.
 * A params length of 256 is encoded as the wire value 0.
 */
export function encodeFourWay(command: number, address: number, params: Uint8Array): Uint8Array {
  if (params.length < 1 || params.length > 256) {
    throw new EscError('validation_failed', '4-way 参数长度必须在 1..256 字节')
  }
  const paramLen = params.length === 256 ? 0 : params.length
  const frame = new Uint8Array(5 + params.length + 2)
  frame[0] = FOUR_WAY_REQUEST_START
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

export const MAX_FOUR_WAY_SEARCH_BYTES = 256

/**
 * Frame-length probe for a 4-way response buffer. Response layout mirrors the
 * request but with an ACK byte inserted before the CRC:
 *   0x2E cmd addr_hi addr_lo param_len param[...] ack crc_hi crc_lo
 *
 * When framing fails on a candidate 0x2E (e.g. noise), slides forward to test
 * subsequent 0x2E occurrences up to MAX_FOUR_WAY_SEARCH_BYTES.
 */
export function fourWayFrameLength(buffered: Uint8Array): number | null {
  const maxSearch = Math.min(buffered.length, MAX_FOUR_WAY_SEARCH_BYTES)
  let foundIncompleteCandidate = false

  for (let start = 0; start < maxSearch; start++) {
    if (buffered[start] !== FOUR_WAY_RESPONSE_START) continue
    if (buffered.length < start + 5) {
      foundIncompleteCandidate = true
      break
    }
    const paramLen = buffered[start + 4] === 0 ? 256 : buffered[start + 4]
    const frameLen = 5 + paramLen + 1 /* ack */ + 2 /* crc */
    const totalLen = start + frameLen
    if (buffered.length < totalLen) {
      foundIncompleteCandidate = true
      continue
    }
    // Check if this candidate frame has a valid CRC
    const receivedCrc = (buffered[totalLen - 2] << 8) | buffered[totalLen - 1]
    const computedCrc = crc16Xmodem(buffered.subarray(start, totalLen - 2))
    if (computedCrc === receivedCrc) {
      return totalLen
    }
    // CRC mismatch on candidate 0x2E -> slide forward and check next 0x2E
  }

  if (foundIncompleteCandidate) return null
  return null
}

/** Decode and CRC-check a complete 4-way response frame, resynchronizing past noise. */
export function decodeFourWay(frame: Uint8Array): FourWayResponse {
  const maxSearch = Math.min(frame.length, MAX_FOUR_WAY_SEARCH_BYTES)
  for (let start = 0; start < maxSearch; start++) {
    if (frame[start] !== FOUR_WAY_RESPONSE_START) continue
    if (frame.length < start + 8) continue
    const candidate = frame.subarray(start)
    const command = candidate[1]
    const address = (candidate[2] << 8) | candidate[3]
    const paramLen = candidate[4] === 0 ? 256 : candidate[4]
    const expectedLength = 5 + paramLen + 1 + 2
    if (candidate.length < expectedLength) continue
    const receivedCrc = (candidate[expectedLength - 2] << 8) | candidate[expectedLength - 1]
    const computed = crc16Xmodem(candidate.subarray(0, expectedLength - 2))
    if (computed === receivedCrc) {
      const params = candidate.subarray(5, 5 + paramLen)
      const ack = candidate[5 + paramLen]
      return { command, address, params: Uint8Array.from(params), ack }
    }
  }
  throw new EscError('crc_mismatch', '4-way CRC 错误或未找到有效响应帧')
}
