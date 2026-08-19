import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { LinuxRfcommConnection } from './LinuxRfcommConnection'
import { parseLinuxRfcommPath } from './BluetoothConnection'

class FakeBridgeProcess extends EventEmitter {
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.signalCode = signal
    queueMicrotask(() => this.emit('exit', null, signal))
    return true
  }
}

test('Linux RFCOMM virtual paths preserve a stable address and channel', () => {
  assert.deepEqual(parseLinuxRfcommPath('bt-rfcomm://08fad1176949/1'), {
    address: '08:FA:D1:17:69:49',
    channel: 1,
  })
  assert.equal(parseLinuxRfcommPath('bt-rfcomm://08fad1176949/31'), null)
  assert.equal(LinuxRfcommConnection.supports('/dev/rfcomm0'), false)
})

test('Linux RFCOMM bridge transports bytes and closes the owned process', async () => {
  const process = new FakeBridgeProcess()
  let target: { address: string; channel: number } | null = null
  const link = new LinuxRfcommConnection({
    processFactory: (address, channel) => {
      target = { address, channel }
      return process as unknown as ChildProcessWithoutNullStreams
    },
    closeTimeoutMs: 100,
  })
  const received: Buffer[] = []
  const sent: number[] = []
  const stdin: Buffer[] = []
  link.on('data', (data: Buffer) => received.push(data))
  link.on('dataSent', (count: number) => sent.push(count))
  process.stdin.on('data', (data: Buffer) => stdin.push(Buffer.from(data)))

  const connecting = link.connect('bt-rfcomm://08fad1176949/1', 57600, 100)
  process.stderr.write('__OPENCONFIGURATOR_RFCOMM_OPEN__\n')
  await connecting
  assert.deepEqual(target, { address: '08:FA:D1:17:69:49', channel: 1 })
  assert.equal(link.connected, true)

  process.stdout.write(Buffer.from([0xfd, 1]))
  assert.equal(link.write(Buffer.from([2, 3])), true)
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(received.map((data) => [...data]), [[0xfd, 1]])
  assert.deepEqual(stdin.map((data) => [...data]), [[2, 3]])
  assert.deepEqual(sent, [2])

  await link.disconnect()
  assert.equal(link.connected, false)
  assert.equal(process.signalCode, 'SIGTERM')
})

test('Linux RFCOMM backpressure prioritizes critical traffic and evicts lower-priority frames', async () => {
  const process = new FakeBridgeProcess()
  const writes: number[] = []
  let firstWrite = true
  process.stdin.write = ((data: Uint8Array, callback?: (error?: Error | null) => void) => {
    writes.push(data[0])
    queueMicrotask(() => callback?.())
    if (firstWrite) {
      firstWrite = false
      return false
    }
    return true
  }) as typeof process.stdin.write
  const link = new LinuxRfcommConnection({
    processFactory: () => process as unknown as ChildProcessWithoutNullStreams,
    maxQueuedFrames: 2,
    maxQueuedBytes: 64,
  })
  const overflows: Array<{ droppedPriority?: string; incomingPriority?: string; evicted?: boolean }> = []
  link.on('overflow', (details) => overflows.push(details))

  const connecting = link.connect('bt-rfcomm://08fad1176949/1', 57600, 100)
  process.stderr.write('__OPENCONFIGURATOR_RFCOMM_OPEN__\n')
  await connecting

  assert.equal(link.write(Buffer.from([0]), 'normal'), true)
  assert.equal(link.write(Buffer.from([1]), 'high'), true)
  assert.equal(link.write(Buffer.from([2]), 'high'), true)
  assert.equal(link.write(Buffer.from([3]), 'critical'), true)
  assert.equal(overflows.length, 1)
  assert.equal(overflows[0].droppedPriority, 'high')
  assert.equal(overflows[0].incomingPriority, 'critical')
  assert.equal(overflows[0].evicted, true)

  process.stdin.emit('drain')
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(writes, [0, 3, 1])
  await link.disconnect()
})

test('Linux RFCOMM bridge surfaces a stale pairing key as an actionable error', async () => {
  const process = new FakeBridgeProcess()
  const link = new LinuxRfcommConnection({
    processFactory: () => process as unknown as ChildProcessWithoutNullStreams,
  })
  const connecting = link.connect('bt-rfcomm://08fad1176949/1', 57600, 100)
  process.stderr.write('BLUEZ_CONNECT_ERROR: org.bluez.Error.Failed: br-connection-key-missing\n')
  process.exitCode = 1
  process.emit('exit', 1, null)
  await assert.rejects(connecting, /配对密钥已失效.*重新配对/)
})
