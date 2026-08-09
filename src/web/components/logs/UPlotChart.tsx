// Canvas time-series chart for the log analysis page. uPlot is used instead
// of recharts because Flight-Review-level analysis renders thousands of
// points per series; SVG charting collapses at that volume.
import { useEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'
import { useThemeStore } from '../../stores/themeStore'
import type { SegmentInfo, SeriesData } from '../../utils/ulogAnalysis'

const SYNC_KEY = 'log-analysis'

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
  /** Stable series IDs plotted against an independent right-hand Y axis. */
  secondaryScaleIds?: string[]
  /** Absolute log time reported whenever the shared cursor moves. */
  onCursorTimeChange?: (timeSec: number) => void
  /** Exposes the rendered plot canvas for local image export. */
  onCanvasChange?: (canvas: HTMLCanvasElement | null) => void
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
  secondaryScaleIds,
  onCursorTimeChange,
  onCanvasChange,
}: UPlotChartProps) {
  const { t } = useTranslation()
  const containerRef = useRef<HTMLDivElement | null>(null)
  const plotRef = useRef<uPlot | null>(null)
  const theme = useThemeStore((state) => state.theme)

  // Join per-series (x, y) tables into one aligned data set with gaps.
  const data = useMemo<uPlot.AlignedData | null>(() => {
    const usable = series.filter((entry) => entry.times.length > 0)
    if (usable.length === 0) return null
    const joined = uPlot.join(
      usable.map((entry) => [entry.times, entry.values] as uPlot.AlignedData),
    )
    return joined
  }, [series])

  useEffect(() => {
    const container = containerRef.current
    if (!container || !data) return
    const usable = series.filter((entry) => entry.times.length > 0)
    const colors = palette()
    const axisColor = cssVar('--chart-axis', '#a2a8b3')
    const gridColor = cssVar('--chart-grid', '#edf0f4')
    const textColor = cssVar('--text-secondary', '#5f6773')
    const accentDim = cssVar('--accent-dim', 'rgba(13,148,136,0.1)')
    const secondaryIds = new Set(secondaryScaleIds)
    const hasSecondaryScale = usable.some((entry) => secondaryIds.has(entry.id))

    const options: uPlot.Options = {
      width: Math.max(280, container.clientWidth),
      height,
      padding: [10, 12, 0, 0],
      cursor: {
        drag: { x: true, y: false, uni: 24 },
        ...(noSync ? {} : { sync: { key: SYNC_KEY } }),
      },
      scales: {
        x: { time: false },
        y: { auto: true },
        ...(hasSecondaryScale ? { y2: { auto: true } } : {}),
      },
      legend: { live: true },
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
          scale: 'y',
          stroke: axisColor,
          grid: { stroke: gridColor, width: 1 },
          ticks: { stroke: gridColor },
          font: '11px "JetBrains Mono", monospace',
          size: 52,
        },
        ...(hasSecondaryScale ? [{
          scale: 'y2',
          side: 1 as const,
          stroke: axisColor,
          grid: { show: false },
          ticks: { stroke: gridColor },
          font: '11px "JetBrains Mono", monospace',
          size: 52,
        }] : []),
      ],
      series: [
        {
          label: frequencyAxis ? t('common.frequency') : t('logAnalysis.time'),
          value: (_u, value) => value == null
            ? ''
            : frequencyAxis ? `${value.toFixed(1)} Hz` : formatSeconds(value),
        },
        ...usable.map((entry, index) => ({
          label: entry.label,
          scale: secondaryIds.has(entry.id) ? 'y2' : 'y',
          stroke: colors[(entry.colorIndex ?? index) % colors.length],
          width: 1.4,
          spanGaps: true,
          points: { show: false },
          value: (_u: uPlot, value: number | null) =>
            value == null ? '—' : `${value.toFixed(2)}${unit ? ` ${unit}` : ''}`,
        })),
      ],
      hooks: {
        setCursor: onCursorTimeChange && !noSync
          ? [(u) => {
            const index = u.cursor.idx
            const timeSec = index == null ? undefined : u.data[0][index]
            if (typeof timeSec === 'number' && Number.isFinite(timeSec)) {
              onCursorTimeChange(timeSec)
            }
          }]
          : [],
        // Paint segment bands beneath the series (armed windows etc.).
        drawClear: bands && bands.length > 0
          ? [(u) => {
            const { ctx } = u
            ctx.save()
            ctx.fillStyle = accentDim
            for (const band of bands) {
              const left = u.valToPos(band.startSec, 'x', true)
              const right = u.valToPos(band.endSec, 'x', true)
              if (right < u.bbox.left || left > u.bbox.left + u.bbox.width) continue
              const clampedLeft = Math.max(left, u.bbox.left)
              const clampedRight = Math.min(right, u.bbox.left + u.bbox.width)
              ctx.fillRect(clampedLeft, u.bbox.top, clampedRight - clampedLeft, u.bbox.height)
            }
            ctx.restore()
          }]
          : [],
      },
    }

    const plot = new uPlot(options, data, container)
    plotRef.current = plot
    onCanvasChange?.(plot.ctx.canvas)
    // Legend text inherits the theme colors.
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
      onCanvasChange?.(null)
    }
    // Recreate on theme switch so colors are re-read from CSS variables.
  }, [data, series, height, unit, bands, frequencyAxis, noSync, secondaryScaleIds, onCursorTimeChange, onCanvasChange, theme, t])

  if (!data) {
    return <p className="mc-explorer__notice">{t('logAnalysis.noChartData')}</p>
  }
  return <div ref={containerRef} className="mc-uplot" />
}
