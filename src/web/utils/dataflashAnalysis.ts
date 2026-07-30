// ArduPilot DataFlash (.bin) log parser. The format is self-describing: FMT
// messages (msg id 128) declare every message's id, length, name, per-field
// type codes and column names; data messages follow as 0xA3 0x95 <id> frames.
// The parser streams the buffer once into the same bounded collectors as the
// ULog worker and produces an identical UlogAnalysisDataset, so every chart
// component works unchanged. Framework-agnostic (worker + node tests).
import {
  EnvelopeCollector,
  VibrationAnalyzer,
  buildSegments,
  type PidLoopData,
  type SeriesData,
  type UlogAnalysisDataset,
  type UlogEvent,
  type UlogParamEntry,
} from './ulogAnalysis'
import {
  finishEnvelope,
  finishRaw,
  makeRaw,
  pushRaw,
} from './seriesCompression'
import { decodeFlightMode, type VehicleClass } from '../../shared/vehicleProfiles'

const FRAME_HEAD_0 = 0xa3
const FRAME_HEAD_1 = 0x95
const FMT_MSG_ID = 0x80
// FMT wire layout: 3-byte frame header + Type(1) Length(1) Name(4) Format(16)
// Columns(64) = 89 bytes total.
const FMT_MSG_LENGTH = 89

const MAX_EVENTS = 500
const ENVELOPE_BUCKET_SEC = 0.05
const TRACK_MIN_INTERVAL_SEC = 0.2
const MAX_MOTORS = 14

// GPS epoch (1980-01-06T00:00:00Z) in Unix ms, and the current GPS-UTC leap
// second offset. ArduPilot logs GPS week (GWk) + ms-in-week (GMS).
const GPS_EPOCH_UNIX_MS = 315_964_800_000
const GPS_UTC_LEAP_MS = 18_000
const MS_PER_WEEK = 604_800_000

export function gpsWeekToUtcMs(week: number, msInWeek: number): number {
  return GPS_EPOCH_UNIX_MS + week * MS_PER_WEEK + msInWeek - GPS_UTC_LEAP_MS
}

/**
 * DataFlash field type codes -> byte size. 'a' (int16[32]) is carried for
 * offset accounting only; its value is not consumed by any handler.
 */
const FIELD_SIZES: Record<string, number> = {
  b: 1, B: 1, M: 1,
  h: 2, H: 2, c: 2, C: 2,
  i: 4, I: 4, f: 4, e: 4, E: 4, L: 4,
  d: 8, q: 8, Q: 8,
  n: 4, N: 16, Z: 64,
  a: 64,
}

interface MessageFormat {
  type: number
  /** Full frame length including the 3-byte header. */
  length: number
  name: string
  format: string
  columns: string[]
  /** Byte offset of each field inside the payload. */
  offsets: number[]
  /** True when every format char is known and fits the declared length. */
  decodable: boolean
}

type FieldValue = number | string

function readString(bytes: Uint8Array, start: number, length: number): string {
  let end = start
  const limit = Math.min(start + length, bytes.length)
  while (end < limit && bytes[end] !== 0) end++
  let out = ''
  for (let index = start; index < end; index++) out += String.fromCharCode(bytes[index])
  return out
}

function readField(view: DataView, offset: number, code: string, bytes: Uint8Array): FieldValue {
  switch (code) {
    case 'b': return view.getInt8(offset)
    case 'B': case 'M': return view.getUint8(offset)
    case 'h': return view.getInt16(offset, true)
    case 'H': return view.getUint16(offset, true)
    case 'i': return view.getInt32(offset, true)
    case 'I': return view.getUint32(offset, true)
    case 'f': return view.getFloat32(offset, true)
    case 'd': return view.getFloat64(offset, true)
    // Fixed-point centi-units and 1e-7-degree coordinates.
    case 'c': return view.getInt16(offset, true) / 100
    case 'C': return view.getUint16(offset, true) / 100
    case 'e': return view.getInt32(offset, true) / 100
    case 'E': return view.getUint32(offset, true) / 100
    case 'L': return view.getInt32(offset, true) / 1e7
    case 'q': return Number(view.getBigInt64(offset, true))
    case 'Q': return Number(view.getBigUint64(offset, true))
    case 'n': return readString(bytes, offset, 4)
    case 'N': return readString(bytes, offset, 16)
    case 'Z': return readString(bytes, offset, 64)
    default: return Number.NaN // 'a' and future codes: skipped, never consumed
  }
}

