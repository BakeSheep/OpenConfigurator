import assert from 'node:assert/strict'
import {
  connectionPresetEnablesGamepad,
  resolveSerialPreset,
  samePresetDevice,
  updateConnectionPresetGamepadPreference,
  type ConnectionPreset,
} from './connectionPresets'

const legacy: ConnectionPreset = {
  id: 'legacy',
  name: 'COM10 (Microsoft)',
  type: 'serial',
  port: 'COM10',
  baudRate: 57600,
}
const currentUsb = {
  path: 'COM11',
  manufacturer: 'Microsoft',
  vendorId: '1B8C',
  productId: '0036',
}

assert.deepEqual(resolveSerialPreset(legacy, [currentUsb]), {
  ...legacy,
  name: 'COM11 (Microsoft)',
  port: 'COM11',
  vendorId: '1B8C',
  productId: '0036',
})
assert.equal(resolveSerialPreset(legacy, [
  currentUsb,
  { path: 'COM12', vendorId: '0483', productId: '5740' },
]), null)

const identified = { ...legacy, vendorId: '0x1b8c', productId: '36' }
assert.equal(resolveSerialPreset(identified, [
  currentUsb,
  { path: 'COM12', vendorId: '0483', productId: '5740' },
])?.port, 'COM11')
assert.equal(resolveSerialPreset(identified, [
  { path: 'COM10', vendorId: '0483', productId: '5740' },
  currentUsb,
])?.port, 'COM11', 'VID/PID identity must win when the saved COM path is reused')
assert.equal(resolveSerialPreset(identified, [
  { path: 'COM10', vendorId: '0483', productId: '5740' },
]), null, 'an occupied saved path with the wrong identity must fail closed')
assert.ok(samePresetDevice(identified, {
  ...legacy,
  port: 'COM99',
  vendorId: '1B8C',
  productId: '0036',
}))
assert.equal(connectionPresetEnablesGamepad(legacy), false)
assert.equal(connectionPresetEnablesGamepad({ ...legacy, enableGamepad: true }), true)
assert.equal(connectionPresetEnablesGamepad({ ...legacy, enableGamepad: 'yes' } as unknown as ConnectionPreset), false)

const anotherPreset: ConnectionPreset = { ...legacy, id: 'another', port: 'COM12' }
assert.deepEqual(updateConnectionPresetGamepadPreference([legacy, anotherPreset], 'legacy', true), [
  { ...legacy, enableGamepad: true },
  anotherPreset,
])
assert.deepEqual(updateConnectionPresetGamepadPreference([legacy], 'missing', true), [legacy])

console.log('connectionPresets unit tests passed')
