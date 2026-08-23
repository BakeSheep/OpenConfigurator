import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import {
  ConnectionManager,
  type ConnectionErrorDetail,
  type ConnectionManagerOptions,
} from './ConnectionManager'
import type { ReconnectTerminalReason } from './BluetoothWorker'
import type { SerialWritePriority } from './SerialConnection'

class FakeSerialLink extends EventEmitter {
  connected = false
  connectCalls = 0
  disconnectCalls = 0
  writes: Buffer[] = []
  writePriorities: SerialWritePriority[] = []
  pendingDisconnect = false
  disconnectError: Error | null = null
  dataDuringConnect: Buffer | null = null
  pendingConnect = false
  private rejectConnectCallback: ((error: Error) => void) | null = null
  private finishDisconnectCallback: (() => void) | null = null

  async connect(): Promise<void> {
    this.connectCalls += 1
    if (this.pendingConnect) {
      await new Promise<void>((_resolve, reject) => {
        this.rejectConnectCallback = reject
      })
      return
    }
    this.connected = true
    if (this.dataDuringConnect) this.emit('data', this.dataDuringConnect)
  }

  disconnect(): Promise<void> {
    this.disconnectCalls += 1
    this.rejectConnectCallback?.(new Error('connect cancelled'))
    this.rejectConnectCallback = null
    if (this.disconnectError) return Promise.reject(this.disconnectError)
    this.connected = false
    if (!this.pendingDisconnect) return Promise.resolve()
    return new Promise<void>((resolve) => {
      this.finishDisconnectCallback = resolve
    })
  }

  finishDisconnect(): void {
    this.finishDisconnectCallback?.()
    this.finishDisconnectCallback = null
  }

  write(data: Buffer, priority: SerialWritePriority = 'normal'): boolean {
    if (!this.connected) return false
    this.writes.push(Buffer.from(data))
    this.writePriorities.push(priority)
    return true
  }
}

class FakeBluetoothLink extends EventEmitter {
  connected = false
  resolvedPort = 'COM_BT'
  terminalReason: ReconnectTerminalReason | null = null
  confirmCalls = 0
  forceReconnectReasons: string[] = []
  disconnectCalls = 0
  emitLifecycleDuringDisconnect = false

  async connect(): Promise<void> {
    this.connected = true
    this.emit('transportConnected')
    this.emit('connected')
  }

  async disconnect(): Promise<void> {
    this.disconnectCalls += 1
    if (this.emitLifecycleDuringDisconnect) {
      this.emit('vehicleReadyChange', true)
      this.emit('reconnecting', { attempt: 1, maxAttempts: 3, delayMs: 1 })
      this.emit('transportDisconnected')
      this.emit('terminal', {
        code: 'STALE_TERMINAL',
        message: 'stale terminal during explicit teardown',
        attempt: 1,
        timestamp: 1,
      } satisfies ReconnectTerminalReason)
    }
    this.connected = false
  }

  confirmVehicleHeartbeat(): void {
    this.confirmCalls += 1
    this.emit('vehicleReadyChange', true)
  }

  forceReconnect(reason?: string): void {
    this.forceReconnectReasons.push(reason ?? '')
  }

  write(): boolean {
    return this.connected
  }
}

const serialConfig = (port: string) => ({
  type: 'serial' as const,
  port,
  baudRate: 57600,
})

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

