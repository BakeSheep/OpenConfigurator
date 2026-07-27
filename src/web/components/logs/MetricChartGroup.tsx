// Chart wrapper with series selector, shared time window controls, and
// threshold overlays. Combines UPlotChart with chip-style series toggles
// and text-based time range actions.
import { useCallback, useMemo, useState } from 'react'
import UPlotChart from './UPlotChart'
import type { ThresholdLine, EventMarker, StateBand } from './UPlotChart'
import type { ChartSeriesGroup, FindingSeverity } from '../../log-analysis/types'
import {
  selectVisibleSeries,
  retainSelection,
  getSeriesColor,
  MAX_VISIBLE_SERIES,
} from '../../log-analysis/chartModel'

interface Props {
  title: string
  description?: string
  seriesGroups: ChartSeriesGroup[]
  thresholds?: Array<{ value: number; label: string; severity: FindingSeverity }>
  /** Shared time range from parent */
  timeRange?: { start: number; end: number }
  onTimeRangeChange?: (range: { start: number; end: number }) => void
  /** Optional event markers */
  eventMarkers?: EventMarker[]
  /** Optional state bands */
  stateBands?: StateBand[]
}

/** Quick time-range presets displayed as text actions. */
interface TimeAction {
  label: string
  range: { start: number; end: number } | null
}

