// Ownership state-machine tests for EscSessionManager (ADR-004): single
// session, owner-only commands, orphan/reclaim lifecycle, idle watchdog and
// exactly-once transport close.
// Run directly: tsx src/local-runtime/esc/EscSessionManager.test.ts
import assert from 'node:assert/strict'
import { EscError } from '../../shared/esc'
import type { EscSessionSnapshot } from '../../shared/esc'
import type {
  EscByteTransport,
  EscTransactionOptions,
  EscTransportTarget,
} from './EscByteTransport'
import { EscSessionManager } from './EscSessionManager'

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail('timed out waiting for asynchronous condition')
    await wait(5)
  }
}

class FakeTransport implements EscByteTransport {
  readonly kind = 'direct' as const
  readonly capabilities = { read: true, write: true }
  openCalls = 0
  closeCalls = 0
  closeReasons: string[] = []
  failOpen = false
  openDelayMs = 0
  private abortedListeners: Array<(error: EscError) => void> = []

  async open(_target: EscTransportTarget, signal: AbortSignal): Promise<void> {
    this.openCalls += 1
    if (this.openDelayMs > 0) await wait(this.openDelayMs)
    if (signal.aborted) throw new EscError('cancelled', 'open aborted')
    if (this.failOpen) throw new EscError('link_unavailable', 'fake open failure')
  }

  async transact(
    _request: Uint8Array,
    _options: EscTransactionOptions,
    _signal: AbortSignal,
  ): Promise<Uint8Array> {
    return new Uint8Array(0)
  }

  async close(reason: string): Promise<void> {
    this.closeCalls += 1
    this.closeReasons.push(reason)
  }

  onAborted(listener: (error: EscError) => void): () => void {
    this.abortedListeners.push(listener)
    return () => {
      this.abortedListeners = this.abortedListeners.filter((entry) => entry !== listener)
    }
  }

  emitAborted(error: EscError): void {
    for (const listener of [...this.abortedListeners]) listener(error)
  }
}

interface Harness {
  manager: EscSessionManager
  transports: FakeTransport[]
  snapshots: EscSessionSnapshot[]
  pins: Array<{ clientId: string; sessionId: string }>
  releases: string[]
}

function createHarness(
  options: { idleTimeoutMs?: number; orphanGraceMs?: number; failOpen?: boolean } = {},
): Harness {
  const transports: FakeTransport[] = []
  const snapshots: EscSessionSnapshot[] = []
  const pins: Array<{ clientId: string; sessionId: string }> = []
  const releases: string[] = []
  const manager = new EscSessionManager({
    createTransport: () => {
      const transport = new FakeTransport()
      transport.failOpen = options.failOpen ?? false
      transports.push(transport)
      return transport
    },
    pinController: (clientId, sessionId) => pins.push({ clientId, sessionId }),
    releaseController: (sessionId) => releases.push(sessionId),
    idleTimeoutMs: options.idleTimeoutMs ?? 60_000,
    orphanGraceMs: options.orphanGraceMs ?? 60_000,
  })
  manager.on('session', (snapshot: EscSessionSnapshot) => snapshots.push(snapshot))
  return { manager, transports, snapshots, pins, releases }
}

const DIRECT_TARGET: EscTransportTarget = { mode: 'direct', port: 'COM9', baudRate: 19200 }

async function expectEscError(
  promise: Promise<unknown>,
  code: string,
  label: string,
): Promise<void> {
  try {
    await promise
    assert.fail(`${label}: expected EscError ${code}`)
  } catch (error) {
    assert.ok(error instanceof EscError, `${label}: expected EscError, got ${String(error)}`)
    assert.equal(error.code, code, `${label}: expected code ${code}, got ${error.code}`)
  }
}

