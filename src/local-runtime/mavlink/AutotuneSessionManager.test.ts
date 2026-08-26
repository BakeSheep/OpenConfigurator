import assert from 'node:assert/strict'
import type { AutotuneSnapshot, RuntimeEvent } from '../../shared/types'
import {
  AUTOTUNE_ORPHAN_GRACE_MS,
  AutotuneSessionManager,
  type AutotuneSessionHandle,
  type AutotuneStartRequest,
} from './AutotuneSessionManager'

type TimerRecord = { at: number; fn: () => void }
class FakeClock {
  nowMs = 0
  timers = new Set<TimerRecord>()
  now = (): number => this.nowMs
  setTimer = (fn: () => void, ms: number): unknown => {
    const timer = { at: this.nowMs + ms, fn }
    this.timers.add(timer)
    return timer
  }
  clearTimer = (handle: unknown): void => { this.timers.delete(handle as TimerRecord) }
  advance(ms: number): void {
    const target = this.nowMs + ms
    for (;;) {
      const due = [...this.timers].filter((timer) => timer.at <= target)
        .sort((a, b) => a.at - b.at)[0]
      if (!due) break
      this.timers.delete(due)
      this.nowMs = due.at
      due.fn()
    }
    this.nowMs = target
  }
}

class FakeSession implements AutotuneSessionHandle {
  terminal = false
  owner: string | null
  recoverUntil: number | null = null
  terminateCodes: string[] = []
  actions: string[] = []
  private seq = 0
  private phase: AutotuneSnapshot['phase'] = 'starting'
  constructor(readonly request: AutotuneStartRequest, private now: () => number) {
    this.owner = request.ownerClientId
  }
  get sessionId(): string { return this.request.sessionId }
  start(): void { this.emit() }
  action(action: 'abort' | 'test_gains' | 'restore_gains') {
    this.actions.push(action)
    return { ok: true as const }
  }
  terminate(code: string): void {
    if (this.terminal) return
    this.terminateCodes.push(code)
    this.finish('interrupted')
  }
  setOwner(ownerClientId: string | null, recoverUntil: number | null): void {
    this.owner = ownerClientId
    this.recoverUntil = recoverUntil
    this.emit()
  }
  finish(phase: AutotuneSnapshot['phase']): void {
    this.terminal = true
    this.phase = phase
    this.emit()
  }
  snapshot(): AutotuneSnapshot { return this.build() }
  private emit(): void { this.seq += 1; this.request.emitSnapshot(this.build()) }
  private build(): AutotuneSnapshot {
    return {
      sessionId: this.sessionId,
      seq: this.seq,
      requestId: this.request.requestId,
      ownerClientId: this.owner,
      recoverUntil: this.recoverUntil,
      family: 'px4',
      phase: this.phase,
      verification: 'not_applicable',
      progress: null,
      axis: null,
      initialModeId: 4,
      updatedAt: this.now(),
      cancelSupported: false,
      baselineParameters: {},
    }
  }
}

const clock = new FakeClock()
const sessions: FakeSession[] = []
const sent: Array<{ clientId: string; message: RuntimeEvent }> = []
const releases: string[] = []
const manager = new AutotuneSessionManager({
  createSession: (request) => {
    const session = new FakeSession(request, clock.now)
    sessions.push(session)
    return session
  },
  broadcast: () => undefined,
  emitToClient: (clientId, message) => sent.push({ clientId, message }),
  pinController: () => undefined,
  releaseController: (sessionId) => releases.push(sessionId),
  now: clock.now,
  setTimer: clock.setTimer,
  clearTimer: clock.clearTimer,
  randomToken: () => 'secret-token-0123456789abcdef',
})

manager.requestStart('client-a', { requestId: 'request-1' })
assert.equal(sessions.length, 1)
assert.equal(manager.sessionActive, true)
const started = sent.find((entry) => entry.message.type === 'autotune_session_started')
assert.ok(started?.message.type === 'autotune_session_started')

manager.handleClientDisconnected('client-a')
assert.equal(sessions[0].owner, null)
clock.advance(AUTOTUNE_ORPHAN_GRACE_MS)
// Owner loss only terminates GCS state; it never invokes an aircraft action.
assert.deepEqual(sessions[0].actions, [])
assert.deepEqual(sessions[0].terminateCodes, ['owner_lost'])
assert.deepEqual(releases, [sessions[0].sessionId])

manager.requestStart('client-b', { requestId: 'request-2' })
manager.handleClientDisconnected('client-b')
const secondStarted = sent.filter((entry) => entry.message.type === 'autotune_session_started')[1]
assert.ok(secondStarted.message.type === 'autotune_session_started')
manager.reclaim('client-c', {
  sessionId: secondStarted.message.data.sessionId,
  recoveryToken: secondStarted.message.data.recoveryToken,
}, 'reclaim-1')
assert.equal(sessions[1].owner, 'client-c')
assert.equal(sessions[1].terminateCodes.length, 0)

console.log('AutotuneSessionManager tests passed')
