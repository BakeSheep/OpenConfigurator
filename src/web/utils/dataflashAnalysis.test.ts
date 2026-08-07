// Unit tests for the ArduPilot DataFlash (.bin) parser. Synthesizes minimal
// FMT + data frames (no real FC needed) and asserts frame resync, field
// scaling (c / L type codes), GPS-week UTC conversion, mode segmentation via
// the shared ArduCopter mode table, armed segmentation and truncation
// tolerance. Run directly: npm run test:dataflash
import assert from 'node:assert/strict'
import i18next from 'i18next'
import { initI18n } from '../i18n/config'
import { localizeLogSeries } from './logSeriesLabels'
import {
  DATAFLASH_TEST_HOOKS,
  gpsWeekToUtcMs,
  parseDataflashLog,
} from './dataflashAnalysis'

initI18n('zh')

const { FRAME_HEAD_0, FRAME_HEAD_1, FMT_MSG_ID, FIELD_SIZES } = DATAFLASH_TEST_HOOKS

function fieldSize(code: string): number {
  const size = FIELD_SIZES[code as keyof typeof FIELD_SIZES]
  if (size === undefined) throw new Error(`unknown format code ${code}`)
  return size
}

function payloadSize(format: string): number {
  let total = 0
  for (const code of format) total += fieldSize(code)
  return total
}

function writeString(buf: Buffer, offset: number, value: string, length: number): void {
  for (let index = 0; index < length; index++) {
    buf[offset + index] = index < value.length ? value.charCodeAt(index) : 0
  }
}

function encodeField(buf: Buffer, offset: number, code: string, value: number | string): void {
  switch (code) {
    case 'b': buf.writeInt8(value as number, offset); break
    case 'B': case 'M': buf.writeUInt8(value as number, offset); break
    case 'h': buf.writeInt16LE(value as number, offset); break
    case 'H': buf.writeUInt16LE(value as number, offset); break
    case 'i': buf.writeInt32LE(value as number, offset); break
    case 'I': buf.writeUInt32LE(value as number, offset); break
    case 'f': buf.writeFloatLE(value as number, offset); break
    case 'd': buf.writeDoubleLE(value as number, offset); break
    case 'c': buf.writeInt16LE(Math.round((value as number) * 100), offset); break
    case 'C': buf.writeUInt16LE(Math.round((value as number) * 100), offset); break
    case 'e': buf.writeInt32LE(Math.round((value as number) * 100), offset); break
    case 'E': buf.writeUInt32LE(Math.round((value as number) * 100), offset); break
    case 'L': buf.writeInt32LE(Math.round((value as number) * 1e7), offset); break
    case 'q': buf.writeBigInt64LE(BigInt(value as number), offset); break
    case 'Q': buf.writeBigUInt64LE(BigInt(value as number), offset); break
    case 'n': writeString(buf, offset, value as string, 4); break
    case 'N': writeString(buf, offset, value as string, 16); break
    case 'Z': writeString(buf, offset, value as string, 64); break
    default: throw new Error(`unhandled encode code ${code}`)
  }
}

interface MsgDef {
  type: number
  name: string
  format: string
  columns: string[]
}

function fmtFrame(def: MsgDef): Buffer {
  // 3-byte header + Type(1) Length(1) Name(4) Format(16) Columns(64) = 89.
  const frame = Buffer.alloc(89)
  frame[0] = FRAME_HEAD_0
  frame[1] = FRAME_HEAD_1
  frame[2] = FMT_MSG_ID
  frame[3] = def.type
  frame[4] = 3 + payloadSize(def.format) // full data-frame length
  writeString(frame, 5, def.name, 4)
  writeString(frame, 9, def.format, 16)
  writeString(frame, 25, def.columns.join(','), 64)
  return frame
}

function dataFrame(def: MsgDef, values: Record<string, number | string>): Buffer {
  const frame = Buffer.alloc(3 + payloadSize(def.format))
  frame[0] = FRAME_HEAD_0
  frame[1] = FRAME_HEAD_1
  frame[2] = def.type
  let offset = 3
  for (let index = 0; index < def.format.length; index++) {
    const code = def.format[index]
    encodeField(frame, offset, code, values[def.columns[index]] ?? 0)
    offset += fieldSize(code)
  }
  return frame
}

function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  const copy = new Uint8Array(buffer.byteLength)
  copy.set(buffer)
  return copy.buffer
}

