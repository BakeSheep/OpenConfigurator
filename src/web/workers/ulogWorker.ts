/// <reference lib="webworker" />
// ULog analysis worker: parses a .ulg Blob with @foxglove/ulog and
// streams every data message once into bounded collectors, so the main thread
// only ever receives the pre-digested UlogAnalysisDataset (each series is
// downsampled to a few thousand points).
import { LogLevel } from '@foxglove/ulog'
import type { FieldStruct } from '@foxglove/ulog'
import {
  EnvelopeCollector,
  NAV_STATE_NAMES,
  RAD_TO_DEG,
  VibrationAnalyzer,
  appendBoundedTransition,
  buildSegments,
  quaternionToEuler,
  type UlogAnalysisDataset,
  type UlogEvent,
  type UlogWorkerRequest,
  type UlogWorkerResult,
} from '../utils/ulogAnalysis'
import { BlobLogSource, StructuredUlogDecoder } from '../../shared/logs'
import type { StructuredJsonValue, StructuredLogStreamSchema } from '../../shared/logs'
import {
  finishEnvelope,
  finishRaw,
  makeRaw,
  pushRaw,
} from '../utils/seriesCompression'
import i18next from 'i18next'
import { zh } from '../i18n/locales/zh'
import { en } from '../i18n/locales/en'

i18next.init({
  resources: { zh: { translation: zh }, en: { translation: en } },
  lng: 'zh',
  fallbackLng: 'zh',
  interpolation: { escapeValue: false },
})
const t = i18next.t.bind(i18next)

const MAX_EVENTS = 500
const ENVELOPE_BUCKET_SEC = 0.05
const TRACK_MIN_INTERVAL_SEC = 0.2
const MAX_MOTORS = 12

function num(value: unknown): number {
  if (typeof value === 'number') return value
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'string' && value.trim() !== '') return Number(value)
  if (typeof value === 'boolean') return value ? 1 : 0
  return Number.NaN
}

function numArray(value: unknown): number[] | null {
  return Array.isArray(value) ? value.map(num) : null
}

