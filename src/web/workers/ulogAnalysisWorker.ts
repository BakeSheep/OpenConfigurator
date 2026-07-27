/// <reference lib="webworker" />
// Persistent ULog analysis worker. Receives typed requests via the worker
// protocol, keeps a UlogDocument in memory between requests, and supports
// lazy series extraction and cancellation.
import { MessageType } from '@foxglove/ulog'
import { UlogDocument } from '../log-analysis/parser/UlogDocument.js'
import type { WorkerRequest, WorkerResponse, WorkerErrorData } from '../log-analysis/workerProtocol.js'
import type {
  UlogAnalysisDataset,
  RawSeriesQuery,
  RawSeriesResult,
} from '../log-analysis/types.js'
import { ModuleRegistry } from '../log-analysis/engine/moduleRegistry.js'
import { runAnalysis } from '../log-analysis/engine/runAnalysis.js'
import { flightOverviewModule } from '../log-analysis/modules/flightOverview.js'
import { powerModule } from '../log-analysis/modules/power.js'
import { propulsionModule } from '../log-analysis/modules/propulsion.js'
import { navigationModule } from '../log-analysis/modules/navigation.js'
import { eventsModule } from '../log-analysis/modules/events.js'
import { estimatorModule } from '../log-analysis/modules/estimator.js'
import { sensorsModule } from '../log-analysis/modules/sensors.js'
import { failsafeModule } from '../log-analysis/modules/failsafe.js'
import { systemHealthModule } from '../log-analysis/modules/systemHealth.js'
import { controlTrackingModule } from '../log-analysis/modules/controlTracking.js'
import { actuatorsModule } from '../log-analysis/modules/actuators.js'
import { SeriesCache, buildCacheKey } from '../log-analysis/seriesCache.js'
import { readFieldPath, validateRawQuery } from '../log-analysis/rawQuery.js'

// ─── Bounded LRU Series Cache ──────────────────────────────────────────────
// SeriesCache is imported from ../log-analysis/seriesCache.js

// ─── Worker state ──────────────────────────────────────────────────────────

let document: UlogDocument | null = null
let cancelToken: { requestId: string; canceled: boolean } | null = null
const seriesCache = new SeriesCache()

// Build the module registry once at worker startup
function createRegistry(): ModuleRegistry {
  const registry = new ModuleRegistry()
  registry.register(flightOverviewModule)
  registry.register(powerModule)
  registry.register(propulsionModule)
  registry.register(navigationModule)
  registry.register(eventsModule)
  registry.register(estimatorModule)
  registry.register(sensorsModule)
  registry.register(failsafeModule)
  registry.register(systemHealthModule)
  registry.register(controlTrackingModule)
  registry.register(actuatorsModule)
  return registry
}

