import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import {
  BluetoothConnection,
  BluetoothPortResolutionError,
  type BluetoothPortRecord,
} from './BluetoothConnection'
import {
  BluetoothWorker,
  type BluetoothSerialLink,
  type ReconnectProgress,
  type ReconnectTerminalReason,
} from './BluetoothWorker'

class FakeBluetoothLink extends EventEmitter implements BluetoothSerialLink {
  connected = false
  connectCalls = 0
  disconnectCalls = 0
  writes: Buffer[] = []
  pendingConnect = false
  pendingDisconnect = false
  disconnectError: Error | null = null
  connectError: Error | null = null
  private resolveConnect: (() => void) | null = null
  private rejectConnect: ((error: Error) => void) | null = null
  private resolveDisconnect: (() => void) | null = null

  connect(): Promise<void> {
    this.connectCalls += 1
    if (this.connectError) return Promise.reject(this.connectError)
    if (!this.pendingConnect) {
      this.connected = true
      return Promise.resolve()
    }
    return new Promise<void>((resolve, reject) => {
      this.resolveConnect = () => {
        this.connected = true
        resolve()
      }
      this.rejectConnect = reject
    })
  }

  succeedConnect(): void {
    this.resolveConnect?.()
    this.resolveConnect = null
    this.rejectConnect = null
  }

  disconnect(): Promise<void> {
    this.disconnectCalls += 1
    this.connected = false
    this.rejectConnect?.(new Error('connect cancelled by disconnect'))
    this.resolveConnect = null
    this.rejectConnect = null
    if (this.disconnectError) return Promise.reject(this.disconnectError)
    if (!this.pendingDisconnect) return Promise.resolve()
    return new Promise<void>((resolve) => {
      this.resolveDisconnect = resolve
    })
  }

  finishDisconnect(): void {
    this.resolveDisconnect?.()
    this.resolveDisconnect = null
  }

  write(data: Buffer): boolean {
    if (!this.connected) return false
    this.writes.push(Buffer.from(data))
    return true
  }
}

test('failed Linux RFCOMM open invalidates the resolved SPP channel', async () => {
  const link = new FakeBluetoothLink()
  link.connectError = new Error('RFCOMM channel refused')
  const invalidated: string[] = []
  const path = 'bt-rfcomm://08fad1176949/3'
  const worker = new BluetoothWorker({
    type: 'bluetooth',
    port: path,
    baudRate: 57600,
    bluetoothAddress: '08:FA:D1:17:69:49',
  }, {
    linkFactory: () => link,
    resolvePort: async () => path,
    invalidateSppChannel: (address) => invalidated.push(address),
  })

  await assert.rejects(worker.connect(), /RFCOMM channel refused/)
  assert.deepEqual(invalidated, ['08:FA:D1:17:69:49'])
})

