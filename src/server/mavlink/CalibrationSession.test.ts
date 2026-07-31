import assert from 'node:assert/strict'
import type { CalibrationSnapshot } from '../../shared/types'
import { CalibrationSession, type CalibrationSessionOptions } from './CalibrationSession'

// ---------------------------------------------------------------------------
// Deterministic session state machine tests: injectable clock/timers, strict
// (sessionId, seq) monotonicity, 200ms progress coalescing, terminal
// idempotence and single-send command policy.
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

  get pending(): number {
    return this.timers.size
  }

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

type Harness = {
  session: CalibrationSession
  clock: FakeClock
  sent: Array<{ commandId: number; params: number[] }>
  snapshots: CalibrationSnapshot[]
}

function last(snapshots: CalibrationSnapshot[]): CalibrationSnapshot {
  assert.ok(snapshots.length > 0, 'expected at least one emitted snapshot')
  return snapshots[snapshots.length - 1]
}

function makeSession(overrides: Partial<CalibrationSessionOptions> = {}): Harness {
  const clock = new FakeClock()
  const sent: Array<{ commandId: number; params: number[] }> = []
  const snapshots: CalibrationSnapshot[] = []
  const session = new CalibrationSession({
    sessionId: 'sess-0001',
    requestId: 'req-1',
    family: 'px4',
    kind: 'accel',
    sendCommand: (commandId, params) => {
      sent.push({ commandId, params: [...params] })
      return true
    },
    emitSnapshot: (snapshot) => snapshots.push(structuredClone(snapshot)),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    ...overrides,
  })
  return { session, clock, sent, snapshots }
}

function assertSeqStrictlyIncreasing(snapshots: CalibrationSnapshot[]): void {
  for (let i = 1; i < snapshots.length; i++) {
    assert.ok(
      snapshots[i].seq > snapshots[i - 1].seq,
      `seq must strictly increase: ${snapshots[i - 1].seq} -> ${snapshots[i].seq}`,
    )
  }
}

// -- PX4 accel: happy path with sides, coalesced progress, verified done ------
{
  const { session, clock, sent, snapshots } = makeSession()
  session.start()
  assert.equal(sent.length, 1)
  assert.equal(sent[0].commandId, 241)
  assert.deepEqual(sent[0].params, [0, 0, 0, 0, 1, 0, 0]) // accel p5=1
  assert.equal(last(snapshots).phase, 'starting')
  assert.equal(last(snapshots).cancelSupported, true)
  assert.equal(last(snapshots).sessionId, 'sess-0001')
  assert.equal(last(snapshots).family, 'px4')

  // ACK accepted moves to running but NEVER produces a verified done.
  session.handleCommandAck(241, 0)
  assert.equal(last(snapshots).phase, 'running')
  assert.equal(last(snapshots).verification, 'not_applicable')

  // started line initializes all six sides for accel.
  session.handleStatustext('[cal] calibration started: 2 accel')
  const startedSnap = last(snapshots)
  assert.equal(startedSnap.protocolDegraded ?? false, false)
  assert.deepEqual(startedSnap.sides, {
    down: 'pending', up: 'pending', left: 'pending',
    right: 'pending', front: 'pending', back: 'pending',
  })

  // Orientation lifecycle emits immediately (phase-level change).
  session.handleStatustext('[cal] down orientation detected')
  assert.equal(last(snapshots).sides?.down, 'active')

  // Progress-only changes coalesce to >=200ms.
  const beforeProgress = snapshots.length
  session.handleStatustext('[cal] progress <5>')
  session.handleStatustext('[cal] progress <7>')
  session.handleStatustext('[cal] progress <9>')
  assert.equal(snapshots.length, beforeProgress, 'progress within 200ms must not emit yet')
  clock.advance(200)
  assert.equal(snapshots.length, beforeProgress + 1, 'coalesced progress flushes once')
  assert.equal(last(snapshots).progress, 9)

  session.handleStatustext('[cal] down side done, rotate to a different side')
  assert.equal(last(snapshots).sides?.down, 'done')

  // Unrelated statustext lines are ignored.
  const beforeJunk = snapshots.length
  session.handleStatustext('ARMED')
  session.handleStatustext('[cal] some unknown line')
  assert.equal(snapshots.length, beforeJunk)

  session.handleStatustext('[cal] calibration done: accel')
  const doneSnap = last(snapshots)
  assert.equal(doneSnap.phase, 'done')
  assert.equal(doneSnap.verification, 'verified')
  assert.equal(doneSnap.progress, 100)
  assert.equal(clock.pending, 0, 'no timers may survive a terminal snapshot')

  // Terminal idempotence: nothing after done produces snapshots or sends.
  const terminalCount = snapshots.length
  session.handleStatustext('[cal] calibration failed')
  session.handleStatustext('[cal] progress <50>')
  session.handleCommandAck(241, 4)
  assert.equal(snapshots.length, terminalCount)
  assert.equal(sent.length, 1, 'start command must be sent exactly once')
  assertSeqStrictlyIncreasing(snapshots)
}