test('replacement connect waits for prior teardown and stale link callbacks are ignored', async () => {
  const first = new FakeSerialLink()
  first.pendingDisconnect = true
  const second = new FakeSerialLink()
  const links = [first, second]
  const manager = new ConnectionManager({
    serialFactory: () => links.shift()!,
  })

  await manager.connect(serialConfig('COM1'))
  manager.notifyAutopilotHeartbeat()
  assert.equal(manager.transportOpen, true)
  assert.equal(manager.vehicleReady, true)
  assert.equal(manager.write(Buffer.from([0xaa])), true)

  const replacing = manager.connect(serialConfig('COM2'))
  await delay(0)
  assert.equal(first.disconnectCalls, 1)
  assert.equal(second.connectCalls, 0, 'new port must wait until the old handle is released')
  assert.equal(manager.status, 'connecting')
  assert.equal(manager.transportOpen, false)
  assert.equal(manager.vehicleReady, false)
  assert.equal(manager.write(Buffer.from([0xbb])), false)
  assert.equal(first.writes.length, 1, 'writes must stop while the old native handle is closing')

  first.finishDisconnect()
  await replacing
  assert.equal(second.connectCalls, 1)
  assert.equal(manager.config?.port, 'COM2')
  const bytesBeforeStaleEvent = manager.bytesReceived
  first.emit('data', Buffer.from([1, 2, 3]))
  assert.equal(manager.bytesReceived, bytesBeforeStaleEvent)
  assert.equal(manager.status, 'connected')

  await manager.disconnect()
})

test('explicit disconnect rejects writes as soon as a slow native close starts', async () => {
  const link = new FakeSerialLink()
  link.pendingDisconnect = true
  const manager = new ConnectionManager({ serialFactory: () => link })

  await manager.connect(serialConfig('COM1'))
  manager.notifyAutopilotHeartbeat()
  assert.equal(manager.vehicleReady, true)
  assert.equal(manager.write(Buffer.from([0xaa])), true)

  const disconnecting = manager.disconnect()
  await delay(0)

  assert.equal(link.disconnectCalls, 1)
  assert.equal(manager.status, 'disconnected')
  assert.equal(manager.transportOpen, false)
  assert.equal(manager.vehicleReady, false)
  assert.equal(manager.write(Buffer.from([0xbb])), false)
  assert.equal(link.writes.length, 1, 'writes must stop before native disconnect resolves')

  link.finishDisconnect()
  await disconnecting

  assert.equal(manager.status, 'disconnected')
  assert.equal(manager.config, null)
  assert.equal(manager.transportOpen, false)
  assert.equal(manager.vehicleReady, false)
})

test('disconnect immediately cancels a provisional connect instead of waiting in the queue', async () => {
  const link = new FakeSerialLink()
  link.pendingConnect = true
  const manager = new ConnectionManager({ serialFactory: () => link })

  const connecting = manager.connect(serialConfig('COM_PENDING')).then(
    () => null,
    (error: unknown) => error,
  )
  await delay(0)
  assert.equal(manager.status, 'connecting')
  assert.equal(link.connectCalls, 1)

  const disconnecting = manager.disconnect()
  await delay(0)

  assert.equal(manager.status, 'disconnected')
  assert.equal(link.disconnectCalls, 1, 'provisional link must receive cancellation immediately')
  const cancellation = await connecting
  assert.ok(cancellation instanceof Error)
  assert.match(cancellation.message, /连接请求已取消/)
  await disconnecting
  assert.equal(manager.config, null)
  assert.equal(manager.lastError, null)
})

test('spontaneous serial errors share the operation queue with a following connect', async () => {
  const first = new FakeSerialLink()
  first.pendingDisconnect = true
  const second = new FakeSerialLink()
  const links = [first, second]
  const manager = new ConnectionManager({
    serialFactory: () => links.shift()!,
    serialAutoReconnect: false,
  })
  manager.on('connectionError', () => undefined)

  await manager.connect(serialConfig('COM1'))
  manager.notifyAutopilotHeartbeat()
  assert.equal(manager.vehicleReady, true)
  assert.equal(manager.write(Buffer.from([0xaa])), true)

  first.emit('error', new Error('cable removed'))
  await delay(0)

  assert.equal(first.disconnectCalls, 1)
  assert.equal(manager.status, 'error')
  assert.equal(manager.transportOpen, false)
  assert.equal(manager.vehicleReady, false)
  assert.equal(manager.write(Buffer.from([0xbb])), false)
  assert.equal(first.writes.length, 1, 'writes must stop while error cleanup is pending')

  const reconnecting = manager.connect(serialConfig('COM2'))
  await delay(0)
  assert.equal(second.connectCalls, 0)
  first.finishDisconnect()
  await reconnecting

  assert.equal(manager.status, 'connected')
  assert.equal(manager.config?.port, 'COM2')
  await manager.disconnect()
})