function infoString(map: Record<string, StructuredJsonValue>, key: string): string | null {
  const value = map[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

async function analyze(blob: Blob): Promise<UlogAnalysisDataset> {
  // --- collectors -----------------------------------------------------
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
  // PX4 logs no per-loop PID error topic; hold the latest rate setpoint and
  // subtract each angular-velocity sample from it (both already in deg/s).
  const pidError = {
    roll: makeRaw('pid:roll:error', t('logAnalysis.label.error', { label: 'Roll' })),
    pitch: makeRaw('pid:pitch:error', t('logAnalysis.label.error', { label: 'Pitch' })),
    yaw: makeRaw('pid:yaw:error', t('logAnalysis.label.error', { label: 'Yaw' })),
  }
  const lastRatesSp: { value: { roll: number; pitch: number; yaw: number } | null } = { value: null }
  const battery = {
    voltage: makeRaw('battery.voltage', t('logAnalysis.label.voltage')),
    current: makeRaw('battery.current', t('logAnalysis.label.current')),
    power: makeRaw('battery.power', t('logAnalysis.label.power')),
  }
  const gpsQuality = {
    satellites: makeRaw('gps.satellites', t('logAnalysis.label.satellites')),
    eph: makeRaw('gps.hdop', t('logAnalysis.label.hdop')),
    epv: makeRaw('gps.vdop', t('logAnalysis.label.vdop')),
    fix: makeRaw('gps.fix', t('logAnalysis.label.fix')),
  }
  const altitude = {
    local: makeRaw('altitude.relative', t('logAnalysis.label.relAlt')),
    baro: makeRaw('altitude.baro', t('logAnalysis.label.baroAlt')),
    gps: makeRaw('altitude.gps', t('logAnalysis.label.gpsAlt')),
  }
  const velocity = {
    vx: makeRaw('velocity.north', t('logAnalysis.label.velNorth')),
    vy: makeRaw('velocity.east', t('logAnalysis.label.velEast')),
    vz: makeRaw('velocity.down', t('logAnalysis.label.vz')),
    ground: makeRaw('velocity.ground', t('logAnalysis.label.groundSpeed')),
  }
  let motorEnvelopes: EnvelopeCollector[] = []
  let motorLabelsFromPwm = true
  let motorSampleCount = 0
  let motorSaturatedCount = 0
  const vibration = new VibrationAnalyzer()
  const rawAcc: [EnvelopeCollector, EnvelopeCollector, EnvelopeCollector] = [
    new EnvelopeCollector(ENVELOPE_BUCKET_SEC),
    new EnvelopeCollector(ENVELOPE_BUCKET_SEC),
    new EnvelopeCollector(ENVELOPE_BUCKET_SEC),
  ]
  const modeSamples: Array<{ timeSec: number; label: string }> = []
  const armedSamples: Array<{ timeSec: number; label: string }> = []
  const events: UlogEvent[] = []
  const track = {
    timesSec: [] as number[],
    lat: [] as number[],
    lon: [] as number[],
    altM: [] as Array<number | null>,
  }
  let lastTrackSec = -Infinity
  let haveGlobalPosition = false
  // Wrapped in a holder because TS does not track assignments made inside
  // the topic-handler closures.
  const gpsUtcRef: { value: { utcMs: number; timeSec: number } | null } = { value: null }
  let droppedMessages = 0
  let endSec = 0
  let information: Record<string, StructuredJsonValue> = {}

  // --- topic handlers ---------------------------------------------------
  const handleGpsFix = (value: FieldStruct, timeSec: number) => {
    pushRaw(gpsQuality.satellites, timeSec, num(value.satellites_used))
    pushRaw(gpsQuality.eph, timeSec, num(value.eph))
    pushRaw(gpsQuality.epv, timeSec, num(value.epv))
    pushRaw(gpsQuality.fix, timeSec, num(value.fix_type))
    const lat = 'latitude_deg' in value ? num(value.latitude_deg) : num(value.lat) / 1e7
    const lon = 'longitude_deg' in value ? num(value.longitude_deg) : num(value.lon) / 1e7
    const altM = 'altitude_msl_m' in value ? num(value.altitude_msl_m) : num(value.alt) / 1000
    if (Number.isFinite(altM)) pushRaw(altitude.gps, timeSec, altM)
    const utcUsec = num(value.time_utc_usec)
    if (!gpsUtcRef.value && Number.isFinite(utcUsec) && utcUsec > 1e15) {
      gpsUtcRef.value = { utcMs: utcUsec / 1000, timeSec }
    }
    // GPS-derived track is the fallback when vehicle_global_position is absent.
    if (
      !haveGlobalPosition
      && Number.isFinite(lat) && Number.isFinite(lon)
      && (lat !== 0 || lon !== 0)
      && num(value.fix_type) >= 2
      && timeSec - lastTrackSec >= TRACK_MIN_INTERVAL_SEC
    ) {
      lastTrackSec = timeSec
      track.timesSec.push(timeSec)
      track.lat.push(lat)
      track.lon.push(lon)
      track.altM.push(Number.isFinite(altM) ? altM : null)
    }
  }

  const handleActuatorSample = (outputs: number[], timeSec: number, isPwm: boolean) => {
    if (motorEnvelopes.length === 0) {
      const count = Math.min(MAX_MOTORS, outputs.length)
      motorLabelsFromPwm = isPwm
      motorEnvelopes = Array.from(
        { length: count },
        () => new EnvelopeCollector(ENVELOPE_BUCKET_SEC),
      )
    }
    let sampleMax = Number.NEGATIVE_INFINITY
    let any = false
    for (let index = 0; index < motorEnvelopes.length; index++) {
      const value = outputs[index]
      if (!Number.isFinite(value)) continue
      // PWM value 0 means "output not driven" (unassigned channel).
      if (isPwm && value === 0) continue
      motorEnvelopes[index].add(timeSec, value)
      sampleMax = Math.max(sampleMax, value)
      any = true
    }
    if (any) {
      motorSampleCount++
      if (sampleMax >= (isPwm ? 1950 : 0.98)) motorSaturatedCount++
    }
  }

  let haveActuatorMotors = false
  const handlers: Record<string, (value: FieldStruct, timeSec: number) => void> = {
    vehicle_attitude: (value, timeSec) => {
      const q = numArray(value.q)
      if (!q || q.length < 4) return
      const euler = quaternionToEuler(q[0], q[1], q[2], q[3])
      pushRaw(attitude.roll, timeSec, euler.roll * RAD_TO_DEG)
      pushRaw(attitude.pitch, timeSec, euler.pitch * RAD_TO_DEG)
      pushRaw(attitude.yaw, timeSec, euler.yaw * RAD_TO_DEG)
    },
    vehicle_attitude_setpoint: (value, timeSec) => {
      const qd = numArray(value.q_d)
      if (qd && qd.length >= 4 && qd.some((component) => component !== 0)) {
        const euler = quaternionToEuler(qd[0], qd[1], qd[2], qd[3])
        pushRaw(attitude.rollSp, timeSec, euler.roll * RAD_TO_DEG)
        pushRaw(attitude.pitchSp, timeSec, euler.pitch * RAD_TO_DEG)
        pushRaw(attitude.yawSp, timeSec, euler.yaw * RAD_TO_DEG)
        return
      }
      // Older firmwares logged Euler setpoints directly.
      pushRaw(attitude.rollSp, timeSec, num(value.roll_body) * RAD_TO_DEG)
      pushRaw(attitude.pitchSp, timeSec, num(value.pitch_body) * RAD_TO_DEG)
      pushRaw(attitude.yawSp, timeSec, num(value.yaw_body) * RAD_TO_DEG)
    },
    vehicle_angular_velocity: (value, timeSec) => {
      const xyz = numArray(value.xyz)
      if (!xyz || xyz.length < 3) return
      pushRaw(rates.roll, timeSec, xyz[0] * RAD_TO_DEG)
      pushRaw(rates.pitch, timeSec, xyz[1] * RAD_TO_DEG)
      pushRaw(rates.yaw, timeSec, xyz[2] * RAD_TO_DEG)
      const sp = lastRatesSp.value
      if (sp) {
        pushRaw(pidError.roll, timeSec, sp.roll - xyz[0] * RAD_TO_DEG)
        pushRaw(pidError.pitch, timeSec, sp.pitch - xyz[1] * RAD_TO_DEG)
        pushRaw(pidError.yaw, timeSec, sp.yaw - xyz[2] * RAD_TO_DEG)
      }
    },
    vehicle_rates_setpoint: (value, timeSec) => {
      pushRaw(rates.rollSp, timeSec, num(value.roll) * RAD_TO_DEG)
      pushRaw(rates.pitchSp, timeSec, num(value.pitch) * RAD_TO_DEG)
      pushRaw(rates.yawSp, timeSec, num(value.yaw) * RAD_TO_DEG)
      const roll = num(value.roll) * RAD_TO_DEG
      const pitch = num(value.pitch) * RAD_TO_DEG
      const yaw = num(value.yaw) * RAD_TO_DEG
      if (Number.isFinite(roll) && Number.isFinite(pitch) && Number.isFinite(yaw)) {
        lastRatesSp.value = { roll, pitch, yaw }
      }
    },
    actuator_motors: (value, timeSec) => {
      const controls = numArray(value.control)
      if (!controls) return
      if (!haveActuatorMotors) {
        // Normalized controls supersede the PWM mirror once observed.
        haveActuatorMotors = true
        motorEnvelopes = []
        motorSampleCount = 0
        motorSaturatedCount = 0
      }
      handleActuatorSample(
        controls.filter((entry) => Number.isFinite(entry)),
        timeSec,
        false,
      )
    },
    actuator_outputs: (value, timeSec) => {
      if (haveActuatorMotors) return
      const outputs = numArray(value.output)
      if (!outputs) return
      const count = Math.min(
        MAX_MOTORS,
        Number.isFinite(num(value.noutputs)) && num(value.noutputs) > 0
          ? num(value.noutputs)
          : outputs.length,
      )
      handleActuatorSample(outputs.slice(0, count), timeSec, true)
    },
    battery_status: (value, timeSec) => {
      const voltage = num(value.voltage_v)
      if (voltage > 0) pushRaw(battery.voltage, timeSec, voltage)
      const current = num(value.current_a)
      pushRaw(battery.current, timeSec, current)
      if (voltage > 0 && Number.isFinite(current)) {
        pushRaw(battery.power, timeSec, voltage * current)
      }
    },
    vehicle_gps_position: handleGpsFix,
    sensor_gps: handleGpsFix,
    vehicle_local_position: (value, timeSec) => {
      const z = num(value.z)
      if (Number.isFinite(z)) pushRaw(altitude.local, timeSec, -z)
      const vx = num(value.vx)
      const vy = num(value.vy)
      pushRaw(velocity.vx, timeSec, vx)
      pushRaw(velocity.vy, timeSec, vy)
      pushRaw(velocity.vz, timeSec, -num(value.vz))
      if (Number.isFinite(vx) && Number.isFinite(vy)) {
        pushRaw(velocity.ground, timeSec, Math.hypot(vx, vy))
      }
    },
    vehicle_air_data: (value, timeSec) => {
      pushRaw(altitude.baro, timeSec, num(value.baro_alt_meter))
    },
    vehicle_global_position: (value, timeSec) => {
      const lat = num(value.lat)
      const lon = num(value.lon)
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) return
      if (!haveGlobalPosition) {
        haveGlobalPosition = true
        track.timesSec.length = 0
        track.lat.length = 0
        track.lon.length = 0
        track.altM.length = 0
        lastTrackSec = -Infinity
      }
      if (timeSec - lastTrackSec < TRACK_MIN_INTERVAL_SEC) return
      lastTrackSec = timeSec
      track.timesSec.push(timeSec)
      track.lat.push(lat)
      track.lon.push(lon)
      const alt = num(value.alt)
      track.altM.push(Number.isFinite(alt) ? alt : null)
    },
    sensor_combined: (value, timeSec) => {
      const acc = numArray(value.accelerometer_m_s2)
      if (!acc || acc.length < 3) return
      vibration.addSample(timeSec, acc[0], acc[1], acc[2])
      rawAcc[0].add(timeSec, acc[0])
      rawAcc[1].add(timeSec, acc[1])
      rawAcc[2].add(timeSec, acc[2])
    },
    vehicle_status: (value, timeSec) => {
      const navState = num(value.nav_state)
      if (Number.isFinite(navState)) {
        const label = NAV_STATE_NAMES[navState] ?? `Mode ${navState}`
        if (appendBoundedTransition(
          modeSamples,
          { timeSec, label },
          (previous, next) => previous.label === next.label,
        ) === 'full') droppedMessages++
      }
      const armingState = num(value.arming_state)
      if (Number.isFinite(armingState)) {
        const label = armingState === 2 ? 'armed' : 'disarmed'
        if (appendBoundedTransition(
          armedSamples,
          { timeSec, label },
          (previous, next) => previous.label === next.label,
        ) === 'full') droppedMessages++
      }
    },
  }

  const schemas = new Map<string, StructuredLogStreamSchema>()
  const parameterValues = new Map<string, { value: number; type?: number }>()
  for await (const envelope of new StructuredUlogDecoder().decode(
    new BlobLogSource('analysis.ulg', blob),
  )) {
    if (envelope.kind === 'schema') {
      schemas.set(envelope.schema.streamId, envelope.schema)
    } else if (envelope.kind === 'record') {
      const schema = schemas.get(envelope.record.streamId)
      if (!schema || schema.sourceInstance !== 0 || !(schema.sourceName in handlers)) continue
      const timeSec = envelope.record.elapsedUs === null ? Number.NaN : Number(envelope.record.elapsedUs) / 1e6
      if (!Number.isFinite(timeSec)) {
        droppedMessages++
        continue
      }
      if (timeSec > endSec) endSec = timeSec
      handlers[schema.sourceName]?.(envelope.record.data as unknown as FieldStruct, timeSec)
    } else if (envelope.kind === 'event') {
      const timeSec = envelope.event.elapsedUs === null ? 0 : Number(envelope.event.elapsedUs) / 1e6
      if (Number.isFinite(timeSec) && timeSec > endSec) endSec = timeSec
      if ((envelope.event.type === 'log' || envelope.event.type === 'log-tagged')
        && envelope.event.level !== null && envelope.event.level <= LogLevel.Info
        && events.length < MAX_EVENTS) {
        events.push({
          timeSec,
          level: envelope.event.level,
          message: envelope.event.message ?? '',
        })
      }
      if (envelope.event.type === 'dropout') droppedMessages++
    } else if (envelope.kind === 'parameter' && envelope.parameter.kind !== 'default') {
      const value = num(envelope.parameter.value)
      if (Number.isFinite(value)) {
        parameterValues.set(envelope.parameter.name, {
          value,
          type: envelope.parameter.mavParamType,
        })
      }
    } else if (envelope.kind === 'complete') {
      information = envelope.metadata.information
      if (envelope.metadata.firstTimeUs !== null && envelope.metadata.lastTimeUs !== null) {
        endSec = Math.max(endSec, Number(BigInt(envelope.metadata.lastTimeUs) - BigInt(envelope.metadata.firstTimeUs)) / 1e6)
      }
    }
  }

  // --- assemble dataset -------------------------------------------------
  const modeSegments = buildSegments(modeSamples, endSec)
  const armedSegments = buildSegments(armedSamples, endSec)
    .filter((segment) => segment.label === 'armed')
    .map((segment) => ({ ...segment, label: 'armed' }))
  const totalArmedSec = armedSegments.reduce(
    (sum, segment) => sum + Math.max(0, segment.endSec - segment.startSec),
    0,
  )

  const params = [...parameterValues.entries()]
    .map(([name, entry]) => ({ name, value: entry.value, type: entry.type }))
    .sort((a, b) => a.name.localeCompare(b.name))

  const startTimeUtcMs = gpsUtcRef.value
    ? gpsUtcRef.value.utcMs - gpsUtcRef.value.timeSec * 1000
    : null

  const motorSeries = motorEnvelopes.map((collector, index) =>
    finishEnvelope(
      motorLabelsFromPwm ? t('logAnalysis.label.motorUs', {channel: index + 1}) : t('logAnalysis.label.motor', {channel: index + 1}),
      collector,
      `actuator.motor${motorLabelsFromPwm ? 'Us' : ''}:${index + 1}`,
    ),
  ).filter((series) => series.times.length > 0)

  const dataset: UlogAnalysisDataset = {
    overview: {
      durationSec: endSec,
      startTimeUtcMs,
      startTimeSource: startTimeUtcMs === null ? null : 'gps',
      firmware: infoString(information, 'ver_sw_release')
        ?? infoString(information, 'ver_sw'),
      firmwareBranch: infoString(information, 'ver_sw_branch'),
      hardware: infoString(information, 'ver_hw'),
      sysName: infoString(information, 'sys_name'),
      totalArmedSec,
      droppedMessages,
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
    // Rate-loop PID tracking: target = setpoint, actual = angular velocity,
    // error streamed above. Loops without any data are dropped.
    pidLoops: [
      { id: 'roll', label: 'Roll', tar: rates.rollSp, act: rates.roll, err: pidError.roll },
      { id: 'pitch', label: 'Pitch', tar: rates.pitchSp, act: rates.pitch, err: pidError.pitch },
      { id: 'yaw', label: 'Yaw', tar: rates.yawSp, act: rates.yaw, err: pidError.yaw },
    ].map((loop) => ({
      id: loop.id,
      label: loop.label,
      unit: '°/s',
      series: [
        { ...finishRaw(loop.tar), id: `pid:${loop.id}:target`, label: t('logAnalysis.label.target', { label: loop.label }) },
        { ...finishRaw(loop.act), id: `pid:${loop.id}:actual`, label: t('logAnalysis.label.actual', { label: loop.label }) },
        { ...finishRaw(loop.err), id: `pid:${loop.id}:error`, label: t('logAnalysis.label.error', { label: loop.label }) },
      ].filter((series) => series.times.length > 0),
    })).filter((loop) => loop.series.length > 0),
    actuators: motorSeries,
    actuatorSaturation: motorSeries.length > 0
      ? {
        saturationPct: motorSampleCount > 0 ? motorSaturatedCount / motorSampleCount * 100 : 0,
        motorCount: motorSeries.length,
      }
      : null,
    battery: [battery.voltage, battery.current, battery.power]
      .map(finishRaw).filter((series) => series.times.length > 0),
    gpsQuality: [gpsQuality.satellites, gpsQuality.eph, gpsQuality.epv, gpsQuality.fix]
      .map(finishRaw).filter((series) => series.times.length > 0),
    altitude: [altitude.local, altitude.baro, altitude.gps]
      .map(finishRaw).filter((series) => series.times.length > 0),
    velocity: [velocity.vx, velocity.vy, velocity.vz, velocity.ground]
      .map(finishRaw).filter((series) => series.times.length > 0),
    vibration: vibration.result(),
    rawAcc: [
      finishEnvelope(t('logAnalysis.label.accelX'), rawAcc[0], 'rawAccel.x'),
      finishEnvelope(t('logAnalysis.label.accelY'), rawAcc[1], 'rawAccel.y'),
      finishEnvelope(t('logAnalysis.label.accelZ'), rawAcc[2], 'rawAccel.z'),
    ].filter((series) => series.times.length > 0),
    params,
    track: track.lat.length > 1 ? track : null,
  }
  return dataset
}

self.onmessage = (event: MessageEvent<UlogWorkerRequest>) => {
  void (async () => {
    try {
      await i18next.changeLanguage(event.data.language)
      const dataset = await analyze(event.data.blob)
      ;(self as unknown as { postMessage(message: UlogWorkerResult): void })
        .postMessage({ dataset })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      ;(self as unknown as { postMessage(message: UlogWorkerResult): void })
        .postMessage({ error: t('logAnalysis.ulogParseFailed', {message}) })
    }
  })()
}
