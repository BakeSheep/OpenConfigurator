import assert from 'node:assert/strict'
import {
  connectionPresetEnablesGamepad,
  connectionConfigFromPreset,
  resolveBluetoothPreset,
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

assert.equal(resolveSerialPreset(legacy, [currentUsb]), null)
assert.equal(resolveSerialPreset(legacy, [
  currentUsb,
  { path: 'COM12', vendorId: '0483', productId: '5740' },
]), null)

const identified = { ...legacy, vendorId: '0x1b8c', productId: '36' }
assert.equal(resolveSerialPreset(identified, [
  currentUsb,
  { path: 'COM12', vendorId: '0483', productId: '5740' },
]), null, 'VID/PID-only presets must not follow a renumbered device')
assert.equal(resolveSerialPreset(identified, [
  { ...currentUsb, path: 'COM10' },
  currentUsb,
])?.port, 'COM10', 'a VID/PID-only preset remains usable on its saved path')
assert.equal(resolveSerialPreset(identified, [
  { path: 'COM10', vendorId: '0483', productId: '5740' },
]), null, 'an occupied saved path with the wrong identity must fail closed')
assert.ok(samePresetDevice(identified, {
  ...legacy,
  port: 'COM99',
  vendorId: '1B8C',
  productId: '0036',
}))

assert.equal(resolveSerialPreset({ ...identified, port: 'local-port-1' }, [
  { ...currentUsb, path: 'local-port-1' },
]), null, 'legacy browser-local paths require an explicit picker after reload')

const browserSessionPreset: ConnectionPreset = {
  ...identified,
  port: 'local-port-1',
  deviceId: 'webserial:session-a:local-port-1',
}
assert.equal(resolveSerialPreset(browserSessionPreset, [{
  ...currentUsb,
  path: 'local-port-1',
  deviceId: 'webserial:session-b:local-port-1',
}]), null, 'a reused browser-local path must not match a previous page lifecycle')

const stableSerialPreset: ConnectionPreset = {
  ...identified,
  deviceId: 'serial:stable-1',
  stablePath: '/dev/serial/by-id/usb-Pixhawk_1-if00',
  serialNumber: 'PX4-001',
  transport: 'serial',
}
const renumberedStablePort = {
  ...currentUsb,
  path: 'COM27',
  deviceId: 'serial:stable-1',
  serialNumber: 'PX4-001',
  transport: 'serial' as const,
}
assert.equal(resolveSerialPreset(stableSerialPreset, [renumberedStablePort])?.port, 'COM27')
assert.deepEqual(connectionConfigFromPreset(stableSerialPreset), {
  type: 'serial',
  port: 'COM10',
  baudRate: 57600,
  vendorId: '0x1b8c',
  productId: '36',
  deviceId: 'serial:stable-1',
  transport: 'serial',
  stablePath: '/dev/serial/by-id/usb-Pixhawk_1-if00',
  serialNumber: 'PX4-001',
})
assert.equal(connectionPresetEnablesGamepad(legacy), false)
assert.equal(connectionPresetEnablesGamepad({ ...legacy, enableGamepad: true }), true)
assert.equal(connectionPresetEnablesGamepad({ ...legacy, enableGamepad: 'yes' } as unknown as ConnectionPreset), false)

const anotherPreset: ConnectionPreset = { ...legacy, id: 'another', port: 'COM12' }
assert.deepEqual(updateConnectionPresetGamepadPreference([legacy, anotherPreset], 'legacy', true), [
  { ...legacy, enableGamepad: true },
  anotherPreset,
])
assert.deepEqual(updateConnectionPresetGamepadPreference([legacy], 'missing', true), [legacy])

const bluetoothPreset: ConnectionPreset = {
  id: 'bluetooth',
  name: 'MicoAir',
  type: 'bluetooth',
  port: 'Bluetooth SPP 0x1101',
  baudRate: 57600,
  bluetoothServiceClassId: '0x1101',
}
const pairedBluetooth = {
  path: 'bt-rfcomm://08fad1176949/1',
  friendlyName: 'MicoAir743v2-94296',
  bluetoothAddress: '08:FA:D1:17:69:49',
  bluetoothChannel: 1,
  bluetoothServiceClassId: '0x1101',
}
assert.deepEqual(resolveBluetoothPreset(bluetoothPreset, [pairedBluetooth]), {
  ...bluetoothPreset,
  name: 'MicoAir743v2-94296',
  port: pairedBluetooth.path,
  bluetoothAddress: pairedBluetooth.bluetoothAddress,
  bluetoothChannel: 1,
})
assert.equal(resolveBluetoothPreset(bluetoothPreset, [
  pairedBluetooth,
  { ...pairedBluetooth, path: 'bt-rfcomm://001122334455/1', bluetoothAddress: '00:11:22:33:44:55' },
]), null, 'a service-only preset must not guess between multiple paired devices')
assert.equal(resolveBluetoothPreset({
  ...bluetoothPreset,
  port: 'local-port-1',
  deviceId: 'webserial:session-a:local-port-1',
}, [{
  ...pairedBluetooth,
  path: 'local-port-1',
  deviceId: 'webserial:session-b:local-port-1',
}]), null, 'Bluetooth Web Serial presets must not cross page lifecycles')
assert.ok(samePresetDevice(
  { ...bluetoothPreset, bluetoothAddress: '08:fa:d1:17:69:49' },
  { ...bluetoothPreset, port: pairedBluetooth.path, bluetoothAddress: '08FAD1176949' },
))
assert.deepEqual(connectionConfigFromPreset({
  ...bluetoothPreset,
  port: pairedBluetooth.path,
  bluetoothAddress: pairedBluetooth.bluetoothAddress,
  bluetoothChannel: pairedBluetooth.bluetoothChannel,
}), {
  type: 'bluetooth',
  port: pairedBluetooth.path,
  baudRate: 57600,
  bluetoothAddress: pairedBluetooth.bluetoothAddress,
  bluetoothChannel: 1,
  bluetoothServiceClassId: '0x1101',
})

console.log('connectionPresets unit tests passed')
