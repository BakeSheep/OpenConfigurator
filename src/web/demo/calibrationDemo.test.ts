import assert from 'node:assert/strict'
import type { CalibrationSnapshot } from '../../shared/types'
import { createCalibrationDemo } from './calibrationDemo'

// ---------------------------------------------------------------------------
// Demo calibration driver: deterministic scripts that emit valid, monotonic
// (sessionId, seq) snapshots and an owner-only recovery token, with fully
// tracked timers. Covers PX4 six-side, ArduPilot six-position confirm,
// ArduPilot mag report/accept, failure/cancel and cleanup.
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
  readonly clearTimer = (handle: unknown): void => { this.timers.delete(handle as TimerRecord) }
  get pending(): number { return this.timers.size }
  advance(ms: number): void {
    const target = this.nowMs + ms
    for (;;) {
      const due = [...this.timers].filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0]
      if (!due) break
      this.timers.delete(due)
      this.nowMs = Math.max(this.nowMs, due.at)
      due.fn()
    }
    this.nowMs = target
  }
}

type Harness = {
  clock: FakeClock
  snapshots: CalibrationSnapshot[]
  demo: ReturnType<typeof createCalibrationDemo>
}

function makeDemo(family: 'px4' | 'ardupilot'): Harness {
  const clock = new FakeClock()
  const snapshots: CalibrationSnapshot[] = []
  let id = 0
  const demo = createCalibrationDemo({
    applySnapshot: (snapshot) => snapshots.push(structuredClone(snapshot)),
    family: () => family,
    ownerClientId: () => 'demo-client',
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    makeId: () => `id-${id++}`,
  })
  return { clock, snapshots, demo }
}

function last(snapshots: CalibrationSnapshot[]): CalibrationSnapshot {
  assert.ok(snapshots.length > 0)
  return snapshots[snapshots.length - 1]
}

function assertMonotonic(snapshots: CalibrationSnapshot[]): void {
  for (let i = 1; i < snapshots.length; i++) {
    assert.equal(snapshots[i].sessionId, snapshots[0].sessionId)
    assert.ok(snapshots[i].seq > snapshots[i - 1].seq, 'seq must strictly increase')
  }
}

// -- PX4 six-side accel drives itself to a verified done ----------------------
{
  const h = makeDemo('px4')
  const handled = h.demo.handleRuntimeCommand({ type: 'start_calibration', requestId: 'r1', data: { kind: 'accel' } })
  assert.equal(handled, true)
  assert.equal(h.snapshots[0].phase, 'starting')
  assert.equal(h.snapshots[0].ownerClientId, 'demo-client')
  h.clock.advance(20_000)
  assert.equal(last(h.snapshots).phase, 'done')
  assert.equal(last(h.snapshots).verification, 'verified')
  for (const side of ['down', 'up', 'left', 'right', 'front', 'back'] as const) {
    assert.equal(last(h.snapshots).sides?.[side], 'done')
  }
  assertMonotonic(h.snapshots)
  assert.equal(h.clock.pending, 0, 'no timers leak after completion')
}

// -- PX4 gyro one-shot -> verified done ---------------------------------------
{
  const h = makeDemo('px4')
  h.demo.handleRuntimeCommand({ type: 'start_calibration', requestId: 'r1', data: { kind: 'gyro' } })
  h.clock.advance(5_000)
  assert.equal(last(h.snapshots).phase, 'done')
  assert.equal(last(h.snapshots).verification, 'verified')
}

// -- ArduPilot six-position accel waits for confirm at each step --------------
{
  const h = makeDemo('ardupilot')
  h.demo.handleRuntimeCommand({ type: 'start_calibration', requestId: 'r1', data: { kind: 'accel' } })
  const sessionId = h.snapshots[0].sessionId
  h.clock.advance(1_000)
  assert.equal(last(h.snapshots).phase, 'waiting_position')
  assert.equal(last(h.snapshots).requestedPosition, 1)
  // Confirm all six positions.
  for (let position = 1; position <= 6; position++) {
    h.demo.handleRuntimeCommand({
      type: 'calibration_action',
      requestId: `a${position}`,
      data: { sessionId, action: 'confirm_position', position: position as 1 },
    })
    h.clock.advance(1_000)
  }
  assert.equal(last(h.snapshots).phase, 'done')
  assert.equal(last(h.snapshots).verification, 'verified')
  assert.equal(h.clock.pending, 0)
}

// -- ArduPilot mag: progress -> awaiting_accept -> accept -> done+reboot -------
{
  const h = makeDemo('ardupilot')
  h.demo.handleRuntimeCommand({ type: 'start_calibration', requestId: 'r1', data: { kind: 'mag' } })
  const sessionId = h.snapshots[0].sessionId
  h.clock.advance(10_000)
  assert.equal(last(h.snapshots).phase, 'awaiting_accept')
  assert.equal(last(h.snapshots).magInstances?.[0]?.report?.autosaved, false)
  h.demo.handleRuntimeCommand({ type: 'calibration_action', requestId: 'a', data: { sessionId, action: 'accept_mag' } })
  h.clock.advance(2_000)
  assert.equal(last(h.snapshots).phase, 'done')
  assert.equal(last(h.snapshots).rebootRequired, true)
  assert.equal(last(h.snapshots).magInstances?.[0]?.report?.autosaved, true)
}

// -- cancel produces a cancelled snapshot and clears timers -------------------
{
  const h = makeDemo('px4')
  h.demo.handleRuntimeCommand({ type: 'start_calibration', requestId: 'r1', data: { kind: 'accel' } })
  const sessionId = h.snapshots[0].sessionId
  h.clock.advance(1_000)
  h.demo.handleRuntimeCommand({ type: 'calibration_action', requestId: 'c', data: { sessionId, action: 'cancel' } })
  assert.equal(last(h.snapshots).phase, 'cancelled')
  assert.equal(h.clock.pending, 0, 'cancel clears pending script timers')
}

// -- stop() clears all timers and detaches --------------------------------------
{
  const h = makeDemo('px4')
  h.demo.handleRuntimeCommand({ type: 'start_calibration', requestId: 'r1', data: { kind: 'accel' } })
  h.clock.advance(1_000)
  assert.ok(h.clock.pending > 0)
  h.demo.stop()
  assert.equal(h.clock.pending, 0)
}

console.log('calibration demo script checks passed')
