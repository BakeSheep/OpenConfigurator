import assert from 'node:assert/strict'
import test from 'node:test'
import {
  attitudeToHorizonTransform,
  attitudeToModelRotation,
} from './attitudeVisualization'

test('maps MAVLink attitude axes to the Three.js model axes', () => {
  assert.deepEqual(
    attitudeToModelRotation({ roll: 0.25, pitch: -0.1, yaw: 0.75 }),
    { x: -0.1, y: -0.75, z: -0.25 },
  )
})

test('counter-rotates the artificial horizon for positive roll', () => {
  assert.equal(attitudeToHorizonTransform(14, -2.7), 'rotate(-14.0deg) translateY(3.1%)')
})
