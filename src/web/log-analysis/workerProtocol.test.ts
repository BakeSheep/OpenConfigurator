import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { UlogAnalysisClient } from './UlogAnalysisClient.js'
import type { WorkerPort } from './UlogAnalysisClient.js'
import type { WorkerRequest, WorkerResponse } from './workerProtocol.js'
import type { UlogAnalysisDataset, LogSource } from './types.js'

// ─── Mock Worker ─────────────────────────────────────────────────────────────

/**
 * A mock WorkerPort that captures posted messages and lets tests simulate
 * worker responses.
 */
class MockWorkerPort implements WorkerPort {
  onmessage: ((e: MessageEvent<WorkerResponse>) => void) | null = null
  onerror: ((message: string) => void) | null = null
  posted: WorkerRequest[] = []
  terminated = false
  // When set, auto-responds to load requests with a loaded response
  autoLoadResponse: UlogAnalysisDataset | null = null
  // When set, auto-responds to load requests with an error
  autoLoadError: string | null = null

  postMessage(msg: unknown, _transfer?: Transferable[]): void {
    const req = msg as WorkerRequest
    this.posted.push(req)

    // Auto-respond for load requests
    if (req.type === 'load') {
      if (this.autoLoadError) {
        queueMicrotask(() => this.respond({
          type: 'error',
          requestId: req.requestId,
          error: { code: 'unknown', message: this.autoLoadError! },
        }))
      } else if (this.autoLoadResponse) {
        queueMicrotask(() => this.respond({
          type: 'loaded',
          requestId: req.requestId,
          dataset: this.autoLoadResponse!,
        }))
      }
    }

    if (req.type === 'get_series' && this.autoLoadResponse) {
      queueMicrotask(() => this.respond({
        type: 'series',
        requestId: req.requestId,
        result: {
          topic: 'test',
          multiId: 0,
          series: [],
          truncated: false,
          originalSampleCount: 0,
        },
      }))
    }
  }

  terminate(): void {
    this.terminated = true
  }

  respond(msg: WorkerResponse): void {
    this.onmessage?.(new MessageEvent('message', { data: msg }))
  }

  triggerError(message: string): void {
    this.onerror?.(message)
  }

  /** Find the last load request id */
  lastLoadRequestId(): string | undefined {
    for (let i = this.posted.length - 1; i >= 0; i--) {
      if (this.posted[i].type === 'load') return this.posted[i].requestId
    }
    return undefined
  }
}

function makeMockDataset(overrides?: Partial<UlogAnalysisDataset>): UlogAnalysisDataset {
  return {
    metadata: {
      version: 1,
      timestamp: null,
      utcTimeSec: null,
      vehicleType: null,
      vehicleUuid: null,
      airframeName: null,
      firmwareVersion: null,
      hardwareVersion: null,
      systemInfo: {},
      information: {},
      multiInformation: [],
      logDuration: 10,
      hadAppendedData: false,
      warnings: [],
    },
    catalog: [],
    coverage: {
      discoveredTopicInstances: 0,
      analyzedTopicInstances: 0,
      rawOnlyTopicInstances: 0,
      unsupportedTopicInstances: 0,
      discoveredFields: 0,
      plottableFields: 0,
      warnings: [],
    },
    findings: [],
    parameters: [],
    events: [],
    sections: {},
    timeline: {
      logStartSec: 0,
      logEndSec: 10,
      armedStartSec: null,
      armedEndSec: null,
      takeoffSec: null,
      landSec: null,
      modeChanges: [],
      dropoutCount: 0,
      dropoutTotalMs: 0,
      dropoutMaxMs: 0,
      dropoutMeanMs: 0,
    },
    ...overrides,
  }
}