const config = {
  type: 'bluetooth' as const,
  port: 'MicoAir SPP',
  baudRate: 57600,
  vendorId: '0001',
  productId: '000A',
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const windowsPort = (path: string, suffix = ''): BluetoothPortRecord => ({
  path,
  manufacturer: 'Microsoft Bluetooth',
  pnpId: `BTHENUM\\{00001101-0000-1000-8000-00805F9B34FB}_VID&0001_PID&000A\\7&ABC&0&001122334455_C${suffix}`,
})

test('Windows VID/PID matching canonicalizes leading zeroes', async () => {
  const result = await BluetoothConnection.findPortByIds(
    { vendorId: '0001', productId: '000A' },
    { platform: 'win32', listPorts: async () => [windowsPort('COM7')] },
  )
  assert.equal(result, 'COM7')
})

test('Windows Bluetooth service UUID matching accepts the common braced form', async () => {
  const customServicePort = {
    ...windowsPort('COM8'),
    pnpId: windowsPort('COM8').pnpId!.replace('00001101', '00001234'),
  }
  const result = await BluetoothConnection.findPortByIds(
    {
      vendorId: '0001',
      productId: '000A',
      bluetoothServiceClassId: '{00001234-0000-1000-8000-00805f9b34fb}',
    },
    { platform: 'win32', listPorts: async () => [customServicePort] },
  )
  assert.equal(result, 'COM8')
})

test('ambiguous Bluetooth identities fail closed', async () => {
  await assert.rejects(
    BluetoothConnection.findPortByIds(
      { vendorId: '0001', productId: '000A' },
      {
        platform: 'win32',
        listPorts: async () => [windowsPort('COM7', '1'), windowsPort('COM9', '2')],
      },
    ),
    (error: unknown) =>
      error instanceof BluetoothPortResolutionError
      && error.code === 'AMBIGUOUS'
      && error.candidates.length === 2,
  )
})

test('product-only selectors match uniquely and unmatched labels never fall back', async () => {
  const ports = [windowsPort('COM7'), {
    ...windowsPort('COM9'),
    pnpId: windowsPort('COM9').pnpId!.replace('_PID&000A', '_PID&000B'),
  }]
  const product = await BluetoothConnection.findPortByIds(
    { productId: '000B' },
    { platform: 'win32', listPorts: async () => ports },
  )
  assert.equal(product, 'COM9')

  const missing = await BluetoothConnection.findPortByIds(
    { label: 'device-that-does-not-exist' },
    { platform: 'win32', listPorts: async () => [windowsPort('COM7')] },
  )
  assert.equal(missing, null)
})

test('malformed or incomplete Bluetooth identity evidence fails closed', async () => {
  await assert.rejects(
    BluetoothConnection.findPortByIds(
      { label: 'COM7', vendorId: 'not-hex' },
      { platform: 'win32', listPorts: async () => [windowsPort('COM7')] },
    ),
    (error: unknown) =>
      error instanceof BluetoothPortResolutionError
      && error.code === 'IDENTITY_MISMATCH',
  )

  await assert.rejects(
    BluetoothConnection.findPortByIds(
      {
        bluetoothAddress: '00:11:22:33:44:55',
        vendorId: '0002',
        productId: '000A',
      },
      { platform: 'win32', listPorts: async () => [windowsPort('COM7')] },
    ),
    (error: unknown) =>
      error instanceof BluetoothPortResolutionError
      && error.code === 'IDENTITY_MISMATCH',
  )
})

test('Linux rfcomm and macOS SPP paths are recognized without arbitrary fallback', async () => {
  const linux = await BluetoothConnection.scanDevices({
    platform: 'linux',
    listPorts: async () => [{ path: '/dev/rfcomm0' }, { path: '/dev/ttyUSB0' }],
    linuxPairedDevices: async () => [],
  })
  assert.deepEqual(linux.map((port) => port.path), ['/dev/rfcomm0'])

  const mac = await BluetoothConnection.scanDevices({
    platform: 'darwin',
    listPorts: async () => [
      { path: '/dev/cu.MicoAir-SPP' },
      { path: '/dev/cu.Bluetooth-Incoming-Port', manufacturer: 'IOBluetooth' },
      { path: '/dev/cu.usbserial-1234' },
    ],
  })
  assert.deepEqual(mac.map((port) => port.path), ['/dev/cu.MicoAir-SPP'])
})

test('Linux paired BlueZ SPP devices are exposed and service-only selection stays unique', async () => {
  const paired = {
    path: 'bt-rfcomm://08fad1176949/1',
    manufacturer: 'BlueZ',
    friendlyName: 'MicoAir743v2-94296',
    bluetoothAddress: '08:FA:D1:17:69:49',
    bluetoothChannel: 1,
    bluetoothServiceClassId: '0x1101',
  }
  const dependencies = {
    platform: 'linux' as const,
    listPorts: async () => [],
    linuxPairedDevices: async () => [paired],
  }
  const scanned = await BluetoothConnection.scanDevices(dependencies)
  assert.equal(scanned.length, 1)
  assert.equal(scanned[0].path, paired.path)
  assert.equal(scanned[0].transport, 'bluetooth-spp')
  assert.equal(scanned[0].bluetoothAddress, '08:FA:D1:17:69:49')
  assert.equal(scanned[0].bluetoothChannel, 1)
  assert.equal(scanned[0].bluetoothServiceClassId, '0x1101')
  assert.equal(scanned[0].availability, 'paired')
  assert.equal(scanned[0].requiresDeepResolution, false)
  assert.equal(scanned[0].recommended, true)
  assert.ok(scanned[0].deviceId?.startsWith('bt-spp:'))
  assert.equal(await BluetoothConnection.findPortByIds(
    { bluetoothServiceClassId: '0x1101', label: 'Bluetooth SPP 0x1101' },
    dependencies,
  ), paired.path)
  assert.equal(await BluetoothConnection.findPortByIds(
    { bluetoothAddress: '08:FA:D1:17:69:49' },
    dependencies,
  ), paired.path)
})

test('disconnect reaches and waits for a provisional in-flight serial connection', async () => {
  const link = new FakeBluetoothLink()
  link.pendingConnect = true
  const worker = new BluetoothWorker(config, {
    serialFactory: () => link,
    resolvePort: async () => 'COM7',
    disconnectTimeoutMs: 100,
  })

  const connecting = worker.connect()
  await delay(0)
  const disconnecting = worker.disconnect()
  await disconnecting
  await assert.rejects(connecting, /cancelled|取消/i)

  assert.equal(link.disconnectCalls, 1)
  assert.equal(worker.transportOpen, false)
  assert.equal(worker.vehicleReady, false)
})

test('disconnect cancels a hung Bluetooth port-resolution attempt immediately', async () => {
  const worker = new BluetoothWorker(config, {
    resolvePort: () => new Promise<string | null>(() => undefined),
    openTimeoutMs: 5_000,
    disconnectTimeoutMs: 100,
  })
  const connecting = worker.connect().then(
    () => null,
    (error: unknown) => error,
  )
  await delay(0)

  const startedAt = Date.now()
  await worker.disconnect()
  const elapsed = Date.now() - startedAt
  const cancellation = await connecting

  assert.ok(cancellation instanceof Error)
  assert.match(cancellation.message, /已取消/)
  assert.ok(elapsed < 80, `disconnect waited for port resolution (${elapsed}ms)`)
  assert.equal(worker.transportOpen, false)
})

test('transport data flows before validated heartbeat confirms vehicle readiness', async () => {
  const link = new FakeBluetoothLink()
  const worker = new BluetoothWorker(config, {
    serialFactory: () => link,
    resolvePort: async () => 'COM7',
    vehicleConfirmTimeoutMs: 100,
  })
  const data: Buffer[] = []
  worker.on('data', (chunk: Buffer) => data.push(chunk))

  await worker.connect()
  assert.equal(worker.transportOpen, true)
  assert.equal(worker.vehicleReady, false)

  link.emit('data', Buffer.from([0xfd, 1]))
  assert.deepEqual(data.map((chunk) => [...chunk]), [[0xfd, 1]])
  assert.equal(worker.vehicleReady, false, 'raw bytes must not confirm the vehicle')

  worker.confirmVehicleHeartbeat()
  assert.equal(worker.vehicleReady, true)
  await worker.disconnect()
})

test('heartbeat confirmation received before transport-open cannot leak into the new session', async () => {
  const link = new FakeBluetoothLink()
  link.pendingConnect = true
  const worker = new BluetoothWorker(config, {
    serialFactory: () => link,
    resolvePort: async () => 'COM7',
    vehicleConfirmTimeoutMs: 100,
  })

  const connecting = worker.connect()
  await delay(0)
  worker.confirmVehicleHeartbeat()
  assert.equal(worker.vehicleReady, false)

  link.succeedConnect()
  await connecting
  assert.equal(worker.transportOpen, true)
  assert.equal(worker.vehicleReady, false)

  worker.confirmVehicleHeartbeat()
  assert.equal(worker.vehicleReady, true)
  await worker.disconnect()
})

test('reconnect keeps the last error and waits for a new validated heartbeat', async () => {
  const first = new FakeBluetoothLink()
  const second = new FakeBluetoothLink()
  const links = [first, second]
  const progress: ReconnectProgress[] = []
  const worker = new BluetoothWorker(config, {
    serialFactory: () => links.shift()!,
    resolvePort: async () => 'COM7',
    reconnectBaseIntervalMs: 1,
    maxReconnectIntervalMs: 1,
    vehicleConfirmTimeoutMs: 100,
  })
  worker.on('reconnecting', (item: ReconnectProgress) => progress.push(item))

  await worker.connect()
  worker.confirmVehicleHeartbeat()
  first.emit('error', new Error('radio dropped'))
  await delay(15)

  assert.equal(second.connectCalls, 1)
  assert.equal(worker.transportOpen, true)
  assert.equal(worker.vehicleReady, false)
  second.emit('data', Buffer.from([1]))
  assert.equal(worker.vehicleReady, false)
  assert.equal(progress[0]?.lastError, 'radio dropped')

  worker.confirmVehicleHeartbeat()
  assert.equal(worker.vehicleReady, true)
  assert.equal(worker.lastReconnectError, null)
  await worker.disconnect()
})

test('deterministic port resolution failures stop reconnecting immediately', async () => {
  const first = new FakeBluetoothLink()
  let resolutionCalls = 0
  const progress: ReconnectProgress[] = []
  const worker = new BluetoothWorker(config, {
    serialFactory: () => first,
    resolvePort: async () => {
      resolutionCalls += 1
      if (resolutionCalls === 1) return 'COM7'
      throw new BluetoothPortResolutionError(
        'multiple matching Bluetooth ports',
        'AMBIGUOUS',
        ['COM7', 'COM9'],
      )
    },
    reconnectBaseIntervalMs: 1,
    maxReconnectIntervalMs: 1,
  })
  worker.on('reconnecting', (item: ReconnectProgress) => progress.push(item))
  const terminalEvent = new Promise<ReconnectTerminalReason>((resolve) => {
    worker.once('terminal', resolve)
  })

  await worker.connect()
  worker.confirmVehicleHeartbeat()
  first.emit('error', new Error('radio dropped'))
  const reason = await terminalEvent
  await delay(10)

  assert.equal(reason.code, 'AMBIGUOUS')
  assert.equal(resolutionCalls, 2, 'the deterministic failure must not be retried')
  assert.equal(progress.length, 1)
  assert.equal(worker.transportOpen, false)
})
test('heartbeat confirmation exhaustion produces a structured terminal reason', async () => {
  const links = [new FakeBluetoothLink(), new FakeBluetoothLink()]
  const worker = new BluetoothWorker(config, {
    serialFactory: () => links.shift()!,
    resolvePort: async () => 'COM7',
    maxReconnectAttempts: 1,
    reconnectBaseIntervalMs: 1,
    maxReconnectIntervalMs: 1,
    vehicleConfirmTimeoutMs: 5,
  })
  const terminalEvent = new Promise<ReconnectTerminalReason>((resolve) => {
    worker.on('terminal', (reason: ReconnectTerminalReason) => {
      resolve(reason)
    })
  })

  await worker.connect()
  const terminal = await Promise.race([
    terminalEvent,
    delay(250).then(() => {
      throw new Error('timed out waiting for terminal reconnect reason')
    }),
  ])

  assert.equal(terminal.code, 'MAX_ATTEMPTS')
  assert.match(terminal.message, /飞控心跳/)
  assert.equal(worker.transportOpen, false)
  assert.equal(worker.vehicleReady, false)
})

test('failed teardown becomes terminal and never opens a replacement over the retained handle', async () => {
  const first = new FakeBluetoothLink()
  first.disconnectError = new Error('driver refused close')
  const created: FakeBluetoothLink[] = []
  const worker = new BluetoothWorker(config, {
    serialFactory: () => {
      const link = created.length === 0 ? first : new FakeBluetoothLink()
      created.push(link)
      return link
    },
    resolvePort: async () => 'COM7',
    reconnectBaseIntervalMs: 1,
    maxReconnectIntervalMs: 1,
  })
  const terminalEvent = new Promise<ReconnectTerminalReason>((resolve) => {
    worker.once('terminal', resolve)
  })

  await worker.connect()
  first.emit('error', new Error('radio dropped'))
  const reason = await terminalEvent

  assert.equal(reason.code, 'CLOSE_FAILED')
  assert.equal(created.length, 1)
  assert.equal(worker.transportOpen, false)

  first.disconnectError = null
  await worker.disconnect()
})
