// Pure chart-series selection logic — framework-agnostic and fully testable.
// Handles series visibility limits, deterministic color assignment, unit
// compatibility checks, and selection retention across group changes.

/** Deterministic palette shared with UPlotChart. */
const CHART_PALETTE: string[] = [
  '#0d9488', // chart-1 teal
  '#dc2626', // chart-4 red
  '#ca8a04', // chart-3 amber
  '#0284c7', // info blue
  '#16a34a', // chart-2 green
  '#a855f7', // purple
  '#f97316', // orange
  '#64748b', // slate
  '#ec4899', // pink
  '#22d3ee', // cyan
  '#84cc16', // lime
  '#e11d48', // rose
]

/** Maximum number of series visible simultaneously on one chart. */
export const MAX_VISIBLE_SERIES = 6

export interface SeriesDescriptor {
  id: string
  label: string
  unit: string
  color?: string
}

export interface ChartSeriesConfig {
  /** Max visible series at once */
  maxVisibleSeries: number
  /** Available series with deterministic colors */
  availableSeries: SeriesDescriptor[]
  /** Currently selected series IDs */
  selectedSeriesIds: string[]
}

/** Get deterministic color for a series index */
export function getSeriesColor(index: number): string {
  return CHART_PALETTE[index % CHART_PALETTE.length]
}

/**
 * Check if two units are compatible for display on the same Y-axis.
 * Empty units are compatible with anything (dimensionless).
 * Exact string match is always compatible.
 * Common incompatible pairs: m/s vs deg/s, etc.
 */
export function unitsCompatible(unitA: string, unitB: string): boolean {
  if (unitA === '' || unitB === '') return true
  if (unitA === unitB) return true
  return false
}

/**
 * Select series for display:
 * - Limit to maxVisibleSeries
 * - Preserve deterministic colors
 * - Group compatible units together (don't mix m/s with deg/s)
 * - Prefer explicitly selected IDs; fall back to first available
 */
export function selectVisibleSeries(config: ChartSeriesConfig): string[] {
  const { maxVisibleSeries, availableSeries, selectedSeriesIds } = config

  if (availableSeries.length === 0) return []

  const availableIds = new Set(availableSeries.map((s) => s.id))

  // Filter selection to only currently-available IDs
  const validSelection = selectedSeriesIds.filter((id) => availableIds.has(id))

  // If no valid selection, pick the first series
  if (validSelection.length === 0) {
    return [availableSeries[0].id]
  }

  // Determine the primary unit from the first selected series
  const firstSelected = availableSeries.find((s) => s.id === validSelection[0])
  const primaryUnit = firstSelected?.unit ?? ''

  // Partition selected into compatible and incompatible
  const compatible: string[] = []
  const incompatible: string[] = []

  for (const id of validSelection) {
    const series = availableSeries.find((s) => s.id === id)
    if (!series) continue
    if (unitsCompatible(primaryUnit, series.unit)) {
      compatible.push(id)
    } else {
      incompatible.push(id)
    }
  }

  // Take compatible series up to the limit
  const result = compatible.slice(0, maxVisibleSeries)

  // If there's room and incompatible series exist, add them only if we have
  // remaining capacity — but in practice we separate them, so just cap
  return result.slice(0, maxVisibleSeries)
}

/**
 * Retain last valid selection when changing groups.
 * Keeps only IDs that are still available in the new series list.
 * If nothing survives, returns the first new series ID.
 */
export function retainSelection(
  previousSelection: string[],
  newAvailableSeries: string[],
): string[] {
  if (newAvailableSeries.length === 0) return []

  const newSet = new Set(newAvailableSeries)
  const retained = previousSelection.filter((id) => newSet.has(id))

  if (retained.length === 0) {
    return [newAvailableSeries[0]]
  }

  return retained
}

/**
 * Assign deterministic colors to a list of series descriptors.
 * Returns a new array with color populated for each entry.
 */
export function assignColors(series: SeriesDescriptor[]): SeriesDescriptor[] {
  return series.map((s, index) => ({
    ...s,
    color: s.color ?? getSeriesColor(index),
  }))
}
