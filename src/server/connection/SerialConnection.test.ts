import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import {
  SerialConnection,
  type SerialPortLike,
  type SerialWriteOverflow,
} from './SerialConnection'

class FakeSerialPort extends EventEmitter implements SerialPortLike {
  isOpen = false
  openCalls = 0
  closeCalls = 0
  writes: Buffer[] = []
  writeCallbacks: Array<(error?: Error | null) => void> = []
  writeResults: boolean[] = []
  manualClose = false
  closeError: Error | null = null
  writeThrow: Error | null = null
  private closeCallback: ((error?: Error | null) => void) | null = null

  open(): void {
    this.openCalls += 1
  }

  succeedOpen(): void {
    this.isOpen = true
    this.emit('open')
  }

  failOpen(error: Error): void {
    this.emit('error', error)
  }

  close(callback?: (error?: Error | null) => void): void {
    this.closeCalls += 1
    if (this.manualClose) {
      this.closeCallback = callback ?? null
      return
    }
    if (this.closeError) {
      callback?.(this.closeError)
      return
    }
    this.finishClose()
    callback?.(null)
  }

  finishClose(error: Error | null = null): void {
    const callback = this.closeCallback
    this.closeCallback = null
    if (!error) {
      this.isOpen = false
      this.emit('close')
    }
    callback?.(error)
  }

  write(data: Buffer, callback?: (error?: Error | null) => void): boolean {
    if (this.writeThrow) throw this.writeThrow
    this.writes.push(Buffer.from(data))
    this.writeCallbacks.push(callback ?? (() => undefined))
    return this.writeResults.shift() ?? true
  }

  finishWrite(index: number, error: Error | null = null): void {
    this.writeCallbacks[index]?.(error)
  }

