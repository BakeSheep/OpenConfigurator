import assert from 'node:assert/strict'
import test from 'node:test'
import {
  discoverSerialDevices,
  isLinuxPlatformUart,
  serialDisplayName,
  stableSerialDeviceId,
  type SerialPortRecord,
} from './serialDiscovery'

const linuxDependencies = (
  ports: SerialPortRecord[],
  byId: Record<string, string> = {},
) => ({
  platform: 'linux' as const,
  listPorts: async () => ports,
  readByIdDirectory: async () => new Map(Object.entries(byId)),
})

test('Linux merges /dev/serial/by-id aliases with their current tty into one device', async () => {
  const { recommended, all } = await discoverSerialDevices(linuxDependencies(
    [
      {
        path: '/dev/ttyACM0',
        manufacturer: 'Pixhawk',
        vendorId: '2dae',
        productId: '1011',
        serialNumber: '340034000A',
      },
    ],
    { '/dev/serial/by-id/usb-Pixhawk_Pixhawk_1_340034000A-if00': '/dev/ttyACM0' },
  ))

  assert.equal(recommended.length, 1)
  assert.equal(all.length, 1)
  assert.equal(recommended[0].path, '/dev/ttyACM0')
  assert.equal(
    recommended[0].stablePath,
    '/dev/serial/by-id/usb-Pixhawk_Pixhawk_1_340034000A-if00',
  )
  assert.equal(recommended[0].transport, 'serial')
  assert.ok(recommended[0].deviceId?.startsWith('serial:'))
})

test('platform UARTs stay out of the recommended list but remain in scope=all', async () => {
  const ports: SerialPortRecord[] = [
    { path: '/dev/ttyACM0', vendorId: '2dae', productId: '1011', serialNumber: 'S1' },
    ...Array.from({ length: 32 }, (_, index) => ({ path: `/dev/ttyS${index}` })),
  ]
  const { recommended, all } = await discoverSerialDevices(linuxDependencies(ports))

  assert.equal(recommended.length, 1)
  assert.equal(recommended[0].path, '/dev/ttyACM0')
  assert.equal(all.length, 33)
  assert.ok(all.some((device) => device.path === '/dev/ttyS31'))
  for (const device of recommended) {
    assert.ok(!isLinuxPlatformUart(device.path))
  }
})

test('identical VID/PID adapters with distinct serials keep distinct stable identities', async () => {
  const { recommended } = await discoverSerialDevices(linuxDependencies([
    { path: '/dev/ttyUSB0', vendorId: '1a86', productId: '7523', serialNumber: 'SER-A' },
    { path: '/dev/ttyUSB1', vendorId: '1a86', productId: '7523', serialNumber: 'SER-B' },
  ]))

  assert.equal(recommended.length, 2)
  const ids = recommended.map((device) => device.deviceId)
  assert.notEqual(ids[0], ids[1])
})

test('deviceId survives a tty renumber when a stable identity exists', async () => {
  const first = await discoverSerialDevices(linuxDependencies([
    { path: '/dev/ttyACM0', vendorId: '2dae', productId: '1011', serialNumber: 'S-1' },
  ]))
  const second = await discoverSerialDevices(linuxDependencies([
    { path: '/dev/ttyACM1', vendorId: '2dae', productId: '1011', serialNumber: 'S-1' },
  ]))

  assert.equal(first.recommended[0].deviceId, second.recommended[0].deviceId)
  assert.notEqual(first.recommended[0].path, second.recommended[0].path)
})

test('by-id-only device (re-enumeration race) is still listed', async () => {
  const { recommended } = await discoverSerialDevices(linuxDependencies(
    [],
    { '/dev/serial/by-id/usb-FTDI_FT232R_A50285BI-if00-port0': '/dev/ttyUSB0' },
  ))
  assert.equal(recommended.length, 1)
  assert.equal(recommended[0].path, '/dev/ttyUSB0')
  assert.ok(recommended[0].stablePath)
})

test('deviceId stays stable when a by-id-only device gains serial metadata', async () => {
  const stablePath = '/dev/serial/by-id/usb-FTDI_FT232R_A50285BI-if00-port0'
  const first = await discoverSerialDevices(linuxDependencies(
    [],
    { [stablePath]: '/dev/ttyUSB0' },
  ))
  const second = await discoverSerialDevices(linuxDependencies(
    [{
      path: '/dev/ttyUSB1',
      vendorId: '0403',
      productId: '6001',
      serialNumber: 'A50285BI',
    }],
    { [stablePath]: '/dev/ttyUSB1' },
  ))

  assert.equal(first.recommended[0].deviceId, second.recommended[0].deviceId)
  assert.notEqual(first.recommended[0].path, second.recommended[0].path)
})

test('Windows keeps every COM port recommended with PnP metadata', async () => {
  const { recommended, all } = await discoverSerialDevices({
    platform: 'win32',
    listPorts: async () => [
      { path: 'COM3', pnpId: 'USB\\VID_2DAE&PID_1011\\123', manufacturer: 'Pixhawk' },
      { path: 'COM7' },
    ],
    readByIdDirectory: async () => {
      throw new Error('by-id must not be read on Windows')
    },
  })
  assert.equal(recommended.length, 2)
  assert.equal(all.length, 2)
  assert.ok(recommended.every((device) => device.recommended))
})

test('display name follows friendly → manufacturer+serial → stable → path priority', () => {
  assert.equal(serialDisplayName({ path: '/dev/ttyACM0', friendlyName: 'MicoAir Link' }), 'MicoAir Link')
  assert.equal(
    serialDisplayName({ path: '/dev/ttyACM0', manufacturer: 'Pixhawk', serialNumber: '000A12345' }),
    'Pixhawk …2345',
  )
  assert.equal(
    serialDisplayName({ path: '/dev/ttyUSB0', stablePath: '/dev/serial/by-id/usb-FTDI_X-if00' }),
    'usb-FTDI_X-if00',
  )
  assert.equal(serialDisplayName({ path: '/dev/ttyUSB1' }), '/dev/ttyUSB1')
})

test('stableSerialDeviceId falls back to path only without identity', () => {
  const withIdentity = stableSerialDeviceId({
    path: '/dev/ttyACM0',
    serialNumber: 'S1',
  })
  const sameIdentityDifferentPath = stableSerialDeviceId({
    path: '/dev/ttyACM1',
    serialNumber: 'S1',
  })
  const noIdentity = stableSerialDeviceId({ path: '/dev/ttyUSB0' })
  const noIdentityOtherPath = stableSerialDeviceId({ path: '/dev/ttyUSB1' })

  assert.equal(withIdentity, sameIdentityDifferentPath)
  assert.notEqual(noIdentity, noIdentityOtherPath)
})
