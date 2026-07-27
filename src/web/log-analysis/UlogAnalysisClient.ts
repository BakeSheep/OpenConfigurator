import type { UlogAnalysisDataset, RawSeriesQuery, RawSeriesResult, LogSource } from './types.js'
import type { WorkerRequest, WorkerResponse, SessionState, WorkerErrorData } from './workerProtocol.js'

/**
 * Error thrown by UlogAnalysisClient with a machine-readable error code.
 */
export class UlogAnalysisError extends Error {
  readonly code: WorkerErrorData['code']
  constructor(code: WorkerErrorData['code'], message: string) {
    super(message)
    this.name = 'UlogAnalysisError'
    this.code = code
  }
}

/**
 * Minimal Worker-like surface used by UlogAnalysisClient.
 * Allows injecting a mock in tests without a real Web Worker.
 */
export interface WorkerPort {
  postMessage(msg: unknown, transfer?: Transferable[]): void
  onmessage: ((e: MessageEvent<WorkerResponse>) => void) | null
  onerror: ((message: string) => void) | null
  terminate(): void
}

export type WorkerFactory = () => WorkerPort

interface PendingRequest {
  resolve: (value: any) => void
  reject: (reason: unknown) => void
  signal?: AbortSignal
  abortHandler?: () => void
}

let idCounter = 0
function generateRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  // Fallback for environments without crypto.randomUUID
  return `req-${Date.now()}-${++idCounter}`
}

export class UlogAnalysisClient {
  private worker: WorkerPort
  private pendingRequests = new Map<string, PendingRequest>()
  private state: SessionState = 'idle'
  private activeLoadId: string | null = null
  private onProgress?: (phase: string, fraction: number) => void

  constructor(workerFactory: WorkerFactory, onProgress?: (phase: string, fraction: number) => void) {
    this.worker = workerFactory()
    this.worker.onmessage = this.handleMessage.bind(this)
    this.worker.onerror = this.handleError.bind(this)
    this.onProgress = onProgress
  }

  get sessionState(): SessionState {
    return this.state
  }

  async load(buffer: ArrayBuffer, source: LogSource, signal?: AbortSignal): Promise<UlogAnalysisDataset> {
    if (this.state === 'disposed') throw new Error('Session disposed')

    // Cancel any in-flight load
    if (this.state === 'loading' && this.activeLoadId) {
      this.sendCancel(this.activeLoadId)
      // Reject the old load promise
      const oldPending = this.pendingRequests.get(this.activeLoadId)
      if (oldPending) {
        this.pendingRequests.delete(this.activeLoadId)
        if (oldPending.signal && oldPending.abortHandler) {
          oldPending.signal.removeEventListener('abort', oldPending.abortHandler)
        }
        oldPending.reject(new DOMException('Superseded by new load', 'AbortError'))
      }
    }

    const requestId = generateRequestId()
    this.state = 'loading'
    this.activeLoadId = requestId

    return new Promise<UlogAnalysisDataset>((resolve, reject) => {
      const pending: PendingRequest = { resolve, reject, signal }

      if (signal) {
        const abortHandler = () => {
          this.sendCancel(requestId)
          this.pendingRequests.delete(requestId)
          if (this.activeLoadId === requestId) {
            this.state = 'idle'
            this.activeLoadId = null
          }
          reject(new DOMException('Load canceled', 'AbortError'))
        }
        pending.abortHandler = abortHandler
        if (signal.aborted) {
          abortHandler()
          return
        }
        signal.addEventListener('abort', abortHandler, { once: true })
      }

      this.pendingRequests.set(requestId, pending)
      this.worker.postMessage(
        { type: 'load', requestId, buffer, source } satisfies WorkerRequest,
        [buffer],
      )
    })
  }

  async getSeries(query: RawSeriesQuery, signal?: AbortSignal): Promise<RawSeriesResult> {
    if (this.state === 'disposed') throw new Error('Session disposed')
    if (this.state !== 'ready') throw new Error('Session not ready; call load() first')

    const requestId = generateRequestId()
    return new Promise<RawSeriesResult>((resolve, reject) => {
      const pending: PendingRequest = { resolve, reject, signal }

      if (signal) {
        const abortHandler = () => {
          this.sendCancel(requestId)
          this.pendingRequests.delete(requestId)
          reject(new DOMException('Query canceled', 'AbortError'))
        }
        pending.abortHandler = abortHandler
        if (signal.aborted) {
          abortHandler()
          return
        }
        signal.addEventListener('abort', abortHandler, { once: true })
      }

      this.pendingRequests.set(requestId, pending)
      this.worker.postMessage({
        type: 'get_series',
        requestId,
        query,
      } satisfies WorkerRequest)
    })
  }

  async dispose(): Promise<void> {
    if (this.state === 'disposed') return
    this.state = 'disposed'

    // Reject all pending requests
    for (const [, pending] of this.pendingRequests) {
      if (pending.signal && pending.abortHandler) {
        pending.signal.removeEventListener('abort', pending.abortHandler)
      }
      pending.reject(new Error('Session disposed'))
    }
    this.pendingRequests.clear()
    this.activeLoadId = null

    const requestId = generateRequestId()
    try {
      this.worker.postMessage({ type: 'dispose', requestId } satisfies WorkerRequest)
    } catch {
      // Worker may already be terminated
    }
    this.worker.terminate()
  }

  private sendCancel(targetRequestId: string): void {
    try {
      this.worker.postMessage({
        type: 'cancel',
        requestId: generateRequestId(),
        targetRequestId: targetRequestId,
      } satisfies WorkerRequest)
    } catch {
      // Worker may be terminated
    }
  }

  private handleMessage(e: MessageEvent<WorkerResponse>): void {
    const msg = e.data

    // Progress events are not tied to a pending promise
    if (msg.type === 'progress') {
      this.onProgress?.(msg.phase, msg.fraction)
      return
    }

    const pending = this.pendingRequests.get(msg.requestId)
    if (!pending) {
      // Stale or unknown requestId — silently ignore
      return
    }
    this.pendingRequests.delete(msg.requestId)

    // Clean up abort listener
    if (pending.signal && pending.abortHandler) {
      pending.signal.removeEventListener('abort', pending.abortHandler)
    }

    switch (msg.type) {
      case 'loaded':
        this.state = 'ready'
        this.activeLoadId = null
        pending.resolve(msg.dataset)
        break
      case 'series':
        pending.resolve(msg.result)
        break
      case 'error':
        if (this.state === 'loading' && this.activeLoadId === msg.requestId) {
          this.state = 'idle'
          this.activeLoadId = null
        }
        pending.reject(new UlogAnalysisError(msg.error.code, msg.error.message))
        break
      case 'disposed':
        // Acknowledged; nothing to do
        break
    }
  }

  private handleError(message: string): void {
    // Worker-level error (e.g. uncaught exception). Reject all pending.
    const error = new Error(message || 'Worker error')
    for (const [, pending] of this.pendingRequests) {
      if (pending.signal && pending.abortHandler) {
        pending.signal.removeEventListener('abort', pending.abortHandler)
      }
      pending.reject(error)
    }
    this.pendingRequests.clear()
    if (this.state === 'loading') {
      this.state = 'idle'
      this.activeLoadId = null
    }
  }
}
