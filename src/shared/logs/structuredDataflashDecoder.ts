import {
  bytesToBase64,
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

const FRAME_HEAD_0 = 0xa3
const FRAME_HEAD_1 = 0x95
const FMT_MSG_ID = 0x80
const FMT_MSG_LENGTH = 89
const READ_CHUNK_SIZE = 1024 * 1024

interface FieldDescriptor {
  size: number
  multiplier: number | null
  type: string
  encoding?: StructuredLogFieldSchema['encoding']
}

const FIELD_DESCRIPTORS: Record<string, FieldDescriptor> = {
  a: { size: 64, multiplier: null, type: 'int16[32]' },
  b: { size: 1, multiplier: null, type: 'int8' },
  B: { size: 1, multiplier: null, type: 'uint8' },
  g: { size: 2, multiplier: null, type: 'float16' },
  h: { size: 2, multiplier: null, type: 'int16' },
  H: { size: 2, multiplier: null, type: 'uint16' },
  i: { size: 4, multiplier: null, type: 'int32' },
  I: { size: 4, multiplier: null, type: 'uint32' },
  f: { size: 4, multiplier: null, type: 'float32' },
  d: { size: 8, multiplier: null, type: 'float64' },
  q: { size: 8, multiplier: null, type: 'int64', encoding: 'decimal-string' },
  Q: { size: 8, multiplier: null, type: 'uint64', encoding: 'decimal-string' },
  c: { size: 2, multiplier: 1e-2, type: 'int16' },
  C: { size: 2, multiplier: 1e-2, type: 'uint16' },
  e: { size: 4, multiplier: 1e-2, type: 'int32' },
  E: { size: 4, multiplier: 1e-2, type: 'uint32' },
  L: { size: 4, multiplier: 1e-7, type: 'int32' },
  M: { size: 1, multiplier: null, type: 'uint8' },
  n: { size: 4, multiplier: null, type: 'char[4]', encoding: 'utf-8' },
  N: { size: 16, multiplier: null, type: 'char[16]', encoding: 'utf-8' },
  Z: { size: 64, multiplier: null, type: 'char[64]', encoding: 'utf-8' },
}

interface DataflashFormat {
  type: number
  length: number
  name: string
  format: string
  columns: string[]
  offsets: number[]
  revision: number
  decodable: boolean
  unitIds: string | null
  multIds: string | null
  instanceField: string | null
  schema: StructuredLogStreamSchema
}

function abortError(): Error {
  const error = new Error('Structured log decoding cancelled')
  error.name = 'AbortError'
  return error
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError()
}

class SequentialSourceReader {
  position = 0
  private bufferStart = 0
  private buffer: Uint8Array<ArrayBufferLike> = new Uint8Array()
  private furthestRead = 0

  constructor(
    private readonly source: RandomAccessLogSource,
    private readonly options: StructuredLogDecodeOptions,
  ) {}

  async peek(length: number): Promise<Uint8Array> {
    throwIfAborted(this.options.signal)
    const bufferEnd = this.bufferStart + this.buffer.length
    if (this.position < this.bufferStart || this.position + length > bufferEnd) {
      this.bufferStart = this.position
      this.buffer = await this.source.read(this.position, Math.max(READ_CHUNK_SIZE, length))
      this.furthestRead = Math.max(this.furthestRead, this.position + this.buffer.length)
      this.options.onProgress?.({
        phase: 'parsing',
        processedBytes: Math.min(this.source.size, this.furthestRead),
        totalBytes: this.source.size,
      })
    }
    const offset = this.position - this.bufferStart
    return this.buffer.subarray(offset, Math.min(this.buffer.length, offset + length))
  }

  advance(length: number): void {
    this.position = Math.min(this.source.size, this.position + length)
  }
}
function readAscii(bytes: Uint8Array, start: number, length: number): string {
  const endLimit = Math.min(bytes.length, start + length)
  let end = start
  while (end < endLimit && bytes[end] !== 0) end++
  let output = ''
  for (let index = start; index < end; index++) output += String.fromCharCode(bytes[index])
  return output
}

function halfFloat(value: number): number {
  const sign = (value & 0x8000) !== 0 ? -1 : 1
  const exponent = (value >>> 10) & 0x1f
  const fraction = value & 0x3ff
  if (exponent === 0) return sign * fraction * 2 ** -24
  if (exponent === 0x1f) return fraction === 0 ? sign * Infinity : NaN
  return sign * (1 + fraction / 1024) * 2 ** (exponent - 15)
}

function decodeTextOrBytes(bytes: Uint8Array): StructuredJsonValue {
  let end = bytes.indexOf(0)
  if (end < 0) end = bytes.length
  const value = bytes.subarray(0, end)
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(value)
  } catch {
    return { $binary: bytesToBase64(bytes), encoding: 'base64' }
  }
}

