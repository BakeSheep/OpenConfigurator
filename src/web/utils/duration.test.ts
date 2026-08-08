import assert from 'node:assert/strict'
import test from 'node:test'
import { roundedDurationParts } from './duration'

test('rounded duration carries 60 seconds into the next minute', () => {
  assert.deepEqual(roundedDurationParts(59.6), { minutes: 1, seconds: 0 })
  assert.deepEqual(roundedDurationParts(119.6), { minutes: 2, seconds: 0 })
  assert.deepEqual(roundedDurationParts(61.2), { minutes: 1, seconds: 1 })
  assert.equal(roundedDurationParts(Number.NaN), null)
})