test('transport readiness is immediate but vehicle readiness requires heartbeat', async () => {
  const link = new FakeSerialLink()
  const manager = new ConnectionManager({ serialFactory: () => link })
  const readiness: boolean[] = []
  manager.on('vehicleReadyChange', (ready: boolean) => readiness.push(ready))

  await manager.connect(serialConfig('COM1'))
  assert.equal(manager.status, 'connected')
  assert.equal(manager.transportOpen, true)
  assert.equal(manager.vehicleReady, false)

  manager.notifyAutopilotActivity()
  assert.equal(manager.vehicleReady, false)
  manager.notifyAutopilotHeartbeat()
  assert.equal(manager.vehicleReady, true)
  assert.deepEqual(readiness, [true])
  assert.equal(manager.write(Buffer.from([0xcc]), 'critical'), true)
  assert.equal(link.writePriorities[0], 'critical')

  await manager.disconnect()
  assert.equal(manager.transportOpen, false)
  assert.equal(manager.vehicleReady, false)
})

test('pre-open bytes are replayed only after the new transport session is announced', async () => {
  const link = new FakeSerialLink()
  link.dataDuringConnect = Buffer.from([0xfd, 1, 2, 3])
  const manager = new ConnectionManager({ serialFactory: () => link })
  const sequence: string[] = []
  manager.on('transportChange', (open: boolean) => sequence.push(`transport:${open}`))
  manager.on('statusChange', (status: string) => sequence.push(`status:${status}`))
  manager.on('data', () => {
    sequence.push('data')
    manager.notifyAutopilotHeartbeat()
  })

  await manager.connect(serialConfig('COM1'))

  assert.ok(sequence.indexOf('transport:true') < sequence.indexOf('status:connected'))
  assert.ok(sequence.indexOf('status:connected') < sequence.indexOf('data'))
  assert.equal(manager.vehicleReady, true)
  await manager.disconnect()
})

test('valid activity grants only soft grace and cannot suppress the hard heartbeat deadline', async () => {
  let now = 0
  let heartbeatCheck: () => void = () => assert.fail('heartbeat monitor was not installed')
  const link = new FakeSerialLink()
  const options: ConnectionManagerOptions = {
    serialFactory: () => link,
    serialAutoReconnect: false,
    monotonicNow: () => now,
    setIntervalFn: (callback) => {
      heartbeatCheck = callback
      return 1 as unknown as ReturnType<typeof setInterval>
    },
    clearIntervalFn: () => undefined,
    serialSoftHeartbeatTimeoutMs: 5,
    serialHardHeartbeatTimeoutMs: 10,
    activityGraceMs: 5,
  }
  const manager = new ConnectionManager(options)
  manager.on('connectionError', () => undefined)

  await manager.connect(serialConfig('COM1'))
  now = 6
  manager.notifyAutopilotActivity()
  heartbeatCheck()
  await delay(0)
  assert.equal(link.disconnectCalls, 0, 'fresh activity should cover the soft deadline')

  now = 11
  manager.notifyAutopilotActivity()
  heartbeatCheck()
  await delay(0)
  await delay(0)

  assert.equal(link.disconnectCalls, 1, 'hard deadline must win even with fresh activity')
  assert.equal(manager.vehicleReady, false)
  assert.equal(manager.lastError?.phase, 'heartbeat')
  assert.equal(manager.status, 'disconnected')
})

