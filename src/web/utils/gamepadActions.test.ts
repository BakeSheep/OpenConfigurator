import assert from 'node:assert/strict'
import { buildVehicleIdentity } from '../../shared/vehicleProfiles'
import {
  canRepeatGamepadAction,
  createModeGamepadAction,
  isGamepadActionId,
  normalizeGamepadActionForIdentity,
  requiresGamepadArmHold,
  resolveGamepadArmHoldTransition,
  resolveGamepadModeAction,
} from './gamepadActions'

const px4Copter = buildVehicleIdentity(12, 2)
const arducopter = buildVehicleIdentity(3, 2)

assert.equal(createModeGamepadAction(px4Copter, 4), 'mode:px4:4')
assert.equal(createModeGamepadAction(arducopter, 4), 'mode:ardupilot:copter:4')
assert.equal(createModeGamepadAction(buildVehicleIdentity(3, 1), 4), null)

assert.equal(resolveGamepadModeAction('mode:px4:4', px4Copter)?.name, 'Mission')
assert.equal(resolveGamepadModeAction('mode:ardupilot:copter:4', arducopter)?.name, 'Guided')
assert.equal(resolveGamepadModeAction('mode:px4:4', arducopter), null)
assert.equal(resolveGamepadModeAction('mode:ardupilot:copter:4', px4Copter), null)

// Version-1 semantic assignments remain compatible, but resolve only against
// the current profile's QGC-selectable list.
assert.equal(resolveGamepadModeAction('mission', px4Copter)?.name, 'Mission')
assert.equal(resolveGamepadModeAction('mission', arducopter)?.name, 'Auto')
assert.equal(resolveGamepadModeAction('rtl', px4Copter)?.name, 'Return')
assert.equal(resolveGamepadModeAction('land', px4Copter), null)
assert.equal(resolveGamepadModeAction('land', arducopter)?.name, 'Land')
assert.equal(normalizeGamepadActionForIdentity('mission', px4Copter), 'mode:px4:4')

for (const action of [
  'none', 'arm', 'disarm', 'toggle_arm', 'mission',
  'mode:px4:4', 'mode:ardupilot:copter:28',
]) {
  assert.equal(isGamepadActionId(action), true, action)
}
for (const action of [
  '', 'launch', 'mode:px4:-1', 'mode:px4:Infinity', 'mode:ardupilot:plane:4',
  'mode:ardupilot:copter:4x', 'mode:unknown:4',
]) {
  assert.equal(isGamepadActionId(action), false, action)
}

assert.equal(canRepeatGamepadAction('arm'), false)
assert.equal(canRepeatGamepadAction('mission'), false)
assert.equal(canRepeatGamepadAction('mode:px4:4'), false)

assert.equal(requiresGamepadArmHold('arm', false), true)
assert.equal(requiresGamepadArmHold('toggle_arm', false), true)
assert.equal(requiresGamepadArmHold('disarm', true), false)
assert.equal(requiresGamepadArmHold('toggle_arm', true), false)
assert.deepEqual(resolveGamepadArmHoldTransition(true, false, undefined, 1_000), {
  kind: 'started',
  startedAt: 1_000,
})
assert.deepEqual(resolveGamepadArmHoldTransition(true, true, 1_000, 2_999), {
  kind: 'pending',
  startedAt: 1_000,
})
assert.deepEqual(resolveGamepadArmHoldTransition(true, true, 1_000, 3_000), {
  kind: 'confirmed',
})
assert.deepEqual(resolveGamepadArmHoldTransition(false, true, 1_000, 1_500), {
  kind: 'cancelled',
})

console.log('gamepad action compatibility checks passed')
