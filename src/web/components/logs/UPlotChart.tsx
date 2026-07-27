// Canvas time-series chart for the log analysis page. uPlot is used instead
// of recharts because Flight-Review-level analysis renders thousands of
// points per series; SVG charting collapses at that volume.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'
import { useThemeStore } from '../../stores/themeStore'
import type { SegmentInfo, SeriesData } from '../../utils/ulogAnalysis'
import type { FindingSeverity } from '../../log-analysis/types'

const SYNC_KEY = 'log-analysis'

/** Optional horizontal threshold line overlay. */
export interface ThresholdLine {
  value: number
  label: string
  severity: FindingSeverity
}

/** Optional state-band overlay (colored background region). */
export interface StateBand {
  startSec: number
  endSec: number
  label?: string
  color?: string
}

/** Optional event marker (vertical line with label). */
export interface EventMarker {
  timeSec: number
  label: string
  severity?: FindingSeverity
}

interface UPlotChartProps {
  series: SeriesData[]
  height?: number
  /** Y-axis unit suffix shown in the legend values. */
  unit?: string
  /** Shaded background bands (e.g. armed segments). */
  bands?: SegmentInfo[]
  /** X values are frequencies (Hz) instead of seconds. */
  frequencyAxis?: boolean
  /** Disable the page-wide cursor sync (frequency-domain charts). */
  noSync?: boolean
  /** Horizontal threshold lines. */
  thresholds?: ThresholdLine[]
  /** Colored background state bands. */
  stateBands?: StateBand[]
  /** Vertical event markers. */
  eventMarkers?: EventMarker[]
  /** Per-series gap metadata: true means the series has gaps (null values). */
  seriesHasGaps?: boolean[]
  /** Callback when series visibility is toggled via legend. */
  onSeriesToggle?: (seriesIndex: number) => void
  /** Currently hidden series indices (controlled mode). */
  hiddenSeries?: Set<number>
}

function cssVar(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value || fallback
}

function palette(): string[] {
  return [
    cssVar('--chart-1', '#0d9488'),
    cssVar('--chart-4', '#dc2626'),
    cssVar('--chart-3', '#ca8a04'),
    cssVar('--info', '#0284c7'),
    cssVar('--chart-2', '#16a34a'),
    '#a855f7',
    '#f97316',
    '#64748b',
    '#ec4899',
    '#22d3ee',
    '#84cc16',
    '#e11d48',
  ]
}

export function seriesColor(index: number): string {
  const colors = palette()
  return colors[index % colors.length]
}

const SEVERITY_COLOR_VARS: Record<FindingSeverity, string> = {
  critical: '--severity-critical',
  warning: '--severity-warning',
  notice: '--severity-notice',
  healthy: '--severity-healthy',
}

function formatSeconds(value: number): string {
  if (!Number.isFinite(value)) return ''
  const minutes = Math.floor(value / 60)
  const seconds = value - minutes * 60
  return `${minutes}:${seconds.toFixed(0).padStart(2, '0')}`
}