// -- PX4 kind encodings --------------------------------------------------------
{
  const gyro = makeSession({ kind: 'gyro' })
  gyro.session.start()
  assert.deepEqual(gyro.sent[0].params, [1, 0, 0, 0, 0, 0, 0])
  const mag = makeSession({ kind: 'mag' })
  mag.session.start()
  assert.deepEqual(mag.sent[0].params, [0, 1, 0, 0, 0, 0, 0])
  const baro = makeSession({ kind: 'baro' })
  baro.session.start()
  assert.deepEqual(baro.sent[0].params, [0, 0, 1, 0, 0, 0, 0])
  const level = makeSession({ kind: 'level' })
  level.session.start()
  assert.deepEqual(level.sent[0].params, [0, 0, 0, 0, 2, 0, 0])
}

// -- PX4 mag: CAL_MAG_SIDES mask hides non-required sides ----------------------
{
  // bit0=back(tail) bit1=front(nose) bit2=left bit3=right bit4=up bit5=down
  const { session, snapshots } = makeSession({ kind: 'mag', magSides: (1 << 0) | (1 << 2) })
  session.start()
  session.handleStatustext('[cal] calibration started: 2 mag')
  const sides = last(snapshots).sides
  assert.deepEqual(sides, {
    down: 'hidden', up: 'hidden', left: 'pending',
    right: 'hidden', front: 'hidden', back: 'pending',
  })
  // Hidden side events are ignored instead of resurrecting the side.
  session.handleStatustext('[cal] up orientation detected')
  assert.equal(last(snapshots).sides?.up, 'hidden')
}

// -- Unknown protocol version: degraded, no side semantics, still terminal -----
{
  const { session, snapshots } = makeSession()
  session.start()
  session.handleStatustext('[cal] calibration started: 3 accel')
  assert.equal(last(snapshots).protocolDegraded, true)
  assert.equal(last(snapshots).sides, undefined)
  session.handleStatustext('[cal] down orientation detected')
  assert.equal(last(snapshots).sides, undefined)
  session.handleStatustext('[cal] progress <40>')
  assert.equal(session.snapshot().progress, 40)
  session.handleStatustext('[cal] calibration done: accel')
  assert.equal(last(snapshots).phase, 'done')
  assert.equal(last(snapshots).verification, 'verified')
}

// -- ACK accepted followed by protocol failure overrides ----------------------
{
  const { session, snapshots } = makeSession()
  session.start()
  session.handleCommandAck(241, 0)
  session.handleStatustext('[cal] calibration started: 2 accel')
  session.handleStatustext('[cal] calibration failed: sensor timeout')
  const failed = last(snapshots)
  assert.equal(failed.phase, 'failed')
  assert.equal(failed.failureCode, 'calibration_failed')
}

// -- ACK denied fails the session ---------------------------------------------
{
  const { session, snapshots, clock } = makeSession()
  session.start()
  session.handleCommandAck(241, 2) // MAV_RESULT_DENIED
  assert.equal(last(snapshots).phase, 'failed')
  assert.equal(last(snapshots).failureCode, 'start_denied')
  assert.equal(clock.pending, 0)
}

// -- Start evidence timeout (15s), single send, stable failureCode -------------
{
  const { session, clock, sent, snapshots } = makeSession()
  session.start()
  clock.advance(14_999)
  assert.equal(session.snapshot().phase, 'starting')
  clock.advance(1)
  assert.equal(last(snapshots).phase, 'failed')
  assert.equal(last(snapshots).failureCode, 'start_timeout')
  assert.equal(sent.length, 1, 'timeout must not retransmit the start command')
  assert.equal(clock.pending, 0)
}

