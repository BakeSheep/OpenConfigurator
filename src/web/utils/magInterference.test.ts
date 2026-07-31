import assert from 'node:assert/strict'
import {
  createMagInterferenceDetector,
  magFieldFromMilliGauss,
  MAG_FIELD_HYSTERESIS_GAUSS,
  MAG_FIELD_MAX_GAUSS,
  MAG_FIELD_MIN_GAUSS,
  MAG_STATE_DEBOUNCE_MS,
} from './magInterference'

// -- magnitude conversion from the latest mGauss components -----------------
assert.equal(magFieldFromMilliGauss(300, 400, 0), 0.5)
assert.equal(magFieldFromMilliGauss(0, 0, 0), 0)
assert.ok(Number.isNaN(magFieldFromMilliGauss(Number.NaN, 0, 0)))

// -- first live value is available immediately, with no sample window --------
{
  const detector = createMagInterferenceDetector()
  assert.deepEqual(detector.update(0.45, 1000), { fieldGauss: 0.45, warning: false })
}
{
  const detector = createMagInterferenceDetector()
  assert.deepEqual(detector.update(0.9, 1000), { fieldGauss: 0.9, warning: true })
}

// -- brief or alternating threshold crossings cannot flicker the state -------
{
  const detector = createMagInterferenceDetector()
  detector.update(MAG_FIELD_MAX_GAUSS - 0.01, 1000)
  assert.equal(detector.update(MAG_FIELD_MAX_GAUSS + 0.01, 1100)?.warning, false)
  assert.equal(detector.update(MAG_FIELD_MAX_GAUSS - 0.01, 1300)?.warning, false)
  assert.equal(detector.update(MAG_FIELD_MAX_GAUSS + 0.01, 1500)?.warning, false)
  assert.equal(detector.update(MAG_FIELD_MAX_GAUSS + 0.01, 1500 + MAG_STATE_DEBOUNCE_MS - 1)?.warning, false)
  assert.equal(detector.update(MAG_FIELD_MAX_GAUSS + 0.01, 1500 + MAG_STATE_DEBOUNCE_MS)?.warning, true)
}

// -- warning clears only after sustained return inside the hysteresis band ---
{
  const detector = createMagInterferenceDetector()
  detector.update(0.9, 1000)
  const clearBoundary = MAG_FIELD_MAX_GAUSS - MAG_FIELD_HYSTERESIS_GAUSS
  assert.equal(detector.update(clearBoundary + 0.005, 1200)?.warning, true)
  assert.equal(detector.update(clearBoundary - 0.005, 1300)?.warning, true)
  assert.equal(detector.update(clearBoundary - 0.005, 1300 + MAG_STATE_DEBOUNCE_MS)?.warning, false)
}

// -- low-field transition follows the same debounce --------------------------
{
  const detector = createMagInterferenceDetector()
  detector.update(0.45, 1000)
  assert.equal(detector.update(MAG_FIELD_MIN_GAUSS - 0.01, 1200)?.warning, false)
  assert.equal(detector.update(MAG_FIELD_MIN_GAUSS - 0.01, 1200 + MAG_STATE_DEBOUNCE_MS)?.warning, true)
}

// -- invalid values and reset -------------------------------------------------
{
  const detector = createMagInterferenceDetector()
  assert.equal(detector.update(Number.NaN, 0), null)
  detector.update(0.9, 1000)
  detector.reset()
  assert.equal(detector.update(0.45, 2000)?.warning, false)
}

console.log('magInterference real-time debounce checks passed')