test('expected reboot lowers readiness immediately and rejects the final stale heartbeat', async () => {
  let now = 100
  const link = new FakeSerialLink()
  const manager = new ConnectionManager({
    serialFactory: () => link,
    monotonicNow: () => now,
  })

  await manager.connect(serialConfig('COM1'))
  manager.notifyAutopilotHeartbeat()
  assert.equal(manager.vehicleReady, true)

  assert.equal(manager.expectVehicleReboot(), true)
  assert.equal(manager.vehicleReady, false, 'the reboot command invalidates physical readiness')

  now += 100
  manager.notifyAutopilotHeartbeat()
  assert.equal(manager.vehicleReady, false, 'a queued pre-reboot heartbeat must stay offline')

  now += 800
  manager.notifyAutopilotHeartbeat()
  assert.equal(manager.vehicleReady, true, 'a later heartbeat restores readiness')
  await manager.disconnect()
})

test('an expected flight-controller reboot automatically reopens serial and waits for heartbeat', async () => {
  const first = new FakeSerialLink()
  const second = new FakeSerialLink()
  const links = [first, second]
  const manager = new ConnectionManager({
    serialFactory: () => links.shift()!,
    serialAutoReconnect: false,
    rebootReconnectDelayMs: 1,
    rebootReconnectGraceMs: 500,
  })

  await manager.connect(serialConfig('COM1'))
  manager.notifyAutopilotHeartbeat()
  assert.equal(manager.expectVehicleReboot(), true)
  // A final heartbeat from the pre-reboot process must not cancel recovery.
  manager.notifyAutopilotHeartbeat()

  first.emit('disconnected')
  for (let i = 0; i < 30 && second.connectCalls === 0; i++) await delay(2)

  assert.equal(first.disconnectCalls, 1)
  assert.equal(second.connectCalls, 1)
  assert.equal(manager.status, 'connected')
  assert.equal(manager.transportOpen, true)
  assert.equal(manager.vehicleReady, false, 'transport reopen alone must not prove vehicle readiness')

  manager.notifyAutopilotHeartbeat()
  assert.equal(manager.vehicleReady, true)
  assert.equal(manager.reconnect, null)
  await manager.disconnect()
})

test('explicit disconnect cancels an expected reboot reconnect', async () => {
  const first = new FakeSerialLink()
  const second = new FakeSerialLink()
  const links = [first, second]
  const manager = new ConnectionManager({
    serialFactory: () => links.shift()!,
    serialAutoReconnect: false,
    rebootReconnectDelayMs: 20,
    rebootReconnectGraceMs: 500,
  })

  await manager.connect(serialConfig('COM1'))
  manager.notifyAutopilotHeartbeat()
  manager.expectVehicleReboot()
  first.emit('disconnected')
  await delay(1)
  await manager.disconnect()
  await delay(30)

  assert.equal(second.connectCalls, 0)
  assert.equal(manager.status, 'disconnected')
})

test('Bluetooth hard deadline clears readiness and requests worker reconnect', async () => {
  let now = 0
  let heartbeatCheck: () => void = () => assert.fail('heartbeat monitor was not installed')
  const link = new FakeBluetoothLink()
  const manager = new ConnectionManager({
    bluetoothFactory: () => link,
    monotonicNow: () => now,
    setIntervalFn: (callback) => {
      heartbeatCheck = callback
      return 1 as unknown as ReturnType<typeof setInterval>
    },
    clearIntervalFn: () => undefined,
    bluetoothSoftHeartbeatTimeoutMs: 5,
    bluetoothHardHeartbeatTimeoutMs: 10,
    activityGraceMs: 5,
  })

  await manager.connect({ type: 'bluetooth', port: 'COM_BT', baudRate: 57600 })
  manager.notifyAutopilotHeartbeat()
  assert.equal(manager.vehicleReady, true)
  assert.equal(link.confirmCalls, 1)

  now = 11
  manager.notifyAutopilotActivity()
  heartbeatCheck()

  assert.equal(manager.vehicleReady, false)
  assert.equal(link.forceReconnectReasons.length, 1)
  assert.match(link.forceReconnectReasons[0], /硬期限/)
  await manager.disconnect()
})

