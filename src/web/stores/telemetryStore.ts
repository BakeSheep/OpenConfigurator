import { create } from 'zustand'
import type { AttitudeData, GpsData, BatteryData, VehicleStatus, EkfStatusData, RcChannelsData } from '../../shared/types'

export type StatusSeverity = 'emergency' | 'alert' | 'critical' | 'error' | 'warning' | 'notice' | 'info' | 'debug'

export interface StatusLogEntry {
  id: number
  severity: StatusSeverity
  text: string
  time: number
}

interface TelemetryState {
  attitude: AttitudeData | null
  gps: GpsData | null
  battery: BatteryData | null
  status: VehicleStatus | null
  ekfStatus: EkfStatusData | null
  rcChannels: RcChannelsData | null
  altitude: number
  relativeAlt: number
  groundSpeed: number
  airSpeed: number
  climbRate: number
  heading: number
  throttle: number
  globalPosition: { lat: number; lon: number; alt: number; relative_alt: number; vx: number; vy: number; vz: number; hdg: number } | null
  statusLogs: StatusLogEntry[]
  setAttitude: (data: AttitudeData) => void
  setGps: (data: GpsData) => void
  setBattery: (data: BatteryData) => void
  setStatus: (data: VehicleStatus) => void
  setEkfStatus: (data: EkfStatusData) => void
  setRcChannels: (data: RcChannelsData) => void
  setVfrHud: (data: any) => void
  setGlobalPosition: (data: any) => void
  setSysStatus: (data: any) => void
  addStatusLog: (severity: number, text: string) => void
  clearStatusLogs: () => void
}

const severityNames: StatusSeverity[] = ['emergency', 'alert', 'critical', 'error', 'warning', 'notice', 'info', 'debug']
let statusLogIdCounter = 0

export const useTelemetryStore = create<TelemetryState>((set) => ({
  attitude: null,
  gps: null,
  battery: null,
  status: null,
  ekfStatus: null,
  rcChannels: null,
  altitude: 0,
  relativeAlt: 0,
  groundSpeed: 0,
  airSpeed: 0,
  climbRate: 0,
  heading: 0,
  throttle: 0,
  globalPosition: null,
  statusLogs: [],
  setAttitude: (data) => set({ attitude: data }),
  setGps: (data) => set({ gps: data }),
  setBattery: (data) => set({ battery: data }),
  setStatus: (data) => set({ status: data }),
  setEkfStatus: (data) => set({ ekfStatus: data }),
  setRcChannels: (data) => set({ rcChannels: data }),
  setVfrHud: (data) => set({
    airSpeed: data.airspeed,
    groundSpeed: data.groundspeed,
    altitude: data.alt,
    climbRate: data.climb,
    heading: data.heading,
    throttle: data.throttle,
  }),
  setGlobalPosition: (data) => set({
    globalPosition: data,
    relativeAlt: data.relative_alt,
  }),
  setSysStatus: (data) => set((state) => ({
    battery: {
      voltage: data.voltageBattery || state.battery?.voltage || 0,
      current: data.currentBattery || state.battery?.current || 0,
      remaining: data.batteryRemaining >= 0 ? data.batteryRemaining : state.battery?.remaining || 0,
      consumed_mah: state.battery?.consumed_mah || 0,
    },
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
}))
