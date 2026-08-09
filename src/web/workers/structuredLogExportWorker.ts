/// <reference lib="webworker" />
import type { VehicleIdentity } from '../../shared/types'
import type { StructuredFlightLogExportOptions, StructuredLogProgress } from '../../shared/logs'
import type { UlogAnalysisDataset } from '../utils/ulogAnalysis'
import { BlobLogSource } from '../../shared/logs'
import { createStructuredFlightLogPackage } from '../utils/structuredLogExport'

export interface ExportWorkerRequest {
  source: Blob
  name: string
  format: 'ulog' | 'dataflash'
  summary: UlogAnalysisDataset
  vehicleIdentity: VehicleIdentity | null
  options: StructuredFlightLogExportOptions
  output?: WritableStream<Uint8Array>
}

export type ExportWorkerResponse =
  | { type: 'progress'; progress: StructuredLogProgress }
  | { type: 'done'; blob: Blob | null; manifestStatus: 'complete' | 'partial' }
  | { type: 'error'; error: string; errorName: string }

const worker = self as unknown as DedicatedWorkerGlobalScope

worker.onmessage = (event: MessageEvent<ExportWorkerRequest>) => {
  void (async () => {
    try {
      const result = await createStructuredFlightLogPackage({
        source: new BlobLogSource(event.data.name, event.data.source),
        format: event.data.format,
        summary: event.data.summary,
        vehicleIdentity: event.data.vehicleIdentity,
        options: event.data.options,
        output: event.data.output,
        onProgress: (progress) => worker.postMessage({ type: 'progress', progress } satisfies ExportWorkerResponse),
      })
      worker.postMessage({
        type: 'done',
        blob: result.blob,
        manifestStatus: result.manifest.integrity.status,
      } satisfies ExportWorkerResponse)
    } catch (error) {
      worker.postMessage({
        type: 'error',
        error: error instanceof Error ? error.message : String(error),
        errorName: error instanceof Error ? error.name : 'Error',
      } satisfies ExportWorkerResponse)
    }
  })()
}