export default function UPlotChart({
  series,
  height = 220,
  unit = '',
  bands,
  frequencyAxis = false,
  noSync = false,
  thresholds,
  stateBands,
  eventMarkers,
  seriesHasGaps,
  onSeriesToggle,
  hiddenSeries,
}: UPlotChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const plotRef = useRef<uPlot | null>(null)
  const theme = useThemeStore((state) => state.theme)
  const [localHidden, setLocalHidden] = useState<Set<number>>(new Set())

  // Use controlled hidden series if provided, otherwise local state
  const effectiveHidden = hiddenSeries ?? localHidden

  const handleToggleSeries = useCallback(
    (index: number) => {
      if (onSeriesToggle) {
        onSeriesToggle(index)
      } else {
        setLocalHidden((prev) => {
          const next = new Set(prev)
          if (next.has(index)) {
            next.delete(index)
          } else {
            next.add(index)
          }
          return next
        })
      }
    },
    [onSeriesToggle],
  )

  // Join per-series (x, y) tables into one aligned data set with gaps.
  // When seriesHasGaps is true for a series, null values are preserved
  // to show dropouts and sensor gaps as line breaks.
  const data = useMemo<uPlot.AlignedData | null>(() => {
    const usable = series
      .map((entry, originalIndex) => ({ entry, originalIndex }))
      .filter(({ entry }) => entry.times.length > 0)
    if (usable.length === 0) return null

    // If any series has gaps, we need to handle null insertion
    const hasAnyGaps = seriesHasGaps?.some(Boolean) ?? false

    if (!hasAnyGaps) {
      // Fast path: no gaps, use uPlot.join as before
      const joined = uPlot.join(
        usable.map(({ entry }) => [entry.times, entry.values] as uPlot.AlignedData),
      )
      return joined
    }

    // Insert one explicit null only at unusually large intervals. Aligning all
    // series on a union of timestamps would incorrectly turn normal sample-rate
    // differences into gaps.
    const seriesArrays: Array<[number[], Array<number | null>]> = usable.map(
      ({ entry, originalIndex }) => {
        const hasGaps = seriesHasGaps?.[originalIndex] ?? false
        if (!hasGaps) {
          return [entry.times, entry.values] as [number[], Array<number | null>]
        }

        const deltas: number[] = []
        for (let i = 1; i < entry.times.length; i++) {
          const delta = entry.times[i] - entry.times[i - 1]
          if (delta > 0 && Number.isFinite(delta)) deltas.push(delta)
        }
        deltas.sort((a, b) => a - b)
        const typicalDelta = deltas.length > 0 ? deltas[Math.floor(deltas.length / 2)] : 0
        const gapThreshold = typicalDelta > 0 ? typicalDelta * 3 : Number.POSITIVE_INFINITY
        const times: number[] = []
        const values: Array<number | null> = []

        for (let i = 0; i < entry.times.length; i++) {
          if (i > 0) {
            const previous = entry.times[i - 1]
            const delta = entry.times[i] - previous
            if (delta > gapThreshold) {
              times.push(previous + Math.min(typicalDelta, delta / 2))
              values.push(null)
            }
          }
          times.push(entry.times[i])
          values.push(entry.values[i])
        }

        return [times, values]
      },
    )

    // Use uPlot.join to align everything
    const joined = uPlot.join(
      seriesArrays.map(([times, values]) => [times, values] as uPlot.AlignedData),
    )
    return joined
  }, [series, seriesHasGaps])

  useEffect(() => {
    const container = containerRef.current
    if (!container || !data) return
    const usable = series.filter((entry) => entry.times.length > 0)
    const colors = palette()
    const axisColor = cssVar('--chart-axis', '#a2a8b3')
    const gridColor = cssVar('--chart-grid', '#edf0f4')
    const textColor = cssVar('--text-secondary', '#5f6773')
    const accentDim = cssVar('--accent-dim', 'rgba(13,148,136,0.1)')
    const severityColors = Object.fromEntries(
      Object.entries(SEVERITY_COLOR_VARS).map(([severity, variable]) => [
        severity,
        cssVar(variable, '#94a3b8'),
      ]),
    ) as Record<FindingSeverity, string>

    const options: uPlot.Options = {
      width: Math.max(280, container.clientWidth),
      height,
      padding: [10, 12, 0, 0],
      cursor: {
        drag: { x: true, y: false, uni: 24 },
        ...(noSync ? {} : { sync: { key: SYNC_KEY } }),
      },
      scales: { x: { time: false } },
      legend: { show: false }, // We render our own accessible legend
      axes: [
        {
          stroke: axisColor,
          grid: { stroke: gridColor, width: 1 },
          ticks: { stroke: gridColor },
          values: (_u, ticks) => ticks.map((tick) =>
            frequencyAxis ? `${tick.toFixed(0)}` : formatSeconds(tick),
          ),
          font: '11px "JetBrains Mono", monospace',
          size: 32,
        },
        {
          stroke: axisColor,
          grid: { stroke: gridColor, width: 1 },
          ticks: { stroke: gridColor },
          font: '11px "JetBrains Mono", monospace',
          size: 52,
        },
      ],
      series: [
        {
          label: frequencyAxis ? '频率' : '时间',
          value: (_u, value) => value == null
            ? ''
            : frequencyAxis ? `${value.toFixed(1)} Hz` : formatSeconds(value),
        },
        ...usable.map((entry, index) => ({
          label: entry.label,
          stroke: colors[index % colors.length],
          width: 1.4,
          // Do NOT span gaps — dropouts and sensor gaps must remain visible
          spanGaps: false,
          points: { show: false },
          show: !effectiveHidden.has(index),
          value: (_u: uPlot, value: number | null) =>
            value == null ? '—' : `${value.toFixed(2)}${unit ? ` ${unit}` : ''}`,
        })),
      ],
      hooks: {
        drawClear: [
          (u) => {
            const { ctx } = u
            ctx.save()

            // Paint segment bands beneath the series (armed windows etc.)
            if (bands && bands.length > 0) {
              ctx.fillStyle = accentDim
              for (const band of bands) {
                const left = u.valToPos(band.startSec, 'x', true)
                const right = u.valToPos(band.endSec, 'x', true)
                if (right < u.bbox.left || left > u.bbox.left + u.bbox.width) continue
                const clampedLeft = Math.max(left, u.bbox.left)
                const clampedRight = Math.min(right, u.bbox.left + u.bbox.width)
                ctx.fillRect(clampedLeft, u.bbox.top, clampedRight - clampedLeft, u.bbox.height)
              }
            }

            // Paint state bands
            if (stateBands && stateBands.length > 0) {
              for (const band of stateBands) {
                const left = u.valToPos(band.startSec, 'x', true)
                const right = u.valToPos(band.endSec, 'x', true)
                if (right < u.bbox.left || left > u.bbox.left + u.bbox.width) continue
                const clampedLeft = Math.max(left, u.bbox.left)
                const clampedRight = Math.min(right, u.bbox.left + u.bbox.width)
                ctx.fillStyle = band.color ?? 'rgba(100, 116, 139, 0.08)'
                ctx.fillRect(clampedLeft, u.bbox.top, clampedRight - clampedLeft, u.bbox.height)
              }
            }

            // Paint threshold lines
            if (thresholds && thresholds.length > 0) {
              for (const threshold of thresholds) {
                const y = u.valToPos(threshold.value, 'y', true)
                if (y < u.bbox.top || y > u.bbox.top + u.bbox.height) continue
                ctx.strokeStyle = severityColors[threshold.severity]
                ctx.lineWidth = 1
                ctx.setLineDash([4, 4])
                ctx.beginPath()
                ctx.moveTo(u.bbox.left, y)
                ctx.lineTo(u.bbox.left + u.bbox.width, y)
                ctx.stroke()
                ctx.setLineDash([])

                // Label
                ctx.fillStyle = severityColors[threshold.severity]
                ctx.font = '10px "JetBrains Mono", monospace'
                ctx.textAlign = 'right'
                ctx.fillText(
                  `${threshold.label}: ${threshold.value.toFixed(2)}`,
                  u.bbox.left + u.bbox.width - 4,
                  y - 4,
                )
              }
            }

            // Paint event markers
            if (eventMarkers && eventMarkers.length > 0) {
              for (const marker of eventMarkers) {
                const x = u.valToPos(marker.timeSec, 'x', true)
                if (x < u.bbox.left || x > u.bbox.left + u.bbox.width) continue
                ctx.strokeStyle = marker.severity
                  ? severityColors[marker.severity]
                  : '#94a3b8'
                ctx.lineWidth = 1
                ctx.setLineDash([2, 3])
                ctx.beginPath()
                ctx.moveTo(x, u.bbox.top)
                ctx.lineTo(x, u.bbox.top + u.bbox.height)
                ctx.stroke()
                ctx.setLineDash([])

                // Label at top
                ctx.fillStyle = ctx.strokeStyle
                ctx.font = '9px "JetBrains Mono", monospace'
                ctx.textAlign = 'center'
                ctx.fillText(marker.label, x, u.bbox.top + 10)
              }
            }

            ctx.restore()
          },
        ],
      },
    }

    const plot = new uPlot(options, data, container)
    plotRef.current = plot
    container.style.setProperty('--uplot-text', textColor)

    const observer = new ResizeObserver(() => {
      if (container.clientWidth > 0) {
        plot.setSize({ width: container.clientWidth, height })
      }
    })
    observer.observe(container)
    return () => {
      observer.disconnect()
      plot.destroy()
      plotRef.current = null
    }
    // Recreate on theme switch so colors are re-read from CSS variables.
  }, [data, series, height, unit, bands, frequencyAxis, noSync, theme, thresholds, stateBands, eventMarkers, effectiveHidden])

  // Build accessible legend data
  const legendItems = useMemo(() => {
    const usable = series.filter((entry) => entry.times.length > 0)
    return usable.map((entry, index) => ({
      label: entry.label,
      color: seriesColor(index),
      hidden: effectiveHidden.has(index),
      unit,
      // Get last value for current display
      lastValue: entry.values.length > 0 ? entry.values[entry.values.length - 1] : null,
    }))
  }, [series, effectiveHidden, unit])

  if (!data) {
    return <p className="mc-explorer__notice">此日志不包含该板块的数据</p>
  }
  return (
    <div className="mc-uplot-wrapper">
      <div ref={containerRef} className="mc-uplot" />
      <div className="chart-legend" role="list" aria-label="图表系列">
        {legendItems.map((item, index) => (
          <button
            key={item.label}
            type="button"
            role="listitem"
            className={`chart-legend-item${item.hidden ? ' chart-legend-item--hidden' : ''}`}
            onClick={() => handleToggleSeries(index)}
            aria-pressed={!item.hidden}
            title={`${item.label}${item.unit ? ` (${item.unit})` : ''} — 点击切换显示`}
          >
            <span
              className="chart-legend-swatch"
              style={{ background: item.hidden ? 'var(--text-disabled)' : item.color }}
              aria-hidden="true"
            />
            <span className="chart-legend-label">
              {item.label}
              {item.unit ? <span className="chart-legend-unit"> ({item.unit})</span> : null}
            </span>
            <span className="chart-legend-value mc-mono">
              {item.lastValue != null ? item.lastValue.toFixed(2) : '—'}
            </span>
            <span className="chart-legend-state">
              {item.hidden ? '已隐藏' : '显示中'}
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}