// -- Idle timeout after activity (PX4 120s) ------------------------------------
{
  const { session, clock, snapshots } = makeSession()
  session.start()
  session.handleStatustext('[cal] calibration started: 2 accel')
  clock.advance(119_000)
  session.handleStatustext('[cal] progress <10>') // resets idle watchdog
  clock.advance(119_999)
  assert.notEqual(session.snapshot().phase, 'failed')
  clock.advance(1)
  assert.equal(last(snapshots).phase, 'failed')
  assert.equal(last(snapshots).failureCode, 'idle_timeout')
  assert.equal(clock.pending, 0)
}

// -- Overall timeout (PX4 15min) even with steady activity ---------------------
{
  const { session, clock, snapshots } = makeSession()
  session.start()
  session.handleStatustext('[cal] calibration started: 2 accel')
  for (let i = 0; i < 14; i++) {
    clock.advance(60_000)
    session.handleStatustext(`[cal] progress <${i + 1}>`)
  }
  clock.advance(60_000)
  assert.equal(last(snapshots).phase, 'failed')
  assert.equal(last(snapshots).failureCode, 'overall_timeout')
  assert.equal(clock.pending, 0)
}

// -- PX4 cancel: single all-zero 241; verified by [cal] cancelled ---------------
{
  const { session, clock, sent, snapshots } = makeSession()
  session.start()
  session.handleStatustext('[cal] calibration started: 2 accel')
  const result = session.cancel()
  assert.equal(result.ok, true)
  assert.equal(sent.length, 2)
  assert.deepEqual(sent[1], { commandId: 241, params: [0, 0, 0, 0, 0, 0, 0] })
  session.handleStatustext('[cal] calibration cancelled')
  assert.equal(last(snapshots).phase, 'cancelled')
  assert.equal(last(snapshots).verification, 'verified')
  assert.equal(clock.pending, 0)
  // cancel after terminal is refused without sending anything.
  const again = session.cancel()
  assert.equal(again.ok, false)
  assert.equal(sent.length, 2)
}

// -- PX4 cancel without confirmation: cancelled but unverified -----------------
{
  const { session, clock, snapshots } = makeSession()
  session.start()
  session.handleStatustext('[cal] calibration started: 2 accel')
  session.cancel()
  clock.advance(30_000)
  const snap = last(snapshots)
  assert.equal(snap.phase, 'cancelled')
  assert.equal(snap.verification, 'ack_only')
  assert.equal(snap.failureCode, 'cancel_unverified')
  assert.equal(clock.pending, 0)
}

// -- ArduPilot one-shot kinds: ACK-only terminal, never verified ----------------
{
  const { session, sent, snapshots, clock } = makeSession({ family: 'ardupilot', kind: 'accel_simple' })
  session.start()
  assert.deepEqual(sent[0].params, [0, 0, 0, 0, 4, 0, 0]) // simple p5=4
  assert.equal(last(snapshots).cancelSupported, false)
  session.handleCommandAck(241, 0)
  const snap = last(snapshots)
  assert.equal(snap.phase, 'accepted')
  assert.equal(snap.verification, 'ack_only')
  assert.equal(clock.pending, 0)
}
{
  const level = makeSession({ family: 'ardupilot', kind: 'level' })
  level.session.start()
  assert.deepEqual(level.sent[0].params, [0, 0, 0, 0, 2, 0, 0])
  const gyro = makeSession({ family: 'ardupilot', kind: 'gyro' })
  gyro.session.start()
  assert.deepEqual(gyro.sent[0].params, [1, 0, 0, 0, 0, 0, 0])
  const baro = makeSession({ family: 'ardupilot', kind: 'baro' })
  baro.session.start()
  assert.deepEqual(baro.sent[0].params, [0, 0, 1, 0, 0, 0, 0])
  // IN_PROGRESS extends the wait instead of finishing.
  gyro.session.handleCommandAck(241, 5)
  assert.equal(last(gyro.snapshots).phase, 'running')
  gyro.session.handleCommandAck(241, 0)
  assert.equal(last(gyro.snapshots).phase, 'accepted')
  assert.equal(last(gyro.snapshots).verification, 'ack_only')
  // Cancel is unsupported for AP one-shots.
  const cancelResult = baro.session.cancel()
  assert.equal(cancelResult.ok, false)
  if (!cancelResult.ok) assert.equal(cancelResult.code, 'cancel_unsupported')
}

