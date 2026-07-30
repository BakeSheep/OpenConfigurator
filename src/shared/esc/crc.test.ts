// Golden-vector tests for the shared CRC16-XMODEM implementation used by the
// 4-way interface and the AM32 bootloader protocol.
// Run directly: tsx src/shared/esc/crc.test.ts
import assert from 'node:assert/strict'
import { crc16Xmodem } from './crc'

// Canonical XMODEM check value (ITU-T V.41, poly 0x1021, init 0x0000).
assert.equal(crc16Xmodem(new TextEncoder().encode('123456789')), 0x31c3)

// Empty input yields the initial value.
assert.equal(crc16Xmodem(new Uint8Array(0)), 0x0000)

// Single-byte vectors computed with a bit-at-a-time reference below.
function referenceCrc16Xmodem(data: Uint8Array): number {
  let crc = 0
  for (const byte of data) {
    crc ^= byte << 8
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff
    }
  }
  return crc & 0xffff
}

assert.equal(crc16Xmodem(Uint8Array.of(0x00)), referenceCrc16Xmodem(Uint8Array.of(0x00)))
assert.equal(crc16Xmodem(Uint8Array.of(0xff)), referenceCrc16Xmodem(Uint8Array.of(0xff)))

// Independent reference agreement across varied payloads, including values
// with the MSB set and long runs, so a table-generation bug cannot hide.
const samples: Uint8Array[] = [
  Uint8Array.of(0x2f, 0x30, 0x00, 0x00, 0x01, 0x00),
  new Uint8Array(256).map((_, i) => i),
  new Uint8Array(1024).fill(0xa5),
  new TextEncoder().encode('AM32 ESC configurator golden sample'),
]
for (const sample of samples) {
  assert.equal(crc16Xmodem(sample), referenceCrc16Xmodem(sample))
}

// Incremental computation matches one-shot computation when chained via the
// optional seed argument (needed for streaming frame builders).
const whole = new TextEncoder().encode('123456789')
const partial = crc16Xmodem(whole.subarray(4), crc16Xmodem(whole.subarray(0, 4)))
assert.equal(partial, 0x31c3)

console.log('esc crc16-xmodem golden vectors passed')