async function run(): Promise<void> {
  // -------------------------------------------------------------------------
  // Start creates a single owned session and pins the local safety authority.
  // -------------------------------------------------------------------------
  {
    const h = createHarness()
    const started = await h.manager.start('client-a', DIRECT_TARGET, true)
    assert.ok(started.sessionId.length > 0)
    assert.ok(started.recoveryToken.length >= 16)
    const snapshot = h.manager.snapshot()
    assert.equal(snapshot.state, 'active')
    assert.equal(snapshot.ownerClientId, 'client-a')
    assert.equal(snapshot.mode, 'direct')
    assert.equal(snapshot.safetyConfirmed, true)
    assert.deepEqual(snapshot.capabilities, { read: true, write: true })
    assert.equal(h.manager.blocksMavlinkMutations(), true, 'direct sessions also isolate flight mutations')
    assert.deepEqual(h.pins[h.pins.length - 1], { clientId: 'client-a', sessionId: started.sessionId })
    assert.ok(h.snapshots.some((s) => s.state === 'entering'))
    assert.ok(h.snapshots.some((s) => s.state === 'active'))

    // Only one session at a time.
    await expectEscError(
      h.manager.start('client-b', DIRECT_TARGET, true),
      'session_exists',
      'second start',
    )

    // Non-owner commands are rejected, including reads and exit.
    assert.throws(
      () => h.manager.assertOwner('client-b', started.sessionId),
      (error: unknown) => error instanceof EscError && error.code === 'not_owner',
    )
    await expectEscError(
      h.manager.exit('client-b', started.sessionId),
      'not_owner',
      'non-owner exit',
    )
    assert.equal(h.transports[0].closeCalls, 0)

    // Wrong session id is rejected even for the owner.
    assert.throws(
      () => h.manager.assertOwner('client-a', 'bogus-session'),
      (error: unknown) => error instanceof EscError && error.code === 'session_not_found',
    )

    // release_control is blocked while the session lives.
    assert.equal(h.manager.blocksControllerRelease(), true)
    assert.doesNotThrow(() => h.manager.assertSettingsWriteAllowed('client-a', started.sessionId))

    // Owner exit closes the transport exactly once and releases the pin.
    await h.manager.exit('client-a', started.sessionId)
    assert.equal(h.manager.snapshot().state, 'idle')
    assert.equal(h.manager.snapshot().safetyConfirmed, false)
    assert.equal(h.transports[0].closeCalls, 1)
    assert.deepEqual(h.releases, [started.sessionId])
    assert.equal(h.manager.blocksControllerRelease(), false)

    // Double exit is a no-op error (session gone), close stays at one.
    await expectEscError(
      h.manager.exit('client-a', started.sessionId),
      'session_not_found',
      'double exit',
    )
    assert.equal(h.transports[0].closeCalls, 1)
  }

  // -------------------------------------------------------------------------
  // A session without the physical-safety acknowledgement can never write.
  // The Worker/service boundary rejects such starts; this exercises the
  // manager's independent fail-closed guard.
  // -------------------------------------------------------------------------
  {
    const h = createHarness()
    const started = await h.manager.start('client-a', DIRECT_TARGET, false)
    assert.equal(h.manager.snapshot().safetyConfirmed, false)
    assert.throws(
      () => h.manager.assertSettingsWriteAllowed('client-a', started.sessionId),
      (error: unknown) => error instanceof EscError && error.code === 'precondition_failed',
    )
    await h.manager.exit('client-a', started.sessionId)
  }

  // -------------------------------------------------------------------------
  // Failed open finalizes the session and closes the transport exactly once.
  // -------------------------------------------------------------------------
  {
    const h = createHarness({ failOpen: true })
    await expectEscError(
      h.manager.start('client-a', DIRECT_TARGET, true),
      'link_unavailable',
      'failing open',
    )
    assert.equal(h.manager.snapshot().state, 'idle')
    assert.equal(h.transports[0].closeCalls, 1)
    assert.equal(h.releases.length, 1)
  }

  // -------------------------------------------------------------------------
  // Owner disconnect without an active job exits immediately.
  // -------------------------------------------------------------------------
  {
    const h = createHarness()
    const started = await h.manager.start('client-a', DIRECT_TARGET, true)
    h.manager.handleClientDisconnected('client-a')
    await waitFor(() => h.manager.snapshot().state === 'idle')
    assert.equal(h.transports[0].closeCalls, 1)
    assert.deepEqual(h.releases, [started.sessionId])

    // Disconnect of an unrelated client is ignored.
    h.manager.handleClientDisconnected('client-zz')
    assert.equal(h.transports[0].closeCalls, 1)
  }

  // -------------------------------------------------------------------------
  // Owner disconnect during a job orphans the session; reclaim restores it.
  // -------------------------------------------------------------------------
  {
    const h = createHarness({ orphanGraceMs: 60_000 })
    const started = await h.manager.start('client-a', DIRECT_TARGET, true)
    let releaseJob!: () => void
    const jobGate = new Promise<void>((resolve) => {
      releaseJob = resolve
    })
    const job = h.manager.runExclusiveJob('client-a', 'settings_read', async () => {
      await jobGate
      return 'job-result'
    })
    await waitFor(() => h.manager.snapshot().activeJobId !== null)

    h.manager.handleClientDisconnected('client-a')
    const orphanSnapshot = h.manager.snapshot()
    assert.equal(orphanSnapshot.state, 'orphaned')
    assert.equal(orphanSnapshot.safetyConfirmed, false, 'owner loss expires physical-safety acknowledgement')
    assert.ok(orphanSnapshot.recoverUntil !== null && orphanSnapshot.recoverUntil > Date.now())
    // The job keeps running: transport untouched.
    assert.equal(h.transports[0].closeCalls, 0)

    // Wrong recovery token is rejected.
    await expectEscError(
      h.manager.reclaim('client-a2', started.sessionId, 'wrong-token'),
      'invalid_recovery_token',
      'bad token reclaim',
    )
    // Wrong session id is rejected.
    await expectEscError(
      h.manager.reclaim('client-a2', 'other-session', started.recoveryToken),
      'session_not_found',
      'bad session reclaim',
    )

    // Correct reclaim transfers ownership and re-pins the controller.
    await h.manager.reclaim('client-a2', started.sessionId, started.recoveryToken)
    assert.equal(h.manager.snapshot().state, 'active')
    assert.equal(h.manager.snapshot().ownerClientId, 'client-a2')
    assert.equal(h.manager.snapshot().safetyConfirmed, false, 'reclaim cannot revive an expired acknowledgement')
    assert.throws(
      () => h.manager.assertSettingsWriteAllowed('client-a2', started.sessionId),
      (error: unknown) => error instanceof EscError && error.code === 'precondition_failed',
    )
    assert.deepEqual(h.pins[h.pins.length - 1], { clientId: 'client-a2', sessionId: started.sessionId })

    releaseJob()
    assert.equal(await job, 'job-result')
    await waitFor(() => h.manager.snapshot().activeJobId === null)
    assert.equal(h.manager.snapshot().state, 'active')

    await h.manager.exit('client-a2', started.sessionId)
    assert.equal(h.transports[0].closeCalls, 1)
  }

  // -------------------------------------------------------------------------
  // Orphaned session without reclaim exits after the job completes and the
  // grace window elapses; the in-flight job is never interrupted.
  // -------------------------------------------------------------------------
  {
    const h = createHarness({ orphanGraceMs: 40 })
    await h.manager.start('client-a', DIRECT_TARGET, true)
    let releaseJob!: () => void
    const jobGate = new Promise<void>((resolve) => {
      releaseJob = resolve
    })
    const job = h.manager.runExclusiveJob('client-a', 'settings_read', async () => {
      await jobGate
      return null
    })
    await waitFor(() => h.manager.snapshot().activeJobId !== null)
    h.manager.handleClientDisconnected('client-a')
    assert.equal(h.manager.snapshot().state, 'orphaned')

    // Grace expires while the job is still running: nothing is torn down.
    await wait(80)
    assert.equal(h.transports[0].closeCalls, 0)
    assert.equal(h.manager.snapshot().state, 'orphaned')

    releaseJob()
    await job
    await waitFor(() => h.manager.snapshot().state === 'idle')
    assert.equal(h.transports[0].closeCalls, 1)
  }

  // -------------------------------------------------------------------------
  // Single job at a time; job runner requires ownership.
  // -------------------------------------------------------------------------
  {
    const h = createHarness()
    await h.manager.start('client-a', DIRECT_TARGET, true)
    let releaseJob!: () => void
    const jobGate = new Promise<void>((resolve) => {
      releaseJob = resolve
    })
    const first = h.manager.runExclusiveJob('client-a', 'scan', async () => {
      await jobGate
      return null
    })
    await waitFor(() => h.manager.snapshot().activeJobId !== null)
    const activeSessionId = h.manager.snapshot().sessionId!
    await expectEscError(
      h.manager.exit('client-a', activeSessionId),
      'busy',
      'exit during active job',
    )
    await expectEscError(
      h.manager.runExclusiveJob('client-a', 'scan', async () => null),
      'busy',
      'second concurrent job',
    )
    await expectEscError(
      h.manager.runExclusiveJob('client-b', 'scan', async () => null),
      'not_owner',
      'non-owner job',
    )
    releaseJob()
    await first
    await h.manager.destroy()
  }

  // -------------------------------------------------------------------------
  // Idle watchdog exits sessions with no commands; jobs suspend it.
  // -------------------------------------------------------------------------
  {
    const h = createHarness({ idleTimeoutMs: 60 })
    await h.manager.start('client-a', DIRECT_TARGET, true)
    // Activity keeps it alive across two windows.
    await wait(40)
    h.manager.noteActivity('client-a')
    await wait(40)
    assert.equal(h.manager.snapshot().state, 'active')
    // Then let it expire.
    await waitFor(() => h.manager.snapshot().state === 'idle')
    assert.equal(h.transports[0].closeCalls, 1)
  }
  {
    const h = createHarness({ idleTimeoutMs: 50 })
    await h.manager.start('client-a', DIRECT_TARGET, true)
    let releaseJob!: () => void
    const jobGate = new Promise<void>((resolve) => {
      releaseJob = resolve
    })
    const job = h.manager.runExclusiveJob('client-a', 'settings_write', async () => {
      await jobGate
      return null
    })
    await wait(120)
    // Watchdog must not fire while the job runs.
    assert.equal(h.manager.snapshot().state, 'active')
    releaseJob()
    await job
    await h.manager.destroy()
  }

  // -------------------------------------------------------------------------
  // Transport abort (link lost) finalizes exactly once.
  // -------------------------------------------------------------------------
  {
    const h = createHarness()
    await h.manager.start('client-a', DIRECT_TARGET, true)
    h.transports[0].emitAborted(new EscError('link_lost', 'serial unplugged'))
    await waitFor(() => h.manager.snapshot().state === 'idle')
    assert.equal(h.transports[0].closeCalls, 1)
    const last = h.snapshots[h.snapshots.length - 1]
    assert.ok(last && last.reason === 'link_lost')
    // A stale abort from the old, already-detached transport must not affect
    // a new session running on a fresh transport.
    await h.manager.start('client-b', DIRECT_TARGET, true)
    h.transports[0].emitAborted(new EscError('link_lost', 'stale'))
    await wait(20)
    assert.equal(h.manager.snapshot().state, 'active')
    assert.equal(h.transports[1].closeCalls, 0)
    await h.manager.destroy()
  }

  // -------------------------------------------------------------------------
  // destroy() tears down whatever is left.
  // -------------------------------------------------------------------------
  {
    const h = createHarness()
    await h.manager.start('client-a', DIRECT_TARGET, true)
    await h.manager.destroy()
    assert.equal(h.manager.snapshot().state, 'idle')
    assert.equal(h.transports[0].closeCalls, 1)
  }

  console.log('EscSessionManager ownership state machine tests passed')
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
