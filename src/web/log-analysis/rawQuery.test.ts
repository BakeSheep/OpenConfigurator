import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFieldPath, validateRawQuery } from './rawQuery.js'
import type { RawSeriesQuery, UlogTopicCatalogEntry } from './types.js'

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeCatalog(): UlogTopicCatalogEntry[] {
  return [
    {
      name: 'sensor_accel',
      multiId: 0,
      msgId: 100,
      sampleCount: 5000,
      firstTimeSec: 0,
      lastTimeSec: 30,
      fields: [
        { path: 'timestamp', type: 'uint64_t', arrayLength: null, unit: 'us', plottable: true },
        { path: 'x', type: 'float', arrayLength: null, unit: 'm/s^2', plottable: true },
        { path: 'y', type: 'float', arrayLength: null, unit: 'm/s^2', plottable: true },
        { path: 'z', type: 'float', arrayLength: null, unit: 'm/s^2', plottable: true },
        { path: 'temperature', type: 'float', arrayLength: null, unit: 'degC', plottable: true },
      ],
      consumedBy: ['sensors'],
      warnings: [],
    },
    {
      name: 'sensor_accel',
      multiId: 1,
      msgId: 101,
      sampleCount: 4800,
      firstTimeSec: 0.5,
      lastTimeSec: 30,
      fields: [
        { path: 'timestamp', type: 'uint64_t', arrayLength: null, unit: 'us', plottable: true },
        { path: 'x', type: 'float', arrayLength: null, unit: 'm/s^2', plottable: true },
        { path: 'y', type: 'float', arrayLength: null, unit: 'm/s^2', plottable: true },
        { path: 'z', type: 'float', arrayLength: null, unit: 'm/s^2', plottable: true },
      ],
      consumedBy: ['sensors'],
      warnings: [],
    },
    {
      name: 'vehicle_status',
      multiId: 0,
      msgId: 200,
      sampleCount: 300,
      firstTimeSec: 0,
      lastTimeSec: 30,
      fields: [
        { path: 'timestamp', type: 'uint64_t', arrayLength: null, unit: 'us', plottable: true },
        { path: 'mode', type: 'uint8_t', arrayLength: null, unit: null, plottable: true },
        { path: 'status_text', type: 'char[20]', arrayLength: 20, unit: null, plottable: false },
      ],
      consumedBy: ['flightOverview'],
      warnings: [],
    },
  ]
}

