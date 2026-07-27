import type { AnalysisSectionId, TopicInstanceKey, DiagnosticFinding, ChartSeriesGroup } from '../types.js'

/** A resolved topic instance with its subscription info */
export interface ResolvedTopic {
  name: string
  multiId: number
  msgId: number
  /** Map of field path → field index in the message value */
  fieldMap: Map<string, string>
}

/** A sample from a resolved topic */
export interface ResolvedSample {
  topic: ResolvedTopic
  timeSec: number
  values: Record<string, number | string | boolean>
}

/** Context passed to modules during creation and finalization */
export interface AnalysisContext {
  /** All resolved topics for this module */
  resolvedTopics: Map<string, ResolvedTopic>
  /** Log start time in seconds (for relative time calculation) */
  logStartSec: number
  /** Log end time in seconds */
  logEndSec: number
  /** Log duration in seconds */
  logDuration: number
  /** All topic subscriptions from the document */
  allSubscriptions: Array<{ name: string; multiId: number; msgId: number }>
  /** Parameters from the document */
  parameters: Array<{ name: string; value: number | string }>
  /** Metadata from the document */
  metadata: {
    vehicleType: string | null
    firmwareVersion: string | null
    airframeName: string | null
  }
}

/** Topic requirement specification */
export interface TopicRequirement {
  /** Alias names to try in order (first match wins) */
  aliases: string[]
  /** Whether this topic is required (if false, module still runs but reports it as missing) */
  required: boolean
  /** Local name to bind this requirement to in the context */
  bindAs: string
  /** Optional: specific fields needed (if empty, all fields available) */
  fields?: string[]
  /** Whether to accept multiple instances */
  multiInstance?: boolean
}

/** Result from an analysis module */
export interface ModuleResult<TState = unknown, TResult = unknown> {
  /** Bounded chart series */
  chartSeries: ChartSeriesGroup[]
  /** Key metrics */
  metrics: Record<string, unknown>
  /** Diagnostic findings */
  findings: DiagnosticFinding[]
  /** Topic instances this module consumed */
  consumedTopics: TopicInstanceKey[]
  /** Missing requirements (topics not found in log) */
  missingRequirements: string[]
  /** Warnings from processing */
  warnings: string[]
  /** Module-specific typed result data */
  result: TResult
}

/** Analysis module interface */
export interface AnalysisModule<TState = unknown, TResult = unknown> {
  /** Unique module identifier */
  id: string
  /** Which UI section this module belongs to */
  section: AnalysisSectionId
  /** Topic requirements */
  requirements: TopicRequirement[]
  /** Create initial state */
  create(context: AnalysisContext): TState
  /** Process a single sample */
  consume(state: TState, sample: ResolvedSample, topicBindName: string): void
  /** Finalize and produce results */
  finalize(state: TState, context: AnalysisContext): ModuleResult<TState, TResult>
}
