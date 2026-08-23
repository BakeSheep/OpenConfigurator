import {
  MessageType,
  ULog,
  parseBasicFieldValue,
  parseFieldDefinition,
  type FieldStruct,
  type MessageDataParsed,
  type MessageDefinition,
} from '@foxglove/ulog'
import {
  toStructuredJson,
  type RandomAccessLogSource,
  type StructuredFlightLogDecoder,
  type StructuredJsonValue,
  type StructuredLogDecodeOptions,
  type StructuredLogEnvelope,
  type StructuredLogEvent,
  type StructuredLogFieldSchema,
  type StructuredLogIntegrityIssue,
  type StructuredLogParameter,
  type StructuredLogRecord,
  type StructuredLogStreamSchema,
} from './index'

const KNOWN_INCOMPATIBLE_FLAGS = 1 // appended data
const ULOG_MAV_PARAM_TYPES: Readonly<Record<string, number>> = {
  uint8_t: 1,
  int8_t: 2,
  uint16_t: 3,
  int16_t: 4,
  uint32_t: 5,
  int32_t: 6,
  uint64_t: 7,
  int64_t: 8,
  float: 9,
  double: 10,
  bool: 1,
}

async function assertCompatibleUlogSource(source: RandomAccessLogSource): Promise<void> {
  // ULog places the mandatory flag-bits message immediately after its
  // 16-byte file header. Check it before the third-party reader builds its
  // index so an unsupported file always produces a useful error.
  const prefix = await source.read(0, 59)
  if (prefix.length < 19 || prefix[18] !== MessageType.FlagBits) return
  const payloadLength = prefix[16] | (prefix[17] << 8)
  if (payloadLength !== 40 || prefix.length < 59) return
  for (let index = 0; index < 8; index++) {
    const value = prefix[27 + index]
    if ((index === 0 && (value & ~KNOWN_INCOMPATIBLE_FLAGS) !== 0) || (index > 0 && value !== 0)) {
      throw new Error(`ULog uses unsupported incompatible format flags (byte ${index}: ${value})`)
    }
  }
}
function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  const error = new Error('Structured log decoding cancelled')
  error.name = 'AbortError'
  throw error
}

function definitionFields(definition: MessageDefinition): StructuredLogFieldSchema[] {
  return definition.fields
    .filter((field) => !field.name.startsWith('_padding'))
    .map((field) => ({
      name: field.name,
      type: field.type,
      arrayLength: field.arrayLength,
      nestedType: field.isComplex ? field.type : undefined,
      unit: null,
      multiplier: null,
      encoding: field.type === 'char'
        ? 'utf-8'
        : field.type === 'int64_t' || field.type === 'uint64_t'
          ? 'decimal-string'
          : undefined,
    }))
}

function informationObject(
  values: Map<string, unknown>,
): Record<string, StructuredJsonValue> {
  return Object.fromEntries(
    [...values.entries()].map(([key, value]) => [key, toStructuredJson(value)]),
  )
}

function parseRuntimeParameter(raw: {
  key?: unknown
  value?: unknown
  defaultTypes?: unknown
}): { name: string; value: StructuredJsonValue; mavParamType?: number; defaultTypes: number } | null {
  if (typeof raw.key !== 'string' || !(raw.value instanceof Uint8Array)) return null
  const field = parseFieldDefinition(raw.key)
  if (!field || field.isComplex || field.arrayLength !== undefined) return null
  try {
    const view = new DataView(raw.value.buffer, raw.value.byteOffset, raw.value.byteLength)
    return {
      name: field.name,
      value: toStructuredJson(parseBasicFieldValue(field, view)),
      mavParamType: ULOG_MAV_PARAM_TYPES[field.type],
      defaultTypes: typeof raw.defaultTypes === 'number' ? raw.defaultTypes : 0,
    }
  } catch {
    return null
  }
}

interface ScannedUlogParameter {
  name: string
  value: StructuredJsonValue
  kind: StructuredLogParameter['kind']
  mavParamType?: number
  defaultTypes: number
}

