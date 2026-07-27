import { ULog, MessageType, LogLevel } from '@foxglove/ulog'
import type { Filelike } from '@foxglove/ulog'
import type { Field } from '@foxglove/ulog'
import { normalizeUlogBuffer } from './normalizeUlogBuffer.js'
import { expandFieldPaths, isNumericType } from './fieldPaths.js'
import type {
  UlogTopicCatalogEntry,
  UlogFieldCatalogEntry,
  CoverageSummary,
  UlogMetadata,
  ParameterEntry,
  LogEvent,
  TimelineSummary,
  NormalizedUlogBuffer,
} from '../types.js'

/**
 * Minimal Filelike implementation for reading from an in-memory ArrayBuffer.
 */
class BufferReader implements Filelike {
  private data: Uint8Array
  constructor(buffer: ArrayBuffer) {
    this.data = new Uint8Array(buffer)
  }
  async open(): Promise<number> {
    return this.data.byteLength
  }
  size(): number {
    return this.data.byteLength
  }
  async read(offset: number, length: number): Promise<Uint8Array> {
    return this.data.slice(offset, offset + length)
  }
}

/**
 * Decode a ULog information value that may be a string or Uint8Array.
 */
function decodeInfoValue(value: unknown): string | number | boolean | bigint {
  if (value instanceof Uint8Array) {
    return new TextDecoder().decode(value)
  }
  if (typeof value === 'string') {
    // Strip trailing null terminators from ULog char arrays
    return value.replace(/\0+$/, '')
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return value
  }
  return String(value)
}

/**
 * Extract the field name from a raw ULog information key.
 * E.g. "char sys_name" → "sys_name", "char[10] ver_sw" → "ver_sw"
 */
function extractFieldNameFromKey(key: string): string {
  const spaceIdx = key.indexOf(' ')
  return spaceIdx >= 0 ? key.slice(spaceIdx + 1) : key
}

/**
 * UlogDocument wraps a parsed ULog file and provides structured access to
 * metadata, topic catalog, parameters, events, timeline, and coverage.
 */
export class UlogDocument {
  private ulog: ULog
  private normalized: NormalizedUlogBuffer
  private _catalog: UlogTopicCatalogEntry[]
  private _metadata: UlogMetadata
  private _coverage: CoverageSummary
  private _parameters: ParameterEntry[]
  private _events: LogEvent[]
  private _timeline: TimelineSummary

  private constructor(normalized: NormalizedUlogBuffer, ulog: ULog) {
    this.normalized = normalized
    this.ulog = ulog
    this._catalog = []
    this._metadata = {
      version: 0,
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
      logDuration: 0,
      hadAppendedData: false,
      warnings: [],
    }
    this._coverage = {
      discoveredTopicInstances: 0,
      analyzedTopicInstances: 0,
      rawOnlyTopicInstances: 0,
      unsupportedTopicInstances: 0,
      discoveredFields: 0,
      plottableFields: 0,
      warnings: [],
    }
    this._parameters = []
    this._events = []
    this._timeline = {
      logStartSec: 0,
      logEndSec: 0,
      armedStartSec: null,
      armedEndSec: null,
      takeoffSec: null,
      landSec: null,
      modeChanges: [],
      dropoutCount: 0,
      dropoutTotalMs: 0,
      dropoutMaxMs: 0,
      dropoutMeanMs: 0,
    }
  }

  /**
   * Open a ULog buffer and build the full document (catalog, metadata, etc.).
   */
  static async open(buffer: ArrayBuffer): Promise<UlogDocument> {
    const normalized = normalizeUlogBuffer(buffer)
    const reader = new BufferReader(normalized.buffer)
    const ulog = new ULog(reader)
    await ulog.open()

    const doc = new UlogDocument(normalized, ulog)
    await doc.build()
    return doc
  }

  get catalog(): readonly UlogTopicCatalogEntry[] {
    return this._catalog
  }
  get metadata(): UlogMetadata {
    return this._metadata
  }
  get coverage(): CoverageSummary {
    return this._coverage
  }
  get parameters(): readonly ParameterEntry[] {
    return this._parameters
  }
  get events(): readonly LogEvent[] {
    return this._events
  }
  get timeline(): TimelineSummary {
    return this._timeline
  }
  get rawUlog(): ULog {
    return this.ulog
  }