// -- ArduPilot one-shot ACK timeout (30s) --------------------------------------
{
  const { session, clock, snapshots } = makeSession({ family: 'ardupilot', kind: 'level' })
  session.start()
  clock.advance(30_000)
  assert.equal(last(snapshots).phase, 'failed')
  assert.equal(last(snapshots).failureCode, 'ack_timeout')
  assert.equal(clock.pending, 0)
}

// -- External termination (link drop) cleans up --------------------------------
{
  const { session, clock, snapshots } = makeSession()
  session.start()
  session.handleStatustext('[cal] calibration started: 2 accel')
  session.terminate('link_lost', '飞控链路已断开')
  const snap = last(snapshots)
  assert.equal(snap.phase, 'failed')
  assert.equal(snap.failureCode, 'link_lost')
  assert.equal(clock.pending, 0)
  // terminate is idempotent.
  const count = snapshots.length
  session.terminate('link_lost', 'again')
  assert.equal(snapshots.length, count)
}

// -- Ownership updates re-emit; replay does not bump seq ------------------------
{
  const { session, snapshots } = makeSession()
  session.start()
  session.setOwner('client-a', null)
  assert.equal(last(snapshots).ownerClientId, 'client-a')
  const seqAfterOwner = last(snapshots).seq
  session.setOwner('client-a', null) // unchanged: no new snapshot
  assert.equal(last(snapshots).seq, seqAfterOwner)
  session.setOwner(null, 12_345)
  assert.equal(last(snapshots).ownerClientId, null)
  assert.equal(last(snapshots).recoverUntil, 12_345)
  const replay = session.snapshot()
  assert.deepEqual(replay, last(snapshots))
  assert.equal(session.snapshot().seq, replay.seq, 'replay must not bump seq')
  assertSeqStrictlyIncreasing(snapshots)
}

// -- Write rejection fails the session immediately ------------------------------
{
  const clock = new FakeClock()
  const snapshots: CalibrationSnapshot[] = []
  const session = new CalibrationSession({
    sessionId: 'sess-0002',
    requestId: 'req-2',
    family: 'px4',
    kind: 'gyro',
    sendCommand: () => false,
    emitSnapshot: (snapshot) => snapshots.push(structuredClone(snapshot)),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  })
  session.start()
  assert.equal(last(snapshots).phase, 'failed')
  assert.equal(last(snapshots).failureCode, 'write_rejected')
  assert.equal(clock.pending, 0)
}

// -- ArduPilot interactive accel (42429): six-position sequence ----------------
{
  const { session, sent, snapshots, clock } = makeSession({ family: 'ardupilot', kind: 'accel' })
  session.start()
  assert.deepEqual(sent[0], { commandId: 241, params: [0, 0, 0, 0, 1, 0, 0] })
  assert.equal(last(snapshots).cancelSupported, false)
  // Six sides are shown from the start so the wizard is complete.
  assert.deepEqual(last(snapshots).sides, {
    down: 'pending', up: 'pending', left: 'pending',
    right: 'pending', front: 'pending', back: 'pending',
  })

  // FC requests LEVEL (position 1 -> down side).
  session.handlePositionRequest(1)
  assert.equal(last(snapshots).phase, 'waiting_position')
  assert.equal(last(snapshots).requestedPosition, 1)
  assert.equal(last(snapshots).sides?.down, 'active')

  // A stale/mismatched confirm is rejected and sends nothing.
  const sentBeforeConfirm = sent.length
  const staleConfirm = session.confirmPosition(2)
  assert.equal(staleConfirm.ok, false)
  assert.equal(sent.length, sentBeforeConfirm)

  // Correct confirm echoes the same COMMAND_LONG(42429) with param1=position.
  const confirm = session.confirmPosition(1)
  assert.equal(confirm.ok, true)
  assert.deepEqual(sent[sent.length - 1], { commandId: 42429, params: [1, 0, 0, 0, 0, 0, 0] })
  assert.equal(last(snapshots).phase, 'running')
  assert.equal(last(snapshots).requestedPosition, null)

  // FC repeats the same position (retry): idempotent re-confirm is allowed.
  session.handlePositionRequest(1)
  assert.equal(last(snapshots).phase, 'waiting_position')
  const reconfirm = session.confirmPosition(1)
  assert.equal(reconfirm.ok, true)

  // Next position (LEFT=2): the previous side is marked done.
  session.handlePositionRequest(2)
  assert.equal(last(snapshots).sides?.down, 'done')
  assert.equal(last(snapshots).sides?.left, 'active')
  session.confirmPosition(2)

  // Success sentinel: verified done, all sides done, no residual timers.
  session.handlePositionRequest(16777215)
  assert.equal(last(snapshots).phase, 'done')
  assert.equal(last(snapshots).verification, 'verified')
  assert.equal(last(snapshots).progress, 100)
  for (const side of ['down', 'up', 'left', 'right', 'front', 'back'] as const) {
    assert.equal(last(snapshots).sides?.[side], 'done')
  }
  assert.equal(clock.pending, 0)
  // A confirm after terminal is refused.
  assert.equal(session.confirmPosition(1).ok, false)
}

