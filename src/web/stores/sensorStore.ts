import { create } from 'zustand'
import type { ImuData, BaroData, OpticalFlowData, DistanceSensorData } from '../../shared/types'
import {
  createMagInterferenceDetector,
  magFieldFromMilliGauss,
  type MagInterferenceReading,
} from '../utils/magInterference'

// A Zustand store is a module singleton. Replacing this module through Vite
// HMR can temporarily leave long-lived WebSocket code writing one instance
// while mounted components still subscribe to another. Force a clean reload
// after store edits in development; production builds never enter this path.
if (import.meta.hot) {
  import.meta.hot.accept(() => window.location.reload())
}

type SensorField = 'imu' | 'baro' | 'opticalFlow' | 'distanceSensor'

// Unit of the magnetometer components currently feeding magData. SCALED_IMU
// and HIGHRES_IMU are normalized to milligauss by the bridge; RAW_IMU carries
// uncalibrated raw counts that are NOT convertible to Gauss.
export type MagUnit = 'mgauss' | 'raw'

// The detector receives every frame, while UI-facing value writes are capped
// at 5 Hz unless the debounced warning state changes.
const MAG_INTERFERENCE_THROTTLE_MS = 200

// Module-level real-time detector + throttle bookkeeping. Kept out of the
// store so every MAVLink frame can advance the debounce without forcing React
// subscribers to render at the full telemetry rate.
const magDetector = createMagInterferenceDetector()
let lastMagInterferenceWriteAt = Number.NEGATIVE_INFINITY
let lastMagWarning = false

// MAVLink message stream an IMU update came from. PX4 emits HIGHRES_IMU,
// SCALED_IMU(2/3) and RAW_IMU concurrently for the same physical IMU; without
// arbitration they alternate-overwrite the same instance slot and the UI
// flickers between differently-scaled values (e.g. temperature 15 vs 47 degC).
export type ImuSource = 'HIGHRES_IMU' | 'SCALED_IMU' | 'RAW_IMU'

const IMU_SOURCE_PRIORITY: Record<ImuSource, number> = {
  HIGHRES_IMU: 2,
  SCALED_IMU: 1,
  RAW_IMU: 0,
}

// Temperature is arbitrated separately from motion data: SCALED_IMU/RAW_IMU
// carry the IMU die temperature (cdegC, 0 = no sensor), while PX4 is known to
// fill HIGHRES_IMU.temperature with a 15 degC ISA placeholder, so HIGHRES_IMU
// is the least trusted source for this field.
const IMU_TEMP_PRIORITY: Record<ImuSource, number> = {
  SCALED_IMU: 2,
  RAW_IMU: 1,
  HIGHRES_IMU: 0,
}

// If the preferred stream stops for this long, fall back to a lower-priority one.
const IMU_SOURCE_STALE_MS = 1500

// Baro updates arrive from SCALED_PRESSURE (real baro message with the die
// temperature) and from the HIGHRES_IMU pressure fallback (no trusted
// temperature; PX4 fills a 15 degC ISA placeholder). Without arbitration the
// two streams alternate-overwrite the card and the temperature flickers.
export type BaroSource = 'SCALED_PRESSURE' | 'HIGHRES_IMU_PRESSURE'
const BARO_SOURCE_STALE_MS = 2000

interface SensorState {
  imu: ImuData | null
  imus: Partial<Record<number, ImuData>>
  // Winning stream per IMU instance; lower-priority streams are dropped while
  // the winner is fresh (see setImu). Temperature has its own winner because
  // its trust order differs from the motion fields.
  imuSources: Partial<Record<number, { source: ImuSource; ts: number }>>
  imuTempSources: Partial<Record<number, { source: ImuSource; ts: number }>>
  baro: BaroData | null
  // Winning baro stream; the HIGHRES_IMU fallback is dropped while
  // SCALED_PRESSURE is fresh (see setBaro).
  baroSource: { source: BaroSource; ts: number } | null
  opticalFlow: OpticalFlowData | null
  distanceSensor: DistanceSensorData | null
  magData: { x: number; y: number; z: number } | null
  // Unit and timestamp of the stream currently feeding magData; interference
  // analysis only runs on 'mgauss' samples.
  magSource: { unit: MagUnit; ts: number } | null
  // Latest field magnitude plus its stabilized advisory classification.
  magInterference: MagInterferenceReading | null
  sensorHealth: Record<string, 'ok' | 'warning' | 'error' | 'offline'>
  // Timestamp (Date.now()) of the last update per sensor field. 0 = never
  // received OR marked stale by markAllOffline() on disconnect.
  lastUpdate: Record<SensorField, number>
  setImu: (data: ImuData, instance?: number, source?: ImuSource, nowMs?: number) => void
  setBaro: (data: BaroData, source?: BaroSource) => void
  setOpticalFlow: (data: OpticalFlowData) => void
  setDistanceSensor: (data: DistanceSensorData) => void
  setMag: (data: { x: number; y: number; z: number }) => void
  setSensorHealth: (sensor: string, status: 'ok' | 'warning' | 'error' | 'offline') => void
  // Called on link drop: revert all sensor health to 'offline' so the UI
  // dots turn grey. Sensor data itself is retained for greyed-out display.
  markAllOffline: () => void
  // Selector: true if the sensor field has not been updated within its
  // threshold. Mirrors telemetryStore.isStale so the UI can treat sensor
  // fields and telemetry fields uniformly.
  isStale: (field: SensorField, thresholdMs?: number) => boolean
}

