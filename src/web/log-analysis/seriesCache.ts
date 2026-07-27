import type { RawSeriesResult } from './types.js'

/**
 * Bounded LRU cache for series query results.
 * Limits by both entry count (max 24) and total byte size (max 32MB).
 * Evicts least-recently-used entries when limits are exceeded.
 */
export class SeriesCache {
  private cache = new Map<string, { result: RawSeriesResult; size: number }>()
  private readonly maxEntries = 24
  private readonly maxBytes = 32 * 1024 * 1024 // 32 MB
  private currentBytes = 0

  get size(): number {
    return this.cache.size
  }

  get bytes(): number {
    return this.currentBytes
  }

  get(key: string): RawSeriesResult | undefined {
    const entry = this.cache.get(key)
    if (entry === undefined) return undefined
    // Move to end (most recently used)
    this.cache.delete(key)
    this.cache.set(key, entry)
    return entry.result
  }

  set(key: string, result: RawSeriesResult): void {
    // If already cached, update in place
    if (this.cache.has(key)) {
      const old = this.cache.get(key)!
      this.currentBytes -= old.size
      this.cache.delete(key)
    }

    const entrySize = estimateSize(result)

    // Evict until we have room (by count and bytes)
    while (
      this.cache.size >= this.maxEntries ||
      this.currentBytes + entrySize > this.maxBytes
    ) {
      const firstKey = this.cache.keys().next().value
      if (firstKey === undefined) break
      const firstEntry = this.cache.get(firstKey)!
      this.cache.delete(firstKey)
      this.currentBytes -= firstEntry.size
    }

    this.cache.set(key, { result, size: entrySize })
    this.currentBytes += entrySize
  }

  clear(): void {
    this.cache.clear()
    this.currentBytes = 0
  }
}

export function estimateSize(result: RawSeriesResult): number {
  let count = 0
  for (const s of result.series) {
    count += s.times.length + s.values.length
  }
  return count * 8 // 8 bytes per number (float64)
}

export function buildCacheKey(query: {
  topic: string
  multiId: number
  fields: string[]
  startSec?: number
  endSec?: number
  pointBudget?: number
}): string {
  const fields = query.fields.join(',')
  const start = query.startSec ?? ''
  const end = query.endSec ?? ''
  const budget = query.pointBudget ?? ''
  return `${query.topic}:${query.multiId}:${fields}:${start}:${end}:${budget}`
}
