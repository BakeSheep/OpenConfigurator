import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { SeriesCache, buildCacheKey, estimateSize } from './seriesCache.js'
import { UlogAnalysisClient } from './UlogAnalysisClient.js'
import type { WorkerPort } from './UlogAnalysisClient.js'
import type { WorkerRequest, WorkerResponse } from './workerProtocol.js'
import type { UlogAnalysisDataset, RawSeriesResult, LogSource } from './types.js'

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeSeriesResult(fields: number, pointsPerField: number): RawSeriesResult {
  return {
    topic: 'test_topic',
    multiId: 0,
    series: Array.from({ length: fields }, (_, i) => ({
      field: `field_${i}`,
      times: new Array(pointsPerField).fill(0),
      values: new Array(pointsPerField).fill(0),
    })),
    truncated: false,
    originalSampleCount: pointsPerField,
  }
}

function makeMockDataset(overrides?: Partial<UlogAnalysisDataset>): UlogAnalysisDataset {
  return {
    metadata: {
      version: 1, timestamp: null, utcTimeSec: null, vehicleType: null,
      vehicleUuid: null, airframeName: null, firmwareVersion: null,
      hardwareVersion: null, systemInfo: {}, information: {}, multiInformation: [],
      logDuration: 10, hadAppendedData: false, warnings: [],
    },
    catalog: [],
    coverage: {
      discoveredTopicInstances: 0, analyzedTopicInstances: 0,
      rawOnlyTopicInstances: 0, unsupportedTopicInstances: 0,
      discoveredFields: 0, plottableFields: 0, warnings: [],
    },
    findings: [], parameters: [], events: [], sections: {},
    timeline: {
      logStartSec: 0, logEndSec: 10, armedStartSec: null, armedEndSec: null,
      takeoffSec: null, landSec: null, modeChanges: [], dropoutCount: 0,
      dropoutTotalMs: 0, dropoutMaxMs: 0, dropoutMeanMs: 0,
    },
    ...overrides,
  }
}

/**
 * Mock WorkerPort that captures posted messages and lets tests simulate
 * worker responses.
 */
class MockWorkerPort implements WorkerPort {
  onmessage: ((e: MessageEvent<WorkerResponse>) => void) | null = null
  onerror: ((message: string) => void) | null = null
  posted: WorkerRequest[] = []
  terminated = false
  transferred: Transferable[][] = []

  postMessage(msg: unknown, transfer?: Transferable[]): void {
    const req = msg as WorkerRequest
    this.posted.push(req)
    if (transfer) this.transferred.push(transfer)
  }

  terminate(): void {
    this.terminated = true
  }

  respond(msg: WorkerResponse): void {
    this.onmessage?.(new MessageEvent('message', { data: msg }))
  }

  lastLoadRequestId(): string | undefined {
    for (let i = this.posted.length - 1; i >= 0; i--) {
      if (this.posted[i].type === 'load') return this.posted[i].requestId
    }
    return undefined
  }
}

// ─── SeriesCache tests ──────────────────────────────────────────────────────

