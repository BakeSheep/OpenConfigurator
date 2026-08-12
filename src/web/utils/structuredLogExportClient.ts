import type { StructuredFlightLogExportOptions, StructuredLogProgress } from '../../shared/logs'
import type { VehicleIdentity } from '../../shared/types'
import type { UlogAnalysisDataset } from './ulogAnalysis'

export const MAX_BLOB_EXPORT_SOURCE_BYTES = 64 * 1024 * 1024

export function canUseBlobExportFallback(sourceSize: number): boolean {
  return sourceSize <= MAX_BLOB_EXPORT_SOURCE_BYTES
}

export interface StructuredLogExportRequest {
  source: Blob
  name: string
  format: 'ulog' | 'dataflash'
  summary: UlogAnalysisDataset
  vehicleIdentity: VehicleIdentity | null
  options: StructuredFlightLogExportOptions
  output?: WritableStream<Uint8Array>
}

type ExportWorkerResponse =
  | { type: 'progress'; progress: StructuredLogProgress }
  | { type: 'done'; blob: Blob | null; manifestStatus: 'complete' | 'partial' }
  | { type: 'error'; error: string; errorName: string }

export interface StructuredLogExportTask {
  result: Promise<{ blob: Blob | null; manifestStatus: 'complete' | 'partial' }>
  cancel: () => void
}

export function startStructuredLogExport(
  request: StructuredLogExportRequest,
  onProgress: (progress: StructuredLogProgress) => void,
): StructuredLogExportTask {
  const worker = new Worker(new URL('../workers/structuredLogExportWorker.ts', import.meta.url), { type: 'module' })
  let settled = false
  let rejectPromise: ((reason: Error) => void) | null = null
  const cleanup = () => worker.terminate()
  const result = new Promise<{ blob: Blob | null; manifestStatus: 'complete' | 'partial' }>((resolve, reject) => {
    rejectPromise = reject
    worker.onmessage = (event: MessageEvent<ExportWorkerResponse>) => {
      if (event.data.type === 'progress') {
        onProgress(event.data.progress)
        return
      }
      if (settled) return
      settled = true
      cleanup()
      if (event.data.type === 'done') resolve(event.data)
      else {
        const error = new Error(event.data.error)
        error.name = event.data.errorName
        reject(error)
      }
    }
    worker.onerror = (event) => {
      if (settled) return
      settled = true
      cleanup()
      reject(new Error(event.message || 'Structured log export worker failed'))
    }
    try {
      const transfer = request.output ? [request.output as unknown as Transferable] : []
      worker.postMessage(request, transfer)
    } catch (error) {
      settled = true
      cleanup()
      reject(error instanceof Error ? error : new Error(String(error)))
    }
  })
  return {
    result,
    cancel: () => {
      if (settled) return
      settled = true
      cleanup()
      const error = new Error('Structured log export cancelled')
      error.name = 'AbortError'
      rejectPromise?.(error)
    },
  }
}