// --- message definitions -----------------------------------------------------
const ATT: MsgDef = {
  type: 30,
  name: 'ATT',
  format: 'QffffffB',
  columns: ['TimeUS', 'DesRoll', 'Roll', 'DesPitch', 'Pitch', 'DesYaw', 'Yaw', 'AEKF'],
}
const MODE: MsgDef = {
  type: 40,
  name: 'MODE',
  format: 'QBBB',
  columns: ['TimeUS', 'Mode', 'ModeNum', 'Rsn'],
}
const EV: MsgDef = {
  type: 41,
  name: 'EV',
  format: 'QB',
  columns: ['TimeUS', 'Id'],
}
const GPS: MsgDef = {
  type: 42,
  name: 'GPS',
  format: 'QBIHBcLLfff',
  columns: ['TimeUS', 'Status', 'GMS', 'GWk', 'NSats', 'HDop', 'Lat', 'Lng', 'Alt', 'Spd', 'VZ'],
}
const PARM: MsgDef = {
  type: 43,
  name: 'PARM',
  format: 'QNf',
  columns: ['TimeUS', 'Name', 'Value'],
}
const MSG: MsgDef = {
  type: 44,
  name: 'MSG',
  format: 'QZ',
  columns: ['TimeUS', 'Message'],
}
// Include a non-zero I contribution to ensure it is not mistaken for an
// instance selector (PID logs use I for the integral term).
const PIDR: MsgDef = {
  type: 45,
  name: 'PIDR',
  format: 'Qffffff',
  columns: ['TimeUS', 'Tar', 'Act', 'Err', 'P', 'I', 'D'],
}

const GPS_WEEK = 2308
const GPS_MS = 3_600_000
const LAT = 47.397742
const LNG = 8.545594

function buildLog(): Buffer {
  const parts: Buffer[] = []
  // All FMT definitions first.
  parts.push(fmtFrame(ATT), fmtFrame(MODE), fmtFrame(EV), fmtFrame(GPS), fmtFrame(PARM), fmtFrame(MSG), fmtFrame(PIDR))
  // Firmware banner (sets vehicle class = copter) and a parameter.
  parts.push(dataFrame(MSG, { TimeUS: 500_000, Message: 'ArduCopter V4.7.0 (1511f271)' }))
  parts.push(dataFrame(PARM, { TimeUS: 600_000, Name: 'FRAME_CLASS', Value: 1 }))
  // Garbage between frames must trigger a byte-wise resync (avoid 0xA3/0x95).
  parts.push(Buffer.from([0x00, 0x11, 0x22]))
  parts.push(dataFrame(MODE, { TimeUS: 1_000_000, Mode: 0, ModeNum: 0, Rsn: 1 })) // Stabilize
  parts.push(dataFrame(EV, { TimeUS: 1_100_000, Id: 10 })) // Armed
  parts.push(dataFrame(GPS, {
    TimeUS: 2_000_000, Status: 3, GMS: GPS_MS, GWk: GPS_WEEK, NSats: 12,
    HDop: 1.5, Lat: LAT, Lng: LNG, Alt: 100, Spd: 2, VZ: 0.1,
  }))
  parts.push(dataFrame(ATT, {
    TimeUS: 2_100_000, DesRoll: 1, Roll: 1.2, DesPitch: -2, Pitch: -1.8, DesYaw: 90, Yaw: 89, AEKF: 1,
  }))
  parts.push(dataFrame(PIDR, {
    TimeUS: 2_200_000, Tar: 10, Act: 9.5, Err: 0.5, P: 0.3, I: 0.2, D: 0.1,
  }))
  parts.push(dataFrame(GPS, {
    TimeUS: 2_300_000, Status: 3, GMS: GPS_MS + 300, GWk: GPS_WEEK, NSats: 12,
    HDop: 1.2, Lat: LAT + 0.0001, Lng: LNG + 0.0001, Alt: 101, Spd: 2.1, VZ: 0,
  }))
  parts.push(dataFrame(MODE, { TimeUS: 3_000_000, Mode: 6, ModeNum: 6, Rsn: 1 })) // RTL
  parts.push(dataFrame(EV, { TimeUS: 3_500_000, Id: 11 })) // Disarmed
  return Buffer.concat(parts)
}

