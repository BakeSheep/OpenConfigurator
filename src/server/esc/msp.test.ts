// Golden-vector tests for the MSP v1 codec.
// Run directly: tsx src/server/esc/msp.test.ts
import assert from 'node:assert/strict'
import { EscError } from '../../shared/esc'
import {
  decodeMspResponse,
  encodeMspRequest,
  MSP_COMMANDS,
  mspChecksum,
  mspFrameLength,
} from './msp'

// XOR checksum: MSP_API_VERSION (1) request with empty payload => crc = 0 ^ 1.
assert.equal(mspChecksum(MSP_COMMANDS.API_VERSION, new Uint8Array(0)), 1)
// With payload the XOR folds every byte in.
assert.equal(mspChecksum(100, Uint8Array.of(0x01, 0x02, 0x03)), (3 ^ 100 ^ 0x01 ^ 0x02 ^ 0x03) & 0xff)

// Request framing: `$M<` size cmd crc.
{
  const frame = encodeMspRequest(MSP_COMMANDS.API_VERSION)
  assert.deepEqual([...frame], [0x24, 0x4d, 0x3c, 0x00, 0x01, 0x01])
}
{
  const frame = encodeMspRequest(214, Uint8Array.of(0x10, 0x20))
  // '$' 'M' '<' size=2 cmd=214 payload crc
  const crc = (2 ^ 214 ^ 0x10 ^ 0x20) & 0xff
  assert.deepEqual([...frame], [0x24, 0x4d, 0x3c, 0x02, 214, 0x10, 0x20, crc])
}

// Response framing probe: needs a full `$M>` frame.
{
  assert.equal(mspFrameLength(Uint8Array.of(0x24)), null)
  assert.equal(mspFrameLength(Uint8Array.of(0x24, 0x4d, 0x3e, 0x03)), 9) // 6 + size(3)
  assert.throws(() => mspFrameLength(Uint8Array.of(0x00)), (e: unknown) => e instanceof EscError)
  assert.throws(
    () => mspFrameLength(Uint8Array.of(0x24, 0x4d, 0x40)),
    (e: unknown) => e instanceof EscError,
    'bad direction byte rejected',
  )
}

// Round-trip decode of a response frame.
{
  const payload = Uint8Array.of(0x02, 0x1d, 0x51) // e.g. api version bytes
  const size = payload.length
  const cmd = MSP_COMMANDS.API_VERSION
  const crc = mspChecksum(cmd, payload)
  const frame = Uint8Array.of(0x24, 0x4d, 0x3e, size, cmd, ...payload, crc)
  const decoded = decodeMspResponse(frame)
  assert.equal(decoded.command, cmd)
  assert.equal(decoded.isError, false)
  assert.deepEqual([...decoded.payload], [...payload])
}

// Error direction ('!') is flagged.
{
  const cmd = MSP_COMMANDS.SET_PASSTHROUGH
  const crc = mspChecksum(cmd, new Uint8Array(0))
  const frame = Uint8Array.of(0x24, 0x4d, 0x21, 0x00, cmd, crc)
  const decoded = decodeMspResponse(frame)
  assert.equal(decoded.isError, true)
}

// Corrupted checksum is rejected.
{
  const payload = Uint8Array.of(0xaa)
  const cmd = 5
  const frame = Uint8Array.of(0x24, 0x4d, 0x3e, 1, cmd, ...payload, 0x00 /* wrong crc */)
  assert.throws(() => decodeMspResponse(frame), (e: unknown) => e instanceof EscError && e.code === 'crc_mismatch')
}

console.log('MSP v1 codec golden vectors passed')
