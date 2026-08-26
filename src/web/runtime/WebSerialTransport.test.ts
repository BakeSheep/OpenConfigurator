import assert from 'node:assert/strict'
import test from 'node:test'
import { WebSerialTransport } from './WebSerialTransport'

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

class FakeSerialPort {
  readable: ReadableStream<Uint8Array> | null = null
  writable: WritableStream<Uint8Array> | null = null
  readonly writes: number[] = []
  openOptions: SerialOptions[] = []
  closeCount = 0
  private readController: ReadableStreamDefaultController<Uint8Array> | null = null
  private firstWriteRelease: (() => void) | null = null

  async getInfo(): Promise<SerialPortInfo> {
    return { usbVendorId: 0x1209, usbProductId: 0x5740 }
  }

  async open(options: SerialOptions): Promise<void> {
    this.openOptions.push(options)
    this.readable = new ReadableStream({ start: (controller) => { this.readController = controller } })
    this.writable = new WritableStream({
      write: async (data) => {
        this.writes.push(data[0])
        if (this.writes.length === 1) await new Promise<void>((resolve) => { this.firstWriteRelease = resolve })
      },
    })
  }

  async close(): Promise<void> {
    this.closeCount += 1
    this.readable = null
    this.writable = null
  }

  emit(data: number[]): void {
    this.readController?.enqueue(Uint8Array.from(data))
  }

  unplug(): void {
    this.readController?.error(new Error('usb unplugged'))
  }

  releaseFirstWrite(): void {
    this.firstWriteRelease?.()
  }
}

function installSerial(port: FakeSerialPort): () => void {
  const navigatorObject = globalThis.navigator as Navigator & { serial?: Serial }
  const original = Object.getOwnPropertyDescriptor(navigatorObject, 'serial')
  Object.defineProperty(navigatorObject, 'serial', {
    configurable: true,
    value: {
      getPorts: async () => [port as unknown as SerialPort],
      requestPort: async () => port as unknown as SerialPort,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => true,
    } satisfies Serial,
  })
  return () => {
    if (original) Object.defineProperty(navigatorObject, 'serial', original)
    else delete navigatorObject.serial
  }
}

test('authorized ports are inert until open and bytes remain tab-local', async () => {
  const port = new FakeSerialPort()
  const restore = installSerial(port)
  try {
    const transport = new WebSerialTransport()
    const listed = await transport.listAuthorizedPorts()
    assert.equal(listed.length, 1)
    assert.equal(port.openOptions.length, 0, 'listing a grant must never occupy the port')
    const picked = await transport.requestPort()
    assert.equal(picked.id, listed[0].id)
    assert.equal(picked.deviceId, listed[0].deviceId)

    const received: number[][] = []
    await transport.open(
      { portId: picked.id, type: 'serial', baudRate: 115200, protocol: 'auto' },
      { onBytes: (data) => received.push([...new Uint8Array(data)]), onClosed: () => undefined },
    )
    port.emit([0xfd, 1, 2, 3])
    await tick()
    assert.deepEqual(received, [[0xfd, 1, 2, 3]])
    assert.equal(port.openOptions[0].baudRate, 115200)
    await transport.close()
  } finally {
    restore()
  }
})

test('opening the same authorized port again performs a bounded baud-rate switch', async () => {
  const port = new FakeSerialPort()
  const restore = installSerial(port)
  try {
    const transport = new WebSerialTransport()
    const [descriptor] = await transport.listAuthorizedPorts()
    const handlers = { onBytes: () => undefined, onClosed: () => undefined }
    await transport.open(
      { portId: descriptor.id, type: 'serial', baudRate: 115200, protocol: 'auto' },
      handlers,
    )
    await transport.open(
      { portId: descriptor.id, type: 'serial', baudRate: 57600, protocol: 'v1' },
      handlers,
    )
    assert.deepEqual(port.openOptions.map((options) => options.baudRate), [115200, 57600])
    assert.ok(port.closeCount >= 1)
    await transport.close()
  } finally {
    restore()
  }
})

