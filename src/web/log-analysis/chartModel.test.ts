import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  selectVisibleSeries,
  getSeriesColor,
  unitsCompatible,
  retainSelection,
  assignColors,
  MAX_VISIBLE_SERIES,
} from './chartModel.js'
import type { ChartSeriesConfig, SeriesDescriptor } from './chartModel.js'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeSeries(count: number, unit = 'm/s'): SeriesDescriptor[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `series-${i}`,
    label: `Series ${i}`,
    unit,
  }))
}

function makeConfig(
  overrides: Partial<ChartSeriesConfig> & { availableSeries: SeriesDescriptor[] },
): ChartSeriesConfig {
  return {
    maxVisibleSeries: MAX_VISIBLE_SERIES,
    selectedSeriesIds: [],
    ...overrides,
  }
}

// ─── getSeriesColor ──────────────────────────────────────────────────────────

describe('getSeriesColor', () => {
  it('returns deterministic colors for sequential indices', () => {
    const color0 = getSeriesColor(0)
    const color1 = getSeriesColor(1)
    assert.notEqual(color0, color1)
    assert.equal(typeof color0, 'string')
    assert.ok(color0.startsWith('#'))
  })

  it('wraps around after palette length', () => {
    const paletteLength = 12
    assert.equal(getSeriesColor(0), getSeriesColor(paletteLength))
    assert.equal(getSeriesColor(1), getSeriesColor(paletteLength + 1))
  })
})

// ─── unitsCompatible ─────────────────────────────────────────────────────────

describe('unitsCompatible', () => {
  it('same units are compatible', () => {
    assert.equal(unitsCompatible('m/s', 'm/s'), true)
    assert.equal(unitsCompatible('deg/s', 'deg/s'), true)
  })

  it('different non-empty units are incompatible', () => {
    assert.equal(unitsCompatible('m/s', 'deg/s'), false)
    assert.equal(unitsCompatible('m', 'm/s'), false)
  })

  it('empty unit is compatible with anything', () => {
    assert.equal(unitsCompatible('', 'm/s'), true)
    assert.equal(unitsCompatible('deg/s', ''), true)
    assert.equal(unitsCompatible('', ''), true)
  })
})

// ─── selectVisibleSeries ─────────────────────────────────────────────────────

describe('selectVisibleSeries', () => {
  it('limits to maxVisibleSeries (6)', () => {
    const config = makeConfig({
      availableSeries: makeSeries(10),
      selectedSeriesIds: [
        'series-0', 'series-1', 'series-2', 'series-3',
        'series-4', 'series-5', 'series-6', 'series-7',
      ],
    })
    const result = selectVisibleSeries(config)
    assert.ok(result.length <= MAX_VISIBLE_SERIES)
    assert.equal(result.length, MAX_VISIBLE_SERIES)
  })

  it('returns first series when no selection', () => {
    const config = makeConfig({
      availableSeries: makeSeries(3),
      selectedSeriesIds: [],
    })
    const result = selectVisibleSeries(config)
    assert.equal(result.length, 1)
    assert.equal(result[0], 'series-0')
  })

  it('returns empty array when no available series', () => {
    const config = makeConfig({
      availableSeries: [],
      selectedSeriesIds: ['series-0'],
    })
    const result = selectVisibleSeries(config)
    assert.deepEqual(result, [])
  })

  it('preserves deterministic colors via ordering', () => {
    const series = makeSeries(4)
    const colored = assignColors(series)
    assert.equal(colored[0].color, getSeriesColor(0))
    assert.equal(colored[1].color, getSeriesColor(1))
    assert.equal(colored[2].color, getSeriesColor(2))
    assert.equal(colored[3].color, getSeriesColor(3))
  })

  it('separates incompatible units (does not mix m/s with deg/s)', () => {
    const mixedSeries: SeriesDescriptor[] = [
      { id: 'vel-x', label: 'Vel X', unit: 'm/s' },
      { id: 'vel-y', label: 'Vel Y', unit: 'm/s' },
      { id: 'rate-z', label: 'Rate Z', unit: 'deg/s' },
      { id: 'vel-z', label: 'Vel Z', unit: 'm/s' },
    ]
    const config = makeConfig({
      availableSeries: mixedSeries,
      // Select velocity and rate together
      selectedSeriesIds: ['vel-x', 'vel-y', 'rate-z', 'vel-z'],
    })
    const result = selectVisibleSeries(config)
    // Only compatible units (m/s) should be returned
    assert.ok(result.includes('vel-x'))
    assert.ok(result.includes('vel-y'))
    assert.ok(result.includes('vel-z'))
    assert.ok(!result.includes('rate-z'))
  })

  it('filters out selected IDs that are no longer available', () => {
    const config = makeConfig({
      availableSeries: makeSeries(3),
      selectedSeriesIds: ['series-0', 'removed-series'],
    })
    const result = selectVisibleSeries(config)
    assert.ok(result.includes('series-0'))
    assert.ok(!result.includes('removed-series'))
  })
})

// ─── retainSelection ─────────────────────────────────────────────────────────

describe('retainSelection', () => {
  it('retains IDs that are still available', () => {
    const result = retainSelection(
      ['series-0', 'series-1', 'series-2'],
      ['series-0', 'series-2', 'series-3'],
    )
    assert.deepEqual(result, ['series-0', 'series-2'])
  })

  it('returns first new series when nothing survives', () => {
    const result = retainSelection(
      ['old-0', 'old-1'],
      ['new-0', 'new-1'],
    )
    assert.deepEqual(result, ['new-0'])
  })

  it('returns empty when new available list is empty', () => {
    const result = retainSelection(['series-0'], [])
    assert.deepEqual(result, [])
  })

  it('preserves order of previous selection', () => {
    const result = retainSelection(
      ['c', 'a', 'b'],
      ['a', 'b', 'c', 'd'],
    )
    assert.deepEqual(result, ['c', 'a', 'b'])
  })
})

// ─── assignColors ────────────────────────────────────────────────────────────

describe('assignColors', () => {
  it('assigns colors to series without explicit colors', () => {
    const series: SeriesDescriptor[] = [
      { id: 'a', label: 'A', unit: 'm/s' },
      { id: 'b', label: 'B', unit: 'm/s' },
    ]
    const result = assignColors(series)
    assert.equal(result[0].color, getSeriesColor(0))
    assert.equal(result[1].color, getSeriesColor(1))
  })

  it('preserves explicit colors', () => {
    const series: SeriesDescriptor[] = [
      { id: 'a', label: 'A', unit: 'm/s', color: '#ff0000' },
      { id: 'b', label: 'B', unit: 'm/s' },
    ]
    const result = assignColors(series)
    assert.equal(result[0].color, '#ff0000')
    assert.equal(result[1].color, getSeriesColor(1))
  })
})
