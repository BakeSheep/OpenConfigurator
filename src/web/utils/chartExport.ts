import type { SeriesData } from './ulogAnalysis'

export type ChartExportFormat = 'csv' | 'png'

const INVALID_FILE_NAME = /[<>:"/\\|?*\u0000-\u001f]/g
const RESERVED_WINDOWS_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i

export function chartExportBaseName(value: string): string {
  const withoutExtension = value.trim().replace(/\.(?:csv|png)$/i, '')
  const normalized = withoutExtension
    .replace(INVALID_FILE_NAME, '-')
    .replace(/\s+/g, ' ')
    .replace(/-+/g, '-')
    .replace(/[ .-]+$/g, '')
    .replace(/^[ .-]+/g, '')
    .slice(0, 120)
  if (!normalized) return 'flight-chart'
  return RESERVED_WINDOWS_NAME.test(normalized) ? `_${normalized}` : normalized
}

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

function numericCell(value: number): string {
  if (Number.isNaN(value)) return 'NaN'
  if (value === Infinity) return 'Infinity'
  if (value === -Infinity) return '-Infinity'
  return String(value)
}

export function buildChartCsv(
  series: SeriesData[],
  options: { axisLabel?: string; unit?: string } = {},
): string {
  const usable = series.filter((entry) => entry.times.length > 0 && entry.values.length > 0)
  const rows = new Map<number, Array<number | undefined>>()
  usable.forEach((entry, seriesIndex) => {
    const length = Math.min(entry.times.length, entry.values.length)
    for (let index = 0; index < length; index += 1) {
      const time = entry.times[index]
      if (!Number.isFinite(time)) continue
      const row = rows.get(time) ?? new Array<number | undefined>(usable.length)
      row[seriesIndex] = entry.values[index]
      rows.set(time, row)
    }
  })

  const unitSuffix = options.unit ? ` [${options.unit}]` : ''
  const header = [
    options.axisLabel ?? 'time_s',
    ...usable.map((entry) => `${entry.label}${unitSuffix} (${entry.id})`),
  ].map(csvCell).join(',')
  const lines = [...rows.entries()]
    .sort(([left], [right]) => left - right)
    .map(([time, values]) => [
      numericCell(time),
      ...values.map((value) => value === undefined ? '' : numericCell(value)),
    ].join(','))
  return `\uFEFF${[header, ...lines].join('\r\n')}\r\n`
}

function cssVar(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value || fallback
}

export async function createChartPng({
  source,
  title,
  legend,
}: {
  source: HTMLCanvasElement
  title: string
  legend: Array<{ label: string; color: string }>
}): Promise<Blob> {
  const rect = source.getBoundingClientRect()
  const pixelRatio = rect.width > 0 ? source.width / rect.width : Math.max(1, window.devicePixelRatio)
  const logicalWidth = rect.width > 0 ? rect.width : source.width / pixelRatio
  const logicalHeight = rect.height > 0 ? rect.height : source.height / pixelRatio
  const scratch = document.createElement('canvas').getContext('2d')
  if (!scratch) throw new Error('Canvas is unavailable')
  const fontFamily = cssVar('--font-sans', 'sans-serif')
  scratch.font = `11px ${fontFamily}`
  let legendX = 18
  let legendY = 48
  for (const item of legend) {
    const width = scratch.measureText(item.label).width + 32
    if (legendX > 18 && legendX + width > logicalWidth - 18) {
      legendX = 18
      legendY += 18
    }
    legendX += width
  }
  const headerHeight = legendY + 18
  const output = document.createElement('canvas')
  output.width = Math.max(1, Math.ceil(logicalWidth * pixelRatio))
  output.height = Math.max(1, Math.ceil((logicalHeight + headerHeight) * pixelRatio))
  const context = output.getContext('2d')
  if (!context) throw new Error('Canvas is unavailable')
  context.scale(pixelRatio, pixelRatio)
  context.fillStyle = cssVar('--bg-secondary', '#ffffff')
  context.fillRect(0, 0, logicalWidth, logicalHeight + headerHeight)
  context.fillStyle = cssVar('--text-primary', '#111827')
  context.font = `600 15px ${fontFamily}`
  context.fillText(title, 18, 24, logicalWidth - 36)
  context.font = `11px ${fontFamily}`
  context.textBaseline = 'middle'
  legendX = 18
  legendY = 48
  for (const item of legend) {
    const width = context.measureText(item.label).width + 32
    if (legendX > 18 && legendX + width > logicalWidth - 18) {
      legendX = 18
      legendY += 18
    }
    context.fillStyle = item.color
    context.fillRect(legendX, legendY - 1.5, 14, 3)
    context.fillStyle = cssVar('--text-secondary', '#5f6773')
    context.fillText(item.label, legendX + 19, legendY)
    legendX += width
  }
  context.drawImage(source, 0, headerHeight, logicalWidth, logicalHeight)
  return new Promise((resolve, reject) => {
    output.toBlob((blob) => blob ? resolve(blob) : reject(new Error('PNG encoding failed')), 'image/png')
  })
}

export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  anchor.style.display = 'none'
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000)
}