  private async build(): Promise<void> {
    this.buildMetadata()
    this.buildParameters()
    await this.buildSinglePass()
    this.buildCoverage()
  }

  // ── Metadata ──────────────────────────────────────────────────────────────

  private buildMetadata(): void {
    const header = this.ulog.header
    if (!header) return

    const info: Record<string, unknown> = {}
    const multiInfo: Array<Record<string, unknown>> = []

    // Information messages — stored under field name (e.g. "sys_name")
    for (const [key, value] of header.information) {
      const decoded = decodeInfoValue(value)
      info[key] = decoded

      // If the value is an array (from multi-info), also populate multiInformation
      if (Array.isArray(value)) {
        const entry: Record<string, unknown> = {}
        entry[key] = value.map((v: unknown) => decodeInfoValue(v))
        multiInfo.push(entry)
      }
    }

    // Multi-information messages — stored under raw key (e.g. "char ver_multi")
    // due to a library quirk. Handle both key formats.
    for (const [rawKey, value] of header.information) {
      if (Array.isArray(value)) {
        const fieldName = extractFieldNameFromKey(rawKey)
        // Only add if not already captured via field-name key above
        const alreadyCaptured = multiInfo.some(
          (entry) => fieldName in entry || rawKey in entry,
        )
        if (!alreadyCaptured) {
          const entry: Record<string, unknown> = {}
          entry[rawKey] = value.map((v: unknown) => decodeInfoValue(v))
          multiInfo.push(entry)
        }
      }
    }

    const vehicleType = this.extractInfoString(info, 'sys_name')
    const firmwareVersion = this.extractInfoString(info, 'ver_sw')
    const hardwareVersion = this.extractInfoString(info, 'ver_hw')
    const vehicleUuid = this.extractInfoString(info, 'sys_uuid')

    let logDuration = 0
    const timeRange = this.ulog.timeRange()
    if (timeRange) {
      logDuration = Number(timeRange[1] - timeRange[0]) / 1_000_000
    }

    this._metadata = {
      version: header.version,
      timestamp:
        header.timestamp !== 0n ? Number(header.timestamp) / 1_000_000 : null,
      utcTimeSec: null,
      vehicleType,
      vehicleUuid,
      airframeName: null,
      firmwareVersion,
      hardwareVersion,
      systemInfo: {},
      information: info,
      multiInformation: multiInfo,
      logDuration,
      hadAppendedData: this.normalized.hadAppendedData,
      warnings: [...this.normalized.warnings],
    }
  }

  private extractInfoString(
    info: Record<string, unknown>,
    key: string,
  ): string | null {
    const val = info[key]
    if (val == null) return null
    return String(val)
  }

  // ── Single-pass: catalog + events + timeline ───────────────────────────