// -- ArduPilot interactive accel: failure sentinel -----------------------------
{
  const { session, snapshots, clock } = makeSession({ family: 'ardupilot', kind: 'accel' })
  session.start()
  session.handlePositionRequest(1)
  session.confirmPosition(1)
  session.handlePositionRequest(16777216)
  assert.equal(last(snapshots).phase, 'failed')
  assert.equal(last(snapshots).failureCode, 'calibration_failed')
  assert.equal(clock.pending, 0)
}

// -- ArduPilot interactive accel: a position request clears the start watchdog --
{
  const { session, snapshots, clock } = makeSession({ family: 'ardupilot', kind: 'accel' })
  session.start()
  // No ACK, but a position request is protocol evidence: the 15s start timeout
  // must not fire afterwards.
  clock.advance(10_000)
  session.handlePositionRequest(1)
  clock.advance(10_000)
  assert.notEqual(last(snapshots).phase, 'failed')
  // AP accel idle timeout is 5 minutes of no activity.
  clock.advance(5 * 60_000)
  assert.equal(last(snapshots).phase, 'failed')
  assert.equal(last(snapshots).failureCode, 'idle_timeout')
}

// -- ArduPilot onboard compass (42424/191/192/42425): single compass ----------
{
  const { session, sent, snapshots, clock } = makeSession({ family: 'ardupilot', kind: 'mag' })
  session.start()
  // Mag starts with DO_START_MAG_CAL (42424), all-zero params, cancellable.
  assert.deepEqual(sent[0], { commandId: 42424, params: [0, 0, 0, 0, 0, 0, 0] })
  assert.equal(last(snapshots).cancelSupported, true)

  // Cancel uses the ArduPilot-specific command and its ACK immediately ends
  // the UI session instead of leaving the wizard open until timeout.
  assert.deepEqual(session.cancel(), { ok: true })
  assert.deepEqual(sent[1], { commandId: 42426, params: [0, 0, 0, 0, 0, 0, 0] })
  session.handleCommandAck(42426, 0)
  assert.equal(last(snapshots).phase, 'cancelled')
  assert.equal(last(snapshots).verification, 'ack_only')
  assert.equal(clock.pending, 0)
}

// -- ArduPilot onboard compass progress/report/accept flow -------------------
{
  const { session, sent, snapshots, clock } = makeSession({ family: 'ardupilot', kind: 'mag' })
  session.start()

  // 191 progress establishes the expected mask (compass 0) and drives running.
  session.handleMagProgress({ compassId: 0, calMask: 0b001, calStatus: 2, attempt: 1, completionPct: 30 })
  assert.equal(last(snapshots).phase, 'running')
  assert.equal(last(snapshots).expectedMagMask, 0b001)
  const inst0 = last(snapshots).magInstances?.find((m) => m.id === 0)
  assert.equal(inst0?.pct, 30)

  // 192 SUCCESS report (autosave=0 flow) -> awaiting_accept, report attached.
  session.handleMagReport({ compassId: 0, calMask: 0b001, calStatus: 4, autosaved: 0, fitness: 6.5, ofs: [10, 20, 30] })
  assert.equal(last(snapshots).phase, 'awaiting_accept')
  const report0 = last(snapshots).magInstances?.find((m) => m.id === 0)?.report
  assert.equal(report0?.fitness, 6.5)
  assert.equal(report0?.autosaved, false)

  // accept -> DO_ACCEPT_MAG_CAL (42425) with the expected mask.
  const accept = session.acceptMag()
  assert.equal(accept.ok, true)
  assert.deepEqual(sent[sent.length - 1], { commandId: 42425, params: [0b001, 0, 0, 0, 0, 0, 0] })

  // An autosaved report completes the session: verified + reboot required.
  session.handleMagReport({ compassId: 0, calMask: 0b001, calStatus: 4, autosaved: 1, fitness: 6.5, ofs: [10, 20, 30] })
  assert.equal(last(snapshots).phase, 'done')
  assert.equal(last(snapshots).verification, 'verified')
  assert.equal(last(snapshots).rebootRequired, true)
  assert.equal(clock.pending, 0)
}