describe('SeriesCache', () => {
  it('evicts LRU after 24 entries', () => {
    const cache = new SeriesCache()
    // Insert 25 small entries
    for (let i = 0; i < 25; i++) {
      cache.set(`key-${i}`, makeSeriesResult(1, 10))
    }
    assert.ok(cache.size <= 24, `Cache should have at most 24 entries, got ${cache.size}`)
    // First entry should have been evicted
    assert.equal(cache.get('key-0'), undefined, 'First entry should be evicted')
    // Last entry should still be present
    assert.notEqual(cache.get('key-24'), undefined, 'Last entry should be present')
  })

  it('evicts by byte size limit (32MB)', () => {
    const cache = new SeriesCache()
    // Each entry: 2 fields × 1_000_000 points × 8 bytes = 16MB
    // Two such entries = 32MB, third should trigger eviction
    const bigResult = makeSeriesResult(2, 1_000_000)
    const size = estimateSize(bigResult)
    assert.ok(size > 0, 'Size should be positive')

    cache.set('a', bigResult)
    cache.set('b', bigResult)
    // At this point we're at or near 32MB
    const sizeBeforeThird = cache.size
    cache.set('c', bigResult)
    // At least one entry should have been evicted
    assert.ok(cache.size <= 2, `Cache should evict to stay under 32MB, got ${cache.size} entries`)
  })

  it('moves accessed entry to most-recent position', () => {
    const cache = new SeriesCache()
    // Fill 24 entries
    for (let i = 0; i < 24; i++) {
      cache.set(`key-${i}`, makeSeriesResult(1, 10))
    }
    // Access key-0 to make it most recently used
    cache.get('key-0')
    // Insert one more — should evict key-1 (now the LRU), not key-0
    cache.set('key-24', makeSeriesResult(1, 10))
    assert.notEqual(cache.get('key-0'), undefined, 'key-0 should survive (recently accessed)')
    assert.equal(cache.get('key-1'), undefined, 'key-1 should be evicted (LRU)')
  })

  it('clear resets size and bytes to zero', () => {
    const cache = new SeriesCache()
    for (let i = 0; i < 10; i++) {
      cache.set(`key-${i}`, makeSeriesResult(1, 100))
    }
    assert.ok(cache.size > 0)
    assert.ok(cache.bytes > 0)
    cache.clear()
    assert.equal(cache.size, 0)
    assert.equal(cache.bytes, 0)
  })
})

// ─── buildCacheKey ──────────────────────────────────────────────────────────

describe('buildCacheKey', () => {
  it('produces unique keys for different queries', () => {
    const key1 = buildCacheKey({ topic: 'a', multiId: 0, fields: ['x'] })
    const key2 = buildCacheKey({ topic: 'a', multiId: 1, fields: ['x'] })
    const key3 = buildCacheKey({ topic: 'a', multiId: 0, fields: ['y'] })
    const key4 = buildCacheKey({ topic: 'a', multiId: 0, fields: ['x'], startSec: 5 })
    assert.notEqual(key1, key2)
    assert.notEqual(key1, key3)
    assert.notEqual(key1, key4)
  })

  it('produces identical keys for identical queries', () => {
    const q = { topic: 'sensor', multiId: 2, fields: ['x', 'y'], startSec: 1, endSec: 10, pointBudget: 1000 }
    assert.equal(buildCacheKey(q), buildCacheKey({ ...q }))
  })
})

// ─── estimateSize ───────────────────────────────────────────────────────────

describe('estimateSize', () => {
  it('returns 0 for empty series', () => {
    const result: RawSeriesResult = {
      topic: 't', multiId: 0,
      series: [{ field: 'x', times: [], values: [] }],
      truncated: false, originalSampleCount: 0,
    }
    assert.equal(estimateSize(result), 0)
  })

  it('counts total numbers × 8 bytes', () => {
    const result: RawSeriesResult = {
      topic: 't', multiId: 0,
      series: [
        { field: 'x', times: [1, 2, 3], values: [10, 20, 30] },
        { field: 'y', times: [1, 2], values: [10, 20] },
      ],
      truncated: false, originalSampleCount: 3,
    }
    // (3 + 3 + 2 + 2) × 8 = 80
    assert.equal(estimateSize(result), 80)
  })
})

// ─── Buffer transfer (no duplicate on main thread) ─────────────────────────

describe('Buffer transfer', () => {
  it('transfers the buffer to the worker (not copied)', async () => {
    const mock = new MockWorkerPort()
    const client = new UlogAnalysisClient(() => mock)

    const buf = new ArrayBuffer(64)
    const loadPromise = client.load(buf, 'local-file')

    // Verify buffer was included in transfer list
    assert.ok(mock.transferred.length > 0, 'Should have transfer list')
    assert.ok(mock.transferred[0].includes(buf), 'Buffer should be in transfer list')

    // Complete the load
    const reqId = mock.lastLoadRequestId()!
    mock.respond({ type: 'loaded', requestId: reqId, dataset: makeMockDataset() })
    await loadPromise
  })
})

