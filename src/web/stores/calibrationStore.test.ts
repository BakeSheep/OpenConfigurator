import assert from 'node:assert/strict'
import type { CalibrationSnapshot } from '../../shared/types'
import { useCalibrationStore } from './calibrationStore'

// ---------------------------------------------------------------------------
// Idempotent calibration snapshot store: (sessionId, seq) monotonicity, cross
// session reset, terminal retention and disconnect clearing.
// ---------------------------------------------------------------------------

function snapshot(overrides: Partial<CalibrationSnapshot> = {}): CalibrationSnapshot {
  return {
    sessionId: 'sess-1',
    seq: 1,
    ownerClientId: 'client-a',
    recoverUntil: null,
    requestId: 'req-1',
    family: 'px4',
    kind: 'accel',
    phase: 'starting',
    verification: 'not_applicable',
    progress: null,
    updatedAt: 0,
    rebootRequired: false,
    cancelSupported: true,
    ...overrides,
  }
}

function reset(): void {
  useCalibrationStore.getState().reset()
}

// -- monotonic seq within a session -------------------------------------------
reset()
useCalibrationStore.getState().applySnapshot(snapshot({ seq: 1, phase: 'starting' }))
assert.equal(useCalibrationStore.getState().snapshot?.seq, 1)
useCalibrationStore.getState().applySnapshot(snapshot({ seq: 3, phase: 'running' }))
assert.equal(useCalibrationStore.getState().snapshot?.seq, 3)
assert.equal(useCalibrationStore.getState().snapshot?.phase, 'running')
// Older or duplicate seq for the same session is ignored.
useCalibrationStore.getState().applySnapshot(snapshot({ seq: 2, phase: 'starting' }))
assert.equal(useCalibrationStore.getState().snapshot?.seq, 3)
useCalibrationStore.getState().applySnapshot(snapshot({ seq: 3, phase: 'starting' }))
assert.equal(useCalibrationStore.getState().snapshot?.phase, 'running')

// -- a different session may start from seq=1 ---------------------------------
useCalibrationStore.getState().applySnapshot(snapshot({ sessionId: 'sess-2', seq: 1, phase: 'starting' }))
assert.equal(useCalibrationStore.getState().snapshot?.sessionId, 'sess-2')
assert.equal(useCalibrationStore.getState().snapshot?.seq, 1)

// -- terminal snapshot is retained -------------------------------------------
reset()
useCalibrationStore.getState().applySnapshot(snapshot({ seq: 1 }))
useCalibrationStore.getState().applySnapshot(snapshot({ seq: 2, phase: 'done', verification: 'verified' }))
assert.equal(useCalibrationStore.getState().snapshot?.phase, 'done')
assert.equal(useCalibrationStore.getState().isTerminal(), true)

// -- isOwner reflects the snapshot owner vs current client --------------------
reset()
useCalibrationStore.getState().applySnapshot(snapshot({ ownerClientId: 'client-a' }))
assert.equal(useCalibrationStore.getState().isOwner('client-a'), true)
assert.equal(useCalibrationStore.getState().isOwner('client-b'), false)
assert.equal(useCalibrationStore.getState().isOwner(null), false)

reset()
console.log('calibrationStore idempotency checks passed')
