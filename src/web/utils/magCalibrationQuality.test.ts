import assert from 'node:assert/strict'
import { initI18n } from '../i18n/config'
import {
  magFitnessRating,
  magOffsetMagnitude,
  magOffsetWarning,
  MAG_FITNESS_THRESHOLDS,
  MAG_OFFSET_WARN_MGAUSS,
} from './magCalibrationQuality'

initI18n('zh')

// ---------------------------------------------------------------------------
// Advisory-only quality helpers for MAG_CAL_REPORT. These NEVER override the
// firmware cal_status; they only annotate fitness/offset for the operator.
// Thresholds are heuristics (see the source comment for provenance).
// ---------------------------------------------------------------------------

// -- fitness rating buckets ---------------------------------------------------
assert.equal(magFitnessRating(3).level, 'good')
assert.equal(magFitnessRating(MAG_FITNESS_THRESHOLDS.good - 0.01).level, 'good')
assert.equal(magFitnessRating(MAG_FITNESS_THRESHOLDS.good).level, 'acceptable')
assert.equal(magFitnessRating(12).level, 'acceptable')
assert.equal(magFitnessRating(MAG_FITNESS_THRESHOLDS.acceptable).level, 'marginal')
assert.equal(magFitnessRating(20).level, 'marginal')
assert.equal(magFitnessRating(MAG_FITNESS_THRESHOLDS.marginal).level, 'poor')
assert.equal(magFitnessRating(100).level, 'poor')
// Each rating carries a human label for the UI.
assert.equal(typeof magFitnessRating(3).label, 'string')
assert.ok(magFitnessRating(3).label.length > 0)
// Non-finite fitness is treated as unknown, never a false "good".
assert.equal(magFitnessRating(Number.NaN).level, 'unknown')

// -- offset magnitude ---------------------------------------------------------
assert.equal(magOffsetMagnitude([3, 4, 0]), 5)
assert.equal(magOffsetMagnitude([0, 0, 0]), 0)
assert.ok(Math.abs(magOffsetMagnitude([1, 2, 2]) - 3) < 1e-9)

// -- offset warning is advisory ----------------------------------------------
assert.equal(magOffsetWarning([0, 0, 0]), false)
assert.equal(magOffsetWarning([MAG_OFFSET_WARN_MGAUSS + 1, 0, 0]), true)
assert.equal(magOffsetWarning([MAG_OFFSET_WARN_MGAUSS - 1, 0, 0]), false)
// NaN offsets never raise a false warning.
assert.equal(magOffsetWarning([Number.NaN, 0, 0]), false)

console.log('magCalibrationQuality checks passed')
