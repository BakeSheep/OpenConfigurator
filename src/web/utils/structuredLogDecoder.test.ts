import assert from 'node:assert/strict'
import test from 'node:test'
import { MessageType } from '@foxglove/ulog'
import type { StructuredLogEnvelope } from '../../shared/logs'
import {
  BlobLogSource,
  StructuredDataflashDecoder,
  StructuredUlogDecoder,
} from '../../shared/logs'

function message(type: number, payload: Uint8Array): Buffer {
  const output = Buffer.alloc(3 + payload.length)
  output.writeUInt16LE(payload.length, 0)
  output[2] = type
  Buffer.from(payload).copy(output, 3)
  return output
}

function ulogFixture(incompatible = 0): Buffer {
  const header = Buffer.alloc(16)
  Buffer.from([0x55, 0x4c, 0x6f, 0x67, 0x01, 0x12, 0x35, 1]).copy(header)
  header.writeBigUInt64LE(1_000_000n, 8)

  const flags = Buffer.alloc(40)
  flags[0] = 1
  flags[8] = incompatible
  const format = Buffer.from('sample:uint64_t timestamp;float value;', 'ascii')
  const infoKey = Buffer.from('char[3] sys_name', 'ascii')
  const info = Buffer.concat([Buffer.from([infoKey.length]), infoKey, Buffer.from('PX4')])
  const paramKey = Buffer.from('float TEST_PARAM', 'ascii')
  const paramValue = Buffer.alloc(4)
  paramValue.writeFloatLE(2.5)
  const parameter = Buffer.concat([Buffer.from([paramKey.length]), paramKey, paramValue])
  const defaultValue = Buffer.alloc(4)
  defaultValue.writeFloatLE(1.5)
  const parameterDefault = Buffer.concat([Buffer.from([1, paramKey.length]), paramKey, defaultValue])
  const changedValue = Buffer.alloc(4)
  changedValue.writeFloatLE(4.5)
  const parameterChange = Buffer.concat([Buffer.from([paramKey.length]), paramKey, changedValue])
  const subscribe = Buffer.alloc(3 + 'sample'.length)
  subscribe[0] = 2
  subscribe.writeUInt16LE(42, 1)
  subscribe.write('sample', 3, 'ascii')
  const data = Buffer.alloc(14)
  data.writeUInt16LE(42, 0)
  data.writeBigUInt64LE(1_250_000n, 2)
  data.writeFloatLE(3.25, 10)
  const log = Buffer.alloc(1 + 8 + 5)
  log[0] = 4
  log.writeBigUInt64LE(1_300_000n, 1)
  log.write('hello', 9, 'ascii')
  const dropout = Buffer.alloc(2)
  dropout.writeUInt16LE(12)

  return Buffer.concat([
    header,
    message(MessageType.FlagBits, flags),
    message(MessageType.FormatDefinition, format),
    message(MessageType.Information, info),
    message(MessageType.Parameter, parameter),
    message(MessageType.ParameterDefault, parameterDefault),
    message(MessageType.AddLogged, subscribe),
    message(MessageType.Data, data),
    message(MessageType.Parameter, parameterChange),
    message(MessageType.Log, log),
    message(MessageType.Dropout, dropout),
  ])
}

const DF_HEADER = Buffer.from([0xa3, 0x95])

interface DataflashDefinition {
  type: number
  name: string
  format: string
  columns: string[]
}

const DF_SIZES: Record<string, number> = {
  a: 64, b: 1, B: 1, g: 2, h: 2, H: 2, i: 4, I: 4, f: 4,
  d: 8, q: 8, Q: 8, c: 2, C: 2, e: 4, E: 4, L: 4, M: 1,
  n: 4, N: 16, Z: 64,
}

function dfPayloadSize(format: string): number {
  return [...format].reduce((total, code) => total + DF_SIZES[code], 0)
}

function writeFixedString(buffer: Buffer, offset: number, value: string, length: number): void {
  buffer.fill(0, offset, offset + length)
  buffer.write(value, offset, Math.min(length, Buffer.byteLength(value)), 'utf8')
}

