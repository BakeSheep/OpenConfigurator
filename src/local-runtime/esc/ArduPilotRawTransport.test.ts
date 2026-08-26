// Tests for the ArduPilot raw ESC transport: preconditions, pause/resume
// pairing, framed transact, timeout, abort propagation and idempotent close.
// Run directly: tsx src/local-runtime/esc/ArduPilotRawTransport.test.ts
import { ByteBuffer } from '../platform/ByteBuffer'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { EscError } from '../../shared/esc'
import type { RawSessionHandle } from '../connection/BrowserConnectionManager'
import {
  ArduPilotRawTransport,
  type ProtocolPauseController,
  type RawSessionProvider,
} from './ArduPilotRawTransport'
import type { EscTransactionOptions } from './EscByteTransport'

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

class FakeRawSession extends EventEmitter implements RawSessionProvider {
  status = 'connected'
  vehicleReady = true
  rawSessionActive = false
  beginCalls = 0
  writes: ByteBuffer[] = []
  released = 0
  private dataListeners = new Set<(data: ByteBuffer) => void>()
  private abortedListeners = new Set<(reason: string) => void>()
  throwOnBegin: Error | null = null

  beginRawSession(): RawSessionHandle {
    this.beginCalls += 1
    if (this.throwOnBegin) throw this.throwOnBegin
    this.rawSessionActive = true
    return {
      write: (data: ByteBuffer) => {
        this.writes.push(ByteBuffer.from(data))
        return true
      },
      onData: (listener) => {
        this.dataListeners.add(listener)
        return () => this.dataListeners.delete(listener)
      },
      onAborted: (listener) => {
        this.abortedListeners.add(listener)
        return () => this.abortedListeners.delete(listener)
      },
      release: () => {
        this.released += 1
        this.rawSessionActive = false
      },
    }
  }

  deliver(bytes: number[]): void {
    for (const listener of [...this.dataListeners]) listener(ByteBuffer.from(bytes))
  }

  abort(reason: string): void {
    for (const listener of [...this.abortedListeners]) listener(reason)
  }
}

class FakeBridge implements ProtocolPauseController {
  armedState: boolean | null = false
  pauseCalls: string[] = []
  resumeCalls = 0
  pauseProtocol(reason: string): void {
    this.pauseCalls.push(reason)
  }
  resumeProtocol(): void {
    this.resumeCalls += 1
  }
}

