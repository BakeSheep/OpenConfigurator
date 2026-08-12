// ArduPilot DataFlash (.bin) log parser. The format is self-describing: FMT
// messages (msg id 128) declare every message's id, length, name, per-field
// type codes and column names; data messages follow as 0xA3 0x95 <id> frames.
// The parser streams the buffer once into the same bounded collectors as the
// ULog worker and produces an identical UlogAnalysisDataset, so every chart
// component works unchanged. Framework-agnostic (worker + node tests).
import {
  EnvelopeCollector,
  VibrationAnalyzer,
  appendBoundedTransition,
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
import i18next from 'i18next'
import { BlobLogSource, StructuredDataflashDecoder } from '../../shared/logs'
import type { StructuredLogStreamSchema } from '../../shared/logs'

const t = i18next.t.bind(i18next)

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

type FieldValue = number | string

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
export async function parseDataflashLog(source: Blob | ArrayBuffer): Promise<UlogAnalysisDataset> {
  // --- collectors (mirror the ULog worker) ------------------------------
  const attitude = {
    roll: makeRaw('attitude.roll', t('logAnalysis.label.roll')),
    pitch: makeRaw('attitude.pitch', t('logAnalysis.label.pitch')),
    yaw: makeRaw('attitude.yaw', t('logAnalysis.label.yaw')),
    rollSp: makeRaw('attitude.rollSp', t('logAnalysis.label.rollSp')),
    pitchSp: makeRaw('attitude.pitchSp', t('logAnalysis.label.pitchSp')),
    yawSp: makeRaw('attitude.yawSp', t('logAnalysis.label.yawSp')),
  }
  const rates = {
    roll: makeRaw('rates.roll', t('logAnalysis.label.rollRate')),
    pitch: makeRaw('rates.pitch', t('logAnalysis.label.pitchRate')),
    yaw: makeRaw('rates.yaw', t('logAnalysis.label.yawRate')),
    rollSp: makeRaw('rates.rollSp', t('logAnalysis.label.rollRateSp')),
    pitchSp: makeRaw('rates.pitchSp', t('logAnalysis.label.pitchRateSp')),
    yawSp: makeRaw('rates.yawSp', t('logAnalysis.label.yawRateSp')),
  }
  const battery = {
    voltage: makeRaw('battery.voltage', t('logAnalysis.label.voltage')),
    current: makeRaw('battery.current', t('logAnalysis.label.current')),
    power: makeRaw('battery.power', t('logAnalysis.label.power')),
  }
  const gpsQuality = {
    satellites: makeRaw('gps.satellites', t('logAnalysis.label.satellites')),
    hdop: makeRaw('gps.hdop', t('logAnalysis.label.hdop')),
    fix: makeRaw('gps.fix', t('logAnalysis.label.fix')),
  }
  const altitude = {
    rel: makeRaw('altitude.relative', t('logAnalysis.label.relAlt')),
    baro: makeRaw('altitude.baro', t('logAnalysis.label.baroAlt')),
    gps: makeRaw('altitude.gps', t('logAnalysis.label.gpsAlt')),
  }
  const velocity = {
    ground: makeRaw('velocity.ground', t('logAnalysis.label.groundSpeed')),
    vz: makeRaw('velocity.down', t('logAnalysis.label.vz')),
  }
  const vibe = {
    x: makeRaw('rawAccel.vibeX', 'Vibe X (m/s²)'),
    y: makeRaw('rawAccel.vibeY', 'Vibe Y (m/s²)'),
    z: makeRaw('rawAccel.vibeZ', 'Vibe Z (m/s²)'),
  }
  const pidCollectors = new Map(PID_LOOP_DEFS.map((def) => [def.msg, {
    tar: makeRaw(`pid:${def.id}:target`, t('logAnalysis.label.target', { label: def.label })),
    act: makeRaw(`pid:${def.id}:actual`, t('logAnalysis.label.actual', { label: def.label })),
    err: makeRaw(`pid:${def.id}:error`, t('logAnalysis.label.error', { label: def.label })),
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
  let droppedStateSamples = 0

  let timelineTruncated = false
  let endSec = 0

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
      const result = appendBoundedTransition(
        modeSamples,
        { timeSec, mode },
        (previous, next) => previous.mode === next.mode,
      )
      if (result === 'full') droppedStateSamples++
    },
    EV: (fields, timeSec) => {
      const id = numField(fields, 'Id')
      if (!Number.isFinite(id)) return
      if (id === 10 || id === 11) {
        const label = id === 10 ? 'armed' : 'disarmed'
        const result = appendBoundedTransition(
          armedSamples,
          { timeSec, label },
          (previous, next) => previous.label === next.label,
        )
        if (result === 'full') droppedStateSamples++
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

  // --- unified structured decoder pass ----------------------------------
  // Charts and structured export share source parsing. This reducer retains
  // only bounded chart aggregates; the export consumer keeps every record.
  const blob = source instanceof Blob ? source : new Blob([source])
  const schemas = new Map<string, StructuredLogStreamSchema>()
  for await (const envelope of new StructuredDataflashDecoder().decode(
    new BlobLogSource('analysis.bin', blob),
  )) {
    if (envelope.kind === 'schema') {
      schemas.set(envelope.schema.streamId, envelope.schema)
      continue
    }
    if (envelope.kind === 'integrity') {
      if (envelope.issue.code === 'dataflash_resync_bytes') {
        resyncBytes += envelope.issue.count ?? 0
      } else if (envelope.issue.code.includes('truncated')) {
        resyncBytes++
      }
      continue
    }
    if (envelope.kind !== 'record') continue
    // Keep the historical page behavior for a concatenated multi-boot file;
    // the structured export still contains every boot and its boundary event.
    if (envelope.record.bootId > 0) {
      if (!timelineTruncated) {
        timelineTruncated = true
        if (events.length < MAX_EVENTS) {
          events.push({ timeSec: endSec, level: 4, message: t('logAnalysis.multipleBootsTruncated') })
        }
      }
      continue
    }
    const schema = schemas.get(envelope.record.streamId)
    if (!schema || !(schema.sourceName in handlers) || envelope.record.elapsedUs === null) continue
    const timeSec = Number(envelope.record.elapsedUs) / 1e6
    if (!Number.isFinite(timeSec)) continue
    if (timeSec > endSec) endSec = timeSec
    const fields: Record<string, FieldValue> = {}
    for (const [name, value] of Object.entries(envelope.record.data)) {
      if (typeof value === 'number' || typeof value === 'string') fields[name] = value
    }
    handlers[schema.sourceName](fields, timeSec)
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
    .map((segment) => ({ ...segment, label: 'armed' }))
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
      finishEnvelope(t('logAnalysis.label.motorUs', { channel }), motorEnvelopes[slot], `actuator.motorUs:${channel}`))
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
      droppedMessages: resyncBytes + droppedStateSamples,
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
      finishEnvelope(t('logAnalysis.label.accelX'), rawAcc[0], 'rawAccel.x'),
      finishEnvelope(t('logAnalysis.label.accelY'), rawAcc[1], 'rawAccel.y'),
      finishEnvelope(t('logAnalysis.label.accelZ'), rawAcc[2], 'rawAccel.z'),
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
