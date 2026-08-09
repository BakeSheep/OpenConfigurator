export type StructuredLogFormat = 'ulog' | 'dataflash'

export type StructuredJsonPrimitive = string | number | boolean | null
export type StructuredJsonValue =
  | StructuredJsonPrimitive
  | StructuredJsonValue[]
  | { [key: string]: StructuredJsonValue }

export interface RandomAccessLogSource {
  name: string
  size: number
  read(offset: number, length: number): Promise<Uint8Array>
  chunks(chunkSize?: number): AsyncIterable<Uint8Array>
}

export interface StructuredLogFieldSchema {
  name: string
  type: string
  arrayLength?: number
  nestedType?: string
  unit: string | null
  multiplier: number | null
  encoding?: 'utf-8' | 'base64' | 'decimal-string' | 'special-number'
}

export interface StructuredLogStreamSchema {
  streamId: string
  sourceFormat: StructuredLogFormat
  sourceName: string
  sourceMessageId: number | string
  sourceInstance: number | string | null
  revision: number
  instanceField: string | null
  fields: StructuredLogFieldSchema[]
}

export interface StructuredLogRecord {
  seq: number
  streamId: string
  schemaRevision: number
  bootId: number
  timeUs: string | null
  elapsedUs: string | null
  utc: string | null
  sourceInstance: number | string | null
  data: Record<string, StructuredJsonValue>
}

export interface StructuredLogEvent {
  seq: number
  bootId: number
  timeUs: string | null
  elapsedUs: string | null
  utc: string | null
  type: string
  level: number | null
  source: string
  message?: string
  data?: Record<string, StructuredJsonValue>
}

export interface StructuredLogParameter {
  seq: number
  bootId: number
  timeUs: string | null
  name: string
  value: StructuredJsonValue
  kind: 'initial' | 'default' | 'change'
  defaultTypes?: number
}

export interface StructuredLogIntegrityIssue {
  code: string
  severity: 'warning' | 'error'
  message: string
  offset?: number
  count?: number
  data?: Record<string, StructuredJsonValue>
}

export interface StructuredLogDecoderMetadata {
  format: StructuredLogFormat
  information: Record<string, StructuredJsonValue>
  streamCount: number
  recordCount: number
  eventCount: number
  parameterCount: number
  bootCount: number
  firstTimeUs: string | null
  lastTimeUs: string | null
}

export type StructuredLogEnvelope =
  | { kind: 'schema'; schema: StructuredLogStreamSchema }
  | { kind: 'record'; record: StructuredLogRecord }
  | { kind: 'event'; event: StructuredLogEvent }
  | { kind: 'parameter'; parameter: StructuredLogParameter }
  | { kind: 'integrity'; issue: StructuredLogIntegrityIssue }
  | { kind: 'complete'; metadata: StructuredLogDecoderMetadata }

export interface StructuredLogDecodeOptions {
  signal?: AbortSignal
  onProgress?: (progress: StructuredLogProgress) => void
}

export interface StructuredFlightLogDecoder {
  readonly format: StructuredLogFormat
  decode(
    source: RandomAccessLogSource,
    options?: StructuredLogDecodeOptions,
  ): AsyncIterable<StructuredLogEnvelope>
}

export interface StructuredLogProgress {
  phase: 'hashing' | 'scanning' | 'parsing' | 'decoding' | 'compressing' | 'writing'
  processedBytes: number
  totalBytes: number
}

export interface StructuredFlightLogExportOptions {
  includeSource: boolean
  privacyMode: 'full'
}

export interface StructuredFlightLogManifestV1 {
  schemaVersion: 'openconfigurator.flight-log/v1'
  createdAt: string
  generator: { name: 'OpenConfigurator'; version: string }
  source: {
    name: string
    format: StructuredLogFormat
    sizeBytes: number
    sha256: string
    included: boolean
  }
  vehicle: {
    family: 'px4' | 'ardupilot'
    vehicleClass: string | null
    firmware: string | null
    hardware: string | null
    systemName: string | null
  }
  time: {
    bootCount: number
    boots: Array<{
      bootId: number
      firstTimeUs: string | null
      lastTimeUs: string | null
    }>
    firstTimeUs: string | null
    lastTimeUs: string | null
    startTimeUtc: string | null
    endTimeUtc: string | null
  }
  privacy: {
    mode: 'full'
    contains: {
      location: boolean
      deviceIdentifiers: boolean
      textMessages: boolean
      parameters: boolean
    }
  }
  integrity: {
    status: 'complete' | 'partial'
    issues: StructuredLogIntegrityIssue[]
  }
  counts: {
    streams: number
    records: number
    events: number
    parameters: number
  }
  entries: string[]
}