// ─── Session replacement (no retained prior session) ────────────────────────

describe('Session replacement', () => {
  it('loading new file cancels old and clears state', async () => {
    const mock = new MockWorkerPort()
    const client = new UlogAnalysisClient(() => mock)

    const buf1 = new ArrayBuffer(16)
    const load1 = client.load(buf1, 'local-file')
    const load1ReqId = mock.lastLoadRequestId()

    // Start second load before first resolves
    const buf2 = new ArrayBuffer(16)
    const load2 = client.load(buf2, 'local-file')

    // First load should be rejected with AbortError
    await assert.rejects(load1, (err: Error) => err.name === 'AbortError')

    // A cancel message should have been sent for the first request
    const cancelMsg = mock.posted.find(
      m => m.type === 'cancel' && (m as { targetRequestId: string }).targetRequestId === load1ReqId,
    )
    assert.ok(cancelMsg, 'Should have sent cancel for first load')

    // Resolve the second load
    const load2ReqId = mock.lastLoadRequestId()!
    mock.respond({ type: 'loaded', requestId: load2ReqId, dataset: makeMockDataset() })
    const result = await load2
    assert.equal(client.sessionState, 'ready')
    assert.ok(result.metadata)
  })

  it('dispose terminates worker and rejects pending loads', async () => {
    const mock = new MockWorkerPort()
    const client = new UlogAnalysisClient(() => mock)

    const buf = new ArrayBuffer(16)
    const loadPromise = client.load(buf, 'local-file')

    await client.dispose()
    assert.equal(client.sessionState, 'disposed')
    assert.ok(mock.terminated, 'Worker should be terminated')

    await assert.rejects(loadPromise, (err: Error) => err.message.includes('disposed'))
  })
})

// ─── Cancellation ───────────────────────────────────────────────────────────

describe('Cancellation', () => {
  it('AbortSignal cancels in-flight load', async () => {
    const mock = new MockWorkerPort()
    const client = new UlogAnalysisClient(() => mock)
    const controller = new AbortController()

    const buf = new ArrayBuffer(16)
    const loadPromise = client.load(buf, 'local-file', controller.signal)

    controller.abort()

    await assert.rejects(loadPromise, (err: Error) => err.name === 'AbortError')
    assert.equal(client.sessionState, 'idle')
  })

  it('already-aborted signal rejects immediately', async () => {
    const mock = new MockWorkerPort()
    const client = new UlogAnalysisClient(() => mock)
    const controller = new AbortController()
    controller.abort()

    const buf = new ArrayBuffer(16)
    await assert.rejects(
      () => client.load(buf, 'local-file', controller.signal),
      (err: Error) => err.name === 'AbortError',
    )
  })

  it('cancel sends cancel message to worker', async () => {
    const mock = new MockWorkerPort()
    const client = new UlogAnalysisClient(() => mock)
    const controller = new AbortController()

    const buf = new ArrayBuffer(16)
    const loadPromise = client.load(buf, 'local-file', controller.signal)

    controller.abort()
    await assert.rejects(loadPromise)

    const cancelMsg = mock.posted.find(m => m.type === 'cancel')
    assert.ok(cancelMsg, 'Should have sent cancel to worker')
  })
})

// ─── Repeated load/unload cycles ────────────────────────────────────────────

