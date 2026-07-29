/// <reference lib="webworker" />
// ULog analysis worker: parses a .ulg ArrayBuffer with @foxglove/ulog and
// streams every data message once into bounded collectors, so the main thread
// only ever receives the pre-digested UlogAnalysisDataset (each series is
// downsampled to a few thousand points).
import { LogLevel, MessageType, ULog } from '@foxglove/ulog'
import type { FieldStruct } from '@foxglove/ulog'
import {
  CopyingBufferReader,
  EnvelopeCollector,
  NAV_STATE_NAMES,
  RAD_TO_DEG,
  VibrationAnalyzer,
  buildSegments,
  downsampleMinMax,
  quaternionToEuler,
  type SeriesData,
  type UlogAnalysisDataset,
  type UlogEvent,
  type UlogWorkerResult,
} from '../utils/ulogAnalysis'

const MAX_SERIES_POINTS = 4000
const MAX_EVENTS = 500
const ENVELOPE_BUCKET_SEC = 0.05
const TRACK_MIN_INTERVAL_SEC = 0.2
const MAX_MOTORS = 12

function num(value: unknown): number {
  if (typeof value === 'number') return value
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'boolean') return value ? 1 : 0
  return Number.NaN
}

function numArray(value: unknown): number[] | null {
  return Array.isArray(value) ? value.map(num) : null
}

interface RawSeries {
  label: string
  times: number[]
  values: number[]
}

// A raw series compacts itself once it grows past the trigger, keeping worker
// memory bounded on multi-hour 200 Hz+ topics (attitude/rates) instead of
// accumulating millions of samples until finishRaw(). Min/max downsampling
// preserves spikes; the target stays well above the final render resolution
// so repeated compaction barely affects the output.
const RAW_COMPACT_TRIGGER = MAX_SERIES_POINTS * 8
const RAW_COMPACT_TARGET = MAX_SERIES_POINTS * 2

function makeRaw(label: string): RawSeries {
  return { label, times: [], values: [] }
}

function pushRaw(series: RawSeries, timeSec: number, value: number): void {
  if (!Number.isFinite(value)) return
  series.times.push(timeSec)
  series.values.push(value)
  if (series.times.length >= RAW_COMPACT_TRIGGER) {
    const compacted = downsampleMinMax(series.times, series.values, RAW_COMPACT_TARGET)
    series.times = compacted.times
    series.values = compacted.values
  }
}

function finishRaw(series: RawSeries): SeriesData {
  const { times, values } = downsampleMinMax(series.times, series.values, MAX_SERIES_POINTS)
  return { label: series.label, times, values }
}

function finishEnvelope(label: string, collector: EnvelopeCollector): SeriesData {
  const { times, values } = collector.finish()
  const bounded = downsampleMinMax(times, values, MAX_SERIES_POINTS)
  return { label, times: bounded.times, values: bounded.values }
}

function infoString(map: Map<string, unknown> | undefined, key: string): string | null {
  const value = map?.get(key)
  return typeof value === 'string' && value.length > 0 ? value : null
}

