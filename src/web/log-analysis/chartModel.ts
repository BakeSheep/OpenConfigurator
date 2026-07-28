// Pure chart-series selection logic — framework-agnostic and fully testable.
// Handles series visibility limits, deterministic color assignment, unit
// compatibility checks, and selection retention across group changes.
import type { ChartFamily, ChartView } from './types.js'

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
  /** Semantic default selection when the explicit selection is empty */
  defaultVisibleSeriesIds?: string[]
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
 * - Prefer explicitly selected IDs; fall back to the view's semantic
 *   defaultVisibleSeriesIds; only then to all available series (capped).
 *   Never silently collapse to "just the first series".
 */
export function selectVisibleSeries(config: ChartSeriesConfig): string[] {
  const { maxVisibleSeries, availableSeries, selectedSeriesIds, defaultVisibleSeriesIds } = config

  if (availableSeries.length === 0) return []

  const availableIds = new Set(availableSeries.map((s) => s.id))

  // Filter selection to only currently-available IDs
  let validSelection = selectedSeriesIds.filter((id) => availableIds.has(id))

  // If no valid explicit selection, use the semantic default; if that is
  // empty too, show every available series (capped by the unit/limit logic).
  if (validSelection.length === 0) {
    const defaults = (defaultVisibleSeriesIds ?? []).filter((id) => availableIds.has(id))
    validSelection = defaults.length > 0 ? defaults : availableSeries.map((s) => s.id)
  }

  // Determine the primary unit from the first selected series
  const firstSelected = availableSeries.find((s) => s.id === validSelection[0])
  const primaryUnit = firstSelected?.unit ?? ''

  // Partition selected into compatible and incompatible
  const compatible: string[] = []

  for (const id of validSelection) {
    const series = availableSeries.find((s) => s.id === id)
    if (!series) continue
    if (unitsCompatible(primaryUnit, series.unit)) {
      compatible.push(id)
    }
  }

  // Take compatible series up to the limit
  return compatible.slice(0, maxVisibleSeries)
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

// ─── Chart workspace model (one active view per section) ─────────────────

export interface ChartWorkspaceModel {
  families: ChartFamily[]
  activeFamilyId: string
  activeViewId: string
  /** Exactly one view is mounted at a time — never an array of views. */
  activeView: ChartView | null
}

/**
 * Resolve the single active family/view for a section's chart workspace.
 * Retains a valid prior selection; otherwise uses the family's explicit
 * defaultViewId. Array order is never used as an undocumented default.
 */
export function buildChartWorkspaceModel(
  families: ChartFamily[],
  activeFamilyId?: string | null,
  activeViewId?: string | null,
): ChartWorkspaceModel {
  if (families.length === 0) {
    return { families, activeFamilyId: '', activeViewId: '', activeView: null }
  }

  const family =
    families.find((f) => f.id === activeFamilyId) ?? families[0]!

  const requestedView = activeViewId
    ? family.views.find((v) => v.id === activeViewId)
    : undefined
  const defaultView = family.views.find((v) => v.id === family.defaultViewId)
  const view = requestedView ?? defaultView ?? family.views[0] ?? null

  return {
    families,
    activeFamilyId: family.id,
    activeViewId: view?.id ?? '',
    activeView: view,
  }
}

/**
 * Resolve the visible series IDs for a ChartView, honoring its semantic
 * defaultVisibleSeriesIds when the user has made no explicit selection.
 */
export function resolveViewVisibleSeries(
  view: ChartView,
  selectedSeriesIds: string[],
): string[] {
  return selectVisibleSeries({
    maxVisibleSeries: MAX_VISIBLE_SERIES,
    availableSeries: view.series.map((s, i) => ({
      id: s.id,
      label: s.label,
      unit: view.unit,
      color: s.color ?? getSeriesColor(i),
    })),
    selectedSeriesIds,
    defaultVisibleSeriesIds: view.defaultVisibleSeriesIds,
  })
}
