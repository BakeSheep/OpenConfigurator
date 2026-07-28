export function formatChartValue(value: number | null | undefined, unit = ''): string {
  if (value == null || !Number.isFinite(value)) return '—'
  return `${value.toFixed(2)}${unit ? ` ${unit}` : ''}`
}