const registry = createRegistry()

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data

  switch (msg.type) {
    case 'load': {
      // Cancel any previous load
      if (cancelToken) cancelToken.canceled = true
      const token = { requestId: msg.requestId, canceled: false }
      cancelToken = token

      // Clear series cache on new file load
      seriesCache.clear()

      void (async () => {
        try {
          // Phase 1: validating (0-10%)
          post({ type: 'progress', requestId: msg.requestId, phase: 'validating', fraction: 0.02 })

          if (!msg.buffer || msg.buffer.byteLength === 0) {
            throw new Error('Empty or invalid buffer')
          }

          // Phase 2: normalizing (10-20%)
          post({ type: 'progress', requestId: msg.requestId, phase: 'normalizing', fraction: 0.1 })

          if (token.canceled) {
            post({ type: 'error', requestId: msg.requestId, error: { code: 'canceled', message: 'Load canceled' } })
            return
          }

          // Phase 3: indexing (20-40%)
          post({ type: 'progress', requestId: msg.requestId, phase: 'indexing', fraction: 0.2 })

          const loadedDocument = await UlogDocument.open(msg.buffer)

          if (token.canceled) {
            post({ type: 'error', requestId: msg.requestId, error: { code: 'canceled', message: 'Load canceled' } })
            return
          }

          // Phase 4: cataloging (40-50%)
          post({ type: 'progress', requestId: msg.requestId, phase: 'cataloging', fraction: 0.4 })

          // Phase 5: analyzing (50-90%)
          post({ type: 'progress', requestId: msg.requestId, phase: 'analyzing', fraction: 0.5 })

          const analysisResult = await runAnalysis(loadedDocument, registry, (phase, fraction) => {
            if (token.canceled) return
            // Map analysis progress (0-1) into the 50-90% range
            const mappedFraction = 0.5 + fraction * 0.4
            post({ type: 'progress', requestId: msg.requestId, phase, fraction: mappedFraction })
          }, token)

          if (token.canceled) {
            post({ type: 'error', requestId: msg.requestId, error: { code: 'canceled', message: 'Load canceled' } })
            return
          }

          const dataset = buildDataset(loadedDocument, analysisResult)

          if (token.canceled) {
            post({ type: 'error', requestId: msg.requestId, error: { code: 'canceled', message: 'Load canceled' } })
            return
          }

          // Commit the parsed document only after this request is still known
          // to be current. Superseded loads must never replace the active file.
          document = loadedDocument

          // Phase 6: finalizing (90-100%)
          post({ type: 'progress', requestId: msg.requestId, phase: 'finalizing', fraction: 0.95 })
          post({ type: 'progress', requestId: msg.requestId, phase: 'finalizing', fraction: 1.0 })
          post({ type: 'loaded', requestId: msg.requestId, dataset })
        } catch (err) {
          if (cancelToken === token) {
            document = null
            seriesCache.clear()
          }
          const message = err instanceof Error ? err.message : 'Unknown error'
          post({
            type: 'error',
            requestId: msg.requestId,
            error: {
              code: classifyError(message),
              message: sanitizeErrorMessage(message),
            },
          })
        }
      })()
      break
    }

    case 'get_series': {
      if (!document) {
        post({
          type: 'error',
          requestId: msg.requestId,
          error: { code: 'unknown', message: 'No document loaded' },
        })
        return
      }
      void (async () => {
        try {
          const validation = validateRawQuery(msg.query, document!.catalog)
          if (!validation.valid) {
            throw new Error(validation.errors.join('；'))
          }
          const cacheKey = buildCacheKey(msg.query)

          // Check cache first
          const cached = seriesCache.get(cacheKey)
          if (cached !== undefined) {
            post({ type: 'series', requestId: msg.requestId, result: cached })
            return
          }

          const result = await extractSeries(document!, msg.query)

          // Cache the result (bounded LRU)
          seriesCache.set(cacheKey, result)

          post({ type: 'series', requestId: msg.requestId, result })
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          post({
            type: 'error',
            requestId: msg.requestId,
            error: { code: classifyError(message), message: sanitizeErrorMessage(message) },
          })
        }
      })()
      break
    }

    case 'cancel': {
      if (cancelToken?.requestId === msg.targetRequestId) {
        cancelToken.canceled = true
      }
      break
    }

    case 'dispose': {
      document = null
      cancelToken = null
      seriesCache.clear()
      post({ type: 'disposed', requestId: msg.requestId })
      break
    }
  }
}

function post(msg: WorkerResponse): void {
  self.postMessage(msg)
}

function classifyError(message: string): WorkerErrorData['code'] {
  const lower = message.toLowerCase()
  if (lower.includes('magic')) return 'invalid_file'
  if (lower.includes('version')) return 'unsupported_version'
  if (lower.includes('encrypt')) return 'encrypted'
  if (lower.includes('memory') || lower.includes('allocation') || lower.includes('oom')) return 'out_of_memory'
  if (lower.includes('corrupt') || lower.includes('truncat')) return 'corrupt_topic'
  if (lower.includes('canceled') || lower.includes('cancelled')) return 'canceled'
  if (lower.includes('empty') || lower.includes('invalid buffer')) return 'invalid_file'
  return 'unknown'
}

/** Strip internal details that should not reach the UI. */
function sanitizeErrorMessage(message: string): string {
  // Remove stack traces
  const firstLine = message.split('\n')[0]!
  // Keep it user-friendly
  return firstLine.slice(0, 200)
}

