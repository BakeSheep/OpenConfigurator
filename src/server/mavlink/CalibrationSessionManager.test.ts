import assert from 'node:assert/strict'
import type { CalibrationSnapshot, ServerMessage } from '../../shared/types'
import {
  CALIBRATION_ORPHAN_GRACE_MS,
  CALIBRATION_TERMINAL_RETENTION_MS,
  CalibrationSessionManager,
  type CalibrationSessionHandle,
  type CalibrationStartRequest,
} from './CalibrationSessionManager'
import { CalibrationSession } from './CalibrationSession'

// ---------------------------------------------------------------------------
// Ownership manager tests with a fake session: recovery token secrecy, orphan
// grace + reclaim, terminal retention/replay, lease pin lifecycle and the
// mutual-exclusion predicates. Deterministic clock/timers throughout.
// ---------------------------------------------------------------------------

type TimerRecord = { at: number; fn: () => void }

class FakeClock {
  nowMs = 0
  private timers = new Set<TimerRecord>()
  readonly now = (): number => this.nowMs
  readonly setTimer = (fn: () => void, ms: number): unknown => {
    const record: TimerRecord = { at: this.nowMs + Math.max(0, ms), fn }
    this.timers.add(record)
    return record
  }
  readonly clearTimer = (handle: unknown): void => {
    this.timers.delete(handle as TimerRecord)
  }
  get pending(): number { return this.timers.size }
  advance(ms: number): void {
    const target = this.nowMs + ms
    for (;;) {
      const due = [...this.timers]
        .filter((timer) => timer.at <= target)
        .sort((a, b) => a.at - b.at)[0]
      if (!due) break
      this.timers.delete(due)
      this.nowMs = Math.max(this.nowMs, due.at)
      due.fn()
    }
    this.nowMs = target
  }
}

class FakeSession implements CalibrationSessionHandle {
  terminal = false
  cancelSupported = true
  owner: string | null
  recoverUntil: number | null = null
  started = 0
  cancelCalls = 0
  terminateCalls: string[] = []
  confirmCalls: number[] = []
  cancelResult: { ok: true } | { ok: false; code: string } = { ok: true }

  constructor(
    readonly request: CalibrationStartRequest,
    private readonly clockNow: () => number,
  ) {
    this.owner = request.ownerClientId
  }

  get sessionId(): string { return this.request.sessionId }

  private seq = 0
  private phase: CalibrationSnapshot['phase'] = 'starting'

  start(): void {
    this.started += 1
    this.emit()
  }

  cancel(): { ok: true } | { ok: false; code: string } {
    this.cancelCalls += 1
    return this.cancelResult
  }

  terminate(code: string, _reason: string): void {
    if (this.terminal) return
    this.terminateCalls.push(code)
    this.finish('failed')
  }

  /** Test helper: drive the session to a terminal phase via its emit path. */
  finish(phase: CalibrationSnapshot['phase']): void {
    this.terminal = true
    this.phase = phase
    this.emit()
  }

  setOwner(ownerClientId: string | null, recoverUntil: number | null): void {
    this.owner = ownerClientId
    this.recoverUntil = recoverUntil
    this.emit()
  }

  confirmPosition(position: number): { ok: true } | { ok: false; code: string } {
    this.confirmCalls.push(position)
    return { ok: true }
  }

  snapshot(): CalibrationSnapshot {
    return this.build()
  }

  private emit(): void {
    this.seq += 1
    this.request.emitSnapshot(this.build())
  }

  private build(): CalibrationSnapshot {
    return {
      sessionId: this.request.sessionId,
      seq: this.seq,
      ownerClientId: this.owner,
      recoverUntil: this.recoverUntil,
      requestId: this.request.requestId,
      family: 'px4',
      kind: this.request.kind,
      phase: this.phase,
      verification: 'not_applicable',
      progress: null,
      updatedAt: this.clockNow(),
      rebootRequired: false,
      cancelSupported: this.cancelSupported,
    }
  }
}

type Harness = {
  manager: CalibrationSessionManager
  clock: FakeClock
  sessions: FakeSession[]
  broadcasts: ServerMessage[]
  perClient: Array<{ clientId: string; message: ServerMessage }>
  pins: Array<{ clientId: string; sessionId: string }>
  releases: string[]
  linkBusy: { value: string | null }
  factoryRejects: { value: boolean }
}

