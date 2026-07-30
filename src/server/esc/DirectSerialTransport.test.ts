// Tests for the direct half-duplex AM32 serial transport: baud/port guards,
// echo consumption, framed response, timeout, bounded retry with resync, and
// isolation from ConnectionManager.
// Run directly: tsx src/server/esc/DirectSerialTransport.test.ts
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { ESC_SERIAL_BAUD_RATE } from '../../shared/constants'
import { EscError } from '../../shared/esc'
import {
  DirectSerialTransport,
  type DirectSerialLink,
} from './DirectSerialTransport'
import type { EscTransactionOptions } from './EscByteTransport'

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Fake single-wire serial link. Each write echoes the bytes back (as the real
 * one-wire ESC does). A scripted responder decides what response bytes to
 * emit after the echo, per write attempt.
 */
class FakeSerialLink extends EventEmitter implements DirectSerialLink {
  connected = false
  connectCalls = 0
  disconnectCalls = 0
  writes: Buffer[] = []
  connectError: Error | null = null
  echo = true
  responder: ((attempt: number, data: Buffer) => number[] | null) | null = null

  async connect(_path: string, _baud: number): Promise<void> {
    this.connectCalls += 1
    if (this.connectError) throw this.connectError
    this.connected = true
  }

  async disconnect(): Promise<void> {
    this.disconnectCalls += 1
    this.connected = false
  }

  write(data: Buffer): boolean {
    this.writes.push(Buffer.from(data))
    const attempt = this.writes.length
    // Emit echo then optional response asynchronously, like a real UART.
    queueMicrotask(() => {
      if (this.echo) this.emit('data', Buffer.from(data))
      const response = this.responder?.(attempt, Buffer.from(data))
      if (response) this.emit('data', Buffer.from(response))
    })
    return true
  }
}

const DIRECT_TARGET = { mode: 'direct' as const, port: 'COM9', baudRate: 19200 as const }

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
  // Only 19200 baud is accepted.
  {
    const link = new FakeSerialLink()
    const t = new DirectSerialTransport({ serialFactory: () => link })
    await expectEscError(
      t.open({ mode: 'direct', port: 'COM9', baudRate: 57600 as unknown as 19200 }, new AbortController().signal),
      'validation_failed',
      'wrong baud',
    )
    assert.equal(link.connectCalls, 0)
  }

  // Refuses the port currently owned by the MAVLink connection (normalized).
  {
    const link = new FakeSerialLink()
    const t = new DirectSerialTransport({
      serialFactory: () => link,
      getBusyMavlinkPort: () => 'com9',
    })
    await expectEscError(t.open(DIRECT_TARGET, new AbortController().signal), 'busy', 'port conflict')
    assert.equal(link.connectCalls, 0, 'must not open a conflicting port')
  }

  // Happy path: connect at 19200, write echoes back, response follows.
  {
    const link = new FakeSerialLink()
    link.responder = () => [0x30, 0x00, 0x1e] // e.g. an ACK-ish reply
    const t = new DirectSerialTransport({ serialFactory: () => link })
    await t.open(DIRECT_TARGET, new AbortController().signal)
    assert.equal(link.connectCalls, 1)
    assert.equal(link.connected, true)

    const response = await t.transact(Uint8Array.of(0x2f, 0x00, 0x01), {
      timeoutMs: 200,
      frameLength: fixedFrame(3),
      label: 'read',
    }, new AbortController().signal)
    // The echo (3 bytes) is consumed; only the response body is returned.
    assert.deepEqual([...response], [0x30, 0x00, 0x1e])
    await t.close('done')
    assert.equal(link.disconnectCalls, 1)
  }

  // Echo mismatch is reported (garbled single-wire).
  {
    const link = new FakeSerialLink()
    link.echo = false
    link.responder = (_attempt, data) => {
      // Emit wrong "echo" bytes then a body.
      return [0xff ^ data[0], 0x00, 0x00, 0x99]
    }
    const t = new DirectSerialTransport({ serialFactory: () => link, maxAttempts: 1 })
    await t.open(DIRECT_TARGET, new AbortController().signal)
    await expectEscError(
      t.transact(Uint8Array.of(0x2f), { timeoutMs: 100, frameLength: fixedFrame(1) }, new AbortController().signal),
      'echo_mismatch',
      'echo mismatch',
    )
    await t.close('done')
  }

  // Timeout when no response arrives, then bounded retry with resync succeeds.
  {
    const link = new FakeSerialLink()
    // Fail (echo only, no body) on the first attempt; respond on the second.
    link.responder = (attempt) => (attempt >= 2 ? [0xa5, 0xa5] : null)
    const t = new DirectSerialTransport({ serialFactory: () => link, maxAttempts: 3 })
    await t.open(DIRECT_TARGET, new AbortController().signal)
    const response = await t.transact(Uint8Array.of(0x11), {
      timeoutMs: 40,
      frameLength: fixedFrame(2),
      label: 'retry',
    }, new AbortController().signal)
    assert.deepEqual([...response], [0xa5, 0xa5])
    assert.equal(link.writes.length, 2, 'request re-sent once before success')
    await t.close('done')
  }

  // Exhausts retries and fails when the device never responds.
  {
    const link = new FakeSerialLink()
    link.responder = () => null
    const t = new DirectSerialTransport({ serialFactory: () => link, maxAttempts: 3 })
    await t.open(DIRECT_TARGET, new AbortController().signal)
    await expectEscError(
      t.transact(Uint8Array.of(0x11), { timeoutMs: 20, frameLength: fixedFrame(2) }, new AbortController().signal),
      'timeout',
      'exhausted retries',
    )
    assert.equal(link.writes.length, 3, 'exactly maxAttempts writes')
    await t.close('done')
  }

  // Abort during a transaction is terminal (no retry).
  {
    const link = new FakeSerialLink()
    link.responder = () => null
    const t = new DirectSerialTransport({ serialFactory: () => link, maxAttempts: 3 })
    await t.open(DIRECT_TARGET, new AbortController().signal)
    const ac = new AbortController()
    const pending = t.transact(Uint8Array.of(0x11), { timeoutMs: 500, frameLength: fixedFrame(2) }, ac.signal)
    await wait(5)
    ac.abort()
    await expectEscError(pending, 'cancelled', 'aborted transact')
    assert.equal(link.writes.length, 1, 'abort must not retry')
    await t.close('done')
  }

  // Link loss during a session propagates via onAborted.
  {
    const link = new FakeSerialLink()
    const t = new DirectSerialTransport({ serialFactory: () => link })
    await t.open(DIRECT_TARGET, new AbortController().signal)
    const aborts: EscError[] = []
    t.onAborted((error) => aborts.push(error))
    link.emit('disconnected')
    assert.equal(aborts.length, 1)
    assert.equal(aborts[0].code, 'link_lost')
    await t.close('done')
  }

  // Connect failure surfaces link_unavailable and cleans up listeners.
  {
    const link = new FakeSerialLink()
    link.connectError = new Error('port not found')
    const t = new DirectSerialTransport({ serialFactory: () => link })
    await expectEscError(t.open(DIRECT_TARGET, new AbortController().signal), 'link_unavailable', 'connect failure')
    assert.equal(link.listenerCount('data'), 0, 'listeners removed on failed open')
  }

  console.log('DirectSerialTransport tests passed')
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
