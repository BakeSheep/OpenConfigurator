import assert from 'node:assert/strict'
import test from 'node:test'
import { ConnectionDiscoveryService, ConnectionResolutionError } from './ConnectionDiscoveryService'

function makeService(overrides: Partial<ConstructorParameters<typeof ConnectionDiscoveryService>[0]> = {}) {
  const logs: string[] = []
  const service = new ConnectionDiscoveryService({
    serialDependencies: {
      platform: 'linux',
      listPorts: async () => [
        { path: '/dev/ttyACM0', vendorId: '2dae', productId: '1011', serialNumber: 'S-1' },
        { path: '/dev/ttyS0' },
      ],
      readByIdDirectory: async () => new Map(),
    },
    bluetoothDependencies: {
      platform: 'linux',
      runCommand: async () => {
        throw new Error(' bluetoothctl should not be required in these tests')
      },
    },
    monotonicNow: () => 0,
    log: (message) => logs.push(message),
    ...overrides,
  })
  return { service, logs }
}

test('scan generations increase monotonically and cache hits keep the device list', async () => {
  let now = 0
  const { service } = makeService({ monotonicNow: () => now })
  const first = await service.scan('serial', 'recommended')
  const second = await service.scan('serial', 'recommended')
  assert.equal(first.cached, false)
  assert.equal(second.cached, true)
  assert.ok(second.scanGeneration > first.scanGeneration)
  assert.equal(second.devices.length, first.devices.length)
})

test('serial recommended scope hides platform UARTs; all scope lists them', async () => {
  const { service } = makeService()
  const recommended = await service.scan('serial', 'recommended')
  const all = await service.scan('serial', 'all')
  assert.equal(recommended.scope, 'recommended')
  assert.ok(recommended.devices.every((device) => device.path.startsWith('/dev/ttyACM')))
  assert.equal(all.scope, 'all')
  assert.equal(all.devices.length, 2)
})

test('bluetooth quick failure becomes a warning instead of a failed scan', async () => {
  const { service } = makeService({
    bluetoothDependencies: {
      platform: 'linux',
      runCommand: async () => {
        const error = new Error('spawn bluetoothctl ENOENT') as NodeJS.ErrnoException
        error.code = 'ENOENT'
        throw error
      },
    },
  })
  const result = await service.scan('bluetooth')
  assert.equal(result.scope, 'quick')
  assert.deepEqual(result.devices, [])
  assert.equal(result.warnings.length, 1)
  assert.equal(result.warnings[0].code, 'BLUETOOTH_TOOL_MISSING')
})

test('a hung bluetooth scan never blocks the serial scan', async () => {
  const { service } = makeService({
    bluetoothDependencies: {
      platform: 'linux',
      runCommand: () => new Promise((_resolve, reject) => {
        setTimeout(() => reject(new Error('bluetooth never settled')), 5000)
      }),
    },
  })
  void service.scan('bluetooth').catch(() => undefined)
  const startedAt = Date.now()
  const serial = await service.scan('serial', 'recommended')
  assert.ok(Date.now() - startedAt < 1000, 'serial scan must complete independently')
  assert.ok(serial.devices.length > 0)
})

test('resolveSerialTarget verifies deviceId and reports stable codes', async () => {
  const { service } = makeService()
  const scan = await service.scan('serial', 'recommended')
  const device = scan.devices[0]

  const resolved = await service.resolveSerialTarget({
    type: 'serial',
    port: device.path,
    baudRate: 57600,
    deviceId: device.deviceId,
    serialNumber: device.serialNumber,
  })
  assert.equal(resolved.path, '/dev/ttyACM0')
  assert.equal(resolved.identity?.path, '/dev/ttyACM0')

  await assert.rejects(
    service.resolveSerialTarget({
      type: 'serial',
      port: device.path,
      baudRate: 57600,
      deviceId: 'serial:doesnotexist',
    }),
    (error: unknown) =>
      error instanceof ConnectionResolutionError && error.code === 'DEVICE_NOT_FOUND',
  )

  await assert.rejects(
    service.resolveSerialTarget({
      type: 'serial',
      port: device.path,
      baudRate: 57600,
      serialNumber: 'S-1',
      stablePath: '/dev/serial/by-id/usb-Other_0-if00',
    }),
    (error: unknown) =>
      error instanceof ConnectionResolutionError && error.code === 'DEVICE_NOT_FOUND',
  )
})

test('resolveSerialTarget recovers a legacy deviceId only with matching stable evidence', async () => {
  const stablePath = '/dev/serial/by-id/usb-Pixhawk_1-if00'
  const { service } = makeService({
    serialDependencies: {
      platform: 'linux',
      listPorts: async () => [
        { path: '/dev/ttyACM0', vendorId: '2dae', productId: '1011', serialNumber: 'S-1' },
      ],
      readByIdDirectory: async () => new Map([[stablePath, '/dev/ttyACM0']]),
    },
  })
  const resolved = await service.resolveSerialTarget({
    type: 'serial',
    port: '/dev/ttyACM9',
    baudRate: 57600,
    deviceId: 'serial:legacy-composite-hash',
    stablePath,
    serialNumber: 'S-1',
  })
  assert.equal(resolved.path, '/dev/ttyACM0')

  await assert.rejects(
    service.resolveSerialTarget({
      type: 'serial',
      port: '/dev/ttyACM9',
      baudRate: 57600,
      deviceId: 'serial:legacy-composite-hash',
      stablePath: '/dev/serial/by-id/usb-Other-if00',
    }),
    (error: unknown) =>
      error instanceof ConnectionResolutionError && error.code === 'DEVICE_NOT_FOUND',
  )
})

test('resolveSerialTarget fails closed when the identity matches several devices', async () => {
  // Clone adapters sharing one serial number: the strongest identity
  // available cannot tell them apart, so connecting must not guess.
  const { service } = makeService({
    serialDependencies: {
      platform: 'linux',
      listPorts: async () => [
        { path: '/dev/ttyUSB0', vendorId: '1a86', productId: '7523', serialNumber: 'DUP-1' },
        { path: '/dev/ttyUSB1', vendorId: '1a86', productId: '7523', serialNumber: 'DUP-1' },
      ],
      readByIdDirectory: async () => new Map(),
    },
  })
  const scan = await service.scan('serial', 'all')
  await assert.rejects(
    service.resolveSerialTarget({
      type: 'serial',
      port: scan.devices[0].path,
      baudRate: 57600,
      deviceId: scan.devices[0].deviceId,
    }),
    (error: unknown) =>
      error instanceof ConnectionResolutionError && error.code === 'IDENTITY_AMBIGUOUS',
  )
})

test('legacy path-only configs resolve without identity enforcement', async () => {
  const { service } = makeService()
  const resolved = await service.resolveSerialTarget({
    type: 'serial',
    port: '/dev/ttyUSB7',
    baudRate: 115200,
  })
  assert.equal(resolved.path, '/dev/ttyUSB7')
  assert.equal(resolved.identity, null)
})