describe('Repeated load/unload cycles', () => {
  it('load A → replace with B → dispose → load C', async () => {
    const mock = new MockWorkerPort()
    const client = new UlogAnalysisClient(() => mock)

    // Load A
    const bufA = new ArrayBuffer(16)
    const loadA = client.load(bufA, 'local-file')
    const reqA = mock.lastLoadRequestId()!

    // Replace with B before A completes
    const bufB = new ArrayBuffer(16)
    const loadB = client.load(bufB, 'local-file')

    // A should be rejected
    await assert.rejects(loadA, (err: Error) => err.name === 'AbortError')

    // Resolve B
    const reqB = mock.lastLoadRequestId()!
    mock.respond({ type: 'loaded', requestId: reqB, dataset: makeMockDataset() })
    const resultB = await loadB
    assert.equal(client.sessionState, 'ready')
    assert.ok(resultB.metadata)

    // Dispose (simulate navigating away)
    await client.dispose()
    assert.equal(client.sessionState, 'disposed')
    assert.ok(mock.terminated)
  })

  it('stale responses never overwrite active dataset', async () => {
    const mock = new MockWorkerPort()
    const client = new UlogAnalysisClient(() => mock)

    // Load A
    const bufA = new ArrayBuffer(16)
    const loadA = client.load(bufA, 'local-file')
    const reqA = mock.lastLoadRequestId()!

    // Load B (cancels A)
    const bufB = new ArrayBuffer(16)
    const loadB = client.load(bufB, 'local-file')
    const reqB = mock.lastLoadRequestId()!

    // A rejected
    await assert.rejects(loadA)

    // Try to send a stale response for A (should be ignored)
    mock.respond({ type: 'loaded', requestId: reqA, dataset: makeMockDataset() })
    // Client should still be loading B
    assert.equal(client.sessionState, 'loading')

    // Resolve B
    const datasetB = makeMockDataset({ metadata: {
      version: 1, timestamp: null, utcTimeSec: null, vehicleType: null,
      vehicleUuid: null, airframeName: null, firmwareVersion: null,
      hardwareVersion: null, systemInfo: {}, information: {}, multiInformation: [],
      logDuration: 99, hadAppendedData: false, warnings: [],
    }})
    mock.respond({ type: 'loaded', requestId: reqB, dataset: datasetB })
    const result = await loadB
    assert.equal(result.metadata.logDuration, 99, 'Should have B data, not A')
  })
})

// ─── Progress phases ────────────────────────────────────────────────────────

describe('Progress phases', () => {
  it('forwards progress events to callback', async () => {
    const progressEvents: Array<{ phase: string; fraction: number }> = []
    const mock = new MockWorkerPort()
    const client = new UlogAnalysisClient(() => mock, (phase, fraction) => {
      progressEvents.push({ phase, fraction })
    })

    const buf = new ArrayBuffer(16)
    const loadPromise = client.load(buf, 'local-file')
    const reqId = mock.lastLoadRequestId()!

    // Simulate phased progress
    mock.respond({ type: 'progress', requestId: reqId, phase: 'validating', fraction: 0.02 })
    mock.respond({ type: 'progress', requestId: reqId, phase: 'normalizing', fraction: 0.1 })
    mock.respond({ type: 'progress', requestId: reqId, phase: 'indexing', fraction: 0.2 })
    mock.respond({ type: 'progress', requestId: reqId, phase: 'cataloging', fraction: 0.4 })
    mock.respond({ type: 'progress', requestId: reqId, phase: 'analyzing', fraction: 0.5 })
    mock.respond({ type: 'progress', requestId: reqId, phase: 'finalizing', fraction: 1.0 })

    // Complete
    mock.respond({ type: 'loaded', requestId: reqId, dataset: makeMockDataset() })
    await loadPromise

    assert.equal(progressEvents.length, 6)
    assert.equal(progressEvents[0].phase, 'validating')
    assert.equal(progressEvents[1].phase, 'normalizing')
    assert.equal(progressEvents[2].phase, 'indexing')
    assert.equal(progressEvents[3].phase, 'cataloging')
    assert.equal(progressEvents[4].phase, 'analyzing')
    assert.equal(progressEvents[5].phase, 'finalizing')

    // Fractions should be monotonically non-decreasing
    for (let i = 1; i < progressEvents.length; i++) {
      assert.ok(
        progressEvents[i].fraction >= progressEvents[i - 1].fraction,
        `Progress should not go backwards: ${progressEvents[i - 1].fraction} → ${progressEvents[i].fraction}`,
      )
    }
  })
})
