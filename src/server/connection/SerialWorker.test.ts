import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { SerialWorker, type SerialWorkerLink } from './SerialWorker'
import { ConnectionResolutionError } from './ConnectionDiscoveryService'
import type { ConnectionConfig, PortInfo } from '../../shared/types'

class FakeSerialLink extends EventEmitter implements SerialWorkerLink {
  connected = false
  connectCalls: string[] = []
  disconnectCalls = 0
  failConnect = false
  writes: Buffer[] = []

  connect(path: string): Promise<void> {
    this.connectCalls.push(path)
    if (this.failConnect) return Promise.reject(new Error(`open failed: ${path}`))
    this.connected = true
    return Promise.resolve()
  }

  disconnect(): Promise<void> {
    this.disconnectCalls += 1
    this.connected = false
    return Promise.resolve()
  }

  write(data: Buffer): boolean {
    if (!this.connected) return false
    this.writes.push(Buffer.from(data))
    return true
  }
}

const config: ConnectionConfig = {
  type: 'serial',
  port: '/dev/ttyACM0',
  baudRate: 57600,
  deviceId: 'serial:abc',
  serialNumber: 'S-1',
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const identity = (path: string): PortInfo => ({
  path,
  transport: 'serial',
  deviceId: 'serial:abc',
  serialNumber: 'S-1',
})

function makeWorker(
  links: FakeSerialLink[],
  resolvePaths: string[],
  options: Partial<ConstructorParameters<typeof SerialWorker>[1]> = {},
) {
  let resolveIndex = 0
  const worker = new SerialWorker(config, {
    serialFactory: () => links.shift() ?? new FakeSerialLink(),
    resolveTarget: async () => {
      const path = resolvePaths[Math.min(resolveIndex, resolvePaths.length - 1)]
      resolveIndex += 1
      return { path, identity: identity(path) }
    },
    reconnectBackoffScheduleMs: [1, 1, 1],
    maxReconnectAttempts: 3,
    rebootDelayMs: 1,
    rebootGraceMs: 10_000,
    openTimeoutMs: 500,
    ...options,
  })
  return { worker, resolutionCount: () => resolveIndex }
}

test('ordinary drop enters bounded recovery and reports terminal after exhausting attempts', async () => {
  const first = new FakeSerialLink()
  const retryLinks = [
    Object.assign(new FakeSerialLink(), { failConnect: true }),
    Object.assign(new FakeSerialLink(), { failConnect: true }),
    Object.assign(new FakeSerialLink(), { failConnect: true }),
  ]
  const { worker } = makeWorker([first, ...retryLinks], ['/dev/ttyACM0'])
  const progress: unknown[] = []
  worker.on('reconnecting', (event) => progress.push(event))

  await worker.connect()
  assert.equal(worker.transportOpen, true)

  first.emit('disconnected')
  await delay(30)

  assert.equal(worker.terminalReason?.code, 'MAX_ATTEMPTS')
  assert.equal(worker.transportOpen, false)
  assert.equal(progress.length, 3)
  assert.ok(retryLinks.every((link) => link.connectCalls.length === 1))
})

test('recovery re-resolves the stable identity and follows a changed path', async () => {
  const first = new FakeSerialLink()
  const second = new FakeSerialLink()
  const { worker } = makeWorker([first, second], ['/dev/ttyACM0', '/dev/ttyACM1'])
  const events: string[] = []
  worker.on('transportDisconnected', () => events.push('dropped'))
  worker.on('reconnecting', () => events.push('retry'))
  worker.on('transportConnected', () => events.push('reopened'))

  await worker.connect()
  assert.equal(worker.resolvedPort, '/dev/ttyACM0')

  first.emit('error', new Error('usb unplugged'))
  for (let i = 0; i < 30 && second.connectCalls.length === 0; i++) await delay(2)

  assert.equal(second.connectCalls[0], '/dev/ttyACM1')
  assert.equal(worker.resolvedPort, '/dev/ttyACM1')
  assert.equal(worker.transportOpen, true)
  assert.deepEqual(events, ['reopened', 'dropped', 'retry', 'reopened'])
})

test('identity ambiguity terminates immediately instead of guessing', async () => {
  const first = new FakeSerialLink()
  let resolution = 0
  let linksIssued = 0
  const worker = new SerialWorker(config, {
    serialFactory: () => {
      linksIssued += 1
      if (linksIssued === 1) return first
      throw new Error('no link must be created for an ambiguous target')
    },
    resolveTarget: async () => {
      resolution += 1
      if (resolution === 1) return { path: '/dev/ttyACM0', identity: identity('/dev/ttyACM0') }
      throw new ConnectionResolutionError(
        '多个设备匹配同一身份。',
        'IDENTITY_AMBIGUOUS',
      )
    },
    reconnectBackoffScheduleMs: [1],
    maxReconnectAttempts: 5,
    openTimeoutMs: 500,
  })

  await worker.connect()
  first.emit('disconnected')
  await delay(20)

  assert.equal(worker.terminalReason?.code, 'IDENTITY_AMBIGUOUS')
  assert.equal(resolution, 2)
})

test('a vanished device keeps its bounded retry budget', async () => {
  const first = new FakeSerialLink()
  let resolution = 0
  const worker = new SerialWorker(config, {
    serialFactory: () => first,
    resolveTarget: async () => {
      resolution += 1
      if (resolution === 1) return { path: '/dev/ttyACM0', identity: identity('/dev/ttyACM0') }
      throw new ConnectionResolutionError('设备不存在。', 'DEVICE_NOT_FOUND')
    },
    reconnectBackoffScheduleMs: [1, 1],
    maxReconnectAttempts: 2,
    openTimeoutMs: 500,
  })

  await worker.connect()
  first.emit('disconnected')
  await delay(30)

  assert.equal(worker.terminalReason?.code, 'MAX_ATTEMPTS')
  assert.equal(resolution, 3, 'initial resolution + two retries')
})

test('expected reboot uses the long grace schedule inside one state machine', async () => {
  const first = new FakeSerialLink()
  const second = new FakeSerialLink()
  const { worker } = makeWorker([first, second], ['/dev/ttyACM0'], {
    rebootGraceMs: 5000,
    rebootMaxAttempts: 12,
  })

  await worker.connect()
  assert.equal(worker.expectVehicleReboot(), true)
  assert.equal(worker.vehicleReady, false)
  assert.equal(worker.expectedRebootActive, true)

  first.emit('disconnected')
  for (let i = 0; i < 30 && second.connectCalls.length === 0; i++) await delay(2)

  assert.equal(second.connectCalls.length, 1)
  assert.equal(worker.transportOpen, true)
  assert.equal(worker.vehicleReady, false, 'reopen alone never proves vehicle readiness')

  worker.confirmVehicleHeartbeat()
  assert.equal(worker.vehicleReady, true)
  // The manager cancels the shared window once it accepts the heartbeat.
  worker.cancelExpectedVehicleReboot()
  assert.equal(worker.expectedRebootActive, false)
  assert.equal(worker.terminalReason, null)
})

test('reboot grace expiry is terminal rather than an infinite loop', async () => {
  const first = new FakeSerialLink()
  const slowReappear = new FakeSerialLink()
  slowReappear.connect = () => new Promise((_resolve, reject) => {
    setTimeout(() => reject(new Error('still gone')), 30)
  })
  const { worker } = makeWorker([first, slowReappear], ['/dev/ttyACM0'], {
    rebootGraceMs: 15,
    rebootMaxAttempts: 99,
  })

  await worker.connect()
  worker.expectVehicleReboot(15)
  first.emit('disconnected')
  await delay(120)

  assert.equal(worker.terminalReason?.code, 'REBOOT_WINDOW_EXPIRED')
})

test('reboot recovery keeps retrying past the minimum attempt count while grace remains', async () => {
  const first = new FakeSerialLink()
  const recovered = new FakeSerialLink()
  let resolution = 0
  const worker = new SerialWorker(config, {
    serialFactory: () => resolution <= 1 ? first : recovered,
    resolveTarget: async () => {
      resolution += 1
      if (resolution === 1 || resolution >= 6) {
        return { path: '/dev/ttyACM0', identity: identity('/dev/ttyACM0') }
      }
      throw new ConnectionResolutionError('设备仍在重启。', 'DEVICE_NOT_FOUND')
    },
    rebootDelayMs: 1,
    rebootMaxAttempts: 2,
    rebootGraceMs: 1000,
    openTimeoutMs: 500,
  })

  await worker.connect()
  worker.expectVehicleReboot()
  first.emit('disconnected')
  for (let index = 0; index < 100 && !worker.transportOpen; index += 1) await delay(2)

  assert.equal(resolution, 6, 'four missing-device retries must not exhaust a two-attempt minimum')
  assert.equal(worker.transportOpen, true)
  assert.equal(worker.terminalReason, null)
  await worker.disconnect()
})

test('explicit disconnect immediately cancels a hung serial target resolution', async () => {
  const worker = new SerialWorker(config, {
    resolveTarget: () => new Promise(() => undefined),
    openTimeoutMs: 5000,
    disconnectTimeoutMs: 500,
  })
  const connecting = worker.connect()
  void connecting.catch(() => undefined)
  await delay(0)
  const startedAt = Date.now()

  await worker.disconnect()

  assert.ok(Date.now() - startedAt < 200, 'disconnect must not wait for the resolution timeout')
  await assert.rejects(connecting, /已取消/)
})

test('explicit disconnect cancels pending recovery and stops future attempts', async () => {
  const first = new FakeSerialLink()
  const later: FakeSerialLink[] = []
  const { worker } = makeWorker(
    [first, ...later],
    ['/dev/ttyACM0'],
    { reconnectBackoffScheduleMs: [5], maxReconnectAttempts: 5 },
  )

  await worker.connect()
  first.emit('disconnected')
  await delay(1)
  await worker.disconnect()
  const disconnectCalls = first.disconnectCalls
  await delay(30)

  assert.equal(worker.transportOpen, false)
  assert.equal(worker.terminalReason, null)
  assert.equal(first.disconnectCalls, disconnectCalls)
})

test('late data from a dropped link generation never reaches the new transport', async () => {
  const first = new FakeSerialLink()
  const second = new FakeSerialLink()
  const { worker } = makeWorker([first, second], ['/dev/ttyACM0', '/dev/ttyACM0'])
  const received: number[] = []
  worker.on('data', (data: Buffer) => received.push(data[0]))

  await worker.connect()
  first.emit('disconnected')
  await delay(5)
  // The dropped link delivers stale bytes after recovery already started.
  first.emit('data', Buffer.from([0x01]))
  await delay(0)

  assert.deepEqual(received, [])
  assert.equal(worker.transportOpen, true)
})

test('initial resolution and open failures surface without silent retries', async () => {
  const worker = new SerialWorker(config, {
    serialFactory: () => new FakeSerialLink(),
    resolveTarget: async () => {
      throw new ConnectionResolutionError('目标设备不存在。', 'DEVICE_NOT_FOUND')
    },
    reconnectBackoffScheduleMs: [1],
    maxReconnectAttempts: 3,
    openTimeoutMs: 500,
  })
  await assert.rejects(worker.connect(), /目标设备不存在/)

  const failingLink = Object.assign(new FakeSerialLink(), { failConnect: true })
  const openWorker = new SerialWorker(config, {
    serialFactory: () => failingLink,
    resolveTarget: async () => ({ path: '/dev/ttyACM0', identity: null }),
    reconnectBackoffScheduleMs: [1],
    maxReconnectAttempts: 3,
    openTimeoutMs: 500,
  })
  await assert.rejects(openWorker.connect(), /open failed/)
  await delay(10)
  assert.equal(failingLink.connectCalls.length, 1, 'initial failure must not auto-retry')
  assert.equal(openWorker.terminalReason, null)
})