function buildDataset(doc: UlogDocument, analysisResult?: Awaited<ReturnType<typeof runAnalysis>>): UlogAnalysisDataset {
  return {
    metadata: doc.metadata,
    catalog: [...doc.catalog],
    coverage: analysisResult?.coverage ?? doc.coverage,
    findings: analysisResult?.findings ?? [],
    parameters: [...doc.parameters],
    events: [...doc.events],
    sections: analysisResult?.sections ?? {},
    timeline: doc.timeline,
  }
}

async function extractSeries(doc: UlogDocument, query: RawSeriesQuery): Promise<RawSeriesResult> {
  const ulog = doc.rawUlog
  const pointBudget = query.pointBudget ?? 5000

  // Find the subscription matching topic + multiId
  let targetMsgId: number | null = null
  for (const [msgId, sub] of ulog.subscriptions) {
    if (sub.name === query.topic && sub.multiId === query.multiId) {
      targetMsgId = msgId
      break
    }
  }

  if (targetMsgId === null) {
    return {
      topic: query.topic,
      multiId: query.multiId,
      series: query.fields.map((field) => ({ field, times: [], values: [] })),
      truncated: false,
      originalSampleCount: 0,
    }
  }

  const logStartUs = BigInt(Math.round(doc.timeline.logStartSec * 1e6))
  const startUs = query.startSec != null
    ? BigInt(Math.round(query.startSec * 1e6)) + logStartUs
    : undefined
  const endUs = query.endSec != null
    ? BigInt(Math.round(query.endSec * 1e6)) + logStartUs
    : undefined

  // Collect raw samples
  const rawSamples: Array<{ time: number; values: Map<string, number> }> = []
  const wantedIds = new Set<number>([targetMsgId])

  for await (const message of ulog.readMessages({ msgIds: wantedIds, startTime: startUs, endTime: endUs })) {
    if (message.type !== MessageType.Data) continue
    const timeSec = Number(BigInt(message.value.timestamp as number | bigint) - logStartUs) / 1e6
    const values = new Map<string, number>()
    for (const field of query.fields) {
      const val = readFieldPath(message.value as Record<string, unknown>, field)
      const num = typeof val === 'number' ? val : typeof val === 'bigint' ? Number(val) : NaN
      if (Number.isFinite(num)) {
        values.set(field, num)
      }
    }
    rawSamples.push({ time: timeSec, values })
  }

  // Build output series — enforce pointBudget strictly
  const series = query.fields.map((field) => ({
    field,
    times: [] as number[],
    values: [] as number[],
  }))

  if (rawSamples.length <= pointBudget) {
    for (const sample of rawSamples) {
      for (const s of series) {
        const v = sample.values.get(s.field)
        if (v != null) {
          s.times.push(sample.time)
          s.values.push(v)
        }
      }
    }
  } else {
    // Min/max downsampling to fit within point budget
    // Each bucket emits up to two extrema, so size buckets against half the
    // budget. Trimming a 2× overshoot would otherwise discard the latter half
    // of the requested time range.
    const bucketCount = Math.max(1, Math.floor(pointBudget / 2))
    const bucketSize = Math.ceil(rawSamples.length / bucketCount)
    for (let i = 0; i < rawSamples.length; i += bucketSize) {
      const bucketEnd = Math.min(i + bucketSize, rawSamples.length)
      for (const s of series) {
        let minVal = Infinity
        let maxVal = -Infinity
        let minTime = 0
        let maxTime = 0
        for (let j = i; j < bucketEnd; j++) {
          const v = rawSamples[j].values.get(s.field)
          if (v != null) {
            if (v < minVal) { minVal = v; minTime = rawSamples[j].time }
            if (v > maxVal) { maxVal = v; maxTime = rawSamples[j].time }
          }
        }
        if (minVal !== Infinity) {
          if (minTime <= maxTime) {
            s.times.push(minTime, maxTime)
            s.values.push(minVal, maxVal)
          } else {
            s.times.push(maxTime, minTime)
            s.values.push(maxVal, minVal)
          }
        }
      }
    }
  }

  // Enforce point budget: trim if downsampling overshot
  for (const s of series) {
    if (s.times.length > pointBudget) {
      s.times.length = pointBudget
      s.values.length = pointBudget
    }
  }

  return {
    topic: query.topic,
    multiId: query.multiId,
    series,
    truncated: rawSamples.length > pointBudget,
    originalSampleCount: rawSamples.length,
  }
}