// --- tests --------------------------------------------------------------------
{
  const dataset = parseDataflashLog(toArrayBuffer(buildLog()))

  // Duration is TimeUS span from the earliest (500_000) to the latest (3_500_000).
  assert.equal(dataset.overview.durationSec, 3)
  // Firmware banner recognized; frame line captured as the model name.
  assert.equal(dataset.overview.firmware, 'ArduCopter V4.7.0 (1511f271)')

  // Resync counted the injected garbage bytes.
  assert.ok(dataset.overview.droppedMessages >= 3, 'garbage bytes should be counted as resync')

  // Mode segments use the shared ArduCopter table (0 -> Stabilize, 6 -> RTL).
  assert.deepEqual(dataset.modeSegments.map((segment) => segment.label), ['Stabilize', 'RTL'])
  assert.ok(Math.abs(dataset.modeSegments[0].startSec - 0.5) < 1e-6)

  // Armed segment from EV 10 (armed) .. EV 11 (disarmed).
  assert.equal(dataset.armedSegments.length, 1)
  assert.equal(dataset.armedSegments[0].label, 'armed')
  assert.ok(Math.abs(dataset.armedSegments[0].startSec - 0.6) < 1e-6)
  assert.ok(dataset.overview.totalArmedSec > 2 && dataset.overview.totalArmedSec <= 2.5)

  // L-type coordinate scaling (int32 * 1e-7): track carries decoded degrees.
  assert.ok(dataset.track, 'GPS points should produce a track')
  assert.ok(Math.abs(dataset.track!.lat[0] - LAT) < 1e-6)
  assert.ok(Math.abs(dataset.track!.lon[0] - LNG) < 1e-6)

  // c-type fixed-point scaling (int16 / 100): HDop 1.5 decodes exactly.
  const hdop = dataset.gpsQuality.find((series) => series.id === 'gps.hdop')
  assert.ok(hdop, 'HDop series present')
  assert.ok(hdop!.values.some((value) => Math.abs(value - 1.5) < 1e-6), 'HDop 1.5 decoded')

  // GPS-week UTC conversion feeds the start time (utcMs at the GPS sample
  // minus its elapsed time offset).
  const gpsSampleSec = (2_000_000 - 500_000) / 1e6
  const expected = gpsWeekToUtcMs(GPS_WEEK, GPS_MS) - gpsSampleSec * 1000
  assert.equal(dataset.overview.startTimeUtcMs, expected)
  assert.equal(dataset.overview.startTimeSource, 'gps')

  // Attitude series decoded (float fields).
  const roll = dataset.attitude.find((series) => series.id === 'attitude.roll')
  assert.ok(roll && roll.values.some((value) => Math.abs(value - 1.2) < 1e-4))

  // Stable series IDs survive language changes while labels follow the UI.
  const zhRoll = localizeLogSeries([roll!], i18next.getFixedT('zh'))[0]
  const enRoll = localizeLogSeries([roll!], i18next.getFixedT('en'))[0]
  assert.equal(zhRoll.id, 'attitude.roll')
  assert.equal(enRoll.id, 'attitude.roll')
  assert.equal(zhRoll.label, '横滚')
  assert.equal(enRoll.label, 'Roll')

  // PIDR Tar/Act/Err feed the roll PID loop; loops without data are dropped.
  assert.deepEqual(dataset.pidLoops.map((loop) => loop.id), ['roll'])
  const rollLoop = dataset.pidLoops[0]
  const target = rollLoop.series.find((series) => series.id === 'pid:roll:target')
  const error = rollLoop.series.find((series) => series.id === 'pid:roll:error')
  assert.ok(target && target.values.some((value) => Math.abs(value - 10) < 1e-4))
  assert.ok(error && error.values.some((value) => Math.abs(value - 0.5) < 1e-4))

  // Parameter captured.
  assert.deepEqual(dataset.params, [{ name: 'FRAME_CLASS', value: 1 }])
}

// Truncation tolerance: a cut mid-final-frame must not throw and must retain
// everything parsed before the cut.
{
  const full = buildLog()
  const truncated = full.subarray(0, full.length - 5)
  const dataset = parseDataflashLog(toArrayBuffer(truncated))
  assert.equal(dataset.overview.firmware, 'ArduCopter V4.7.0 (1511f271)')
  assert.ok(dataset.modeSegments.length >= 1)
}

// Invalid FMT lengths shorter than the three-byte frame header are ignored.
// A matching frame immediately afterwards used to advance by zero forever.
{
  const invalidFmt = fmtFrame({
    type: 99,
    name: 'BAD',
    format: 'B',
    columns: ['Value'],
  })
  invalidFmt[4] = 0
  const danglingInvalidFrame = Buffer.from([FRAME_HEAD_0, FRAME_HEAD_1, 99])
  const validMessage = 'ArduCopter V4.7.0 (length-guard)'
  const log = Buffer.concat([
    invalidFmt,
    danglingInvalidFrame,
    fmtFrame(MSG),
    dataFrame(MSG, { TimeUS: 1_000_000, Message: validMessage }),
  ])

  const dataset = parseDataflashLog(toArrayBuffer(log))
  assert.equal(dataset.overview.firmware, validMessage)
  assert.ok(
    dataset.overview.droppedMessages >= danglingInvalidFrame.length,
    'invalid data frame is resynchronized byte-wise',
  )
}

// GPS epoch reference: week 0, ms 0 minus the leap-second offset.
assert.equal(gpsWeekToUtcMs(0, 0), 315_964_800_000 - 18_000)

console.log('dataflashAnalysis checks passed')