  drain(): void {
    this.emit('drain')
  }
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

test('late native open after timeout is immediately closed and fully detached', async () => {
  const port = new FakeSerialPort()
  const connection = new SerialConnection({
    portFactory: () => port,
    closeTimeoutMs: 100,
  })
  const diagnostics: string[] = []
  connection.on('diagnostic', ({ kind }) => diagnostics.push(kind))

  await assert.rejects(connection.connect('COM_TEST', 57600, 5), /超时/)
  assert.equal(connection.lifecycleState, 'closing')
  assert.equal(port.closeCalls, 0, 'close must not run while serialport is still opening')

  port.succeedOpen()
  await delay(0)

  assert.equal(port.closeCalls, 1)
  assert.equal(port.isOpen, false)
  assert.equal(connection.lifecycleState, 'idle')
  assert.equal(connection.connected, false)
  assert.equal(port.listenerCount('error'), 0)
  assert.deepEqual(diagnostics, [])
})

test('late native open error after timeout is absorbed by the provisional listener', async () => {
  const port = new FakeSerialPort()
  const connection = new SerialConnection({ portFactory: () => port })
  const diagnostics: string[] = []
  connection.on('diagnostic', ({ kind }) => diagnostics.push(kind))

  await assert.rejects(connection.connect('COM_TEST', 57600, 5), /超时/)
  port.failOpen(new Error('late binding failure'))
  await delay(0)

  assert.equal(connection.lifecycleState, 'idle')
  assert.equal(port.listenerCount('error'), 0)
  assert.ok(diagnostics.includes('latePortError'))
})

test('native close while opening rejects the connect promise', async () => {
  const port = new FakeSerialPort()
  const connection = new SerialConnection({ portFactory: () => port })

  const connecting = connection.connect('COM_TEST', 57600, 100)
  port.emit('close')

  await assert.rejects(connecting, /打开完成前已关闭/)
  assert.equal(connection.lifecycleState, 'idle')
  assert.equal(port.listenerCount('error'), 0)
})

test('an open error cannot leak a port that the native driver already marked open', async () => {
  const port = new FakeSerialPort()
  const connection = new SerialConnection({ portFactory: () => port })

  const connecting = connection.connect('COM_TEST', 57600)
  port.isOpen = true
  port.failOpen(new Error('open callback failed after handle allocation'))
  await assert.rejects(connecting, /handle allocation/)
  await delay(0)

  assert.equal(port.closeCalls, 1)
  assert.equal(port.isOpen, false)
  assert.equal(connection.lifecycleState, 'idle')
  assert.equal(port.listenerCount('error'), 0)
})

test('disconnect enters closing before an outstanding write callback can fail', async () => {
  const port = new FakeSerialPort()
  port.manualClose = true
  const connection = new SerialConnection({
    portFactory: () => port,
    closeTimeoutMs: 100,
  })
  const diagnostics: string[] = []
  connection.on('diagnostic', ({ kind }) => diagnostics.push(kind))

  const connecting = connection.connect('COM_TEST', 57600)
  port.succeedOpen()
  await connecting
  assert.equal(connection.write(Buffer.from([1, 2, 3])), true)

  const disconnecting = connection.disconnect()
  assert.equal(connection.lifecycleState, 'closing')
  assert.equal(connection.connected, false)
  port.finishWrite(0, new Error('write cancelled by close'))
  port.finishClose()
  await disconnecting

  assert.ok(diagnostics.includes('lateWriteError'))
  assert.equal(connection.lifecycleState, 'idle')
  assert.equal(port.listenerCount('error'), 0)
})

test('runtime write failure closes the transport even without a public error listener', async () => {
  const port = new FakeSerialPort()
  const connection = new SerialConnection({ portFactory: () => port })
  const diagnostics: string[] = []
  connection.on('diagnostic', ({ kind }) => diagnostics.push(kind))

  const connecting = connection.connect('COM_TEST', 57600)
  port.succeedOpen()
  await connecting
  connection.write(Buffer.from([9]))
  port.finishWrite(0, new Error('runtime write failure'))
  await delay(0)

  assert.equal(port.closeCalls, 1)
  assert.equal(port.isOpen, false)
  assert.equal(connection.lifecycleState, 'idle')
  assert.ok(diagnostics.includes('unhandledLinkError'))
})

test('synchronous native write failure is rejected and closes the transport', async () => {
  const port = new FakeSerialPort()
  const connection = new SerialConnection({ portFactory: () => port })
  const diagnostics: string[] = []
  connection.on('diagnostic', ({ kind }) => diagnostics.push(kind))

  const connecting = connection.connect('COM_TEST', 57600)
  port.succeedOpen()
  await connecting
  port.writeThrow = new Error('native write threw')

  assert.equal(connection.write(Buffer.from([7])), false)
  await delay(0)

  assert.equal(port.closeCalls, 1)
  assert.equal(connection.connected, false)
  assert.equal(connection.lifecycleState, 'idle')
  assert.ok(diagnostics.includes('unhandledLinkError'))
})

test('close failures reject disconnect and remain observable', async () => {
  const port = new FakeSerialPort()
  port.closeError = new Error('driver refused close')
  const connection = new SerialConnection({ portFactory: () => port })
  const closeErrors: Error[] = []
  connection.on('closeError', (error: Error) => closeErrors.push(error))

  const connecting = connection.connect('COM_TEST', 57600)
  port.succeedOpen()
  await connecting

  await assert.rejects(connection.disconnect(), /driver refused close/)
  assert.equal(closeErrors.length, 1)
  assert.equal(port.isOpen, true)

  port.closeError = null
  await connection.disconnect()
  assert.equal(port.isOpen, false)
  assert.equal(connection.lifecycleState, 'idle')
})

test('write backpressure uses a bounded FIFO and rejects the newest overflow', async () => {
  const port = new FakeSerialPort()
  port.writeResults = [false, true, true]
  const connection = new SerialConnection({
    portFactory: () => port,
    maxQueuedFrames: 2,
    maxQueuedBytes: 8,
  })
  const overflows: SerialWriteOverflow[] = []
  connection.on('overflow', (overflow: SerialWriteOverflow) => overflows.push(overflow))

  const connecting = connection.connect('COM_TEST', 57600)
  port.succeedOpen()
  await connecting

  assert.equal(connection.write(Buffer.from([1])), true)
  assert.equal(connection.write(Buffer.from([2, 2])), true)
  assert.equal(connection.write(Buffer.from([3, 3, 3])), true)
  assert.equal(connection.write(Buffer.from([4])), false)
  assert.equal(connection.pendingWriteBytes, 5)
  assert.equal(port.writes.length, 1)

  port.drain()
  assert.deepEqual(port.writes.map((frame) => [...frame]), [[1], [2, 2], [3, 3, 3]])
  assert.equal(connection.pendingWriteBytes, 0)
  assert.equal(overflows.length, 1)
  assert.equal(overflows[0].droppedBytes, 1)

  await connection.disconnect()
})

test('queued safety traffic overtakes normal frames while preserving FIFO per priority', async () => {
  const port = new FakeSerialPort()
  port.writeResults = [false, true, true, true, true]
  const connection = new SerialConnection({
    portFactory: () => port,
    maxQueuedFrames: 8,
    maxQueuedBytes: 64,
  })
  const connecting = connection.connect('COM_TEST', 57600)
  port.succeedOpen()
  await connecting

  assert.equal(connection.write(Buffer.from([1]), 'normal'), true)
  assert.equal(connection.write(Buffer.from([2]), 'normal'), true)
  assert.equal(connection.write(Buffer.from([3]), 'normal'), true)
  assert.equal(connection.write(Buffer.from([4]), 'high'), true)
  assert.equal(connection.write(Buffer.from([5]), 'critical'), true)

  port.drain()
  assert.deepEqual(
    port.writes.map((frame) => frame[0]),
    [1, 5, 4, 2, 3],
    'in-flight bytes are not preemptible, but queued critical/high frames must lead normal traffic',
  )
  await connection.disconnect()
})

test('a critical frame evicts lower-priority backlog instead of being dropped', async () => {
  const port = new FakeSerialPort()
  port.writeResults = [false, true, true]
  const connection = new SerialConnection({
    portFactory: () => port,
    maxQueuedFrames: 2,
    maxQueuedBytes: 8,
  })
  const overflows: SerialWriteOverflow[] = []
  connection.on('overflow', (overflow: SerialWriteOverflow) => overflows.push(overflow))
  const connecting = connection.connect('COM_TEST', 57600)
  port.succeedOpen()
  await connecting

  connection.write(Buffer.from([1]), 'normal')
  connection.write(Buffer.from([2]), 'normal')
  connection.write(Buffer.from([3]), 'normal')
  assert.equal(connection.write(Buffer.from([9]), 'critical'), true)

  port.drain()
  assert.deepEqual(port.writes.map((frame) => frame[0]), [1, 9, 2])
  assert.equal(overflows.length, 1)
  assert.equal(overflows[0].droppedPriority, 'normal')
  assert.equal(overflows[0].incomingPriority, 'critical')
  assert.equal(overflows[0].evicted, true)
  await connection.disconnect()
})
