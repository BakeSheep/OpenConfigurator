export type AnalysisSectionId =
  | 'overview'
  | 'control'
  | 'estimator'
  | 'sensors-power'
  | 'navigation'
  | 'events-raw'

export type FindingSeverity = 'critical' | 'warning' | 'notice' | 'healthy'
export type FindingConfidence = 'measured' | 'derived' | 'heuristic'

export interface TopicInstanceKey {
  name: string
  multiId: number
  msgId: number
}

export interface UlogFieldCatalogEntry {
  path: string
  type: string
  arrayLength: number | null
  unit: string | null
  plottable: boolean
}

export interface UlogTopicCatalogEntry extends TopicInstanceKey {
  sampleCount: number
  firstTimeSec: number | null
  lastTimeSec: number | null
  fields: UlogFieldCatalogEntry[]
  consumedBy: string[]
  warnings: string[]
}

export interface CoverageSummary {
  discoveredTopicInstances: number
  analyzedTopicInstances: number
  rawOnlyTopicInstances: number
  unsupportedTopicInstances: number
  discoveredFields: number
  plottableFields: number
  warnings: string[]
}

export interface DiagnosticEvidence {
  topic: string
  multiId: number
  fields: string[]
  startSec: number | null
  endSec: number | null
  observed: string
  threshold: string | null
}

export interface DiagnosticFinding {
  id: string
  moduleId: string
  section: AnalysisSectionId
  severity: FindingSeverity
  confidence: FindingConfidence
  title: string
  summary: string
  recommendation: string | null
  evidence: DiagnosticEvidence[]
}

export interface RawSeriesQuery {
  topic: string
  multiId: number
  fields: string[]
  startSec?: number
  endSec?: number
  pointBudget?: number
}

export interface RawSeriesResult {
  topic: string
  multiId: number
  series: Array<{
    field: string
    times: number[]
    values: number[]
  }>
  truncated: boolean
  originalSampleCount: number
}

export type LogSource = 'local-file' | 'flight-download' | 'fc-import'

export interface UlogMetadata {
  version: number
  timestamp: number | null
  utcTimeSec: number | null
  vehicleType: string | null
  vehicleUuid: string | null
  airframeName: string | null
  firmwareVersion: string | null
  hardwareVersion: string | null
  systemInfo: Record<string, string>
  information: Record<string, unknown>
  multiInformation: Array<Record<string, unknown>>
  logDuration: number
  hadAppendedData: boolean
  warnings: string[]
}

export interface ParameterEntry {
  name: string
  value: number | string
  defaultValue: number | string | null
  airframeDefault: number | string | null
  runtimeChanges: Array<{ timeSec: number; value: number | string }>
}

export interface LogEvent {
  timeSec: number
  level: 'info' | 'warning' | 'error' | 'critical' | 'debug'
  tag: string | null
  message: string
  isStructured: boolean
  eventId: number | null
  arguments: unknown[] | null
  metadataAvailable: boolean
}

export interface TimelineSummary {
  logStartSec: number
  logEndSec: number
  armedStartSec: number | null
  armedEndSec: number | null
  takeoffSec: number | null
  landSec: number | null
  modeChanges: Array<{ timeSec: number; mode: string }>
  dropoutCount: number
  dropoutTotalMs: number
  dropoutMaxMs: number
  dropoutMeanMs: number
}

/** Per-module output preserved inside a section (module identity is kept). */
export interface SectionModuleResult {
  moduleId: string
  available: boolean
  missingRequirements: string[]
  warnings: string[]
  consumedTopics: TopicInstanceKey[]
  metrics: Record<string, unknown>
}

export interface SectionResult {
  section: AnalysisSectionId
  available: boolean
  moduleResults: SectionModuleResult[]
  chartFamilies: ChartFamily[]
  findings: DiagnosticFinding[]
  warnings: string[]
}

export interface ChartSeriesGroup {
  id: string
  title: string
  description: string
  unit: string
  series: Array<{
    label: string
    times: number[]
    values: number[]
    color?: string
  }>
  thresholds?: Array<{ value: number; label: string; severity: FindingSeverity }>
  hasGaps: boolean
}

// ─── Chart families (selector-driven presentation contract) ───────────────

export interface ThresholdSpec {
  value: number
  label: string
  severity: FindingSeverity
}

export interface ChartSeries {
  /** Stable series identity — labels alone are not identity */
  id: string
  label: string
  times: number[]
  values: number[]
  color?: string
}

export interface ChartView {
  id: string
  title: string
  description: string
  unit: string
  series: ChartSeries[]
  defaultVisibleSeriesIds: string[]
  thresholds?: ThresholdSpec[]
  xAxis: 'time' | 'frequency' | 'category'
  hasGaps: boolean
}

export interface ChartFamily {
  id: string
  moduleId: string
  title: string
  description: string
  views: ChartView[]
  defaultViewId: string
  order: number
}

export interface UlogAnalysisDataset {
  metadata: UlogMetadata
  catalog: UlogTopicCatalogEntry[]
  coverage: CoverageSummary
  findings: DiagnosticFinding[]
  parameters: ParameterEntry[]
  events: LogEvent[]
  sections: Partial<Record<AnalysisSectionId, SectionResult>>
  timeline: TimelineSummary
}

export interface NormalizedUlogBuffer {
  buffer: ArrayBuffer
  version: number
  hadAppendedData: boolean
  appendedSectionCount: number
  repairedTruncatedTail: boolean
  warnings: string[]
}