function readField(
  view: DataView,
  bytes: Uint8Array,
  offset: number,
  code: string,
  messageName: string,
  fieldName: string,
): StructuredJsonValue {
  switch (code) {
    case 'a': {
      const values: number[] = []
      for (let index = 0; index < 32; index++) values.push(view.getInt16(offset + index * 2, true))
      return values
    }
    case 'b': return view.getInt8(offset)
    case 'M': return view.getUint8(offset)
    case 'B': return view.getUint8(offset)
    case 'g': return toStructuredJson(halfFloat(view.getUint16(offset, true)))
    case 'h': return view.getInt16(offset, true)
    case 'H': return view.getUint16(offset, true)
    case 'i': return view.getInt32(offset, true)
    case 'I': return view.getUint32(offset, true)
    case 'f': return toStructuredJson(view.getFloat32(offset, true))
    case 'd': return toStructuredJson(view.getFloat64(offset, true))
    case 'q': return view.getBigInt64(offset, true).toString()
    case 'Q': return view.getBigUint64(offset, true).toString()
    case 'c': return view.getInt16(offset, true) / 100
    case 'C': return view.getUint16(offset, true) / 100
    case 'e': return view.getInt32(offset, true) / 100
    case 'E': return view.getUint32(offset, true) / 100
    case 'L': return view.getInt32(offset, true) / 1e7
    case 'n': return decodeTextOrBytes(bytes.subarray(offset, offset + 4))
    case 'N': return decodeTextOrBytes(bytes.subarray(offset, offset + 16))
    case 'Z': {
      const fieldBytes = bytes.subarray(offset, offset + 64)
      return messageName === 'FILE' && fieldName === 'Data'
        ? { $binary: bytesToBase64(fieldBytes), encoding: 'base64' }
        : decodeTextOrBytes(fieldBytes)
    }
    default: return { $binary: '', encoding: 'base64' }
  }
}

function parseFormat(bytes: Uint8Array, previousRevision: number): DataflashFormat | null {
  if (bytes.length < FMT_MSG_LENGTH) return null
  const type = bytes[3]
  const length = bytes[4]
  if (length < 3) return null
  const name = readAscii(bytes, 5, 4)
  const format = readAscii(bytes, 9, 16)
  const columns = readAscii(bytes, 25, 64).split(',').filter(Boolean)
  const offsets: number[] = []
  const fields: StructuredLogFieldSchema[] = []
  let payloadOffset = 0
  let decodable = format.length > 0 && format.length === columns.length
  for (let index = 0; index < format.length; index++) {
    const code = format[index]
    const descriptor = FIELD_DESCRIPTORS[code]
    if (!descriptor) {
      decodable = false
      break
    }
    offsets.push(payloadOffset)
    payloadOffset += descriptor.size
    fields.push({
      name: columns[index] ?? `field${index}`,
      type: descriptor.type,
      unit: null,
      multiplier: descriptor.multiplier,
      encoding: descriptor.encoding,
    })
  }
  if (payloadOffset > length - 3) decodable = false
  const revision = previousRevision + 1
  const schema: StructuredLogStreamSchema = {
    streamId: `ardupilot:${name}:${type}`,
    sourceFormat: 'dataflash',
    sourceName: name,
    sourceMessageId: type,
    sourceInstance: null,
    revision,
    instanceField: null,
    fields,
  }
  return {
    type, length, name, format, columns, offsets, revision, decodable,
    unitIds: null, multIds: null, instanceField: null, schema,
  }
}

function idKey(value: StructuredJsonValue | undefined): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String.fromCharCode(value & 0xff)
  if (typeof value === 'string' && value.length > 0) return value[0]
  return null
}

function numeric(value: StructuredJsonValue | undefined): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && /^-?\d+$/.test(value)) {
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) ? parsed : null
  }
  return null
}

function timeValueUs(data: Record<string, StructuredJsonValue>): bigint | null {
  const timeUs = data.TimeUS
  if (typeof timeUs === 'string' && /^\d+$/.test(timeUs)) return BigInt(timeUs)
  if (typeof timeUs === 'number' && Number.isFinite(timeUs) && timeUs >= 0) return BigInt(Math.trunc(timeUs))
  const timeMs = numeric(data.TimeMS)
  return timeMs === null || timeMs < 0 ? null : BigInt(Math.trunc(timeMs * 1000))
}

