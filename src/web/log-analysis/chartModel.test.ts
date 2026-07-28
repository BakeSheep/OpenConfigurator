import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  selectVisibleSeries,
  getSeriesColor,
  unitsCompatible,
  retainSelection,
  assignColors,
  buildChartWorkspaceModel,
  resolveViewVisibleSeries,
  MAX_VISIBLE_SERIES,
} from './chartModel.js'
import type { ChartSeriesConfig, SeriesDescriptor } from './chartModel.js'
import type { ChartFamily, ChartView } from './types.js'

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

  it('shows all available series when neither selection nor default is given', () => {
    const config = makeConfig({
      availableSeries: makeSeries(3),
      selectedSeriesIds: [],
    })
    const result = selectVisibleSeries(config)
    // No semantic default → show all (not collapse to just the first)
    assert.deepEqual(result, ['series-0', 'series-1', 'series-2'])
  })

  it('uses defaultVisibleSeriesIds when selection is empty', () => {
    const config = makeConfig({
      availableSeries: makeSeries(4),
      selectedSeriesIds: [],
      defaultVisibleSeriesIds: ['series-1', 'series-2'],
    })
    const result = selectVisibleSeries(config)
    assert.deepEqual(result, ['series-1', 'series-2'])
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

// ─── buildChartWorkspaceModel ────────────────────────────────────

function makeView(id: string, unit = 'rad', labels = ['实际', '设定']): ChartView {
  return {
    id,
    title: id,
    description: '',
    unit,
    series: labels.map((label, i) => ({ id: `${id}-${i}`, label, times: [0, 1], values: [0, 1] })),
    defaultVisibleSeriesIds: labels.map((_, i) => `${id}-${i}`),
    xAxis: 'time',
    hasGaps: false,
  }
}

function makeFamilies(): ChartFamily[] {
  return [
    {
      id: 'control-tracking',
      moduleId: 'control-tracking',
      title: '控制跟踪',
      description: '',
      views: [makeView('att-roll'), makeView('att-pitch')],
      defaultViewId: 'att-roll',
      order: 10,
    },
    {
      id: 'actuators',
      moduleId: 'actuators',
      title: '执行器',
      description: '',
      views: [makeView('motor-outputs', 'normalized', ['电机 1', '电机 2'])],
      defaultViewId: 'motor-outputs',
      order: 20,
    },
  ]
}

describe('buildChartWorkspaceModel', () => {
  it('returns one active view using the first family default', () => {
    const model = buildChartWorkspaceModel(makeFamilies())
    assert.equal(model.families.length, 2)
    assert.equal(model.activeFamilyId, 'control-tracking')
    assert.equal(model.activeViewId, 'att-roll')
    assert.ok(model.activeView && !Array.isArray(model.activeView))
    assert.equal(model.activeView!.id, 'att-roll')
  })

  it('uses the selected family\'s explicit default view', () => {
    const model = buildChartWorkspaceModel(makeFamilies(), 'actuators')
    assert.equal(model.activeFamilyId, 'actuators')
    assert.equal(model.activeViewId, 'motor-outputs')
  })

  it('retains a valid requested view', () => {
    const model = buildChartWorkspaceModel(makeFamilies(), 'control-tracking', 'att-pitch')
    assert.equal(model.activeViewId, 'att-pitch')
  })

  it('falls back to the family default for an invalid view', () => {
    const model = buildChartWorkspaceModel(makeFamilies(), 'control-tracking', 'nonexistent')
    assert.equal(model.activeViewId, 'att-roll')
  })

  it('handles the empty-family case', () => {
    const model = buildChartWorkspaceModel([])
    assert.equal(model.activeView, null)
    assert.equal(model.activeFamilyId, '')
  })
})

describe('resolveViewVisibleSeries', () => {
  it('defaults to the view\'s semantic default selection', () => {
    const view = makeView('att-roll')
    const visible = resolveViewVisibleSeries(view, [])
    assert.deepEqual(visible, ['att-roll-0', 'att-roll-1'])
  })

  it('honors an explicit user selection', () => {
    const view = makeView('att-roll')
    const visible = resolveViewVisibleSeries(view, ['att-roll-1'])
    assert.deepEqual(visible, ['att-roll-1'])
  })
})