function makeManager(): Harness {
  const clock = new FakeClock()
  const sessions: FakeSession[] = []
  const broadcasts: ServerMessage[] = []
  const perClient: Array<{ clientId: string; message: ServerMessage }> = []
  const pins: Array<{ clientId: string; sessionId: string }> = []
  const releases: string[] = []
  const linkBusy = { value: null as string | null }
  const factoryRejects = { value: false }
  let tokenCounter = 0
  const manager = new CalibrationSessionManager({
    createSession: (request) => {
      if (factoryRejects.value) return null
      const session = new FakeSession(request, clock.now)
      sessions.push(session)
      return session
    },
    broadcast: (message) => broadcasts.push(structuredClone(message)),
    emitToClient: (clientId, message) =>
      perClient.push({ clientId, message: structuredClone(message) }),
    pinController: (clientId, sessionId) => pins.push({ clientId, sessionId }),
    releaseController: (sessionId) => releases.push(sessionId),
    isLinkBusy: () => linkBusy.value,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    randomToken: () => `secret-token-${++tokenCounter}-0123456789abcdef`,
  })
  return { manager, clock, sessions, broadcasts, perClient, pins, releases, linkBusy, factoryRejects }
}

function lastError(h: Harness, clientId: string): { code?: string; operation?: string } {
  const entries = h.perClient.filter(
    (entry) => entry.clientId === clientId && entry.message.type === 'operation_error',
  )
  assert.ok(entries.length > 0, `expected an operation_error for ${clientId}`)
  const message = entries[entries.length - 1].message
  return message.type === 'operation_error' ? message.data : {}
}

// -- start: token secrecy, pinning, single active session -----------------------
{
  const h = makeManager()
  h.manager.requestStart('client-a', { requestId: 'req-1', data: { kind: 'accel' } })
  assert.equal(h.sessions.length, 1)
  assert.equal(h.sessions[0].started, 1)
  assert.deepEqual(h.pins, [{ clientId: 'client-a', sessionId: h.sessions[0].sessionId }])

  const startedMessages = h.perClient.filter(
    (entry) => entry.message.type === 'calibration_session_started',
  )
  assert.equal(startedMessages.length, 1)
  assert.equal(startedMessages[0].clientId, 'client-a')
  const started = startedMessages[0].message
  assert.ok(started.type === 'calibration_session_started')
  assert.equal(started.data.sessionId, h.sessions[0].sessionId)
  assert.match(started.data.recoveryToken, /^secret-token-1/)

  // The token must never appear in any broadcast payload.
  const broadcastJson = JSON.stringify(h.broadcasts)
  assert.ok(!broadcastJson.includes('secret-token'), 'recovery token leaked into broadcast')

  // Snapshots are broadcast with the owner id.
  const update = h.broadcasts.find((message) => message.type === 'calibration_update')
  assert.ok(update && update.type === 'calibration_update')
  assert.equal(update.data.ownerClientId, 'client-a')

  assert.equal(h.manager.sessionActive, true)
  assert.equal(h.manager.blocksControllerRelease(), true)
  assert.equal(h.manager.blocksMavlinkMutations(), true)

  // Second start while active is refused.
  h.manager.requestStart('client-b', { requestId: 'req-2', data: { kind: 'gyro' } })
  assert.equal(h.sessions.length, 1)
  assert.equal(lastError(h, 'client-b').code, 'calibration_busy')
}

// -- real session integration: first snapshot already identifies the owner ------
{
  const clock = new FakeClock()
  const broadcasts: ServerMessage[] = []
  let realSession: CalibrationSession | null = null
  const manager = new CalibrationSessionManager({
    createSession: (request) => {
      realSession = new CalibrationSession({
        sessionId: request.sessionId,
        requestId: request.requestId,
        family: 'ardupilot',
        kind: request.kind,
        sendCommand: () => true,
        emitSnapshot: request.emitSnapshot,
        now: clock.now,
        setTimer: clock.setTimer,
        clearTimer: clock.clearTimer,
      })
      return realSession
    },
    broadcast: (message) => broadcasts.push(structuredClone(message)),
    emitToClient: () => undefined,
    pinController: () => undefined,
    releaseController: () => undefined,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    randomToken: () => 'integration-secret-token',
  })

  manager.requestStart('real-owner', { requestId: 'real-request', data: { kind: 'accel' } })
  assert.ok(realSession)
  const updates = broadcasts.filter((message) => message.type === 'calibration_update')
  assert.ok(updates.length >= 1)
  const firstUpdate = updates[0]
  assert.ok(firstUpdate.type === 'calibration_update')
  assert.equal(firstUpdate.data.ownerClientId, 'real-owner')
  assert.ok(updates.every(
    (message) => message.type === 'calibration_update' && message.data.ownerClientId === 'real-owner',
  ))
}

