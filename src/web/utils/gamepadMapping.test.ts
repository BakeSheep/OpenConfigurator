import assert from 'node:assert/strict'
import { axisFunction, remapAxisFunction } from './gamepadMapping'

const mapping = { throttle: 1, yaw: 0, pitch: 3, roll: 2 }

assert.equal(axisFunction(mapping, 0), 'yaw')
assert.equal(axisFunction(mapping, 1), 'throttle')
assert.equal(axisFunction(mapping, 2), 'roll')
assert.equal(axisFunction(mapping, 3), 'pitch')
assert.equal(axisFunction(mapping, 4), null)

assert.deepEqual(remapAxisFunction(mapping, 0, 'throttle'), {
  throttle: 0,
  yaw: 1,
})
assert.deepEqual(remapAxisFunction(mapping, 2, 'roll'), {})

console.log('gamepad mapping checks passed')