async function scanUlogParameters(
  source: RandomAccessLogSource,
  options: StructuredLogDecodeOptions,
): Promise<{ parameters: ScannedUlogParameter[]; issues: StructuredLogIntegrityIssue[] }> {
  const parameters: ScannedUlogParameter[] = []
  const issues: StructuredLogIntegrityIssue[] = []
  const decoder = new TextDecoder('utf-8')
  let offset = 16
  let inDataSection = false
  const CHUNK_SIZE = 1024 * 1024
  let chunkStart = -1
  let chunk: Uint8Array<ArrayBufferLike> = new Uint8Array()
  const read = async (position: number, length: number): Promise<Uint8Array> => {
    if (position < chunkStart || position + length > chunkStart + chunk.length) {
      chunkStart = position
      chunk = await source.read(position, Math.max(CHUNK_SIZE, length))
      options.onProgress?.({
        phase: 'scanning',
        processedBytes: Math.min(source.size, position + chunk.length),
        totalBytes: source.size,
      })
    }
    const start = position - chunkStart
    return chunk.subarray(start, Math.min(chunk.length, start + length))
  }

  while (offset + 3 <= source.size) {
    throwIfAborted(options.signal)
    const header = await read(offset, 3)
    if (header.length < 3) break
    const payloadLength = header[0] | (header[1] << 8)
    const type = header[2]
    const frameLength = payloadLength + 3
    if (offset + frameLength > source.size) {
      issues.push({
        code: 'ulog_truncated_message', severity: 'warning', offset,
        message: `ULog ends inside message type ${type}`,
        data: { expectedBytes: frameLength, availableBytes: source.size - offset },
      })
      break
    }
    if (type === MessageType.AddLogged || type === MessageType.Data) inDataSection = true
    if (type === MessageType.Parameter || type === MessageType.ParameterDefault) {
      const payload = await read(offset + 3, payloadLength)
      const defaultTypes = type === MessageType.ParameterDefault ? payload[0] ?? 0 : 0
      const keyLengthOffset = type === MessageType.ParameterDefault ? 1 : 0
      const keyLength = payload[keyLengthOffset] ?? 0
      const valueOffset = keyLengthOffset + 1 + keyLength
      if (keyLength === 0 || valueOffset > payload.length) {
        issues.push({
          code: 'ulog_invalid_parameter', severity: 'warning', offset,
          message: 'ULog parameter message has an invalid key length',
        })
      } else {
        const parsed = parseRuntimeParameter({
          key: decoder.decode(payload.subarray(keyLengthOffset + 1, valueOffset)),
          value: payload.subarray(valueOffset),
          defaultTypes,
        })
        if (parsed) {
          parameters.push({
            ...parsed,
            kind: type === MessageType.ParameterDefault ? 'default' : inDataSection ? 'change' : 'initial',
          })
        }
      }
    }
    offset += frameLength
  }
  return { parameters, issues }
}

export class StructuredUlogDecoder implements StructuredFlightLogDecoder {
  readonly format = 'ulog' as const