test('write queue honors priority, cancellation and stream backpressure', async () => {
  const port = new FakeSerialPort()
  const restore = installSerial(port)
  try {
    const transport = new WebSerialTransport()
    const [descriptor] = await transport.listAuthorizedPorts()
    await transport.open(
      { portId: descriptor.id, type: 'serial', baudRate: 57600, protocol: 'v2' },
      { onBytes: () => undefined, onClosed: () => undefined },
    )
    const first = transport.write(Uint8Array.of(1).buffer, 'normal')
    const cancelled = transport.write(Uint8Array.of(2).buffer, 'normal', 'cancel-me')
    const laterNormal = transport.write(Uint8Array.of(3).buffer, 'normal')
    const critical = transport.write(Uint8Array.of(4).buffer, 'critical')
    assert.equal(transport.cancelQueued('cancel-me'), 1)
    await tick()
    port.releaseFirstWrite()
    assert.deepEqual(await Promise.all([first, cancelled, laterNormal, critical]), [true, false, true, true])
    assert.deepEqual(port.writes, [1, 4, 3])
    await transport.close()
  } finally {
    restore()
  }
})

test('USB removal closes the local session and reports the reason', async () => {
  const port = new FakeSerialPort()
  const restore = installSerial(port)
  try {
    const transport = new WebSerialTransport()
    const [descriptor] = await transport.listAuthorizedPorts()
    let reason = ''
    await transport.open(
      { portId: descriptor.id, type: 'serial', baudRate: 115200, protocol: 'auto' },
      { onBytes: () => undefined, onClosed: (value) => { reason = value } },
    )
    port.unplug()
    await tick()
    await tick()
    assert.match(reason, /usb unplugged/)
    assert.ok(port.closeCount >= 1)
  } finally {
    restore()
  }
})

test('Bluetooth SPP reconnects only inside the active tab session', async () => {
  const port = new FakeSerialPort()
  const restore = installSerial(port)
  try {
    const transport = new WebSerialTransport(() => 0)
    const [descriptor] = await transport.listAuthorizedPorts()
    let closed = 0
    let reopened = 0
    await transport.open(
      { portId: descriptor.id, type: 'bluetooth', baudRate: 115200, protocol: 'auto' },
      {
        onBytes: () => undefined,
        onClosed: () => { closed += 1 },
        onReopened: () => { reopened += 1 },
      },
    )
    port.unplug()
    for (let index = 0; index < 5 && reopened === 0; index++) await tick()
    assert.equal(closed, 1)
    assert.equal(reopened, 1)
    assert.equal(port.openOptions.length, 2)
    await transport.close(false)
    await tick()
    assert.equal(port.openOptions.length, 2, 'explicit close must disable reconnect')
  } finally {
    restore()
  }
})

test('Bluetooth reconnect rejects queued writes from the failed link generation', async () => {
  const port = new FakeSerialPort()
  const restore = installSerial(port)
  try {
    const transport = new WebSerialTransport(() => 0)
    const [descriptor] = await transport.listAuthorizedPorts()
    let reopened = 0
    await transport.open(
      { portId: descriptor.id, type: 'bluetooth', baudRate: 115200, protocol: 'auto' },
      {
        onBytes: () => undefined,
        onClosed: () => undefined,
        onReopened: () => { reopened += 1 },
      },
    )
    const inFlight = transport.write(Uint8Array.of(1).buffer, 'normal')
    const staleQueued = transport.write(Uint8Array.of(2).buffer, 'normal')
    await tick()
    port.unplug()
    await tick()
    port.releaseFirstWrite()
    for (let index = 0; index < 8 && reopened === 0; index++) await tick()

    assert.equal(await staleQueued, false)
    assert.equal(await inFlight, true)
    assert.equal(reopened, 1)
    assert.deepEqual(port.writes, [1], 'queued command must not cross the reconnect boundary')
    assert.equal(await transport.write(Uint8Array.of(3).buffer, 'normal'), true)
    assert.deepEqual(port.writes, [1, 3])
    await transport.close(false)
  } finally {
    restore()
  }
})

test('port descriptor identities do not survive a transport lifecycle', async () => {
  const port = new FakeSerialPort()
  const restore = installSerial(port)
  try {
    const [first] = await new WebSerialTransport().listAuthorizedPorts()
    const [second] = await new WebSerialTransport().listAuthorizedPorts()
    assert.equal(first.id, second.id)
    assert.notEqual(first.deviceId, second.deviceId)
  } finally {
    restore()
  }
})