// -- ArduPilot compass: accept ACK without autosaved report -> ack_only --------
{
  const { session, snapshots, clock } = makeSession({ family: 'ardupilot', kind: 'mag' })
  session.start()
  session.handleMagProgress({ compassId: 0, calMask: 0b001, calStatus: 2, attempt: 1, completionPct: 90 })
  session.handleMagReport({ compassId: 0, calMask: 0b001, calStatus: 4, autosaved: 0, fitness: 5, ofs: [0, 0, 0] })
  session.acceptMag()
  session.handleCommandAck(42425, 0)
  // No autosaved report arrives within the compatibility window.
  clock.advance(5_000)
  assert.equal(last(snapshots).phase, 'accepted')
  assert.equal(last(snapshots).verification, 'ack_only')
  assert.equal(last(snapshots).rebootRequired, true)
  assert.equal(clock.pending, 0)
}

// -- ArduPilot compass: missing/failed accept ACK never reports accepted -------
{
  const prepare = (): Harness => {
    const harness = makeSession({ family: 'ardupilot', kind: 'mag' })
    harness.session.start()
    harness.session.handleMagProgress({ compassId: 0, calMask: 0b001, calStatus: 2, attempt: 1, completionPct: 90 })
    harness.session.handleMagReport({ compassId: 0, calMask: 0b001, calStatus: 4, autosaved: 0, fitness: 5, ofs: [0, 0, 0] })
    assert.equal(harness.session.acceptMag().ok, true)
    return harness
  }

  const missing = prepare()
  missing.clock.advance(5_000)
  assert.equal(last(missing.snapshots).phase, 'failed')
  assert.equal(last(missing.snapshots).failureCode, 'accept_ack_timeout')

  const denied = prepare()
  denied.session.handleCommandAck(42425, 2)
  assert.equal(last(denied.snapshots).phase, 'failed')
  assert.equal(last(denied.snapshots).failureCode, 'accept_denied')
  assert.equal(denied.clock.pending, 0)
}

// -- ArduPilot compass: firmware failure status -> specific failure ------------
{
  const { session, snapshots, clock } = makeSession({ family: 'ardupilot', kind: 'mag' })
  session.start()
  session.handleMagProgress({ compassId: 0, calMask: 0b001, calStatus: 2, attempt: 1, completionPct: 40 })
  session.handleMagProgress({ compassId: 0, calMask: 0b001, calStatus: 6, attempt: 1, completionPct: 40 })
  assert.equal(last(snapshots).phase, 'failed')
  assert.match(last(snapshots).failureCode ?? '', /mag/)
  assert.equal(clock.pending, 0)
  // accept after terminal is refused.
  assert.equal(session.acceptMag().ok, false)
}

// -- ArduPilot compass: two compasses must both succeed before accept ----------
{
  const { session, snapshots } = makeSession({ family: 'ardupilot', kind: 'mag' })
  session.start()
  session.handleMagProgress({ compassId: 0, calMask: 0b011, calStatus: 2, attempt: 1, completionPct: 50 })
  session.handleMagProgress({ compassId: 1, calMask: 0b011, calStatus: 2, attempt: 1, completionPct: 20 })
  assert.equal(last(snapshots).expectedMagMask, 0b011)
  assert.equal(last(snapshots).magInstances?.length, 2)
  // Only one compass reports success: still not acceptable.
  session.handleMagReport({ compassId: 0, calMask: 0b011, calStatus: 4, autosaved: 0, fitness: 5, ofs: [0, 0, 0] })
  assert.notEqual(last(snapshots).phase, 'awaiting_accept')
  assert.equal(session.acceptMag().ok, false)
  // Second compass succeeds: now acceptable.
  session.handleMagReport({ compassId: 1, calMask: 0b011, calStatus: 4, autosaved: 0, fitness: 7, ofs: [0, 0, 0] })
  assert.equal(last(snapshots).phase, 'awaiting_accept')
  assert.equal(session.acceptMag().ok, true)
}

console.log('CalibrationSession state machine checks passed')