test('validated heartbeat clears a recovered Bluetooth reconnect error', async () => {
  const link = new FakeBluetoothLink()
  const manager = new ConnectionManager({ bluetoothFactory: () => link })
  manager.on('connectionError', () => undefined)

  await manager.connect({ type: 'bluetooth', port: 'COM_BT', baudRate: 57600 })
  link.emit('error', new Error('temporary radio failure'))
  link.emit('transportDisconnected')
  link.emit('reconnecting', {
    attempt: 1,
    maxAttempts: 3,
    delayMs: 1,
    lastError: 'temporary radio failure',
  })
  assert.equal(manager.lastError?.phase, 'reconnect')
  assert.equal(manager.status, 'reconnecting')

  link.emit('transportConnected')
  assert.equal(manager.status, 'connected')
  assert.equal(manager.vehicleReady, false)
  manager.notifyAutopilotHeartbeat()

  assert.equal(manager.vehicleReady, true)
  assert.equal(manager.lastError, null)
  await manager.disconnect()
})

test('Bluetooth terminal event is sufficient to serialize teardown and leave an error state', async () => {
  const link = new FakeBluetoothLink()
  const manager = new ConnectionManager({ bluetoothFactory: () => link })
  manager.on('connectionError', () => undefined)

  await manager.connect({ type: 'bluetooth', port: 'COM_BT', baudRate: 57600 })
  const terminal: ReconnectTerminalReason = {
    code: 'MAX_ATTEMPTS',
    message: 'vehicle heartbeat was never confirmed',
    attempt: 3,
    timestamp: 123,
  }
  link.terminalReason = terminal
  link.emit('terminal', terminal)
  link.emit('error', new Error(terminal.message))
  await delay(0)
  await delay(0)

  assert.equal(link.disconnectCalls, 1)
  assert.equal(manager.transportOpen, false)
  assert.equal(manager.vehicleReady, false)
  assert.equal(manager.status, 'error')
  assert.equal(manager.reconnectTerminalReason, terminal)
  assert.equal(manager.lastError?.code, 'MAX_ATTEMPTS')
})

test('explicit Bluetooth disconnect suppresses teardown-time reconnect lifecycle events', async () => {
  const link = new FakeBluetoothLink()
  link.emitLifecycleDuringDisconnect = true
  const manager = new ConnectionManager({ bluetoothFactory: () => link })
  const statuses: string[] = []
  manager.on('statusChange', (status: string) => statuses.push(status))

  await manager.connect({ type: 'bluetooth', port: 'COM_BT', baudRate: 57600 })
  statuses.length = 0
  await manager.disconnect()

  assert.deepEqual(statuses, ['disconnected', 'disconnected'])
  assert.equal(manager.transportOpen, false)
  assert.equal(manager.vehicleReady, false)
  assert.equal(manager.reconnect, null)
  assert.equal(manager.reconnectTerminalReason, null)
})

test('explicit disconnect publishes a final snapshot after clearing config and stale errors', async () => {
  const link = new FakeBluetoothLink()
  const manager = new ConnectionManager({ bluetoothFactory: () => link })
  manager.on('connectionError', () => undefined)
  await manager.connect({ type: 'bluetooth', port: 'COM_BT', baudRate: 57600 })
  link.emit('error', new Error('temporary radio warning'))
  assert.equal(manager.lastError?.phase, 'reconnect')

  const snapshots: Array<{
    port: string | undefined
    error: string | undefined
    transportOpen: boolean
  }> = []
  manager.on('statusChange', (status: string) => {
    if (status !== 'disconnected') return
    snapshots.push({
      port: manager.config?.port,
      error: manager.lastError?.message,
      transportOpen: manager.transportOpen,
    })
  })

  await manager.disconnect()

  assert.ok(snapshots.length >= 2)
  assert.ok(snapshots.every((snapshot) => snapshot.transportOpen === false))
  assert.deepEqual(snapshots[snapshots.length - 1], {
    port: undefined,
    error: undefined,
    transportOpen: false,
  })
  assert.equal(manager.config, null)
  assert.equal(manager.lastError, null)
})