function updateSchemaMetadata(
  format: DataflashFormat,
  unitLookup: Map<string, string>,
  multLookup: Map<string, number>,
): void {
  let instanceField: string | null = null
  const fields = format.schema.fields.map((field, index) => {
    const unitId = format.unitIds?.[index]
    const multId = format.multIds?.[index]
    if (unitId === '#') instanceField = field.name
    return {
      ...field,
      unit: unitId ? unitLookup.get(unitId) ?? null : null,
      multiplier: field.multiplier ?? (multId ? multLookup.get(multId) ?? null : null),
    }
  })
  format.instanceField = instanceField
  format.schema = { ...format.schema, instanceField, fields }
}

export class StructuredDataflashDecoder implements StructuredFlightLogDecoder {
  readonly format = 'dataflash' as const

  async *decode(
    source: RandomAccessLogSource,
    options: StructuredLogDecodeOptions = {},
  ): AsyncIterable<StructuredLogEnvelope> {
    const reader = new SequentialSourceReader(source, options)
    const formats = new Map<number, DataflashFormat>()
    const unitLookup = new Map<string, string>()
    const multLookup = new Map<string, number>()
    const pendingFmtu = new Map<number, { unitIds: string; multIds: string }>()
    const seenParameters = new Set<string>()
    const information: Record<string, StructuredJsonValue> = {}
    let seq = 0
    let recordCount = 0
    let eventCount = 0
    let parameterCount = 0
    let bootId = 0
    let bootStartUs: bigint | null = null
    let lastTimeUs: bigint | null = null
    let firstTimeUs: bigint | null = null
    let finalTimeUs: bigint | null = null
    let resyncBytes = 0
    const issues: StructuredLogIntegrityIssue[] = []

    while (reader.position + 3 <= source.size) {
      throwIfAborted(options.signal)
      const header = await reader.peek(3)
      if (header.length < 3) break
      if (header[0] !== FRAME_HEAD_0 || header[1] !== FRAME_HEAD_1) {
        reader.advance(1)
        resyncBytes++
        continue
      }

      const msgId = header[2]
      if (msgId === FMT_MSG_ID) {
        const frame = await reader.peek(FMT_MSG_LENGTH)
        if (frame.length < FMT_MSG_LENGTH) {
          const issue: StructuredLogIntegrityIssue = {
            code: 'dataflash_truncated_fmt', severity: 'warning',
            message: 'DataFlash log ends inside an FMT frame', offset: reader.position,
          }
          issues.push(issue)
          yield { kind: 'integrity', issue }
          break
        }
        const previous = formats.get(frame[3])
        const format = parseFormat(frame, previous?.revision ?? 0)
        if (!format) {
          reader.advance(1)
          resyncBytes++
          continue
        }
        const pending = pendingFmtu.get(format.type)
        if (pending) {
          format.unitIds = pending.unitIds
          format.multIds = pending.multIds
        }
        updateSchemaMetadata(format, unitLookup, multLookup)
        formats.set(format.type, format)
        yield { kind: 'schema', schema: format.schema }
        if (!format.decodable) {
          const issue: StructuredLogIntegrityIssue = {
            code: 'dataflash_unsupported_format', severity: 'warning',
            message: `DataFlash message ${format.name} contains an unsupported or invalid format`,
            offset: reader.position,
            data: { format: format.format },
          }
          issues.push(issue)
          yield { kind: 'integrity', issue }
        }
        reader.advance(FMT_MSG_LENGTH)
        continue
      }

      const format = formats.get(msgId)
      if (!format || format.length < 3) {
        reader.advance(1)
        resyncBytes++
        continue
      }
      const frameOffset = reader.position
      const frame = await reader.peek(format.length)
      if (frame.length < format.length) {
        const issue: StructuredLogIntegrityIssue = {
          code: 'dataflash_truncated_frame', severity: 'warning',
          message: `DataFlash log ends inside a ${format.name} frame`, offset: frameOffset,
          data: { availableBytes: frame.length, expectedBytes: format.length },
        }
        issues.push(issue)
        yield { kind: 'integrity', issue }
        break
      }
      reader.advance(format.length)

      const payload = frame.subarray(3)
      const data: Record<string, StructuredJsonValue> = {}
      if (format.decodable) {
        const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
        for (let index = 0; index < format.format.length; index++) {
          data[format.columns[index]] = readField(
            view, payload, format.offsets[index], format.format[index], format.name, format.columns[index],
          )
        }
      } else {
        data.$rawPayload = { $binary: bytesToBase64(payload), encoding: 'base64' }
      }

      const timestamp = timeValueUs(data)
      if (timestamp !== null) {
        if (lastTimeUs !== null && timestamp < lastTimeUs) {
          bootId++
          bootStartUs = timestamp
          const event: StructuredLogEvent = {
            seq: seq++, bootId, timeUs: timestamp.toString(), elapsedUs: '0', utc: null,
            type: 'boot-boundary', level: 5, source: 'dataflash',
            message: 'DataFlash timestamp moved backwards; a new boot segment was started',
          }
          eventCount++
          yield { kind: 'event', event }
        }
        if (bootStartUs === null) bootStartUs = timestamp
        if (firstTimeUs === null) firstTimeUs = timestamp
        lastTimeUs = timestamp
        finalTimeUs = timestamp
      }
      const recordTime = timestamp ?? lastTimeUs
      const elapsed = recordTime !== null && bootStartUs !== null ? recordTime - bootStartUs : null
      const instance = format.instanceField ? data[format.instanceField] ?? null : null
      const sourceInstance = typeof instance === 'number' || typeof instance === 'string' ? instance : null
      const record: StructuredLogRecord = {
        seq: seq++, streamId: format.schema.streamId, schemaRevision: format.revision,
        bootId, timeUs: recordTime?.toString() ?? null, elapsedUs: elapsed?.toString() ?? null,
        utc: null, sourceInstance, data,
      }
      recordCount++
      yield { kind: 'record', record }

      if (format.name === 'UNIT') {
        const key = idKey(data.Id)
        if (key && typeof data.Label === 'string') unitLookup.set(key, data.Label)
      } else if (format.name === 'MULT') {
        const key = idKey(data.Id)
        const value = numeric(data.Mult)
        if (key && value !== null) multLookup.set(key, value)
      } else if (format.name === 'FMTU') {
        const type = numeric(data.FmtType)
        const unitIds = typeof data.UnitIds === 'string' ? data.UnitIds : ''
        const multIds = typeof data.MultIds === 'string' ? data.MultIds : ''
        if (type !== null) {
          pendingFmtu.set(type, { unitIds, multIds })
          const target = formats.get(type)
          if (target) {
            target.unitIds = unitIds
            target.multIds = multIds
            updateSchemaMetadata(target, unitLookup, multLookup)
            yield { kind: 'schema', schema: target.schema }
          }
        }
      }
      if (format.name === 'UNIT' || format.name === 'MULT') {
        for (const target of formats.values()) {
          if (!target.unitIds && !target.multIds) continue
          updateSchemaMetadata(target, unitLookup, multLookup)
          yield { kind: 'schema', schema: target.schema }
        }
      }

      if (format.name === 'PARM' && typeof data.Name === 'string') {
        const parameterKey = `${bootId}:${data.Name}`
        const parameter: StructuredLogParameter = {
          seq: seq++, bootId, timeUs: recordTime?.toString() ?? null,
          name: data.Name, value: data.Value ?? null,
          kind: seenParameters.has(parameterKey) ? 'change' : 'initial',
        }
        seenParameters.add(parameterKey)
        parameterCount++
        yield { kind: 'parameter', parameter }
      }

      if (format.name === 'MSG' || format.name === 'EV' || format.name === 'ERR') {
        const message = format.name === 'MSG' && typeof data.Message === 'string'
          ? data.Message
          : undefined
        if (message && information.firmware === undefined && /^(Ardu|APM:|Rover|Blimp|AntennaTracker)/i.test(message)) {
          information.firmware = message
        }
        const event: StructuredLogEvent = {
          seq: seq++, bootId, timeUs: recordTime?.toString() ?? null,
          elapsedUs: elapsed?.toString() ?? null, utc: null,
          type: format.name.toLowerCase(), level: format.name === 'ERR' ? 3 : 6,
          source: 'dataflash', message, data,
        }
        eventCount++
        yield { kind: 'event', event }
      }
    }

    if (resyncBytes > 0) {
      const issue: StructuredLogIntegrityIssue = {
        code: 'dataflash_resync_bytes', severity: 'warning',
        message: `Skipped ${resyncBytes} byte(s) while resynchronizing DataFlash frames`,
        count: resyncBytes,
      }
      issues.push(issue)
      yield { kind: 'integrity', issue }
    }

    yield {
      kind: 'complete',
      metadata: {
        format: 'dataflash', information, streamCount: formats.size,
        recordCount, eventCount, parameterCount, bootCount: bootId + 1,
        firstTimeUs: firstTimeUs?.toString() ?? null,
        lastTimeUs: finalTimeUs?.toString() ?? null,
      },
    }
  }
}
