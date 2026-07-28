// One focused chart workspace per active analysis section.
//
// Renders exactly one ChartView at a time behind two text-selector levels
// (family selector + view selector). Only the active view mounts UPlotChart —
// there is no wall of chart cards. Findings and metrics render around the
// workspace, never as additional chart cards.
import { useMemo, useState } from 'react'
import UPlotChart from './UPlotChart'
import type { ChartFamily } from '../../log-analysis/types'
import {
  buildChartWorkspaceModel,
  resolveViewVisibleSeries,
  getSeriesColor,
} from '../../log-analysis/chartModel'

interface Props {
  families: ChartFamily[]
}

export default function SectionChartWorkspace({ families }: Props) {
  const [familyId, setFamilyId] = useState<string | null>(null)
  const [viewId, setViewId] = useState<string | null>(null)
  const [selectedSeriesIds, setSelectedSeriesIds] = useState<string[]>([])

  const model = useMemo(
    () => buildChartWorkspaceModel(families, familyId, viewId),
    [families, familyId, viewId],
  )

  const activeView = model.activeView
  const activeFamily = model.families.find((f) => f.id === model.activeFamilyId)

  const availableSeries = useMemo(() => {
    if (!activeView) return []
    return activeView.series.map((s, i) => ({
      id: s.id,
      label: s.label,
      color: s.color ?? getSeriesColor(i),
    }))
  }, [activeView])

  const visibleSeriesIds = useMemo(() => {
    if (!activeView) return []
    return resolveViewVisibleSeries(activeView, selectedSeriesIds)
  }, [activeView, selectedSeriesIds])

  if (!activeView || !activeFamily) return null

  const chartSeriesData = activeView.series.map((s) => ({
    label: s.label,
    times: s.times,
    values: s.values,
  }))

  const hiddenSeries = new Set(
    availableSeries
      .map((series, index) => ({ series, index }))
      .filter(({ series }) => !visibleSeriesIds.includes(series.id))
      .map(({ index }) => index),
  )

  const toggleSeries = (id: string) => {
    // First interaction seeds from the current visible set so a toggle
    // narrows the semantic default rather than resetting to everything.
    const base = selectedSeriesIds.length > 0 ? selectedSeriesIds : visibleSeriesIds
    setSelectedSeriesIds(
      base.includes(id) ? base.filter((x) => x !== id) : [...base, id],
    )
  }

  const isFrequency = activeView.xAxis === 'frequency'

  return (
    <section className="mc-card chart-workspace">
      {/* Family selector (only when there is a choice) */}
      {model.families.length > 1 && (
        <div className="chart-workspace__selector" role="tablist" aria-label="图表族选择">
          {model.families.map((family) => (
            <button
              key={family.id}
              type="button"
              role="tab"
              aria-selected={family.id === model.activeFamilyId}
              className={`chart-selector__chip${family.id === model.activeFamilyId ? ' chart-selector__chip--active' : ''}`}
              onClick={() => {
                setFamilyId(family.id)
                setViewId(null)
                setSelectedSeriesIds([])
              }}
            >
              {family.title}
            </button>
          ))}
        </div>
      )}

      {/* View selector within the active family */}
      {activeFamily.views.length > 1 && (
        <div className="chart-workspace__selector" role="tablist" aria-label="视图选择">
          {activeFamily.views.map((view) => (
            <button
              key={view.id}
              type="button"
              role="tab"
              aria-selected={view.id === model.activeViewId}
              className={`chart-selector__chip chart-selector__chip--view${view.id === model.activeViewId ? ' chart-selector__chip--active' : ''}`}
              onClick={() => {
                setViewId(view.id)
                setSelectedSeriesIds([])
              }}
            >
              {view.title}
            </button>
          ))}
        </div>
      )}

      <header className="chart-workspace__header">
        <h3 className="mc-section-title">{activeView.title}</h3>
        {activeView.description && (
          <p className="chart-workspace__desc">{activeView.description}</p>
        )}
      </header>

      {/* Series selector — respects the semantic default selection */}
      {availableSeries.length > 1 && (
        <div className="chart-selector" role="group" aria-label="系列选择">
          {availableSeries.map((s) => {
            const isVisible = visibleSeriesIds.includes(s.id)
            return (
              <button
                key={s.id}
                type="button"
                className={`chart-selector__chip chart-selector__chip--series${isVisible ? ' chart-selector__chip--active' : ''}`}
                onClick={() => toggleSeries(s.id)}
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

      <div className="chart-workspace__chart">
        <UPlotChart
          key={activeView.id}
          series={chartSeriesData}
          unit={activeView.unit}
          thresholds={activeView.thresholds}
          seriesHasGaps={activeView.series.map(() => activeView.hasGaps)}
          hiddenSeries={hiddenSeries}
          onSeriesToggle={(index) => {
            const series = availableSeries[index]
            if (series) toggleSeries(series.id)
          }}
          frequencyAxis={isFrequency}
          noSync={isFrequency}
        />
      </div>
    </section>
  )
}
