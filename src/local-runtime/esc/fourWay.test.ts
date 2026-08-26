// Golden-vector tests for the 4-way interface codec.
// Run directly: tsx src/local-runtime/esc/fourWay.test.ts
import assert from 'node:assert/strict'
import { crc16Xmodem, EscError } from '../../shared/esc'
import {
  ackToError,
  decodeFourWay,
  encodeFourWay,
  FOUR_WAY_ACK,
  FOUR_WAY_COMMANDS,
  FOUR_WAY_REQUEST_START,
  FOUR_WAY_RESPONSE_START,
  fourWayFrameLength,
} from './fourWay'

// Request framing: 0x2F cmd addr_hi addr_lo param_len param[...] crc_hi crc_lo.
{
  const frame = encodeFourWay(FOUR_WAY_COMMANDS.InterfaceTestAlive, 0, Uint8Array.of(0))
  const body = Uint8Array.of(FOUR_WAY_REQUEST_START, 0x30, 0x00, 0x00, 0x01, 0x00)
  const crc = crc16Xmodem(body)
  assert.deepEqual([...frame], [...body, (crc >> 8) & 0xff, crc & 0xff])
}
{
  assert.throws(
    () => encodeFourWay(FOUR_WAY_COMMANDS.InterfaceTestAlive, 0, new Uint8Array(0)),
    (e: unknown) => e instanceof EscError && e.code === 'validation_failed',
    'zero params are ambiguous because wire length 0 means 256',
  )
}
{
  // DeviceRead of 0x0000 for 256 bytes: param_len encoded as 0.
  const frame = encodeFourWay(FOUR_WAY_COMMANDS.DeviceRead, 0x0000, Uint8Array.of(0))
  assert.equal(frame[1], 0x3a)
  assert.equal(frame[4], 0x01) // one param byte (the value 0), not the 256 sentinel
}
{
  // A 256-byte param block encodes its length as the wire sentinel 0.
  const params = new Uint8Array(256).fill(0xa5)
  const frame = encodeFourWay(FOUR_WAY_COMMANDS.DeviceWrite, 0x1000, params)
  assert.equal(frame[4], 0x00, '256 params -> length byte 0')
  assert.equal(frame.length, 5 + 256 + 2)
}

// Response framing probe.
{
  assert.equal(fourWayFrameLength(Uint8Array.of(FOUR_WAY_RESPONSE_START)), null)
  // cmd,addr,addr,param_len=3 -> 5 + 3 + 1(ack) + 2(crc) = 11
  assert.equal(fourWayFrameLength(Uint8Array.of(FOUR_WAY_RESPONSE_START, 0x3a, 0, 0, 3)), null)
  // param_len sentinel 0 -> 256 bytes.
  assert.equal(fourWayFrameLength(Uint8Array.of(FOUR_WAY_RESPONSE_START, 0x3a, 0, 0, 0)), null)
  assert.equal(fourWayFrameLength(Uint8Array.of(FOUR_WAY_REQUEST_START)), null)
  assert.equal(fourWayFrameLength(Uint8Array.of(0x00)), null)
}

// Build a valid response frame and round-trip decode it.
function buildResponse(command: number, address: number, params: number[], ack: number): Uint8Array {
  const paramLen = params.length === 256 ? 0 : params.length
  const head = Uint8Array.of(
    FOUR_WAY_RESPONSE_START,
    command,
    (address >> 8) & 0xff,
    address & 0xff,
    paramLen,
    ...params,
    ack,
  )
  const crc = crc16Xmodem(head)
  return Uint8Array.of(...head, (crc >> 8) & 0xff, crc & 0xff)
}

{
  const response = buildResponse(FOUR_WAY_COMMANDS.DeviceRead, 0, [1, 2, 3], FOUR_WAY_ACK.OK)
  assert.equal(fourWayFrameLength(response.subarray(0, 5)), null, 'partial header is not a frame')
  assert.equal(fourWayFrameLength(response.subarray(0, response.length - 1)), null, 'partial body is not a frame')
  assert.equal(fourWayFrameLength(response), response.length)
  const noisy = Uint8Array.of(0xfe, 0x09, ...response)
  assert.equal(fourWayFrameLength(noisy), noisy.length, 'leading link noise is included in framed length')
  assert.deepEqual([...decodeFourWay(noisy).params], [1, 2, 3], 'decoder resynchronizes after leading noise')
}

{
  const frame = buildResponse(FOUR_WAY_COMMANDS.DeviceInitFlash, 0, [0x14, 0x40, 0x00, 0x04], FOUR_WAY_ACK.OK)
  const decoded = decodeFourWay(frame)
  assert.equal(decoded.command, FOUR_WAY_COMMANDS.DeviceInitFlash)
  assert.equal(decoded.ack, FOUR_WAY_ACK.OK)
  assert.deepEqual([...decoded.params], [0x14, 0x40, 0x00, 0x04])
}

// CRC mismatch is rejected.
{
  const frame = buildResponse(FOUR_WAY_COMMANDS.DeviceRead, 0, [0xaa], FOUR_WAY_ACK.OK)
  frame[frame.length - 1] ^= 0xff // corrupt CRC
  assert.throws(() => decodeFourWay(frame), (e: unknown) => e instanceof EscError && e.code === 'crc_mismatch')
}

// ACK mapping.
{
  assert.equal(ackToError(FOUR_WAY_ACK.OK), null)
  const verify = ackToError(FOUR_WAY_ACK.VerifyError)
  assert.ok(verify instanceof EscError && verify.code === 'nack')
  const timeout = ackToError(FOUR_WAY_ACK.Timeout)
  assert.ok(timeout instanceof EscError && timeout.retryable, 'timeout ACK is retryable')
  const invalidCmd = ackToError(FOUR_WAY_ACK.InvalidCommand)
  assert.ok(invalidCmd instanceof EscError && !invalidCmd.retryable)
}

console.log('4-way interface codec golden vectors passed')
