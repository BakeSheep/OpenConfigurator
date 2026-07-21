import { create } from 'zustand'
import type { AttitudeData, GpsData, BatteryData, VehicleStatus, EkfStatusData, RcChannelsData, MotorOutputData } from '../../shared/types'

export type StatusSeverity = 'emergency' | 'alert' | 'critical' | 'error' | 'warning' | 'notice' | 'info' | 'debug'

export interface StatusLogEntry {
  id: number
  severity: StatusSeverity
  text: string
  time: number
}

// Per-field freshness thresholds (ms). High-rate streams (attitude/imu/motors)
// must update frequently; low-rate streams (gps/battery) are allowed more
// slack so they don't falsely report stale between valid updates.
type TelemetryField =
  | 'attitude' | 'gps' | 'battery' | 'status' | 'ekfStatus'
  | 'rcChannels' | 'motorOutputs' | 'vfrHud' | 'globalPosition' | 'sysStatus'

const STALE_THRESHOLDS: Record<TelemetryField, number> = {
  attitude: 1500,
  gps: 3000,
  battery: 3000,
  status: 3000,        // HEARTBEAT @ 1 Hz
  ekfStatus: 3000,
  rcChannels: 1000,
  motorOutputs: 1000,
  vfrHud: 2000,
  globalPosition: 1500,
  sysStatus: 3000,
}

interface TelemetryState {
  attitude: AttitudeData | null
  gps: GpsData | null
  battery: BatteryData | null
  status: VehicleStatus | null
  ekfStatus: EkfStatusData | null
  rcChannels: RcChannelsData | null
  motorOutputs: MotorOutputData | null
  altitude: number
  relativeAlt: number
  groundSpeed: number
  airSpeed: number
  climbRate: number
  heading: number
  throttle: number
  globalPosition: { lat: number; lon: number; alt: number; relative_alt: number; vx: number; vy: number; vz: number; hdg: number } | null
  statusLogs: StatusLogEntry[]
  // Timestamp (Date.now()) of the last update per field. 0 = never received OR
  // explicitly marked stale by markAllStale() on disconnect. UI uses isStale()
  // to decide whether to grey out / freeze rendering.
  lastUpdate: Record<TelemetryField, number>
  setAttitude: (data: AttitudeData) => void
  setGps: (data: GpsData) => void
  setBattery: (data: BatteryData) => void
  setStatus: (data: VehicleStatus) => void
  setEkfStatus: (data: EkfStatusData) => void
  setRcChannels: (data: RcChannelsData) => void
  setMotorOutputs: (data: MotorOutputData) => void
  setVfrHud: (data: any) => void
  setGlobalPosition: (data: any) => void
  setSysStatus: (data: any) => void
  addStatusLog: (severity: number, text: string) => void
  clearStatusLogs: () => void
  // Called on link drop: keep the last values (so the UI can show "frozen"
  // state in grey) but force every field to be considered stale.
  markAllStale: () => void
  // Selector: true if the field has not been updated within its threshold.
  isStale: (field: TelemetryField, thresholdMs?: number) => boolean
}

const severityNames: StatusSeverity[] = ['emergency', 'alert', 'critical', 'error', 'warning', 'notice', 'info', 'debug']
let statusLogIdCounter = 0

const zeroLastUpdate = (): Record<TelemetryField, number> => ({
  attitude: 0, gps: 0, battery: 0, status: 0, ekfStatus: 0,
  rcChannels: 0, motorOutputs: 0, vfrHud: 0, globalPosition: 0, sysStatus: 0,
})

export const useTelemetryStore = create<TelemetryState>((set, get) => ({
  attitude: null,
  gps: null,
  battery: null,
  status: null,
  ekfStatus: null,
  rcChannels: null,
  motorOutputs: null,
  altitude: 0,
  relativeAlt: 0,
  groundSpeed: 0,
  airSpeed: 0,
  climbRate: 0,
  heading: 0,
  throttle: 0,
  globalPosition: null,
  statusLogs: [],
  lastUpdate: zeroLastUpdate(),
  setAttitude: (data) => set((state) => ({ attitude: data, lastUpdate: { ...state.lastUpdate, attitude: Date.now() } })),
  setGps: (data) => set((state) => ({ gps: data, lastUpdate: { ...state.lastUpdate, gps: Date.now() } })),
  setBattery: (data) => set((state) => ({ battery: data, lastUpdate: { ...state.lastUpdate, battery: Date.now() } })),
  setStatus: (data) => set((state) => ({ status: data, lastUpdate: { ...state.lastUpdate, status: Date.now() } })),
  setEkfStatus: (data) => set((state) => ({ ekfStatus: data, lastUpdate: { ...state.lastUpdate, ekfStatus: Date.now() } })),
  setRcChannels: (data) => set((state) => ({ rcChannels: data, lastUpdate: { ...state.lastUpdate, rcChannels: Date.now() } })),
  setMotorOutputs: (data) => set((state) => ({ motorOutputs: data, lastUpdate: { ...state.lastUpdate, motorOutputs: Date.now() } })),
  setVfrHud: (data) => set((state) => ({
    airSpeed: data.airspeed,
    groundSpeed: data.groundspeed,
    altitude: data.alt,
    climbRate: data.climb,
    heading: data.heading,
    throttle: data.throttle,
    lastUpdate: { ...state.lastUpdate, vfrHud: Date.now() },
  })),
  setGlobalPosition: (data) => set((state) => ({
    globalPosition: data,
    relativeAlt: data.relative_alt,
    lastUpdate: { ...state.lastUpdate, globalPosition: Date.now() },
  })),
  setSysStatus: (data) => set((state) => ({
    battery: {
      voltage: data.voltageBattery || state.battery?.voltage || 0,
      current: data.currentBattery || state.battery?.current || 0,
      remaining: data.batteryRemaining >= 0 ? data.batteryRemaining : state.battery?.remaining || 0,
      consumed_mah: state.battery?.consumed_mah || 0,
    },
    lastUpdate: { ...state.lastUpdate, sysStatus: Date.now() },
  })),
  addStatusLog: (severity, text) => set((state) => {
    const sevIdx = Math.min(Math.max(severity, 0), 7)
    const entry: StatusLogEntry = {
      id: ++statusLogIdCounter,
      severity: severityNames[sevIdx],
      text,
      time: Date.now(),
    }
    const next = [entry, ...state.statusLogs]
    return { statusLogs: next.slice(0, 200) }
  }),
  clearStatusLogs: () => set({ statusLogs: [] }),
  markAllStale: () => set({ lastUpdate: zeroLastUpdate() }),
  isStale: (field, thresholdMs) => {
    const ts = get().lastUpdate[field]
    if (ts === 0) return true
    const threshold = thresholdMs ?? STALE_THRESHOLDS[field]
    return Date.now() - ts > threshold
  },
}))
