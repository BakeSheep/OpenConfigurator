import type { UlogAnalysisDataset, RawSeriesQuery, RawSeriesResult, LogSource } from './types.js'

export type WorkerRequest =
  | { type: 'load'; requestId: string; buffer: ArrayBuffer; source: LogSource }
  | { type: 'get_series'; requestId: string; query: RawSeriesQuery }
  | { type: 'cancel'; requestId: string; targetRequestId: string }
  | { type: 'dispose'; requestId: string }

export type WorkerResponse =
  | { type: 'progress'; requestId: string; phase: string; fraction: number }
  | { type: 'loaded'; requestId: string; dataset: UlogAnalysisDataset }
  | { type: 'series'; requestId: string; result: RawSeriesResult }
  | { type: 'error'; requestId: string; error: WorkerErrorData }
  | { type: 'disposed'; requestId: string }

export interface WorkerErrorData {
  code: 'invalid_file' | 'unsupported_version' | 'encrypted' | 'out_of_memory' | 'canceled' | 'module_error' | 'corrupt_topic' | 'unknown'
  message: string
  requestId?: string
}

export type SessionState = 'idle' | 'loading' | 'ready' | 'disposed'