function parseFmtPayload(view: DataView, bytes: Uint8Array, offset: number): MessageFormat {
  const type = view.getUint8(offset)
  const length = view.getUint8(offset + 1)
  const name = readString(bytes, offset + 2, 4)
  const format = readString(bytes, offset + 6, 16)
  const columns = readString(bytes, offset + 22, 64).split(',').filter(Boolean)
  const offsets: number[] = []
  let fieldOffset = 0
  let decodable = format.length > 0 && format.length === columns.length
  for (const code of format) {
    const size = FIELD_SIZES[code]
    if (size === undefined) {
      decodable = false
      break
    }
    offsets.push(fieldOffset)
    fieldOffset += size
  }
  if (fieldOffset > length - 3) decodable = false
  return { type, length, name, format, columns, offsets, decodable }
}

const EVENT_NAMES: Record<number, string> = {
  7: 'AP state',
  9: 'Init simple bearing',
  10: 'Armed',
  11: 'Disarmed',
  15: 'Auto armed',
  17: 'Land complete (maybe)',
  18: 'Land complete',
  25: 'Set home',
  26: 'Set simple on',
  27: 'Set simple off',
  28: 'Not landed',
  29: 'Fence enable',
  30: 'Fence disable',
  62: 'SSRecover enable',
  63: 'Surfaced',
  64: 'Not surfaced',
  65: 'Bottomed',
  66: 'Not bottomed',
}

const FIRMWARE_CLASS_PATTERNS: Array<[RegExp, VehicleClass]> = [
  [/^ArduCopter|^APM:Copter|^Blimp/i, 'copter'],
  [/^ArduPlane|^APM:Plane/i, 'plane'],
  [/^ArduRover|^APM:Rover|^Rover/i, 'rover'],
  [/^ArduSub|^APM:Sub/i, 'sub'],
  [/^AntennaTracker|^APM:Tracker/i, 'tracker'],
]

/**
 * Instance/core column candidates - only the first instance is charted so a
 * multi-IMU / multi-battery vehicle does not draw overlapping series. `IMU`
 * is the instance selector on VIBE records.
 */
const INSTANCE_COLUMNS = ['I', 'Inst', 'Instance', 'IMU']

// AC_PID logging messages -> loop identity. Tar/Act/Err are logged directly
// in each loop's native units (rate loops in rad/s on recent firmwares).
const PID_LOOP_DEFS = [
  { msg: 'PIDR', id: 'roll', label: 'Roll' },
  { msg: 'PIDP', id: 'pitch', label: 'Pitch' },
  { msg: 'PIDY', id: 'yaw', label: 'Yaw' },
  { msg: 'PIDA', id: 'accz', label: 'AccZ' },
] as const

/**
 * Parse a complete DataFlash .bin buffer into the shared analysis dataset.
 * Corrupt bytes trigger a one-byte resync; a truncated final frame is
 * silently ignored, so partially downloaded logs still analyze.
 */
