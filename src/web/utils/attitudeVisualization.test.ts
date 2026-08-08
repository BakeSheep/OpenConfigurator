import assert from 'node:assert/strict'
import test from 'node:test'
import {
  attitudeToHorizonTransform,
  attitudeToModelRotation,
  degreeAttitudeToModelRotation,
} from './attitudeVisualization'

test('maps MAVLink attitude axes to the Three.js model axes', () => {
  assert.deepEqual(
    attitudeToModelRotation({ roll: 0.25, pitch: -0.1, yaw: 0.75 }),
    { x: -0.1, y: -0.75, z: -0.25 },
  )
})

test('maps degree-based log attitude with the same axis signs as live telemetry', () => {
  const logRotation = degreeAttitudeToModelRotation({ roll: 30, pitch: -10, yaw: 45 })
  const liveRotation = attitudeToModelRotation({
    roll: 30 * Math.PI / 180,
    pitch: -10 * Math.PI / 180,
    yaw: 45 * Math.PI / 180,
  })
  assert.deepEqual(logRotation, liveRotation)
  assert.ok(logRotation.z < 0)
})

test('counter-rotates the artificial horizon for positive roll', () => {
  assert.equal(attitudeToHorizonTransform(14, -2.7), 'rotate(-14.0deg) translateY(3.1%)')
})