export default function MetricChartGroup({
  title,
  description,
  seriesGroups,
  thresholds,
  timeRange,
  onTimeRangeChange,
  eventMarkers,
  stateBands,
}: Props) {
  const [activeGroupIndex, setActiveGroupIndex] = useState(0)
  const [selectedSeriesIds, setSelectedSeriesIds] = useState<string[]>([])

  const activeGroup = seriesGroups[activeGroupIndex] ?? seriesGroups[0]

  // Build series descriptors from the active group
  const availableSeries = useMemo(() => {
    if (!activeGroup) return []
    return activeGroup.series.map((s, i) => ({
      id: `${activeGroup.id}:${i}`,
      label: s.label,
      unit: activeGroup.unit,
      color: s.color ?? getSeriesColor(i),
    }))
  }, [activeGroup])

  // When switching groups, retain valid selections
  const handleGroupChange = useCallback(
    (newIndex: number) => {
      const newGroup = seriesGroups[newIndex]
      if (!newGroup) return
      const newIds = newGroup.series.map((_, i) => `${newGroup.id}:${i}`)
      const retained = retainSelection(selectedSeriesIds, newIds)
      setSelectedSeriesIds(retained)
      setActiveGroupIndex(newIndex)
    },
    [seriesGroups, selectedSeriesIds],
  )

  // Compute visible series IDs
  const visibleSeriesIds = useMemo(() => {
    return selectVisibleSeries({
      maxVisibleSeries: MAX_VISIBLE_SERIES,
      availableSeries,
      selectedSeriesIds,
    })
  }, [availableSeries, selectedSeriesIds])

  // Toggle a series in the selector
  const handleSeriesToggle = useCallback(
    (seriesId: string) => {
      setSelectedSeriesIds((prev) => {
        if (prev.includes(seriesId)) {
          return prev.filter((id) => id !== seriesId)
        }
        // Don't exceed max
        if (prev.length >= MAX_VISIBLE_SERIES) return prev
        return [...prev, seriesId]
      })
    },
    [],
  )

  // Build threshold lines from group thresholds + prop thresholds
  const thresholdLines: ThresholdLine[] = useMemo(() => {
    const result: ThresholdLine[] = []
    if (thresholds) {
      result.push(...thresholds)
    }
    if (activeGroup?.thresholds) {
      result.push(...activeGroup.thresholds)
    }
    return result
  }, [thresholds, activeGroup])

  // Build time actions
  const timeActions: TimeAction[] = useMemo(() => {
    if (!timeRange || !onTimeRangeChange) return []
    const actions: TimeAction[] = [
      { label: '全程', range: null }, // null means full range (handled by parent)
    ]
    // If the group has finding-related time ranges, add them
    if (activeGroup) {
      // Check if any series has meaningful time bounds
      let minTime = Infinity
      let maxTime = -Infinity
      for (const s of activeGroup.series) {
        if (s.times.length > 0) {
          minTime = Math.min(minTime, s.times[0])
          maxTime = Math.max(maxTime, s.times[s.times.length - 1])
        }
      }
      if (Number.isFinite(minTime) && Number.isFinite(maxTime)) {
        actions.push({
          label: '仅飞行',
          range: { start: minTime, end: maxTime },
        })
      }
    }
    return actions
  }, [timeRange, onTimeRangeChange, activeGroup])

  // Convert ChartSeriesGroup series to SeriesData format for UPlotChart
  const chartSeriesData = useMemo(() => {
    if (!activeGroup) return []
    return activeGroup.series.map((s) => ({
      label: s.label,
      times: s.times,
      values: s.values,
    }))
  }, [activeGroup])

  // Series gap info
  const seriesHasGaps = useMemo(() => {
    if (!activeGroup) return undefined
    return activeGroup.series.map(() => activeGroup.hasGaps)
  }, [activeGroup])

  const hiddenSeries = useMemo(() => new Set(
    availableSeries
      .map((series, index) => ({ series, index }))
      .filter(({ series }) => !visibleSeriesIds.includes(series.id))
      .map(({ index }) => index),
  ), [availableSeries, visibleSeriesIds])

  if (!activeGroup) {
    return (
      <section className="mc-card metric-chart-group">
        <p className="mc-explorer__notice">此板块没有可用的图表数据</p>
      </section>
    )
  }

  return (
    <section className="mc-card metric-chart-group">
      <header className="metric-chart-group__header">
        <h3 className="mc-section-title">{title}</h3>
        {seriesGroups.length > 1 && (
          <div className="chart-selector" role="tablist" aria-label="图表组选择">
            {seriesGroups.map((group, index) => (
              <button
                key={group.id}
                type="button"
                role="tab"
                aria-selected={index === activeGroupIndex}
                className={`chart-selector__chip${index === activeGroupIndex ? ' chart-selector__chip--active' : ''}`}
                onClick={() => handleGroupChange(index)}
              >
                {group.title}
              </button>
            ))}
          </div>
        )}
      </header>

      {description && (
        <p className="metric-chart-group__desc">{description}</p>
      )}

      {/* Series selector chips */}
      {availableSeries.length > 1 && (
        <div className="chart-selector" role="group" aria-label="系列选择">
          {availableSeries.map((s) => {
            const isVisible = visibleSeriesIds.includes(s.id)
            return (
              <button
                key={s.id}
                type="button"
                className={`chart-selector__chip chart-selector__chip--series${isVisible ? ' chart-selector__chip--active' : ''}`}
                onClick={() => handleSeriesToggle(s.id)}
                aria-pressed={isVisible}
                style={isVisible ? { borderColor: s.color, color: s.color } : undefined}
              >
                <span
                  className="chart-selector__dot"
                  style={{ background: isVisible ? s.color : 'var(--text-disabled)' }}
                  aria-hidden="true"
                />
                {s.label}
              </button>
            )
          })}
        </div>
      )}

      {/* Time range actions */}
      {timeActions.length > 0 && (
        <div className="chart-actions" role="group" aria-label="时间范围">
          {timeActions.map((action) => (
            <button
              key={action.label}
              type="button"
              className="chart-action-btn"
              onClick={() => {
                if (onTimeRangeChange && action.range) {
                  onTimeRangeChange(action.range)
                }
              }}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}

      {/* Chart */}
      <div className="metric-chart-group__chart">
        <UPlotChart
          series={chartSeriesData}
          unit={activeGroup.unit}
          thresholds={thresholdLines}
          stateBands={stateBands}
          eventMarkers={eventMarkers}
          seriesHasGaps={seriesHasGaps}
          hiddenSeries={hiddenSeries}
          onSeriesToggle={(index) => {
            const series = availableSeries[index]
            if (series) handleSeriesToggle(series.id)
          }}
          noSync={false}
        />
      </div>
    </section>
  )
}