test('teardown failures remain observable and prevent replacement from racing the handle', async () => {
  const first = new FakeSerialLink()
  first.disconnectError = new Error('close failed')
  const second = new FakeSerialLink()
  const links = [first, second]
  const manager = new ConnectionManager({ serialFactory: () => links.shift()! })
  const details: Array<ConnectionErrorDetail | null> = []
  manager.on('errorDetailChange', (detail: ConnectionErrorDetail | null) => details.push(detail))
  manager.on('connectionError', () => undefined)

  await manager.connect(serialConfig('COM1'))
  await assert.rejects(manager.connect(serialConfig('COM2')), /close failed/)

  assert.equal(second.connectCalls, 0)
  assert.equal(manager.status, 'error')
  assert.equal(manager.lastError?.phase, 'disconnect')
  assert.ok(details.some((detail) => detail?.message === 'close failed'))

  first.disconnectError = null
  await manager.connect(serialConfig('COM2'))
  assert.equal(second.connectCalls, 1)
  await manager.disconnect()
})

// ---------------------------------------------------------------------------
// Raw ESC session lifecycle (ADR-003/005).
// ---------------------------------------------------------------------------

test('raw session suspends the heartbeat monitor and drops vehicleReady', async () => {
  const link = new FakeSerialLink()
  const manager = new ConnectionManager({
    serialFactory: () => link,
    heartbeatCheckIntervalMs: 5,
    serialSoftHeartbeatTimeoutMs: 10,
    serialHardHeartbeatTimeoutMs: 20,
    activityGraceMs: 5,
  })
  const timeouts: unknown[] = []
  const rawSessionChanges: boolean[] = []
  manager.on('heartbeatTimeout', (detail) => timeouts.push(detail))
  manager.on('rawSessionChange', (active) => rawSessionChanges.push(active))
  manager.on('connectionError', () => undefined)

  await manager.connect(serialConfig('COM1'))
  manager.notifyAutopilotHeartbeat()
  assert.equal(manager.vehicleReady, true)

  const handle = manager.beginRawSession()
  assert.equal(manager.rawSessionActive, true)
  assert.equal(manager.vehicleReady, false, 'raw session must drop vehicleReady')

  // Well past the hard deadline: with the monitor suspended the link survives.
  await delay(60)
  assert.equal(timeouts.length, 0, 'heartbeat monitor must be suspended in raw mode')
  assert.equal(manager.status, 'connected')

  handle.release()
  assert.deepEqual(rawSessionChanges, [true, false], 'raw ownership changes are broadcast')
  await manager.disconnect()
})

test('raw session routes inbound bytes to the sink, not the data event', async () => {
  const link = new FakeSerialLink()
  const manager = new ConnectionManager({ serialFactory: () => link })
  const mavlinkData: Buffer[] = []
  manager.on('data', (data: Buffer) => mavlinkData.push(data))

  await manager.connect(serialConfig('COM1'))
  manager.notifyAutopilotHeartbeat()

  // Before the raw session, bytes flow to MAVLink.
  link.emit('data', Buffer.from([0x01]))
  assert.equal(mavlinkData.length, 1)

  const handle = manager.beginRawSession()
  const rawData: Buffer[] = []
  handle.onData((data) => rawData.push(data))

  link.emit('data', Buffer.from([0x2f, 0x30]))
  assert.equal(rawData.length, 1, 'raw bytes go to the sink')
  assert.deepEqual([...rawData[0]], [0x2f, 0x30])
  assert.equal(mavlinkData.length, 1, 'raw bytes must not reach the MAVLink data event')

  // Outbound writes use high priority.
  assert.equal(handle.write(Buffer.from([0xaa])), true)
  assert.equal(link.writePriorities[link.writePriorities.length - 1], 'high')

  // After release bytes flow to MAVLink again.
  handle.release()
  link.emit('data', Buffer.from([0x02]))
  assert.equal(mavlinkData.length, 2)

  await manager.disconnect()
})

