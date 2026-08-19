import assert from 'node:assert/strict'
import test from 'node:test'
import {
  formatParameterValue,
  parameterValuesEqual,
  roundParameterValue,
  sanitizeParameterFloat,
  shouldReleaseParameterDraft,
} from './parameterDisplay'

test('formats MAVLink float32 parameter echoes without binary noise', () => {
  assert.equal(formatParameterValue(3.200000047683716, 0.01), '3.2')
  assert.equal(formatParameterValue(4.199999809265137, 0.01), '4.2')
  assert.equal(formatParameterValue(21.1200008392334, 0.001), '21.12')
  assert.equal(formatParameterValue(4200, 10), '4200')
  assert.equal(formatParameterValue(0.0000010000001111620804, 1e-7), '0.000001')
})

test('parameter display helpers retain meaningful precision and equality', () => {
  assert.equal(sanitizeParameterFloat(0.123456789), 0.1234568)
  assert.equal(roundParameterValue(1.23456789, 0.001), 1.2346)
  assert.equal(parameterValuesEqual(21.12, 21.1200008392334, 0.001), true)
  assert.equal(parameterValuesEqual(21.13, 21.1200008392334, 0.001), false)
})

test('keeps an optimistic parameter draft until its matching echo arrives', () => {
  assert.equal(shouldReleaseParameterDraft('4.2', 4.199999809265137, 4.2, 0.01), true)
  assert.equal(shouldReleaseParameterDraft('4.2', 4.1, 4.2, 0.01), false)
  assert.equal(shouldReleaseParameterDraft('4.3', 4.199999809265137, 4.2, 0.01), false)
  assert.equal(shouldReleaseParameterDraft('', 0, 0, 0.01), false)
})