const catalog = makeCatalog()

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('validateRawQuery', () => {
  it('accepts a valid query', () => {
    const query: RawSeriesQuery = {
      topic: 'sensor_accel',
      multiId: 0,
      fields: ['x', 'y', 'z'],
    }
    const result = validateRawQuery(query, catalog)
    assert.equal(result.valid, true)
    assert.equal(result.errors.length, 0)
  })

  it('accepts a query with time range and point budget', () => {
    const query: RawSeriesQuery = {
      topic: 'sensor_accel',
      multiId: 1,
      fields: ['x'],
      startSec: 5,
      endSec: 20,
      pointBudget: 10000,
    }
    const result = validateRawQuery(query, catalog)
    assert.equal(result.valid, true)
    assert.equal(result.errors.length, 0)
  })

  it('rejects unknown topic instance', () => {
    const query: RawSeriesQuery = {
      topic: 'sensor_gyro',
      multiId: 0,
      fields: ['x'],
    }
    const result = validateRawQuery(query, catalog)
    assert.equal(result.valid, false)
    assert.ok(result.errors.some((e) => e.includes('Unknown topic instance')))
  })

  it('rejects unknown multiId for known topic name', () => {
    const query: RawSeriesQuery = {
      topic: 'sensor_accel',
      multiId: 99,
      fields: ['x'],
    }
    const result = validateRawQuery(query, catalog)
    assert.equal(result.valid, false)
    assert.ok(result.errors.some((e) => e.includes('Unknown topic instance')))
  })

  it('rejects non-numeric (non-plottable) fields', () => {
    const query: RawSeriesQuery = {
      topic: 'vehicle_status',
      multiId: 0,
      fields: ['status_text'],
    }
    const result = validateRawQuery(query, catalog)
    assert.equal(result.valid, false)
    assert.ok(result.errors.some((e) => e.includes('not numeric')))
  })

  it('rejects unknown field names', () => {
    const query: RawSeriesQuery = {
      topic: 'sensor_accel',
      multiId: 0,
      fields: ['nonexistent_field'],
    }
    const result = validateRawQuery(query, catalog)
    assert.equal(result.valid, false)
    assert.ok(result.errors.some((e) => e.includes('Unknown field')))
  })

  it('rejects more than 6 chart fields', () => {
    const query: RawSeriesQuery = {
      topic: 'sensor_accel',
      multiId: 0,
      fields: ['timestamp', 'x', 'y', 'z', 'temperature'],
    }
    // 5 fields is fine
    const ok = validateRawQuery(query, catalog)
    assert.equal(ok.valid, true)

    // Now add a 7th field from another topic to exceed limit
    const tooMany: RawSeriesQuery = {
      topic: 'sensor_accel',
      multiId: 0,
      fields: ['timestamp', 'x', 'y', 'z', 'temperature', 'x', 'y'],
    }
    const result = validateRawQuery(tooMany, catalog)
    assert.equal(result.valid, false)
    assert.ok(result.errors.some((e) => e.includes('Too many fields')))
  })

  it('rejects invalid time range (start > end)', () => {
    const query: RawSeriesQuery = {
      topic: 'sensor_accel',
      multiId: 0,
      fields: ['x'],
      startSec: 20,
      endSec: 5,
    }
    const result = validateRawQuery(query, catalog)
    assert.equal(result.valid, false)
    assert.ok(result.errors.some((e) => e.includes('Invalid time range')))
  })

  it('rejects excessive point budget (> 50000)', () => {
    const query: RawSeriesQuery = {
      topic: 'sensor_accel',
      multiId: 0,
      fields: ['x'],
      pointBudget: 100000,
    }
    const result = validateRawQuery(query, catalog)
    assert.equal(result.valid, false)
    assert.ok(result.errors.some((e) => e.includes('Point budget')))
  })

  it('rejects a non-positive point budget', () => {
    const result = validateRawQuery({
      topic: 'sensor_accel',
      multiId: 0,
      fields: ['x'],
      pointBudget: -1,
    }, catalog)
    assert.equal(result.valid, false)
    assert.ok(result.errors.some((e) => e.includes('positive integer')))
  })

  it('accepts point budget exactly at limit (50000)', () => {
    const query: RawSeriesQuery = {
      topic: 'sensor_accel',
      multiId: 0,
      fields: ['x'],
      pointBudget: 50000,
    }
    const result = validateRawQuery(query, catalog)
    assert.equal(result.valid, true)
  })

  it('rejects empty fields array', () => {
    const query: RawSeriesQuery = {
      topic: 'sensor_accel',
      multiId: 0,
      fields: [],
    }
    const result = validateRawQuery(query, catalog)
    assert.equal(result.valid, false)
    assert.ok(result.errors.some((e) => e.includes('At least one field')))
  })

  it('collects multiple errors at once', () => {
    const query: RawSeriesQuery = {
      topic: 'sensor_accel',
      multiId: 0,
      fields: ['nonexistent', 'status_text'],
      startSec: 10,
      endSec: 5,
      pointBudget: 60000,
    }
    // nonexistent -> Unknown field
    // status_text doesn't exist on sensor_accel -> Unknown field
    // start > end -> Invalid time range
    // pointBudget > 50000 -> Point budget exceeded
    const result = validateRawQuery(query, catalog)
    assert.equal(result.valid, false)
    assert.ok(result.errors.length >= 3, `Expected >= 3 errors, got ${result.errors.length}`)
  })
})

describe('readFieldPath', () => {
  it('reads scalar, array and nested array fields', () => {
    const value = {
      temperature: 25,
      xyz: [1, 2, 3],
      state: { position: [4, 5, 6] },
    }
    assert.equal(readFieldPath(value, 'temperature'), 25)
    assert.equal(readFieldPath(value, 'xyz[1]'), 2)
    assert.equal(readFieldPath(value, 'state.position[2]'), 6)
    assert.equal(readFieldPath(value, 'missing[0]'), undefined)
  })
})
