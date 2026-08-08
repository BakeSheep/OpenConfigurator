import assert from 'node:assert/strict'
import { useConnectionStore } from './connectionStore'

useConnectionStore.getState().setActivePresetId('preset-1')
assert.equal(useConnectionStore.getState().activePresetId, 'preset-1')
useConnectionStore.getState().setDisconnected()
assert.equal(useConnectionStore.getState().activePresetId, null)

console.log('connection active-preset state checks passed')