test('link teardown invalidates the raw handle and fires onAborted', async () => {
  const link = new FakeSerialLink()
  const manager = new ConnectionManager({ serialFactory: () => link })
  manager.on('connectionError', () => undefined)

  await manager.connect(serialConfig('COM1'))
  manager.notifyAutopilotHeartbeat()
  const handle = manager.beginRawSession()
  const aborts: string[] = []
  handle.onAborted((reason) => aborts.push(reason))

  // Simulate a spontaneous serial disconnect.
  link.emit('disconnected')
  await delay(0)

  assert.equal(aborts.length, 1, 'onAborted must fire exactly once on teardown')
  assert.equal(manager.rawSessionActive, false)
  // A dead handle rejects further writes.
  assert.equal(handle.write(Buffer.from([0xaa])), false)

  await manager.disconnect()
})

test('raw session release is idempotent and restarts the monitor without vehicleReady', async () => {
  const link = new FakeSerialLink()
  const manager = new ConnectionManager({
    serialFactory: () => link,
    heartbeatCheckIntervalMs: 5,
    serialSoftHeartbeatTimeoutMs: 10,
    serialHardHeartbeatTimeoutMs: 20,
    activityGraceMs: 5,
  })
  manager.on('connectionError', () => undefined)

  await manager.connect(serialConfig('COM1'))
  manager.notifyAutopilotHeartbeat()
  const handle = manager.beginRawSession()

  handle.release()
  assert.equal(manager.rawSessionActive, false)
  assert.equal(manager.vehicleReady, false, 'release keeps vehicleReady false until a real heartbeat')

  // Second release is a no-op.
  handle.release()
  assert.equal(manager.rawSessionActive, false)

  // The restored monitor accepts a fresh heartbeat and raises readiness.
  manager.notifyAutopilotHeartbeat()
  assert.equal(manager.vehicleReady, true)

  await manager.disconnect()
})

test('beginRawSession rejects bluetooth links', async () => {
  const bt = new FakeBluetoothLink()
  const manager = new ConnectionManager({
    bluetoothFactory: () => bt as unknown as never,
  })
  await manager.connect({ type: 'bluetooth', port: 'COM_BT', baudRate: 57600 })
  manager.notifyAutopilotHeartbeat()
  assert.throws(() => manager.beginRawSession(), /仅支持串口/)
  await manager.disconnect()
})



// -- Managed serial recovery (Phase 4: serialAutoReconnect) -------------------

import { SerialWorker } from './SerialWorker'

class RecordingSerialLink extends FakeSerialLink {
  paths: string[] = []
  failConnect = false

  async connect(path?: string): Promise<void> {
    if (path !== undefined) this.paths.push(path)
    if (this.failConnect) return Promise.reject(new Error(`open failed: ${path}`))
    return super.connect()
  }
}