export function parseDataflashLog(buffer: ArrayBuffer): UlogAnalysisDataset {
  const bytes = new Uint8Array(buffer)
  const view = new DataView(buffer)
  const formats = new Map<number, MessageFormat>()

  // --- collectors (mirror the ULog worker) ------------------------------
  const attitude = {
    roll: makeRaw('横滚'),
    pitch: makeRaw('俯仰'),
    yaw: makeRaw('偏航'),
    rollSp: makeRaw('横滚设定'),
    pitchSp: makeRaw('俯仰设定'),
    yawSp: makeRaw('偏航设定'),
  }
  const rates = {
    roll: makeRaw('横滚速率'),
    pitch: makeRaw('俯仰速率'),
    yaw: makeRaw('偏航速率'),
    rollSp: makeRaw('横滚速率设定'),
    pitchSp: makeRaw('俯仰速率设定'),
    yawSp: makeRaw('偏航速率设定'),
  }
  const battery = {
    voltage: makeRaw('电压 (V)'),
    current: makeRaw('电流 (A)'),
    power: makeRaw('功率 (W)'),
  }
  const gpsQuality = {
    satellites: makeRaw('卫星数'),
    hdop: makeRaw('水平精度因子 (HDop)'),
    fix: makeRaw('定位类型'),
  }
  const altitude = {
    rel: makeRaw('相对高度 (m)'),
    baro: makeRaw('气压高度 (m)'),
    gps: makeRaw('GPS 海拔 (m)'),
  }
  const velocity = {
    ground: makeRaw('地速 (m/s)'),
    vz: makeRaw('垂直速度 (m/s)'),
  }
  const vibe = {
    x: makeRaw('Vibe X (m/s²)'),
    y: makeRaw('Vibe Y (m/s²)'),
    z: makeRaw('Vibe Z (m/s²)'),
  }
  const pidCollectors = new Map(PID_LOOP_DEFS.map((def) => [def.msg, {
    tar: makeRaw(`${def.label} 目标`),
    act: makeRaw(`${def.label} 实际`),
    err: makeRaw(`${def.label} 误差`),
  }]))
  const motorEnvelopes: EnvelopeCollector[] = []
  const motorIndices: number[] = []
  let motorSampleCount = 0
  let motorSaturatedCount = 0
  const vibration = new VibrationAnalyzer()
  const rawAcc: [EnvelopeCollector, EnvelopeCollector, EnvelopeCollector] = [
    new EnvelopeCollector(ENVELOPE_BUCKET_SEC),
    new EnvelopeCollector(ENVELOPE_BUCKET_SEC),
    new EnvelopeCollector(ENVELOPE_BUCKET_SEC),
  ]
  // Mode numbers are recorded raw and decoded after the whole file is read,
  // because the firmware line (MSG) that names the vehicle class may appear
  // after early MODE records.
  const modeSamples: Array<{ timeSec: number; mode: number }> = []
  const armedSamples: Array<{ timeSec: number; label: string }> = []
  const events: UlogEvent[] = []
  const track = {
    timesSec: [] as number[],
    lat: [] as number[],
    lon: [] as number[],
    altM: [] as Array<number | null>,
  }
  let lastTrackSec = -Infinity
  let havePosTrack = false
  const params = new Map<string, number>()
  let vehicleClass: VehicleClass = 'unknown'
  let firmware: string | null = null
  let hardware: string | null = null
  let frameInfo: string | null = null
  // Wrapped in a holder because TS does not track assignments made inside
  // the per-message handler closures.
  const gpsUtcRef: { value: { utcMs: number; timeSec: number } | null } = { value: null }
  let resyncBytes = 0

  let timeBaseUs: number | null = null
  let endSec = 0
  const toSec = (timeUs: number): number => {
    if (timeBaseUs === null || timeUs < timeBaseUs) timeBaseUs = timeUs
    const seconds = (timeUs - timeBaseUs) / 1e6
    if (seconds > endSec) endSec = seconds
    return seconds
  }

  const handleActuatorSample = (fields: Record<string, FieldValue>, timeSec: number) => {
    // RCOU logs PWM per channel; value 0 means "output not driven".
    let sampleMax = Number.NEGATIVE_INFINITY
    let any = false
    for (let channel = 1; channel <= MAX_MOTORS; channel++) {
      const value = fields[`C${channel}`]
      if (typeof value !== 'number' || !Number.isFinite(value) || value === 0) continue
      let slot = motorIndices.indexOf(channel)
      if (slot < 0) {
        slot = motorIndices.length
        motorIndices.push(channel)
        motorEnvelopes.push(new EnvelopeCollector(ENVELOPE_BUCKET_SEC))
      }
      motorEnvelopes[slot].add(timeSec, value)
      sampleMax = Math.max(sampleMax, value)
      any = true
    }
    if (any) {
      motorSampleCount++
      if (sampleMax >= 1950) motorSaturatedCount++
    }
  }

  const pushTrackPoint = (
    timeSec: number,
    lat: number,
    lon: number,
    altM: number | null,
    fromPos: boolean,
  ) => {
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) return
    // POS (EKF position) supersedes the raw-GPS fallback once observed.
    if (fromPos && !havePosTrack) {
      havePosTrack = true
      track.timesSec.length = 0
      track.lat.length = 0
      track.lon.length = 0
      track.altM.length = 0
      lastTrackSec = -Infinity
    }
    if (!fromPos && havePosTrack) return
    if (timeSec - lastTrackSec < TRACK_MIN_INTERVAL_SEC) return
    lastTrackSec = timeSec
    track.timesSec.push(timeSec)
    track.lat.push(lat)
    track.lon.push(lon)
    track.altM.push(altM !== null && Number.isFinite(altM) ? altM : null)
  }

  const numField = (fields: Record<string, FieldValue>, name: string): number => {
    const value = fields[name]
    return typeof value === 'number' ? value : Number.NaN
  }

  const firstInstanceOnly = (fields: Record<string, FieldValue>): boolean => {
    for (const column of INSTANCE_COLUMNS) {
      const value = fields[column]
      if (typeof value === 'number') return value === 0
    }
    return true
  }

  // --- per-message handlers ---------------------------------------------
  const handlers: Record<string, (fields: Record<string, FieldValue>, timeSec: number) => void> = {
    ATT: (fields, timeSec) => {
      pushRaw(attitude.roll, timeSec, numField(fields, 'Roll'))
      pushRaw(attitude.pitch, timeSec, numField(fields, 'Pitch'))
      pushRaw(attitude.yaw, timeSec, numField(fields, 'Yaw'))
      pushRaw(attitude.rollSp, timeSec, numField(fields, 'DesRoll'))
      pushRaw(attitude.pitchSp, timeSec, numField(fields, 'DesPitch'))
      pushRaw(attitude.yawSp, timeSec, numField(fields, 'DesYaw'))
    },
    // RATE fields are logged in deg/s (ArduPilot unit code 'k').
    RATE: (fields, timeSec) => {
      pushRaw(rates.roll, timeSec, numField(fields, 'R'))
      pushRaw(rates.pitch, timeSec, numField(fields, 'P'))
      pushRaw(rates.yaw, timeSec, numField(fields, 'Y'))
      pushRaw(rates.rollSp, timeSec, numField(fields, 'RDes'))
      pushRaw(rates.pitchSp, timeSec, numField(fields, 'PDes'))
      pushRaw(rates.yawSp, timeSec, numField(fields, 'YDes'))
    },
    RCOU: handleActuatorSample,
    BAT: (fields, timeSec) => {
      if (!firstInstanceOnly(fields)) return
      const voltage = numField(fields, 'Volt')
      const current = numField(fields, 'Curr')
      if (voltage > 0) pushRaw(battery.voltage, timeSec, voltage)
      pushRaw(battery.current, timeSec, current)
      if (voltage > 0 && Number.isFinite(current)) {
        pushRaw(battery.power, timeSec, voltage * current)
      }
    },
    GPS: (fields, timeSec) => {
      if (!firstInstanceOnly(fields)) return
      pushRaw(gpsQuality.satellites, timeSec, numField(fields, 'NSats'))
      pushRaw(gpsQuality.hdop, timeSec, numField(fields, 'HDop'))
      pushRaw(gpsQuality.fix, timeSec, numField(fields, 'Status'))
      const altM = numField(fields, 'Alt')
      if (Number.isFinite(altM)) pushRaw(altitude.gps, timeSec, altM)
      pushRaw(velocity.ground, timeSec, numField(fields, 'Spd'))
      pushRaw(velocity.vz, timeSec, -numField(fields, 'VZ'))
      const week = numField(fields, 'GWk')
      const msInWeek = numField(fields, 'GMS')
      if (!gpsUtcRef.value && week > 0 && Number.isFinite(msInWeek)) {
        gpsUtcRef.value = { utcMs: gpsWeekToUtcMs(week, msInWeek), timeSec }
      }
      if (numField(fields, 'Status') >= 2) {
        pushTrackPoint(
          timeSec,
          numField(fields, 'Lat'),
          numField(fields, 'Lng'),
          Number.isFinite(altM) ? altM : null,
          false,
        )
      }
    },
    POS: (fields, timeSec) => {
      const relAlt = numField(fields, 'RelHomeAlt')
      if (Number.isFinite(relAlt)) pushRaw(altitude.rel, timeSec, relAlt)
      const altM = numField(fields, 'Alt')
      pushTrackPoint(
        timeSec,
        numField(fields, 'Lat'),
        numField(fields, 'Lng'),
        Number.isFinite(altM) ? altM : null,
        true,
      )
    },
    BARO: (fields, timeSec) => {
      if (!firstInstanceOnly(fields)) return
      pushRaw(altitude.baro, timeSec, numField(fields, 'Alt'))
    },
    IMU: (fields, timeSec) => {
      if (!firstInstanceOnly(fields)) return
      const x = numField(fields, 'AccX')
      const y = numField(fields, 'AccY')
      const z = numField(fields, 'AccZ')
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return
      vibration.addSample(timeSec, x, y, z)
      rawAcc[0].add(timeSec, x)
      rawAcc[1].add(timeSec, y)
      rawAcc[2].add(timeSec, z)
    },
    VIBE: (fields, timeSec) => {
      if (!firstInstanceOnly(fields)) return
      pushRaw(vibe.x, timeSec, numField(fields, 'VibeX'))
      pushRaw(vibe.y, timeSec, numField(fields, 'VibeY'))
      pushRaw(vibe.z, timeSec, numField(fields, 'VibeZ'))
    },
    MODE: (fields, timeSec) => {
      const mode = numField(fields, 'Mode')
      if (!Number.isFinite(mode)) return
      if (modeSamples[modeSamples.length - 1]?.mode !== mode) {
        modeSamples.push({ timeSec, mode })
      }
    },
    EV: (fields, timeSec) => {
      const id = numField(fields, 'Id')
      if (!Number.isFinite(id)) return
      if (id === 10 || id === 11) {
        const label = id === 10 ? 'armed' : 'disarmed'
        if (armedSamples[armedSamples.length - 1]?.label !== label) {
          armedSamples.push({ timeSec, label })
        }
      }
      if (events.length < MAX_EVENTS) {
        events.push({ timeSec, level: 6, message: EVENT_NAMES[id] ?? `EV ${id}` })
      }
    },
    MSG: (fields, timeSec) => {
      const text = fields.Message
      if (typeof text !== 'string' || text.length === 0) return
      if (!firmware) {
        for (const [pattern, klass] of FIRMWARE_CLASS_PATTERNS) {
          if (pattern.test(text)) {
            firmware = text
            vehicleClass = klass
            break
          }
        }
      }
      // Boot banner board line: "<board> <serial words>".
      if (!hardware) {
        const board = /^([A-Za-z][\w-]*)\s+[0-9A-Fa-f]{8}\s+[0-9A-Fa-f]{8}\s+[0-9A-Fa-f]{8}$/
          .exec(text)
        if (board) hardware = board[1]
      }
      if (!frameInfo && text.startsWith('Frame:')) frameInfo = text.slice(6).trim()
      if (events.length < MAX_EVENTS) {
        events.push({ timeSec, level: 6, message: text })
      }
    },
    PARM: (fields) => {
      const name = fields.Name
      const value = fields.Value
      if (typeof name === 'string' && name.length > 0 && typeof value === 'number') {
        params.set(name, value)
      }
    },
  }
  for (const def of PID_LOOP_DEFS) {
    const collectors = pidCollectors.get(def.msg)!
    handlers[def.msg] = (fields, timeSec) => {
      // PID records use `I` for the integral contribution, not an instance
      // selector. Applying firstInstanceOnly() here would discard every sample
      // whose integral term is non-zero.
      pushRaw(collectors.tar, timeSec, numField(fields, 'Tar'))
      pushRaw(collectors.act, timeSec, numField(fields, 'Act'))
      pushRaw(collectors.err, timeSec, numField(fields, 'Err'))
    }
  }

  // Message ids we decode (handlers above); everything else is skipped fast.
  const handledIds = new Map<number, MessageFormat>()

  // --- single streaming pass ---------------------------------------------
  let offset = 0
  const total = bytes.length
  while (offset + 3 <= total) {
    if (bytes[offset] !== FRAME_HEAD_0 || bytes[offset + 1] !== FRAME_HEAD_1) {
      offset++
      resyncBytes++
      continue
    }
    const msgId = bytes[offset + 2]
    if (msgId === FMT_MSG_ID) {
      if (offset + FMT_MSG_LENGTH > total) break // truncated trailing frame
      const fmt = parseFmtPayload(view, bytes, offset + 3)
      formats.set(fmt.type, fmt)
      if (fmt.decodable && fmt.name in handlers) handledIds.set(fmt.type, fmt)
      offset += FMT_MSG_LENGTH
      continue
    }
    const fmt = formats.get(msgId)
    if (!fmt) {
      // Data before its FMT definition (or corruption): resync byte-wise.
      offset++
      resyncBytes++
      continue
    }
    if (offset + fmt.length > total) break // truncated trailing frame
    const handled = handledIds.get(msgId)
    if (handled) {
      const payloadOffset = offset + 3
      const fields: Record<string, FieldValue> = {}
      for (let index = 0; index < handled.format.length; index++) {
        fields[handled.columns[index]] = readField(
          view,
          payloadOffset + handled.offsets[index],
          handled.format[index],
          bytes,
        )
      }
      const timeUs = typeof fields.TimeUS === 'number' && Number.isFinite(fields.TimeUS)
        ? fields.TimeUS
        : typeof fields.TimeMS === 'number' && Number.isFinite(fields.TimeMS)
          ? fields.TimeMS * 1000
          : null
      if (timeUs !== null) {
        handlers[handled.name](fields, toSec(timeUs))
      }
    }
    offset += fmt.length
  }

  // --- assemble dataset ----------------------------------------------------
  const modeSegments = buildSegments(
    modeSamples.map((sample) => ({
      timeSec: sample.timeSec,
      label: decodeFlightMode('ardupilot', vehicleClass, sample.mode).name,
    })),
    endSec,
  )
  const armedSegments = buildSegments(armedSamples, endSec)
    .filter((segment) => segment.label === 'armed')
    .map((segment) => ({ ...segment, label: '已解锁' }))
  const totalArmedSec = armedSegments.reduce(
    (sum, segment) => sum + Math.max(0, segment.endSec - segment.startSec),
    0,
  )

  const startTimeUtcMs = gpsUtcRef.value
    ? gpsUtcRef.value.utcMs - gpsUtcRef.value.timeSec * 1000
    : null

  const motorSeries: SeriesData[] = motorIndices
    .map((channel, slot) => ({ channel, slot }))
    .sort((a, b) => a.channel - b.channel)
    .map(({ channel, slot }) =>
      finishEnvelope(`电机 ${channel} (µs)`, motorEnvelopes[slot]))
    .filter((series) => series.times.length > 0)

  const paramList: UlogParamEntry[] = [...params.entries()]
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => a.name.localeCompare(b.name))

  return {
    overview: {
      durationSec: endSec,
      startTimeUtcMs,
      startTimeSource: startTimeUtcMs === null ? null : 'gps',
      firmware,
      firmwareBranch: null,
      hardware,
      sysName: frameInfo,
      totalArmedSec,
      droppedMessages: resyncBytes,
    },
    modeSegments,
    armedSegments,
    events,
    attitude: [
      attitude.roll, attitude.rollSp,
      attitude.pitch, attitude.pitchSp,
      attitude.yaw, attitude.yawSp,
    ].map(finishRaw).filter((series) => series.times.length > 0),
    rates: [
      rates.roll, rates.rollSp,
      rates.pitch, rates.pitchSp,
      rates.yaw, rates.yawSp,
    ].map(finishRaw).filter((series) => series.times.length > 0),
    pidLoops: PID_LOOP_DEFS.map((def): PidLoopData => {
      const collectors = pidCollectors.get(def.msg)!
      return {
        id: def.id,
        label: def.label,
        series: [collectors.tar, collectors.act, collectors.err]
          .map(finishRaw).filter((series) => series.times.length > 0),
      }
    }).filter((loop) => loop.series.length > 0),
    actuators: motorSeries,
    actuatorSaturation: motorSeries.length > 0
      ? {
        saturationPct: motorSampleCount > 0 ? motorSaturatedCount / motorSampleCount * 100 : 0,
        motorCount: motorSeries.length,
      }
      : null,
    battery: [battery.voltage, battery.current, battery.power]
      .map(finishRaw).filter((series) => series.times.length > 0),
    gpsQuality: [gpsQuality.satellites, gpsQuality.hdop, gpsQuality.fix]
      .map(finishRaw).filter((series) => series.times.length > 0),
    altitude: [altitude.rel, altitude.baro, altitude.gps]
      .map(finishRaw).filter((series) => series.times.length > 0),
    velocity: [velocity.ground, velocity.vz]
      .map(finishRaw).filter((series) => series.times.length > 0),
    vibration: vibration.result(),
    rawAcc: [
      finishEnvelope('加速度 X (m/s²)', rawAcc[0]),
      finishEnvelope('加速度 Y (m/s²)', rawAcc[1]),
      finishEnvelope('加速度 Z (m/s²)', rawAcc[2]),
      ...[vibe.x, vibe.y, vibe.z].map(finishRaw),
    ].filter((series) => series.times.length > 0),
    params: paramList,
    track: track.lat.length > 1 ? track : null,
  }
}

/** True when a file name looks like an ArduPilot DataFlash log. */
export function isDataflashFileName(name: string): boolean {
  return name.toLowerCase().endsWith('.bin')
}

// Exported for tests: synthesize FMT/data frames without a real FC.
export const DATAFLASH_TEST_HOOKS = {
  FRAME_HEAD_0,
  FRAME_HEAD_1,
  FMT_MSG_ID,
  FMT_MSG_LENGTH,
  FIELD_SIZES,
}