function dfFmt(definition: DataflashDefinition): Buffer {
  const frame = Buffer.alloc(89)
  DF_HEADER.copy(frame)
  frame[2] = 0x80
  frame[3] = definition.type
  frame[4] = 3 + dfPayloadSize(definition.format)
  writeFixedString(frame, 5, definition.name, 4)
  writeFixedString(frame, 9, definition.format, 16)
  writeFixedString(frame, 25, definition.columns.join(','), 64)
  return frame
}

function dfData(definition: DataflashDefinition, values: Record<string, number | bigint | string | number[]>): Buffer {
  const frame = Buffer.alloc(3 + dfPayloadSize(definition.format))
  DF_HEADER.copy(frame)
  frame[2] = definition.type
  let offset = 3
  definition.format.split('').forEach((code, index) => {
    const value = values[definition.columns[index]] ?? 0
    switch (code) {
      case 'B': case 'M': frame.writeUInt8(Number(value), offset); break
      case 'b': frame.writeInt8(Number(value), offset); break
      case 'a': {
        const entries = Array.isArray(value) ? value : []
        for (let entry = 0; entry < 32; entry++) frame.writeInt16LE(entries[entry] ?? 0, offset + entry * 2)
        break
      }
      case 'g': frame.writeUInt16LE(Number(value), offset); break
      case 'H': frame.writeUInt16LE(Number(value), offset); break
      case 'h': frame.writeInt16LE(Number(value), offset); break
      case 'I': frame.writeUInt32LE(Number(value), offset); break
      case 'i': frame.writeInt32LE(Number(value), offset); break
      case 'Q': frame.writeBigUInt64LE(BigInt(value as string | number | bigint | boolean), offset); break
      case 'q': frame.writeBigInt64LE(BigInt(value as string | number | bigint | boolean), offset); break
      case 'f': frame.writeFloatLE(Number(value), offset); break
      case 'd': frame.writeDoubleLE(Number(value), offset); break
      case 'c': frame.writeInt16LE(Number(value), offset); break
      case 'C': frame.writeUInt16LE(Number(value), offset); break
      case 'e': case 'L': frame.writeInt32LE(Number(value), offset); break
      case 'E': frame.writeUInt32LE(Number(value), offset); break
      case 'n': writeFixedString(frame, offset, String(value), 4); break
      case 'N': writeFixedString(frame, offset, String(value), 16); break
      case 'Z': writeFixedString(frame, offset, String(value), 64); break
      default: throw new Error(`test fixture does not write ${code}`)
    }
    offset += DF_SIZES[code]
  })
  return frame
}

async function collect(decoder: { decode(source: BlobLogSource): AsyncIterable<StructuredLogEnvelope> }, buffer: Buffer) {
  const output: StructuredLogEnvelope[] = []
  const bytes = Uint8Array.from(buffer)
  for await (const entry of decoder.decode(new BlobLogSource('fixture', new Blob([bytes])))) output.push(entry)
  return output
}

test('StructuredUlogDecoder emits schemas, parameters, records, events and integrity', async () => {
  const output = await collect(new StructuredUlogDecoder(), ulogFixture())
  const schema = output.find((entry) => entry.kind === 'schema')
  assert.equal(schema?.kind === 'schema' && schema.schema.streamId, 'px4:sample:2')
  const parameters = output.filter((entry) => entry.kind === 'parameter').map((entry) => entry.parameter)
  assert.deepEqual(parameters.map((entry) => entry.kind), ['initial', 'default', 'change'])
  assert.deepEqual(parameters.map((entry) => entry.value), [2.5, 1.5, 4.5])
  assert.deepEqual(parameters.map((entry) => entry.mavParamType), [9, 9, 9])
  const record = output.find((entry) => entry.kind === 'record')
  assert.equal(record?.kind === 'record' && record.record.data.value, 3.25)
  assert.equal(record?.kind === 'record' && record.record.timeUs, '1250000')
  assert.ok(output.some((entry) => entry.kind === 'event' && entry.event.type === 'dropout'))
  assert.ok(output.some((entry) => entry.kind === 'integrity' && entry.issue.code === 'ulog_dropout'))
})