test('managed serial drop recovers with a new generation and waits for heartbeat', async () => {
  const first = new RecordingSerialLink()
  const second = new RecordingSerialLink()
  const links = [first, second]
  const paths = ['/dev/ttyACM0', '/dev/ttyACM1']
  let resolution = 0
  const manager = new ConnectionManager({
    serialAutoReconnect: true,
    serialWorkerFactory: (config) => new SerialWorker(config, {
      serialFactory: () => links.shift()!,
      resolveTarget: async () => {
        const path = paths[Math.min(resolution, paths.length - 1)]
        resolution += 1
        return { path, identity: null }
      },
      reconnectBackoffScheduleMs: [1],
      maxReconnectAttempts: 3,
      rebootDelayMs: 1,
      rebootGraceMs: 60_000,
      openTimeoutMs: 500,
    }),
  })

  await manager.connect(serialConfig('/dev/ttyACM0'))
  manager.notifyAutopilotHeartbeat()
  assert.equal(manager.vehicleReady, true)
  assert.equal(manager.config?.port, '/dev/ttyACM0')

  first.emit('disconnected')
  await delay(0)
  assert.equal(manager.status, 'reconnecting', 'an ordinary drop enters bounded recovery')
  assert.equal(manager.vehicleReady, false)
  assert.equal(manager.transportOpen, false)

  for (let i = 0; i < 30 && second.paths.length === 0; i += 1) await delay(2)
  assert.equal(second.paths[0], '/dev/ttyACM1', 'recovery follows the re-resolved path')
  assert.equal(manager.status, 'connected')
  assert.equal(manager.transportOpen, true)
  assert.equal(manager.vehicleReady, false, 'reopen alone never proves vehicle readiness')
  assert.equal(manager.config?.port, '/dev/ttyACM1')

  manager.notifyAutopilotHeartbeat()
  assert.equal(manager.vehicleReady, true)
  assert.equal(manager.reconnect, null)
  await manager.disconnect()
})

test('managed serial recovery exhaustion surfaces a terminal error state', async () => {
  const first = new RecordingSerialLink()
  const retries = [new RecordingSerialLink(), new RecordingSerialLink()]
  retries.forEach((link) => { link.failConnect = true })
  const links: FakeSerialLink[] = [first, ...retries]
  const manager = new ConnectionManager({
    serialAutoReconnect: true,
    serialWorkerFactory: (config) => new SerialWorker(config, {
      serialFactory: () => links.shift()!,
      resolveTarget: async () => ({ path: config.port, identity: null }),
      reconnectBackoffScheduleMs: [1, 1],
      maxReconnectAttempts: 2,
      rebootDelayMs: 1,
      rebootGraceMs: 60_000,
      openTimeoutMs: 500,
    }),
  })
  manager.on('connectionError', () => undefined)

  await manager.connect(serialConfig('/dev/ttyACM0'))
  first.emit('disconnected')
  for (let i = 0; i < 50 && manager.status !== 'error'; i += 1) await delay(2)

  assert.equal(manager.status, 'error')
  assert.equal(manager.reconnectTerminalReason?.code, 'MAX_ATTEMPTS')
  assert.equal(manager.transportOpen, false)
})

test('managed serial reboot window is delegated to the worker and ends on heartbeat', async () => {
  const first = new RecordingSerialLink()
  const second = new RecordingSerialLink()
  const links = [first, second]
  const statuses: string[] = []
  let worker: SerialWorker | null = null
  const manager = new ConnectionManager({
    serialAutoReconnect: true,
    serialWorkerFactory: (config) => {
      worker = new SerialWorker(config, {
        serialFactory: () => links.shift()!,
        resolveTarget: async () => ({ path: config.port, identity: null }),
        reconnectBackoffScheduleMs: [1],
        maxReconnectAttempts: 2,
        rebootDelayMs: 1,
        rebootGraceMs: 500,
        openTimeoutMs: 500,
      })
      return worker
    },
  })
  manager.on('statusChange', (status: string) => statuses.push(status))

  await manager.connect(serialConfig('COM1'))
  manager.notifyAutopilotHeartbeat()
  assert.equal(manager.expectVehicleReboot(), true)
  assert.equal(worker!.expectedRebootActive, true, 'manager delegates the reboot window')

  first.emit('disconnected')
  for (let i = 0; i < 30 && second.paths.length === 0; i += 1) await delay(2)

  assert.equal(second.paths.length, 1, 'reboot schedule reopens without user action')
  assert.equal(manager.status, 'connected')
  manager.notifyAutopilotHeartbeat()
  assert.equal(manager.vehicleReady, true)
  assert.equal(worker!.expectedRebootActive, false, 'validated heartbeat ends the window')
  assert.ok(statuses.includes('reconnecting'))
  await manager.disconnect()
})