  async *decode(
    source: RandomAccessLogSource,
    options: StructuredLogDecodeOptions = {},
  ): AsyncIterable<StructuredLogEnvelope> {
    await assertCompatibleUlogSource(source)
    const scanned = await scanUlogParameters(source, options)
    let furthestRead = 0
    const reader = {
      open: async () => source.size,
      size: () => source.size,
      read: async (offset: number, length: number) => {
        throwIfAborted(options.signal)
        const bytes = await source.read(offset, length)
        furthestRead = Math.max(furthestRead, offset + bytes.length)
        options.onProgress?.({
          phase: 'parsing',
          processedBytes: Math.min(source.size, furthestRead),
          totalBytes: source.size,
        })
        return bytes
      },
    }
    const ulog = new ULog(reader)
    await ulog.open()
    throwIfAborted(options.signal)

    const header = ulog.header
    if (!header) throw new Error('ULog header is unavailable')
    const unknownIncompatible = header.flagBits?.incompatibleFlags.reduce(
      (bits, byte, index) => bits | (index === 0 ? byte & ~KNOWN_INCOMPATIBLE_FLAGS : byte),
      0,
    ) ?? 0
    if (unknownIncompatible !== 0) {
      throw new Error('ULog uses unsupported incompatible format flags')
    }

    let seq = 0
    let recordCount = 0
    let eventCount = 0
    let parameterCount = 0
    const schemas = new Map<number, StructuredLogStreamSchema>()
    const timeRange = ulog.timeRange()
    const firstTimestamp = timeRange?.[0] ?? header.timestamp
    let lastTimestamp = firstTimestamp

    for (const [msgId, subscription] of ulog.subscriptions) {
      const schema: StructuredLogStreamSchema = {
        streamId: `px4:${subscription.name}:${subscription.multiId}`,
        sourceFormat: 'ulog',
        sourceName: subscription.name,
        sourceMessageId: msgId,
        sourceInstance: subscription.multiId,
        revision: 1,
        instanceField: null,
        fields: definitionFields(subscription),
      }
      schemas.set(msgId, schema)
      yield { kind: 'schema', schema }
    }

    for (const entry of scanned.parameters) {
      const parameter: StructuredLogParameter = {
        seq: seq++,
        bootId: 0,
        timeUs: entry.kind === 'change' ? null : header.timestamp.toString(),
        name: entry.name,
        value: entry.value,
        kind: entry.kind,
        mavParamType: entry.mavParamType,
        defaultTypes: entry.defaultTypes,
      }
      parameterCount++
      yield { kind: 'parameter', parameter }
    }
    for (const issue of scanned.issues) yield { kind: 'integrity', issue }

    for await (const message of ulog.readMessages()) {
      throwIfAborted(options.signal)
      const raw = message as unknown as Record<string, unknown> & { type: MessageType }
      if (message.type === MessageType.Data) {
        const dataMessage = message as MessageDataParsed
        const schema = schemas.get(dataMessage.msgId)
        if (!schema) continue
        const value = dataMessage.value as FieldStruct
        const timestamp = typeof value.timestamp === 'bigint'
          ? value.timestamp
          : BigInt(Math.trunc(Number(value.timestamp)))
        lastTimestamp = timestamp
        const record: StructuredLogRecord = {
          seq: seq++,
          streamId: schema.streamId,
          schemaRevision: schema.revision,
          bootId: 0,
          timeUs: timestamp.toString(),
          elapsedUs: (timestamp - firstTimestamp).toString(),
          utc: null,
          sourceInstance: schema.sourceInstance,
          data: toStructuredJson(value) as Record<string, StructuredJsonValue>,
        }
        recordCount++
        yield { kind: 'record', record }
        continue
      }

      if (message.type === MessageType.Log || message.type === MessageType.LogTagged) {
        const timestamp = raw.timestamp as bigint
        lastTimestamp = timestamp
        const event: StructuredLogEvent = {
          seq: seq++,
          bootId: 0,
          timeUs: timestamp.toString(),
          elapsedUs: (timestamp - firstTimestamp).toString(),
          utc: null,
          type: message.type === MessageType.LogTagged ? 'log-tagged' : 'log',
          level: Number(raw.logLevel),
          source: 'ulog',
          message: String(raw.message ?? ''),
          data: message.type === MessageType.LogTagged
            ? { tag: toStructuredJson(raw.tag) }
            : undefined,
        }
        eventCount++
        yield { kind: 'event', event }
        continue
      }

      let event: StructuredLogEvent | null = null
      let issue: StructuredLogIntegrityIssue | null = null
      if (message.type === MessageType.Dropout) {
        event = {
          seq: seq++, bootId: 0, timeUs: lastTimestamp.toString(),
          elapsedUs: (lastTimestamp - firstTimestamp).toString(), utc: null,
          type: 'dropout', level: 4, source: 'ulog',
          data: { durationMs: toStructuredJson(raw.duration) },
        }
        issue = {
          code: 'ulog_dropout', severity: 'warning',
          message: `ULog reports a ${String(raw.duration)} ms dropout`,
        }
      } else if (message.type === MessageType.AddLogged || message.type === MessageType.RemoveLogged) {
        event = {
          seq: seq++, bootId: 0, timeUs: lastTimestamp.toString(),
          elapsedUs: (lastTimestamp - firstTimestamp).toString(), utc: null,
          type: message.type === MessageType.AddLogged ? 'subscription-added' : 'subscription-removed',
          level: null, source: 'ulog', data: toStructuredJson(raw) as Record<string, StructuredJsonValue>,
        }
      } else if (message.type === MessageType.Unknown) {
        issue = {
          code: 'ulog_unknown_message', severity: 'warning',
          message: `Unknown compatible ULog message type ${String(raw.unknownType)}`,
          data: { payload: toStructuredJson(raw.data) },
        }
      }
      if (event) {
        eventCount++
        yield { kind: 'event', event }
      }
      if (issue) yield { kind: 'integrity', issue }
    }

    yield {
      kind: 'complete',
      metadata: {
        format: 'ulog',
        information: informationObject(header.information as Map<string, unknown>),
        streamCount: schemas.size,
        recordCount,
        eventCount,
        parameterCount,
        bootCount: 1,
        firstTimeUs: firstTimestamp.toString(),
        lastTimeUs: (timeRange?.[1] ?? lastTimestamp).toString(),
      },
    }
  }
}
