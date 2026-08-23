import assert from 'node:assert/strict'
import type { AutotuneSnapshot } from '../../shared/types'
import { useAutotuneStore } from './autotuneStore'

function snapshot(overrides: Partial<AutotuneSnapshot> = {}): AutotuneSnapshot {
  return {
    sessionId: 'autotune-1',
    seq: 1,
    requestId: 'request-1',
    ownerClientId: 'client-a',
    recoverUntil: null,
    family: 'px4',
    phase: 'starting',
    verification: 'not_applicable',
    progress: null,
    axis: null,
    initialModeId: 4,
    updatedAt: 0,
    cancelSupported: false,
    baselineParameters: { MC_ROLLRATE_P: 0.1 },
    ...overrides,
  }
}

useAutotuneStore.getState().reset()
useAutotuneStore.getState().applySnapshot(snapshot({ seq: 2, phase: 'tuning' }))
useAutotuneStore.getState().applySnapshot(snapshot({ seq: 1, phase: 'starting' }))
assert.equal(useAutotuneStore.getState().snapshot?.seq, 2)
assert.equal(useAutotuneStore.getState().snapshot?.phase, 'tuning')

useAutotuneStore.getState().setRecovery({ sessionId: 'autotune-1', recoveryToken: 'secret-token' })
useAutotuneStore.getState().applySnapshot(snapshot({ seq: 3, phase: 'completed' }))
assert.equal(useAutotuneStore.getState().recovery, null, 'PX4 completed is terminal')

useAutotuneStore.getState().setRecovery({ sessionId: 'autotune-2', recoveryToken: 'secret-token-2' })
useAutotuneStore.getState().applySnapshot(snapshot({
  sessionId: 'autotune-2', seq: 1, family: 'ardupilot', phase: 'completed',
}))
assert.notEqual(useAutotuneStore.getState().recovery, null, 'ArduPilot completion still awaits test/save')
useAutotuneStore.getState().applySnapshot(snapshot({
  sessionId: 'autotune-2', seq: 2, family: 'ardupilot', phase: 'saved',
  verification: 'parameters_saved',
}))
assert.equal(useAutotuneStore.getState().recovery, null)

useAutotuneStore.getState().reset()
console.log('autotuneStore idempotency checks passed')
