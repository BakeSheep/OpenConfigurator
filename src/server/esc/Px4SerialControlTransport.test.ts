// Tests for the PX4 SERIAL_CONTROL ESC transport: device range validation,
// preflight gating, init sequence, chunked transact, reply filtering, timeout,
// abort and channel switching.
// Run directly: tsx src/server/esc/Px4SerialControlTransport.test.ts
import assert from 'node:assert/strict'
import {
  ESC_SERIAL_BAUD_RATE,
  SERIAL_CONTROL_FLAGS,
} from '../../shared/constants'
import { EscError } from '../../shared/esc'
import {
  Px4SerialControlTransport,
  type SerialControlBridge,
  type SerialControlReply,
} from './Px4SerialControlTransport'
import type { EscTransactionOptions } from './EscByteTransport'

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

interface SentFrame {
  device: number
  flags: number
  baudrate: number
  count: number
  data: number[]
}

class FakeSerialControlBridge implements SerialControlBridge {
  sent: SentFrame[] = []
  private listeners = new Set<(message: SerialControlReply) => void>()
  failSend = false

  sendSerialControl(fields: {
    device: number
    flags: number
    timeout: number
    baudrate: number
    count: number
    data: Uint8Array
  }): boolean {
    if (this.failSend) return false
    this.sent.push({
      device: fields.device,
      flags: fields.flags,
      baudrate: fields.baudrate,
      count: fields.count,
      data: Array.from(fields.data),
    })
    return true
  }