test('StructuredUlogDecoder rejects unknown incompatible flags', async () => {
  await assert.rejects(() => collect(new StructuredUlogDecoder(), ulogFixture(2)), /incompatible/i)
})

test('StructuredDataflashDecoder preserves all records and creates boot segments', async () => {
  const msg: DataflashDefinition = { type: 129, name: 'MSG', format: 'QZ', columns: ['TimeUS', 'Message'] }
  const parm: DataflashDefinition = { type: 130, name: 'PARM', format: 'QNf', columns: ['TimeUS', 'Name', 'Value'] }
  const custom: DataflashDefinition = { type: 131, name: 'TEST', format: 'QqQ', columns: ['TimeUS', 'Signed', 'Unsigned'] }
  const buffer = Buffer.concat([
    dfFmt(msg), dfFmt(parm), dfFmt(custom),
    dfData(msg, { TimeUS: 1_000_000n, Message: 'ArduCopter V4.7' }),
    dfData(parm, { TimeUS: 1_100_000n, Name: 'FRAME_CLASS', Value: 1 }),
    dfData(custom, { TimeUS: 1_200_000n, Signed: -5n, Unsigned: 18_446_744_073_709_551_615n }),
    dfData(custom, { TimeUS: 50_000n, Signed: 2n, Unsigned: 3n }),
  ])
  const output = await collect(new StructuredDataflashDecoder(), buffer)
  const records = output.filter((entry) => entry.kind === 'record').map((entry) => entry.record)
  assert.equal(records.length, 4)
  assert.equal(records[2].data.Signed, '-5')
  assert.equal(records[2].data.Unsigned, '18446744073709551615')
  assert.equal(records[3].bootId, 1)
  assert.ok(output.some((entry) => entry.kind === 'event' && entry.event.type === 'boot-boundary'))
  assert.ok(output.some((entry) => entry.kind === 'parameter'
    && entry.parameter.name === 'FRAME_CLASS'
    && entry.parameter.mavParamType === 9))
  const complete = [...output].reverse().find((entry) => entry.kind === 'complete')
  assert.equal(complete?.kind === 'complete' && complete.metadata.bootCount, 2)
})

test('StructuredDataflashDecoder reports resynchronization and truncated frames', async () => {
  const testDef: DataflashDefinition = { type: 140, name: 'TEST', format: 'QB', columns: ['TimeUS', 'Value'] }
  const full = dfData(testDef, { TimeUS: 1_000_000n, Value: 7 })
  const buffer = Buffer.concat([Buffer.from([1, 2, 3]), dfFmt(testDef), full, full.subarray(0, 5)])
  const output = await collect(new StructuredDataflashDecoder(), buffer)
  assert.ok(output.some((entry) => entry.kind === 'integrity' && entry.issue.code === 'dataflash_resync_bytes'))
  assert.ok(output.some((entry) => entry.kind === 'integrity' && entry.issue.code === 'dataflash_truncated_frame'))
})