function createTestClient(
  mock: MockWorkerPort,
  onProgress?: (phase: string, fraction: number) => void,
): UlogAnalysisClient {
  return new UlogAnalysisClient(() => mock, onProgress)
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('UlogAnalysisClient state machine', () => {
  it('starts in idle state', () => {
    const mock = new MockWorkerPort()
    const client = createTestClient(mock)
    assert.equal(client.sessionState, 'idle')
  })

  it('transitions idle → loading → ready on successful load', async () => {
    const mock = new MockWorkerPort()
    const client = createTestClient(mock)
    const dataset = makeMockDataset()
    mock.autoLoadResponse = dataset

    const buf = new ArrayBuffer(16)
    const loadPromise = client.load(buf, 'local-file')
    assert.equal(client.sessionState, 'loading')

    const result = await loadPromise
    assert.equal(client.sessionState, 'ready')
    assert.deepEqual(result, dataset)
  })

  it('transfers the buffer to the worker (zero-copy)', async () => {
    const mock = new MockWorkerPort()
    const client = createTestClient(mock)
    mock.autoLoadResponse = makeMockDataset()

    const buf = new ArrayBuffer(16)
    const transferred: Transferable[][] = []
    const origPost = mock.postMessage.bind(mock)
    mock.postMessage = (msg: unknown, transfer?: Transferable[]) => {
      if (transfer) transferred.push(transfer)
      origPost(msg, transfer)
    }

    await client.load(buf, 'local-file')
    assert.ok(transferred.length > 0, 'should have transferred buffer')
    assert.ok(transferred[0].includes(buf), 'buffer should be in transfer list')
  })

  it('correlates responses by requestId', async () => {
    const mock = new MockWorkerPort()
    const client = createTestClient(mock)

    const buf = new ArrayBuffer(16)
    const loadPromise = client.load(buf, 'local-file')

    // Get the requestId from the posted message
    const loadReq = mock.posted.find(m => m.type === 'load')
    assert.ok(loadReq)

    // Respond with correct requestId
    mock.respond({
      type: 'loaded',
      requestId: loadReq.requestId,
      dataset: makeMockDataset(),
    })

    const result = await loadPromise
    assert.ok(result.metadata, 'should resolve with dataset')
  })

  it('ignores stale responses (response for unknown requestId)', async () => {
    const mock = new MockWorkerPort()
    const client = createTestClient(mock)

    const buf = new ArrayBuffer(16)
    const loadPromise = client.load(buf, 'local-file')

    // Send a response with a bogus requestId
    mock.respond({
      type: 'loaded',
      requestId: 'stale-id-12345',
      dataset: makeMockDataset(),
    })

    // Client should still be in loading state
    assert.equal(client.sessionState, 'loading')

    // Now send the correct response
    const loadReq = mock.posted.find(m => m.type === 'load')
    mock.respond({
      type: 'loaded',
      requestId: loadReq!.requestId,
      dataset: makeMockDataset(),
    })

    await loadPromise // should resolve now
    assert.equal(client.sessionState, 'ready')
  })

  it('cancels in-flight load when a new load starts', async () => {
    const mock = new MockWorkerPort()
    const client = createTestClient(mock)

    const buf1 = new ArrayBuffer(16)
    const load1 = client.load(buf1, 'local-file')
    const load1ReqId = mock.lastLoadRequestId()

    // Start a second load before the first resolves
    const buf2 = new ArrayBuffer(16)
    const load2 = client.load(buf2, 'local-file')

    // First load should be rejected with AbortError
    await assert.rejects(load1, (err: Error) => {
      return err.name === 'AbortError'
    })

    // A cancel message should have been sent for the first request
    const cancelMsg = mock.posted.find(
      m => m.type === 'cancel' && (m as { targetRequestId: string }).targetRequestId === load1ReqId,
    )
    assert.ok(cancelMsg, 'should have sent cancel for first load')

    // Resolve the second load
    const load2ReqId = mock.lastLoadRequestId()
    mock.respond({
      type: 'loaded',
      requestId: load2ReqId!,
      dataset: makeMockDataset(),
    })

    const result = await load2
    assert.equal(client.sessionState, 'ready')
    assert.ok(result.metadata)
  })

  it('forwards progress events to the callback', async () => {
    const progressEvents: Array<{ phase: string; fraction: number }> = []
    const mock = new MockWorkerPort()
    const client = createTestClient(mock, (phase, fraction) => {
      progressEvents.push({ phase, fraction })
    })

    const buf = new ArrayBuffer(16)
    const loadPromise = client.load(buf, 'local-file')
    const loadReqId = mock.lastLoadRequestId()!

    // Send progress events
    mock.respond({ type: 'progress', requestId: loadReqId, phase: 'normalizing', fraction: 0.3 })
    mock.respond({ type: 'progress', requestId: loadReqId, phase: 'cataloging', fraction: 0.7 })

    // Complete the load
    mock.respond({ type: 'loaded', requestId: loadReqId, dataset: makeMockDataset() })

    await loadPromise
    assert.equal(progressEvents.length, 2)
    assert.equal(progressEvents[0].phase, 'normalizing')
    assert.equal(progressEvents[0].fraction, 0.3)
    assert.equal(progressEvents[1].phase, 'cataloging')
    assert.equal(progressEvents[1].fraction, 0.7)
  })

  it('recovers to idle after load error, allowing retry', async () => {
    const mock = new MockWorkerPort()
    const client = createTestClient(mock)

    const buf = new ArrayBuffer(16)
    const loadPromise = client.load(buf, 'local-file')
    const loadReqId = mock.lastLoadRequestId()!

    // Simulate error
    mock.respond({
      type: 'error',
      requestId: loadReqId,
      error: { code: 'invalid_file', message: 'Bad magic bytes' },
    })

    await assert.rejects(loadPromise, (err: Error) => {
      return err.message.includes('Bad magic bytes')
    })
    assert.equal(client.sessionState, 'idle')

    // Retry with a successful load
    mock.autoLoadResponse = makeMockDataset()
    const buf2 = new ArrayBuffer(16)
    const result = await client.load(buf2, 'local-file')
    assert.equal(client.sessionState, 'ready')
    assert.ok(result.metadata)
  })

  it('getSeries only works in ready state', async () => {
    const mock = new MockWorkerPort()
    const client = createTestClient(mock)

    // Should throw in idle state
    await assert.rejects(
      () => client.getSeries({ topic: 'test', multiId: 0, fields: ['x'] }),
      (err: Error) => err.message.includes('not ready'),
    )

    // Load successfully
    mock.autoLoadResponse = makeMockDataset()
    const buf = new ArrayBuffer(16)
    await client.load(buf, 'local-file')
    assert.equal(client.sessionState, 'ready')

    // Now getSeries should work
    const result = await client.getSeries({ topic: 'test', multiId: 0, fields: ['x'] })
    assert.ok(result, 'getSeries should resolve')
  })

  it('getSeries throws in disposed state', async () => {
    const mock = new MockWorkerPort()
    const client = createTestClient(mock)
    mock.autoLoadResponse = makeMockDataset()

    const buf = new ArrayBuffer(16)
    await client.load(buf, 'local-file')
    await client.dispose()

    await assert.rejects(
      () => client.getSeries({ topic: 'test', multiId: 0, fields: ['x'] }),
      (err: Error) => err.message.includes('disposed'),
    )
  })

  it('dispose terminates worker and rejects all pending', async () => {
    const mock = new MockWorkerPort()
    const client = createTestClient(mock)

    const buf = new ArrayBuffer(16)
    const loadPromise = client.load(buf, 'local-file')

    // Dispose while load is in-flight
    await client.dispose()
    assert.equal(client.sessionState, 'disposed')
    assert.ok(mock.terminated, 'worker should be terminated')

    await assert.rejects(loadPromise, (err: Error) => {
      return err.message.includes('disposed')
    })
  })

  it('dispose is idempotent', async () => {
    const mock = new MockWorkerPort()
    const client = createTestClient(mock)
    await client.dispose()
    await client.dispose() // should not throw
    assert.equal(client.sessionState, 'disposed')
  })

  it('load throws in disposed state', async () => {
    const mock = new MockWorkerPort()
    const client = createTestClient(mock)
    await client.dispose()

    const buf = new ArrayBuffer(16)
    await assert.rejects(
      () => client.load(buf, 'local-file'),
      (err: Error) => err.message.includes('disposed'),
    )
  })

  it('AbortSignal cancels an in-flight load', async () => {
    const mock = new MockWorkerPort()
    const client = createTestClient(mock)
    const controller = new AbortController()

    const buf = new ArrayBuffer(16)
    const loadPromise = client.load(buf, 'local-file', controller.signal)

    controller.abort()

    await assert.rejects(loadPromise, (err: Error) => {
      return err.name === 'AbortError'
    })
    assert.equal(client.sessionState, 'idle')
  })

  it('already-aborted signal rejects immediately', async () => {
    const mock = new MockWorkerPort()
    const client = createTestClient(mock)
    const controller = new AbortController()
    controller.abort()

    const buf = new ArrayBuffer(16)
    await assert.rejects(
      () => client.load(buf, 'local-file', controller.signal),
      (err: Error) => err.name === 'AbortError',
    )
  })

  it('worker error event rejects all pending', async () => {
    const mock = new MockWorkerPort()
    const client = createTestClient(mock)

    const buf = new ArrayBuffer(16)
    const loadPromise = client.load(buf, 'local-file')

    mock.triggerError('Worker crashed')

    await assert.rejects(loadPromise, (err: Error) => {
      return err.message.includes('Worker crashed')
    })
    assert.equal(client.sessionState, 'idle')
  })
  it('maximum one active file per session (second load cancels first)', async () => {
    const mock = new MockWorkerPort()
    const client = createTestClient(mock)

    const buf1 = new ArrayBuffer(16)
    const load1 = client.load(buf1, 'local-file')

    const buf2 = new ArrayBuffer(16)
    const load2 = client.load(buf2, 'local-file')

    // First load must be rejected
    await assert.rejects(load1)

    // Resolve second
    const reqId = mock.lastLoadRequestId()!
    mock.respond({ type: 'loaded', requestId: reqId, dataset: makeMockDataset() })
    await load2

    assert.equal(client.sessionState, 'ready')
  })
})