  private async buildSinglePass(): Promise<void> {
    const header = this.ulog.header
    if (!header) return

    const msgCounts = this.ulog.dataMessageCounts() ?? new Map<number, number>()
    const logStart = this.ulog.timeRange()?.[0] ?? 0n
    const logEnd = this.ulog.timeRange()?.[1] ?? 0n

    // Per-topic timestamp tracking
    const topicTimestamps = new Map<number, { min: bigint; max: bigint }>()
    const dropouts: number[] = []

    // Single iteration over all data-section messages
    for await (const msg of this.ulog.readMessages()) {
      switch (msg.type) {
        case MessageType.Data: {
          const msgId = msg.msgId
          const ts = msg.value.timestamp
          const existing = topicTimestamps.get(msgId)
          if (existing) {
            if (ts < existing.min) existing.min = ts
            if (ts > existing.max) existing.max = ts
          } else {
            topicTimestamps.set(msgId, { min: ts, max: ts })
          }
          break
        }
        case MessageType.Log:
          this._events.push({
            timeSec: Number(msg.timestamp - logStart) / 1_000_000,
            level: mapLogLevel(msg.logLevel),
            tag: null,
            message: msg.message,
            isStructured: false,
            eventId: null,
            arguments: null,
            metadataAvailable: false,
          })
          break
        case MessageType.LogTagged:
          this._events.push({
            timeSec: Number(msg.timestamp - logStart) / 1_000_000,
            level: mapLogLevel(msg.logLevel),
            tag: String(msg.tag),
            message: msg.message,
            isStructured: false,
            eventId: null,
            arguments: null,
            metadataAvailable: false,
          })
          break
        case MessageType.Dropout:
          dropouts.push(msg.duration)
          break
      }
    }

    // Build catalog from subscriptions + collected timestamps
    for (const [msgId, subscription] of this.ulog.subscriptions) {
      const fields: UlogFieldCatalogEntry[] = []

      for (const field of subscription.fields) {
        // Reconstruct the full type string for expandFieldPaths
        const fullType =
          field.arrayLength != null
            ? `${field.type}[${field.arrayLength}]`
            : field.type
        const paths = expandFieldPaths(fullType, field.name)
        const plottable = isNumericType(fullType)

        for (const path of paths) {
          fields.push({
            path,
            type: fullType,
            arrayLength: field.arrayLength ?? null,
            unit: null,
            plottable,
          })
        }
      }

      const sampleCount = msgCounts.get(msgId) ?? 0
      const tsRange = topicTimestamps.get(msgId)

      this._catalog.push({
        name: subscription.name,
        multiId: subscription.multiId,
        msgId,
        sampleCount,
        firstTimeSec: tsRange
          ? Number(tsRange.min - logStart) / 1_000_000
          : null,
        lastTimeSec: tsRange
          ? Number(tsRange.max - logStart) / 1_000_000
          : null,
        fields,
        consumedBy: [],
        warnings: [],
      })
    }

    // Build timeline
    const totalMs = dropouts.reduce((s, d) => s + d, 0)
    const maxMs = dropouts.length > 0 ? Math.max(...dropouts) : 0

    this._timeline = {
      logStartSec: Number(logStart) / 1_000_000,
      logEndSec: Number(logEnd) / 1_000_000,
      armedStartSec: null,
      armedEndSec: null,
      takeoffSec: null,
      landSec: null,
      modeChanges: [],
      dropoutCount: dropouts.length,
      dropoutTotalMs: totalMs,
      dropoutMaxMs: maxMs,
      dropoutMeanMs: dropouts.length > 0 ? totalMs / dropouts.length : 0,
    }
  }

  // ── Parameters ────────────────────────────────────────────────────────────

  private buildParameters(): void {
    const header = this.ulog.header
    if (!header) return

    for (const [name, entry] of header.parameters) {
      const value: number | string =
        typeof entry.value === 'number' ? entry.value : Number(entry.value)

      this._parameters.push({
        name,
        value,
        defaultValue: entry.defaultTypes !== 0 ? value : null,
        airframeDefault: null,
        runtimeChanges: [],
      })
    }
  }

  // ── Coverage ──────────────────────────────────────────────────────────────

  private buildCoverage(): void {
    const discovered = this._catalog.length

    let totalFields = 0
    let plottableCount = 0
    for (const entry of this._catalog) {
      totalFields += entry.fields.length
      plottableCount += entry.fields.filter((f) => f.plottable).length
    }

    const warnings: string[] = [...this.normalized.warnings]

    // Warn about subscribed topics with no data
    for (const entry of this._catalog) {
      if (entry.sampleCount === 0) {
        warnings.push(
          `主题 ${entry.name}（消息 ID=${entry.msgId}，实例 ID=${entry.multiId}）没有数据采样`,
        )
      }
    }

    this._coverage = {
      discoveredTopicInstances: discovered,
      analyzedTopicInstances: 0,
      rawOnlyTopicInstances: discovered,
      unsupportedTopicInstances: 0,
      discoveredFields: totalFields,
      plottableFields: plottableCount,
      warnings,
    }
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function mapLogLevel(
  level: LogLevel,
): 'info' | 'warning' | 'error' | 'critical' | 'debug' {
  switch (level) {
    case LogLevel.Emerg:
    case LogLevel.Alert:
    case LogLevel.Crit:
      return 'critical'
    case LogLevel.Err:
      return 'error'
    case LogLevel.Warning:
      return 'warning'
    case LogLevel.Debug:
      return 'debug'
    case LogLevel.Info:
    case LogLevel.Notice:
    default:
      return 'info'
  }
}
