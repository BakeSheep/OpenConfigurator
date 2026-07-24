import { create } from 'zustand'
import type { ImuData, BaroData, OpticalFlowData, DistanceSensorData } from '../../shared/types'

type SensorField = 'imu' | 'baro' | 'opticalFlow' | 'distanceSensor'

interface SensorState {
  imu: ImuData | null
  imus: Partial<Record<number, ImuData>>
  baro: BaroData | null
  opticalFlow: OpticalFlowData | null
  distanceSensor: DistanceSensorData | null
  magData: { x: number; y: number; z: number } | null
  sensorHealth: Record<string, 'ok' | 'warning' | 'error' | 'offline'>
  // Timestamp (Date.now()) of the last update per sensor field. 0 = never
  // received OR marked stale by markAllOffline() on disconnect.
  lastUpdate: Record<SensorField, number>
  setImu: (data: ImuData, instance?: number) => void
  setBaro: (data: BaroData) => void
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
  baro: null,
  opticalFlow: null,
  distanceSensor: null,
  magData: null,
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
  setImu: (data, requestedInstance) => set((state) => {
    const instance = requestedInstance ?? data.instance ?? 0
    const normalized = { ...data, instance }
    const sensorHealth = state.sensorHealth.imu === 'ok' && state.sensorHealth.mag === 'ok'
      ? state.sensorHealth
      : { ...state.sensorHealth, imu: 'ok' as const, mag: 'ok' as const }
    return {
    imu: instance === 0 || state.imu === null ? normalized : state.imu,
    imus: { ...state.imus, [instance]: normalized },
    magData: instance === 0 || state.magData === null ? { x: data.xmag, y: data.ymag, z: data.zmag } : state.magData,
    sensorHealth,
    lastUpdate: { ...state.lastUpdate, imu: Date.now() },
  }}),
  setBaro: (data) => set((state) => ({
    baro: data,
    sensorHealth: { ...state.sensorHealth, baro: 'ok' },
    lastUpdate: { ...state.lastUpdate, baro: Date.now() },
  })),
  setOpticalFlow: (data) => set((state) => ({
    opticalFlow: data,
    sensorHealth: { ...state.sensorHealth, opticalFlow: data.quality > 0 ? 'ok' : 'warning' },
    lastUpdate: { ...state.lastUpdate, opticalFlow: Date.now() },
  })),
  setDistanceSensor: (data) => set((state) => {
    const withinRange = data.current_distance >= data.min_distance
      && data.current_distance <= data.max_distance
    // MAVLink: signal_quality=1 is invalid and 0 means unknown/unset. When
    // quality is unknown, a value pinned to either range limit is treated as
    // warning because it commonly represents saturation/no return.
    const signalUsable = data.signal_quality > 1
      || (data.signal_quality === 0
        && data.current_distance > data.min_distance
        && data.current_distance < data.max_distance)
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
  markAllOffline: () => set((state) => ({
    sensorHealth: Object.fromEntries(Object.keys(state.sensorHealth).map((k) => [k, 'offline' as const])),
    lastUpdate: zeroLastUpdate(),
  })),
  isStale: (field, thresholdMs) => {
    const ts = get().lastUpdate[field]
    if (ts === 0) return true
    const threshold = thresholdMs ?? SENSOR_STALE_THRESHOLDS[field]
    return Date.now() - ts > threshold
  },
}))