// A framing function that returns a fixed-length frame once enough bytes have
// arrived; throws for an impossible prefix.
function fixedFrame(length: number): EscTransactionOptions['frameLength'] {
  return (buffered) => {
    if (buffered.length > 0 && buffered[0] === 0xff) {
      throw new EscError('crc_mismatch', 'bad prefix')
    }
    return buffered.length >= length ? length : null
  }
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
  const AP_TARGET = { mode: 'ardupilot_passthrough' as const }

  // Rejects when armed / arming unknown / heartbeat stale, without pausing.
  {
    const conn = new FakeRawSession()
    const bridge = new FakeBridge()
    bridge.armedState = true
    const t = new ArduPilotRawTransport({ connManager: conn, bridge, settleMs: 0 })
    await expectEscError(t.open(AP_TARGET, new AbortController().signal), 'armed', 'armed open')
    assert.equal(bridge.pauseCalls.length, 0, 'must not pause when armed')
    assert.equal(conn.beginCalls, 0)
  }
  {
    const conn = new FakeRawSession()
    const bridge = new FakeBridge()
    bridge.armedState = null
    const t = new ArduPilotRawTransport({ connManager: conn, bridge, settleMs: 0 })
    await expectEscError(
      t.open(AP_TARGET, new AbortController().signal),
      'arming_state_unknown',
      'unknown arming',
    )
  }
  {
    const conn = new FakeRawSession()
    conn.vehicleReady = false
    const bridge = new FakeBridge()
    const t = new ArduPilotRawTransport({ connManager: conn, bridge, settleMs: 0 })
    await expectEscError(
      t.open(AP_TARGET, new AbortController().signal),
      'precondition_failed',
      'stale heartbeat',
    )
    assert.equal(bridge.pauseCalls.length, 0)
  }

  // Direct USB reuse borrows the same raw link without requiring a MAVLink
  // heartbeat or arming state from a directly attached ESC, and consumes the
  // single-wire request echo before framing the response.
  {
    const conn = new FakeRawSession()
    conn.vehicleReady = false
    const bridge = new FakeBridge()
    bridge.armedState = true
    const t = new ArduPilotRawTransport({ connManager: conn, bridge, targetMode: 'direct' })
    await t.open({ mode: 'direct', port: 'COM9', baudRate: 19200 }, new AbortController().signal)
    assert.equal(t.kind, 'direct')
    assert.equal(conn.beginCalls, 1)
    const request = Uint8Array.of(0x2f, 0x10)
    const pending = t.transact(request, {
      timeoutMs: 200,
      frameLength: fixedFrame(3),
    }, new AbortController().signal)
    await wait(5)
    conn.deliver([...request])
    conn.deliver([0x2e])
    conn.deliver([0x01, 0x02])
    assert.deepEqual([...(await pending)], [0x2e, 0x01, 0x02])
    await t.close('done')
    assert.equal(conn.released, 1)
    assert.equal(bridge.resumeCalls, 1)
  }

  // Rejects when the link is busy with a conflicting MAVLink operation.
  {
    const conn = new FakeRawSession()
    const bridge = new FakeBridge()
    const t = new ArduPilotRawTransport({
      connManager: conn,
      bridge,
      checkBusy: () => 'param_sync',
    })
    await expectEscError(t.open(AP_TARGET, new AbortController().signal), 'busy', 'busy open')
    assert.equal(bridge.pauseCalls.length, 0)
  }

  // Safety-context violations (OCSA-002) refuse the open before the link is
  // borrowed, even when the bridge-side armed flag still reads disarmed.
  {
    const conn = new FakeRawSession()
    const bridge = new FakeBridge()
    const t = new ArduPilotRawTransport({
      connManager: conn,
      bridge,
      settleMs: 0,
      checkSafety: () => new EscError('arming_state_unknown', '飞控解锁状态快照已过期'),
    })
    await expectEscError(
      t.open(AP_TARGET, new AbortController().signal),
      'arming_state_unknown',
      'stale safety snapshot at open',
    )
    assert.equal(bridge.pauseCalls.length, 0, 'must not pause on a violated context')
    assert.equal(conn.beginCalls, 0)
  }
  {
    // Same gate for direct mode: an FC-active connection may not be
    // repurposed in place for a directly attached ESC.
    const conn = new FakeRawSession()
    const bridge = new FakeBridge()
    const t = new ArduPilotRawTransport({
      connManager: conn,
      bridge,
      targetMode: 'direct',
      checkSafety: () => new EscError('precondition_failed', '当前连接曾观测到飞控活动'),
    })
    await expectEscError(
      t.open({ mode: 'direct', port: 'COM9', baudRate: 19200 }, new AbortController().signal),
      'precondition_failed',
      'direct open with FC history',
    )
    assert.equal(conn.beginCalls, 0)
  }

  // A violation appearing mid-session fails the transaction and aborts the
  // session through onAborted so the owner tears down and MAVLink resumes.
  {
    const conn = new FakeRawSession()
    const bridge = new FakeBridge()
    let violation: EscError | null = null
    const t = new ArduPilotRawTransport({
      connManager: conn,
      bridge,
      settleMs: 0,
      checkSafety: () => violation,
    })
    await t.open(AP_TARGET, new AbortController().signal)
    const aborts: EscError[] = []
    t.onAborted((error) => aborts.push(error))
    violation = new EscError('armed', '检测到飞控已解锁，ESC 会话已中止')
    await expectEscError(
      t.transact(Uint8Array.of(0x2f), { timeoutMs: 200, frameLength: fixedFrame(3) }, new AbortController().signal),
      'armed',
      'transact while armed',
    )
    assert.equal(aborts.length, 1, 'violation must abort the session')
    assert.equal(aborts[0].code, 'armed')
    assert.equal(conn.writes.length, 0, 'violated request must not reach the link')
    await t.close('done')
    assert.equal(conn.released, 1)
    assert.equal(bridge.resumeCalls, 1)
  }

  // Happy path: pause precedes beginRawSession; close resumes exactly once.
  {
    const conn = new FakeRawSession()
    const bridge = new FakeBridge()
    const t = new ArduPilotRawTransport({ connManager: conn, bridge, settleMs: 0 })
    await t.open(AP_TARGET, new AbortController().signal)
    assert.deepEqual(bridge.pauseCalls, ['esc_session'])
    assert.equal(conn.beginCalls, 1)

    // A framed transaction resolves once enough bytes arrive.
    const pending = t.transact(Uint8Array.of(0x2f, 0x30), {
      timeoutMs: 500,
      frameLength: fixedFrame(3),
      label: 'test',
    }, new AbortController().signal)
    await wait(5)
    assert.equal(conn.writes.length, 1)
    conn.deliver([0x01])
    conn.deliver([0x02, 0x03])
    const response = await pending
    assert.deepEqual([...response], [0x01, 0x02, 0x03])

    await t.close('done')
    assert.equal(conn.released, 1)
    assert.equal(bridge.resumeCalls, 1)
    // Idempotent close.
    await t.close('again')
    assert.equal(conn.released, 1)
    assert.equal(bridge.resumeCalls, 1)
  }

  // beginRawSession failure rolls back the pause.
  {
    const conn = new FakeRawSession()
    conn.throwOnBegin = new Error('serial busy')
    const bridge = new FakeBridge()
    const t = new ArduPilotRawTransport({ connManager: conn, bridge, settleMs: 0 })
    await expectEscError(
      t.open(AP_TARGET, new AbortController().signal),
      'link_unavailable',
      'begin failure',
    )
    assert.deepEqual(bridge.pauseCalls, ['esc_session'])
    assert.equal(bridge.resumeCalls, 1, 'pause must be rolled back on begin failure')
  }

  // Transaction timeout.
  {
    const conn = new FakeRawSession()
    const bridge = new FakeBridge()
    const t = new ArduPilotRawTransport({ connManager: conn, bridge, settleMs: 0 })
    await t.open(AP_TARGET, new AbortController().signal)
    await expectEscError(
      t.transact(Uint8Array.of(0x2f), { timeoutMs: 20, frameLength: fixedFrame(4) }, new AbortController().signal),
      'timeout',
      'transact timeout',
    )
    await t.close('done')
  }

  // Framing error surfaces as EscError.
  {
    const conn = new FakeRawSession()
    const bridge = new FakeBridge()
    const t = new ArduPilotRawTransport({ connManager: conn, bridge, settleMs: 0 })
    await t.open(AP_TARGET, new AbortController().signal)
    const pending = t.transact(Uint8Array.of(0x2f), { timeoutMs: 200, frameLength: fixedFrame(3) }, new AbortController().signal)
    await wait(5)
    conn.deliver([0xff])
    await expectEscError(pending, 'crc_mismatch', 'bad frame')
    await t.close('done')
  }

  // Abort signal cancels an in-flight transaction.
  {
    const conn = new FakeRawSession()
    const bridge = new FakeBridge()
    const t = new ArduPilotRawTransport({ connManager: conn, bridge, settleMs: 0 })
    await t.open(AP_TARGET, new AbortController().signal)
    const ac = new AbortController()
    const pending = t.transact(Uint8Array.of(0x2f), { timeoutMs: 500, frameLength: fixedFrame(4) }, ac.signal)
    await wait(5)
    ac.abort()
    await expectEscError(pending, 'cancelled', 'aborted transact')
    await t.close('done')
  }

  // Link abort during a session propagates via onAborted.
  {
    const conn = new FakeRawSession()
    const bridge = new FakeBridge()
    const t = new ArduPilotRawTransport({ connManager: conn, bridge, settleMs: 0 })
    await t.open(AP_TARGET, new AbortController().signal)
    const aborts: EscError[] = []
    t.onAborted((error) => aborts.push(error))
    conn.abort('serial unplugged')
    assert.equal(aborts.length, 1)
    assert.equal(aborts[0].code, 'link_lost')
    await t.close('done')
    assert.equal(bridge.resumeCalls, 1)
  }

  console.log('ArduPilotRawTransport tests passed')
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
