import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AM32_LAYOUT_SIZE,
  decodeAm32Eeprom,
  encodeAm32Eeprom,
} from './am32'

function fixture(): Uint8Array {
  const raw = new Uint8Array(AM32_LAYOUT_SIZE).fill(0xa5)
  raw[0] = 0x01
  raw[1] = 3
  raw[3] = 2
  raw[4] = 17
  raw[0x05] = 160
  raw[0x06] = 8
  raw[0x17] = 25
  raw[0x1a] = 82
  raw[0x20] = 128
  raw[0x21] = 128
  raw[0x22] = 128
  raw[0x23] = 50
  raw[0x25] = 50
  return raw
}

test('decodes official AM32 revision 3 transforms', () => {
  const decoded = decodeAm32Eeprom(fixture())
  assert.equal(decoded.layoutRevision, 3)
  assert.equal(decoded.values.rampRate, 16)
  assert.equal(decoded.values.minimumDutyCycle, 4)
  assert.equal(decoded.values.timingAdvance, 14.0625)
  assert.equal(decoded.values.motorKv, 3300)
  assert.equal(decoded.values.servoLowThreshold, 1006)
  assert.equal(decoded.values.servoHighThreshold, 2006)
  assert.equal(decoded.values.servoNeutral, 1502)
  assert.equal(decoded.values.servoDeadBand, 50)
  assert.equal(decoded.values.lowVoltageThreshold, 3)
})

test('encodes only patched bytes and preserves the rest of the EEPROM window', () => {
  const original = fixture()
  const encoded = encodeAm32Eeprom(original, {
    rampRate: 12.5,
    motorKv: 2500,
    complementaryPwm: 1,
  })

  assert.equal(encoded[0x05], 125)
  assert.equal(encoded[0x1a], 62)
  assert.equal(encoded[0x14], 1)
  for (let index = 0; index < encoded.length; index++) {
    if ([0x05, 0x1a, 0x14].includes(index)) continue
    assert.equal(encoded[index], original[index], `byte 0x${index.toString(16)} changed`)
  }
})

test('rejects fields unavailable in the active layout', () => {
  const raw = fixture()
  raw[1] = 2
  assert.throws(
    () => encodeAm32Eeprom(raw, { rampRate: 10 }),
    /当前 AM32 布局不支持参数 rampRate/,
  )
})
