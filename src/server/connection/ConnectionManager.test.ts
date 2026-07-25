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
