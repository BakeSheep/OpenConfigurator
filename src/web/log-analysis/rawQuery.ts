// Pure validation functions for raw series queries.
// No side effects — safe to call from tests or the main thread.
import type {
  RawSeriesQuery,
  UlogTopicCatalogEntry,
} from './types.js'

export interface RawQueryValidation {
  valid: boolean
  errors: string[]
}

const MAX_CHART_FIELDS = 6
const MAX_POINT_BUDGET = 50_000

/** Read flattened catalog paths such as `xyz[0]` or `state.position[2]`. */
export function readFieldPath(value: Record<string, unknown>, path: string): unknown {
  let current: unknown = value
  const segments = path.match(/[^.[\]]+|\d+/g) ?? []
  for (const segment of segments) {
    if (current == null || (typeof current !== 'object' && !Array.isArray(current))) {
      return undefined
    }
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

/**
 * Find a topic instance in the catalog by name + multiId.
 */
function findTopicEntry(
  topic: string,
  multiId: number,
  catalog: readonly UlogTopicCatalogEntry[],
): UlogTopicCatalogEntry | undefined {
  return catalog.find((e) => e.name === topic && e.multiId === multiId)
}

/**
 * Validate a RawSeriesQuery against the current catalog.
 * Checks:
 *  - topic instance exists
 *  - all requested fields exist and are numeric (plottable)
 *  - field count ≤ 6
 *  - time range is valid (start ≤ end)
 *  - pointBudget ≤ 50 000
 */
export function validateRawQuery(
  query: RawSeriesQuery,
  catalog: readonly UlogTopicCatalogEntry[],
): RawQueryValidation {
  const errors: string[] = []

  // 1. Topic instance must exist
  const entry = findTopicEntry(query.topic, query.multiId, catalog)
  if (!entry) {
    errors.push(
      `Unknown topic instance: ${query.topic}[${query.multiId}]`,
    )
    return { valid: false, errors }
  }

  // 2. Field count limit
  if (query.fields.length === 0) {
    errors.push('At least one field is required')
  }
  if (query.fields.length > MAX_CHART_FIELDS) {
    errors.push(
      `Too many fields: ${query.fields.length} (max ${MAX_CHART_FIELDS})`,
    )
  }

  // 3. Each field must exist and be plottable (numeric)
  const catalogFieldNames = new Set(entry.fields.map((f) => f.path))
  const plottableFields = new Set(
    entry.fields.filter((f) => f.plottable).map((f) => f.path),
  )
  for (const field of query.fields) {
    if (!catalogFieldNames.has(field)) {
      errors.push(`Unknown field: ${field}`)
    } else if (!plottableFields.has(field)) {
      errors.push(`Field "${field}" is not numeric and cannot be plotted`)
    }
  }

  // 4. Time range validity
  if (
    query.startSec != null &&
    query.endSec != null &&
    query.startSec > query.endSec
  ) {
    errors.push(
      `Invalid time range: start (${query.startSec}) > end (${query.endSec})`,
    )
  }

  // 5. Point budget limit
  if (query.pointBudget != null) {
    if (!Number.isInteger(query.pointBudget) || query.pointBudget < 1) {
      errors.push('Point budget must be a positive integer')
    } else if (query.pointBudget > MAX_POINT_BUDGET) {
      errors.push(
        `Point budget ${query.pointBudget} exceeds maximum (${MAX_POINT_BUDGET})`,
      )
    }
  }

  return { valid: errors.length === 0, errors }
}