// -- link busy and factory rejection do not create sessions ---------------------
{
  const h = makeManager()
  h.linkBusy.value = 'parameter_sync'
  h.manager.requestStart('client-a', { requestId: 'req-1', data: { kind: 'accel' } })
  assert.equal(h.sessions.length, 0)
  assert.equal(lastError(h, 'client-a').code, 'link_busy')

  h.linkBusy.value = null
  h.factoryRejects.value = true
  h.manager.requestStart('client-a', { requestId: 'req-2', data: { kind: 'accel' } })
  assert.equal(h.sessions.length, 0)
  assert.equal(h.manager.sessionActive, false)
  assert.equal(h.pins.length, 0, 'a rejected start must not pin the lease')
}

// -- actions: owner-only, session id match, dispatch -----------------------------
{
  const h = makeManager()
  h.manager.requestStart('client-a', { requestId: 'req-1', data: { kind: 'accel' } })
  const sessionId = h.sessions[0].sessionId

  h.manager.handleAction('client-b', {
    requestId: 'act-1',
    data: { sessionId, action: 'cancel' },
  })
  assert.equal(lastError(h, 'client-b').code, 'not_session_owner')
  assert.equal(h.sessions[0].cancelCalls, 0)

  h.manager.handleAction('client-a', {
    requestId: 'act-2',
    data: { sessionId: 'ffffffff-0000-0000-0000-000000000000', action: 'cancel' },
  })
  assert.equal(lastError(h, 'client-a').code, 'session_mismatch')

  h.manager.handleAction('client-a', {
    requestId: 'act-3',
    data: { sessionId, action: 'confirm_position', position: 3 },
  })
  assert.deepEqual(h.sessions[0].confirmCalls, [3])

  h.manager.handleAction('client-a', {
    requestId: 'act-4',
    data: { sessionId, action: 'cancel' },
  })
  assert.equal(h.sessions[0].cancelCalls, 1)

  // Unsupported cancel result is surfaced to the owner.
  h.sessions[0].cancelResult = { ok: false, code: 'cancel_unsupported' }
  h.manager.handleAction('client-a', {
    requestId: 'act-5',
    data: { sessionId, action: 'cancel' },
  })
  assert.equal(lastError(h, 'client-a').code, 'cancel_unsupported')

  // accept_mag has no handler on this session yet -> unsupported_action.
  h.manager.handleAction('client-a', {
    requestId: 'act-6',
    data: { sessionId, action: 'accept_mag' },
  })
  assert.equal(lastError(h, 'client-a').code, 'unsupported_action')
}

// -- orphan grace + reclaim -------------------------------------------------------
{
  const h = makeManager()
  h.manager.requestStart('client-a', { requestId: 'req-1', data: { kind: 'accel' } })
  const session = h.sessions[0]
  const token = 'secret-token-1-0123456789abcdef'

  h.manager.handleClientDisconnected('client-a')
  assert.equal(session.owner, null)
  assert.equal(session.recoverUntil, CALIBRATION_ORPHAN_GRACE_MS)

  // While orphaned even the old owner id cannot act.
  h.manager.handleAction('client-a', {
    requestId: 'act-1',
    data: { sessionId: session.sessionId, action: 'cancel' },
  })
  assert.equal(lastError(h, 'client-a').code, 'not_session_owner')

  // Wrong token / wrong session are rejected without detail.
  h.manager.reclaim('client-b', {
    sessionId: session.sessionId,
    recoveryToken: 'wrong-token-wrong-token-wrong',
  }, 'rec-1')
  assert.equal(lastError(h, 'client-b').code, 'reclaim_denied')
  h.manager.reclaim('client-b', {
    sessionId: 'ffffffff-0000-0000-0000-000000000000',
    recoveryToken: token,
  }, 'rec-2')
  assert.equal(lastError(h, 'client-b').code, 'reclaim_denied')

  // Correct token within the grace window transfers ownership and re-pins.
  h.clock.advance(10_000)
  h.manager.reclaim('client-b', { sessionId: session.sessionId, recoveryToken: token }, 'rec-3')
  assert.equal(session.owner, 'client-b')
  assert.deepEqual(h.pins[h.pins.length - 1], {
    clientId: 'client-b',
    sessionId: session.sessionId,
  })
  const restarted = h.perClient.filter(
    (entry) => entry.clientId === 'client-b'
      && entry.message.type === 'calibration_session_started',
  )
  assert.equal(restarted.length, 1)

  // New owner can act again; grace timer no longer fires.
  h.manager.handleAction('client-b', {
    requestId: 'act-2',
    data: { sessionId: session.sessionId, action: 'cancel' },
  })
  assert.equal(session.cancelCalls, 1)
  h.clock.advance(CALIBRATION_ORPHAN_GRACE_MS * 2)
  assert.equal(session.terminateCalls.length, 0)
  assert.equal(session.cancelCalls, 1, 'orphan expiry must not fire after reclaim')
}