  onSerialControl(listener: (message: SerialControlReply) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  reply(device: number, data: number[], flags: number = SERIAL_CONTROL_FLAGS.Reply): void {
    for (const listener of [...this.listeners]) {
      listener({ device, flags, count: data.length, data })
    }
  }
}

const noWait = () => Promise.resolve()

function fixedFrame(length: number): EscTransactionOptions['frameLength'] {
  return (buffered) => (buffered.length >= length ? length : null)
}

async function expectEscError(promise: Promise<unknown>, code: string, label: string) {
  try {
    await promise
    assert.fail(`${label}: expected EscError ${code}`)
  } catch (error) {
    assert.ok(error instanceof EscError, `${label}: expected EscError, got ${String(error)}`)
    assert.equal(error.code, code, `${label}: expected ${code}, got ${error.code}`)
  }
}

async function run(): Promise<void> {
  // Device range validation: only 20-27 allowed.
  {
    const bridge = new FakeSerialControlBridge()
    const t = new Px4SerialControlTransport({ bridge, waitFn: noWait })
    await expectEscError(
      t.open({ mode: 'px4_serial_control', channels: [19] }, new AbortController().signal),
      'validation_failed',
      'device below range',
    )
    await expectEscError(
      t.open({ mode: 'px4_serial_control', channels: [28] }, new AbortController().signal),
      'validation_failed',
      'device above range',
    )
    await expectEscError(
      t.open({ mode: 'px4_serial_control', channels: [] }, new AbortController().signal),
      'validation_failed',
      'no channels',
    )
    // Duplicate channels rejected (L6)
    await expectEscError(
      t.open({ mode: 'px4_serial_control', channels: [20, 20] }, new AbortController().signal),
      'validation_failed',
      'duplicate channels',
    )
    assert.equal(bridge.sent.length, 0, 'invalid open must not touch the link')
  }

  // RX buffer overflow test (M4).
  {
    const bridge = new FakeSerialControlBridge()
    const t = new Px4SerialControlTransport({ bridge, waitFn: noWait, initSettleMs: 0 })
    await t.open({ mode: 'px4_serial_control', channels: [20] }, new AbortController().signal)
    const pending = t.transact(Uint8Array.of(0x2f), { timeoutMs: 500, frameLength: fixedFrame(5000) }, new AbortController().signal)
    await wait(5)
    // Deliver multiple 70-byte chunks to exceed 4096 bytes
    for (let i = 0; i < 60; i++) {
      bridge.reply(20, new Array(70).fill(0x01))
    }
    await expectEscError(pending, 'rx_overflow', 'rx buffer overflow')
    await t.close('done')
  }

  console.log('Px4SerialControlTransport tests passed')

  // Preflight failure is surfaced verbatim and blocks init.
  {
    const bridge = new FakeSerialControlBridge()
    const t = new Px4SerialControlTransport({
      bridge,
      waitFn: noWait,
      preflight: () => new EscError('not_supported', 'PASSTHRU_EN=0'),
    })
    await expectEscError(
      t.open({ mode: 'px4_serial_control', channels: [20] }, new AbortController().signal),
      'not_supported',
      'preflight block',
    )
    assert.equal(bridge.sent.length, 0)
  }

  // Happy open: init frame uses count=0, ESC baud, RESPOND|EXCLUSIVE.
  {
    const bridge = new FakeSerialControlBridge()
    const t = new Px4SerialControlTransport({ bridge, waitFn: noWait })
    await t.open({ mode: 'px4_serial_control', channels: [20, 21] }, new AbortController().signal)
    assert.equal(bridge.sent.length, 1)
    const init = bridge.sent[0]
    assert.equal(init.device, 20)
    assert.equal(init.count, 0)
    assert.equal(init.baudrate, ESC_SERIAL_BAUD_RATE)
    assert.equal(
      init.flags,
      SERIAL_CONTROL_FLAGS.Respond | SERIAL_CONTROL_FLAGS.Exclusive,
      'init must RESPOND|EXCLUSIVE',
    )
    assert.deepEqual(t.availableChannels, [20, 21])
    await t.close('done')
    const releases = bridge.sent.slice(1)
    assert.deepEqual(releases.map((frame) => frame.device), [20, 21])
    assert.ok(releases.every((frame) => frame.flags === 0 && frame.count === 0), 'close releases exclusive access')
  }

  // Init send failure surfaces link_unavailable and unsubscribes.
  {
    const bridge = new FakeSerialControlBridge()
    bridge.failSend = true
    const t = new Px4SerialControlTransport({ bridge, waitFn: noWait })
    await expectEscError(
      t.open({ mode: 'px4_serial_control', channels: [20] }, new AbortController().signal),
      'link_unavailable',
      'init send failure',
    )
  }

  // transact: request is chunked and only matching-device REPLY frames count.
  {
    const bridge = new FakeSerialControlBridge()
    const t = new Px4SerialControlTransport({ bridge, waitFn: noWait, initSettleMs: 0 })
    await t.open({ mode: 'px4_serial_control', channels: [20] }, new AbortController().signal)
    bridge.sent = []

    const request = new Uint8Array(150).map((_, i) => i & 0xff)
    const pending = t.transact(request, {
      timeoutMs: 500,
      frameLength: fixedFrame(3),
      label: 'read',
    }, new AbortController().signal)
    await wait(5)
    // 150 bytes -> 3 chunks of <=70.
    assert.equal(bridge.sent.length, 3, 'request split into 70-byte chunks')
    assert.deepEqual(bridge.sent.map((f) => f.count), [70, 70, 10])

    // A reply for a different device must be ignored.
    bridge.reply(21, [0x99, 0x99, 0x99])
    await wait(5)
    // A non-REPLY (echo) frame on the right device must be ignored too.
    bridge.reply(20, [0x11], 0)
    await wait(5)
    // The real reply arrives split across two frames.
    bridge.reply(20, [0xa1])
    bridge.reply(20, [0xa2, 0xa3])
    const response = await pending
    assert.deepEqual([...response], [0xa1, 0xa2, 0xa3])
    await t.close('done')
  }

  // Timeout when no reply arrives.
  {
    const bridge = new FakeSerialControlBridge()
    const t = new Px4SerialControlTransport({ bridge, waitFn: noWait, initSettleMs: 0 })
    await t.open({ mode: 'px4_serial_control', channels: [22] }, new AbortController().signal)
    await expectEscError(
      t.transact(Uint8Array.of(1, 2), { timeoutMs: 20, frameLength: fixedFrame(4) }, new AbortController().signal),
      'timeout',
      'transact timeout',
    )
    await t.close('done')
  }

  // Abort cancels an in-flight transaction.
  {
    const bridge = new FakeSerialControlBridge()
    const t = new Px4SerialControlTransport({ bridge, waitFn: noWait, initSettleMs: 0 })
    await t.open({ mode: 'px4_serial_control', channels: [23] }, new AbortController().signal)
    const ac = new AbortController()
    const pending = t.transact(Uint8Array.of(1), { timeoutMs: 500, frameLength: fixedFrame(4) }, ac.signal)
    await wait(5)
    ac.abort()
    await expectEscError(pending, 'cancelled', 'aborted transact')
    await t.close('done')
  }

  // setActiveDevice switches the addressed UART and rejects unknown devices.
  {
    const bridge = new FakeSerialControlBridge()
    const t = new Px4SerialControlTransport({ bridge, waitFn: noWait, initSettleMs: 0 })
    await t.open({ mode: 'px4_serial_control', channels: [20, 24] }, new AbortController().signal)
    bridge.sent = []
    t.setActiveDevice(24)
    const pending = t.transact(Uint8Array.of(0x2f), { timeoutMs: 200, frameLength: fixedFrame(1) }, new AbortController().signal)
    await wait(5)
    assert.equal(bridge.sent[0].device, 24, 'transact addresses the active device')
    bridge.reply(24, [0x55])
    await pending
    assert.throws(() => t.setActiveDevice(99), (e: unknown) => e instanceof EscError && e.code === 'invalid_state')
    await t.close('done')
  }

  // Closed transport rejects further transactions; close is idempotent.
  {
    const bridge = new FakeSerialControlBridge()
    const t = new Px4SerialControlTransport({ bridge, waitFn: noWait, initSettleMs: 0 })
    await t.open({ mode: 'px4_serial_control', channels: [25] }, new AbortController().signal)
    await t.close('done')
    await t.close('again')
    await expectEscError(
      t.transact(Uint8Array.of(1), { timeoutMs: 50, frameLength: fixedFrame(1) }, new AbortController().signal),
      'link_lost',
      'transact after close',
    )
  }

  console.log('Px4SerialControlTransport tests passed')
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