async function analyze(buffer: ArrayBuffer): Promise<UlogAnalysisDataset> {
  // CopyingBufferReader instead of the library's DataReader: see its doc
  // comment for the offset-semantics bug the copy avoids.
  const ulog = new ULog(new CopyingBufferReader(buffer))
  await ulog.open()
  const header = ulog.header
  if (!header) throw new Error('无法解析 ULog 文件头')
  // open() builds a complete timestamp index. Use it for duration and the
  // origin so valid logs without our chart topics do not incorrectly show —.
  const timeRange = ulog.timeRange()
  const indexedStartUs = timeRange?.[0] ?? header.timestamp
  const indexedDurationSec = timeRange
    ? Math.max(0, Number(timeRange[1] - timeRange[0]) / 1e6)
    : 0

  // --- collectors -----------------------------------------------------
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
    eph: makeRaw('水平精度 (m)'),
    epv: makeRaw('垂直精度 (m)'),
    fix: makeRaw('定位类型'),
  }
  const altitude = {
    local: makeRaw('相对高度 (m)'),
    baro: makeRaw('气压高度 (m)'),
    gps: makeRaw('GPS 海拔 (m)'),
  }
  const velocity = {
    vx: makeRaw('北向速度 (m/s)'),
    vy: makeRaw('东向速度 (m/s)'),
    vz: makeRaw('垂直速度 (m/s)'),
    ground: makeRaw('地速 (m/s)'),
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
  let timeBaseUs: bigint = indexedStartUs
  let endSec = indexedDurationSec

  const toSec = (timestamp: bigint): number => {
    const seconds = Number(timestamp - timeBaseUs) / 1e6
    if (seconds > endSec) endSec = seconds
    return seconds
  }

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
    },
    vehicle_rates_setpoint: (value, timeSec) => {
      pushRaw(rates.rollSp, timeSec, num(value.roll) * RAD_TO_DEG)
      pushRaw(rates.pitchSp, timeSec, num(value.pitch) * RAD_TO_DEG)
      pushRaw(rates.yawSp, timeSec, num(value.yaw) * RAD_TO_DEG)
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
        const label = NAV_STATE_NAMES[navState] ?? `模式 ${navState}`
        if (modeSamples[modeSamples.length - 1]?.label !== label) {
          modeSamples.push({ timeSec, label })
        }
      }
      const armingState = num(value.arming_state)
      if (Number.isFinite(armingState)) {
        const label = armingState === 2 ? 'armed' : 'disarmed'
        if (armedSamples[armedSamples.length - 1]?.label !== label) {
          armedSamples.push({ timeSec, label })
        }
      }
    },
  }

  // Only request the message ids we actually consume - readMessages skips the rest.
  const wantedIds = new Set<number>()
  for (const [msgId, subscription] of ulog.subscriptions) {
    if (subscription.multiId === 0 && subscription.name in handlers) wantedIds.add(msgId)
  }

  for await (const message of ulog.readMessages()) {
    if (message.type === MessageType.Data) {
      if (!wantedIds.has(message.msgId)) continue
      const subscription = ulog.subscriptions.get(message.msgId)
      if (!subscription) continue
      const value = message.value
      const timestamp = typeof value.timestamp === 'bigint'
        ? value.timestamp
        : BigInt(Math.trunc(num(value.timestamp) || 0))
      handlers[subscription.name]?.(value, toSec(timestamp))
    } else if (message.type === MessageType.Log || message.type === MessageType.LogTagged) {
      if (message.logLevel <= LogLevel.Info && events.length < MAX_EVENTS) {
        events.push({
          timeSec: Number(message.timestamp - timeBaseUs) / 1e6,
          level: message.logLevel,
          message: message.message,
        })
      }
    } else if (message.type === MessageType.Dropout) {
      droppedMessages++
    }
  }

  // --- assemble dataset -------------------------------------------------
  const modeSegments = buildSegments(modeSamples, endSec)
  const armedSegments = buildSegments(armedSamples, endSec)
    .filter((segment) => segment.label === 'armed')
    .map((segment) => ({ ...segment, label: '已解锁' }))
  const totalArmedSec = armedSegments.reduce(
    (sum, segment) => sum + Math.max(0, segment.endSec - segment.startSec),
    0,
  )

  const params = [...header.parameters.entries()]
    .map(([name, entry]) => ({ name, value: entry.value }))
    .sort((a, b) => a.name.localeCompare(b.name))

  const startTimeUtcMs = gpsUtcRef.value
    ? gpsUtcRef.value.utcMs - gpsUtcRef.value.timeSec * 1000
    : null

  const motorSeries = motorEnvelopes.map((collector, index) =>
    finishEnvelope(
      motorLabelsFromPwm ? `电机 ${index + 1} (µs)` : `电机 ${index + 1}`,
      collector,
    ),
  ).filter((series) => series.times.length > 0)

  const dataset: UlogAnalysisDataset = {
    overview: {
      durationSec: endSec,
      startTimeUtcMs,
      startTimeSource: startTimeUtcMs === null ? null : 'gps',
      firmware: infoString(header.information, 'ver_sw_release')
        ?? infoString(header.information, 'ver_sw'),
      firmwareBranch: infoString(header.information, 'ver_sw_branch'),
      hardware: infoString(header.information, 'ver_hw'),
      sysName: infoString(header.information, 'sys_name'),
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
      finishEnvelope('加速度 X (m/s²)', rawAcc[0]),
      finishEnvelope('加速度 Y (m/s²)', rawAcc[1]),
      finishEnvelope('加速度 Z (m/s²)', rawAcc[2]),
    ].filter((series) => series.times.length > 0),
    params,
    track: track.lat.length > 1 ? track : null,
  }
  return dataset
}

self.onmessage = (event: MessageEvent<ArrayBuffer>) => {
  void (async () => {
    try {
      const dataset = await analyze(event.data)
      ;(self as unknown as { postMessage(message: UlogWorkerResult): void })
        .postMessage({ dataset })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      ;(self as unknown as { postMessage(message: UlogWorkerResult): void })
        .postMessage({ error: `ULog 解析失败：${message}` })
    }
  })()
}