// -- expired grace: reclaim denied; cancellable session is cancelled ---------------
{
  const h = makeManager()
  h.manager.requestStart('client-a', { requestId: 'req-1', data: { kind: 'accel' } })
  const session = h.sessions[0]
  h.manager.handleClientDisconnected('client-a')
  h.clock.advance(CALIBRATION_ORPHAN_GRACE_MS)
  assert.equal(session.cancelCalls, 1, 'grace expiry cancels a cancellable session')
  h.manager.reclaim('client-b', {
    sessionId: session.sessionId,
    recoveryToken: 'secret-token-1-0123456789abcdef',
  }, 'rec-late')
  assert.equal(lastError(h, 'client-b').code, 'reclaim_denied')
}

// -- expired grace on a non-cancellable session terminates it ----------------------
{
  const h = makeManager()
  h.manager.requestStart('client-a', { requestId: 'req-1', data: { kind: 'accel' } })
  const session = h.sessions[0]
  session.cancelSupported = false
  h.manager.handleClientDisconnected('client-a')
  h.clock.advance(CALIBRATION_ORPHAN_GRACE_MS)
  assert.equal(session.cancelCalls, 0)
  assert.deepEqual(session.terminateCalls, ['owner_lost'])
}

// -- terminal: pin released, retention window, replay ------------------------------
{
  const h = makeManager()
  h.manager.requestStart('client-a', { requestId: 'req-1', data: { kind: 'accel' } })
  const session = h.sessions[0]
  session.finish('done')
  assert.deepEqual(h.releases, [session.sessionId])
  assert.equal(h.manager.sessionActive, false)
  assert.equal(h.manager.blocksControllerRelease(), false)
  assert.equal(h.manager.blocksMavlinkMutations(), false)

  // Replay returns the retained terminal snapshot for page remounts.
  const replayed: ServerMessage[] = []
  h.manager.replayTo((message) => replayed.push(message))
  assert.equal(replayed.length, 1)
  assert.ok(replayed[0].type === 'calibration_update')
  assert.equal(replayed[0].data.phase, 'done')

  // After the retention window the snapshot is gone.
  h.clock.advance(CALIBRATION_TERMINAL_RETENTION_MS)
  const afterRetention: ServerMessage[] = []
  h.manager.replayTo((message) => afterRetention.push(message))
  assert.equal(afterRetention.length, 0)

  // A new session can start after terminal.
  h.manager.requestStart('client-b', { requestId: 'req-2', data: { kind: 'gyro' } })
  assert.equal(h.sessions.length, 2)
  assert.equal(h.manager.sessionActive, true)
  assert.equal(h.clock.pending >= 0, true)
}

// -- active replay goes to late joiners --------------------------------------------
{
  const h = makeManager()
  h.manager.requestStart('client-a', { requestId: 'req-1', data: { kind: 'mag' } })
  const replayed: ServerMessage[] = []
  h.manager.replayTo((message) => replayed.push(message))
  assert.equal(replayed.length, 1)
  assert.ok(replayed[0].type === 'calibration_update')
  assert.equal(replayed[0].data.phase, 'starting')
  const replayJson = JSON.stringify(replayed)
  assert.ok(!replayJson.includes('secret-token'), 'replay must not leak the token')
}

// -- link down / emergency disarm terminate the active session ----------------------
{
  const h = makeManager()
  h.manager.requestStart('client-a', { requestId: 'req-1', data: { kind: 'accel' } })
  h.manager.handleLinkDown()
  assert.deepEqual(h.sessions[0].terminateCalls, ['link_lost'])

  h.manager.requestStart('client-a', { requestId: 'req-2', data: { kind: 'accel' } })
  h.manager.notifyEmergencyDisarm()
  assert.deepEqual(h.sessions[1].terminateCalls, ['interrupted_by_disarm'])
}

console.log('CalibrationSessionManager ownership checks passed')