test('StructuredDataflashDecoder covers official field codes and binary FILE data', async () => {
  const first: DataflashDefinition = {
    type: 150, name: 'TYP1', format: 'QabBghHiIfd',
    columns: ['TimeUS', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'],
  }
  const second: DataflashDefinition = {
    type: 151, name: 'TYP2', format: 'QqQcCeELMnNZ',
    columns: ['TimeUS', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K'],
  }
  const file: DataflashDefinition = {
    type: 152, name: 'FILE', format: 'QZ', columns: ['TimeUS', 'Data'],
  }
  const output = await collect(new StructuredDataflashDecoder(), Buffer.concat([
    dfFmt(first), dfFmt(second), dfFmt(file),
    dfData(first, {
      TimeUS: 1_000_000n, A: [1, -2, 3], B: -5, C: 250, D: 0x3c00,
      E: -12, F: 65_000, G: -123_456, H: 4_000_000_000, I: 1.25, J: -3.5,
    }),
    dfData(second, {
      TimeUS: 1_100_000n, A: -9n, B: 18_446_744_073_709_551_615n,
      C: -123, D: 456, E: -12_345, F: 67_890, G: 374_221_234,
      H: 200, I: 'abc', J: 'sixteen', K: 'payload',
    }),
    dfData(file, { TimeUS: 1_200_000n, Data: 'binary-source' }),
  ]))
  const records = output.filter((entry) => entry.kind === 'record').map((entry) => entry.record)
  assert.deepEqual(records[0].data.A, [1, -2, 3, ...Array(29).fill(0)])
  assert.equal(records[0].data.D, 1)
  assert.equal(records[1].data.A, '-9')
  assert.equal(records[1].data.B, '18446744073709551615')
  assert.equal(records[1].data.C, -1.23)
  assert.equal(records[1].data.G, 37.4221234)
  assert.equal(records[1].data.H, 200)
  assert.deepEqual(records[2].data.Data, {
    $binary: Buffer.alloc(64, 0).fill(Buffer.from('binary-source'), 0, 'binary-source'.length).toString('base64'),
    encoding: 'base64',
  })
  const fieldTypes = output
    .flatMap((entry) => entry.kind === 'schema'
      ? entry.schema.fields.map((field) => field.type)
      : [])
  assert.ok(fieldTypes.includes('float16'))
  assert.ok(fieldTypes.includes('int16[32]'))
  assert.ok(fieldTypes.includes('uint64'))
})

test('StructuredDataflashDecoder applies FMTU units, multipliers, instances and revisions', async () => {
  const unit: DataflashDefinition = { type: 160, name: 'UNIT', format: 'QBN', columns: ['TimeUS', 'Id', 'Label'] }
  const mult: DataflashDefinition = { type: 161, name: 'MULT', format: 'QBd', columns: ['TimeUS', 'Id', 'Mult'] }
  const fmtu: DataflashDefinition = { type: 162, name: 'FMTU', format: 'QBNN', columns: ['TimeUS', 'FmtType', 'UnitIds', 'MultIds'] }
  const target: DataflashDefinition = { type: 163, name: 'TARG', format: 'QfB', columns: ['TimeUS', 'Value', 'Instance'] }
  const revised: DataflashDefinition = { type: 164, name: 'RDEF', format: 'QB', columns: ['TimeUS', 'Value'] }
  const revisedAgain: DataflashDefinition = { ...revised, format: 'QH' }
  const output = await collect(new StructuredDataflashDecoder(), Buffer.concat([
    dfFmt(unit), dfFmt(mult), dfFmt(fmtu), dfFmt(target), dfFmt(revised),
    dfData(unit, { TimeUS: 1n, Id: 'm'.charCodeAt(0), Label: 'm/s' }),
    dfData(mult, { TimeUS: 2n, Id: 'A'.charCodeAt(0), Mult: 0.1 }),
    dfData(fmtu, { TimeUS: 3n, FmtType: 163, UnitIds: 'sm#', MultIds: ' A ' }),
    dfData(target, { TimeUS: 4n, Value: 5, Instance: 2 }),
    dfData(revised, { TimeUS: 5n, Value: 1 }),
    dfFmt(revisedAgain),
    dfData(revisedAgain, { TimeUS: 6n, Value: 500 }),
  ]))
  const targetSchemas = output
    .flatMap((entry) => entry.kind === 'schema' && entry.schema.sourceName === 'TARG'
      ? [entry.schema]
      : [])
  const latestTarget = targetSchemas[targetSchemas.length - 1]
  assert.equal(latestTarget.instanceField, 'Instance')
  assert.equal(latestTarget.fields[1].unit, 'm/s')
  assert.equal(latestTarget.fields[1].multiplier, 0.1)
  const targetRecord = output.find((entry) => entry.kind === 'record' && entry.record.streamId === latestTarget.streamId)
  assert.equal(targetRecord?.kind === 'record' && targetRecord.record.sourceInstance, 2)
  const revisions = output
    .flatMap((entry) => entry.kind === 'schema' && entry.schema.sourceName === 'RDEF'
      ? [entry.schema.revision]
      : [])
  assert.deepEqual(revisions, [1, 2])
})
