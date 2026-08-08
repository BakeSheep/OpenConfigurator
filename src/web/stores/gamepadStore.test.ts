import assert from 'node:assert/strict'
import { useGamepadStore } from './gamepadStore'

const store = useGamepadStore.getState()
store.setEnabled(true)
store.setConnected(true, 'test pad')
store.setConnected(false)
assert.equal(useGamepadStore.getState().enabled, true, 'temporary gamepad loss must preserve enable intent')
store.setEnabled(false)

console.log('gamepad store enable-intent checks passed')