const zeroLastUpdate = (): Record<SensorField, number> => ({
  imu: 0, baro: 0, opticalFlow: 0, distanceSensor: 0,
})

// Per-sensor freshness thresholds (ms). IMU streams fast; baro/flow/rangefinder
// are lower-rate and need more slack to avoid false stale reports.
const SENSOR_STALE_THRESHOLDS: Record<SensorField, number> = {
  imu: 1500,
  baro: 2000,
  opticalFlow: 2000,
  distanceSensor: 2000,
}

export const useSensorStore = create<SensorState>((set, get) => ({
  imu: null,
  imus: {},
  imuSources: {},
  imuTempSources: {},
  baro: null,
  baroSource: null,
  opticalFlow: null,
  distanceSensor: null,
  magData: null,
  magSource: null,
  magInterference: null,
  sensorHealth: {
    imu: 'offline',
    mag: 'offline',
    baro: 'offline',
    gps: 'offline',
    opticalFlow: 'offline',
    rangefinder: 'offline',
    battery: 'offline',
  },
  lastUpdate: zeroLastUpdate(),
  setImu: (data, requestedInstance, source = 'SCALED_IMU', nowMs) => set((state) => {
    const instance = requestedInstance ?? data.instance ?? 0
    const now = nowMs ?? Date.now()
    const previous = state.imus[instance]
    // Per-field arbitration for temperature: a null reading never claims the
    // slot, and a fresh higher-trust source keeps lower-trust values out.
    const tempWinner = state.imuTempSources[instance]
    const tempAccepted = data.temperature !== null && (!tempWinner
      || tempWinner.source === source
      || IMU_TEMP_PRIORITY[source] >= IMU_TEMP_PRIORITY[tempWinner.source]
      || now - tempWinner.ts >= IMU_SOURCE_STALE_MS)
    const imuTempSources = tempAccepted
      ? { ...state.imuTempSources, [instance]: { source, ts: now } }
      : state.imuTempSources
    const temperature = tempAccepted ? data.temperature : previous?.temperature ?? null
    const sensorHealth = state.sensorHealth.imu === 'ok' && state.sensorHealth.mag === 'ok'
      ? state.sensorHealth
      : { ...state.sensorHealth, imu: 'ok' as const, mag: 'ok' as const }
    // Arbitrate between concurrent IMU streams for the same instance: drop
    // motion updates from a lower-priority stream while a higher-priority one
    // is fresh, but still let every valid frame refresh sensor liveness and
    // let trusted lower-priority sources contribute the temperature field.
    const winner = state.imuSources[instance]
    if (winner && winner.source !== source
      && IMU_SOURCE_PRIORITY[winner.source] > IMU_SOURCE_PRIORITY[source]
      && now - winner.ts < IMU_SOURCE_STALE_MS) {
      if (!tempAccepted || !previous) {
        return {
          sensorHealth,
          lastUpdate: { ...state.lastUpdate, imu: now },
        }
      }
      const merged = { ...previous, temperature }
      return {
        imu: instance === 0 || state.imu === null ? merged : state.imu,
        imus: { ...state.imus, [instance]: merged },
        imuTempSources,
        sensorHealth,
        lastUpdate: { ...state.lastUpdate, imu: now },
      }
    }
    const normalized = { ...data, instance, temperature }
    // magData tracks the primary (instance 0) compass. RAW_IMU mag is raw
    // counts, so it is stored but never analyzed as a Gauss field.
    const updatesMag = instance === 0 || state.magData === null
    if (!updatesMag) {
      return {
        imu: instance === 0 || state.imu === null ? normalized : state.imu,
        imus: { ...state.imus, [instance]: normalized },
        imuSources: { ...state.imuSources, [instance]: { source, ts: now } },
        imuTempSources,
        sensorHealth,
        lastUpdate: { ...state.lastUpdate, imu: now },
      }
    }
    const unit: MagUnit = data.units === 'raw' ? 'raw' : 'mgauss'
    // A unit change (e.g. failing over between streams) invalidates the window.
    if (state.magSource && state.magSource.unit !== unit) {
      magDetector.reset()
      lastMagInterferenceWriteAt = Number.NEGATIVE_INFINITY
      lastMagWarning = false
    }
    let magInterference = state.magInterference
    if (unit === 'mgauss') {
      const reading = magDetector.update(magFieldFromMilliGauss(data.xmag, data.ymag, data.zmag), now)
      if (reading) {
        // Keep the displayed magnitude close to real time, and publish a
        // stabilized state transition immediately once its debounce completes.
        if (reading.warning !== lastMagWarning || now - lastMagInterferenceWriteAt >= MAG_INTERFERENCE_THROTTLE_MS) {
          magInterference = {
            fieldGauss: reading.fieldGauss,
            warning: reading.warning,
          }
          lastMagInterferenceWriteAt = now
          lastMagWarning = reading.warning
        }
      }
    } else {
      // Raw counts are not analyzable; drop any prior advisory.
      magInterference = null
    }
    return {
    imu: instance === 0 || state.imu === null ? normalized : state.imu,
    imus: { ...state.imus, [instance]: normalized },
    imuSources: { ...state.imuSources, [instance]: { source, ts: now } },
    imuTempSources,
    magData: { x: data.xmag, y: data.ymag, z: data.zmag },
    magSource: { unit, ts: now },
    magInterference,
    sensorHealth,
    lastUpdate: { ...state.lastUpdate, imu: now },
  }}),
  setBaro: (data, source = 'SCALED_PRESSURE') => set((state) => {
    const now = Date.now()
    // SCALED_PRESSURE always wins; the HIGHRES_IMU pressure fallback is only
    // accepted while no fresh SCALED_PRESSURE stream is active.
    if (
      source === 'HIGHRES_IMU_PRESSURE'
      && state.baroSource?.source === 'SCALED_PRESSURE'
      && now - state.baroSource.ts < BARO_SOURCE_STALE_MS
    ) return state
    // A null temperature never claims the slot: keep the last trusted reading
    // instead of blanking the UI when the fallback source takes over.
    const temperature = data.temperature ?? state.baro?.temperature ?? null
    return {
      baro: { ...data, temperature },
      baroSource: { source, ts: now },
      sensorHealth: { ...state.sensorHealth, baro: 'ok' },
      lastUpdate: { ...state.lastUpdate, baro: now },
    }
  }),
  setOpticalFlow: (data) => set((state) => ({
    opticalFlow: data,
    sensorHealth: { ...state.sensorHealth, opticalFlow: data.quality > 0 ? 'ok' : 'warning' },
    lastUpdate: { ...state.lastUpdate, opticalFlow: Date.now() },
  })),
  setDistanceSensor: (data) => set((state) => {
    const hasDeclaredRange = data.max_distance > data.min_distance
    const withinRange = hasDeclaredRange
      ? data.current_distance >= data.min_distance
        && data.current_distance <= data.max_distance
      : data.current_distance > 0
    // MAVLink: signal_quality=1 is invalid and 0 means unknown/unset. When
    // quality is unknown, a value pinned to either range limit is treated as
    // warning because it commonly represents saturation/no return.
    const signalUsable = data.signal_quality !== null && data.signal_quality > 1
      || ((data.signal_quality === null || data.signal_quality === 0)
        && (hasDeclaredRange
          ? data.current_distance > data.min_distance
            && data.current_distance < data.max_distance
          : data.current_distance > 0))
    return {
      distanceSensor: data,
      sensorHealth: { ...state.sensorHealth, rangefinder: withinRange && signalUsable ? 'ok' : 'warning' },
      lastUpdate: { ...state.lastUpdate, distanceSensor: Date.now() },
    }
  }),
  setMag: (data) => set({ magData: data }),
  setSensorHealth: (sensor, status) => set((state) => ({
    sensorHealth: { ...state.sensorHealth, [sensor]: status },
  })),
  markAllOffline: () => set((state) => {
    // Reset classification history so a new connection starts from live data.
    magDetector.reset()
    lastMagInterferenceWriteAt = Number.NEGATIVE_INFINITY
    lastMagWarning = false
    return {
      sensorHealth: Object.fromEntries(Object.keys(state.sensorHealth).map((k) => [k, 'offline' as const])),
      lastUpdate: zeroLastUpdate(),
      // Reset stream arbitration so the next connection re-elects a winner.
      imuSources: {},
      imuTempSources: {},
      baroSource: null,
      magSource: null,
      magInterference: null,
    }
  }),
  isStale: (field, thresholdMs) => {
    const ts = get().lastUpdate[field]
    if (ts === 0) return true
    const threshold = thresholdMs ?? SENSOR_STALE_THRESHOLDS[field]
    return Date.now() - ts > threshold
  },
}))
