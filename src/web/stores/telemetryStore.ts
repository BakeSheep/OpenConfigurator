import { create } from 'zustand'
import type { AttitudeData, GpsData, BatteryData, VehicleStatus, EkfStatusData, RcChannelsData, MotorOutputData, AutopilotVersionData, SysStatusData, VfrHudData, GlobalPositionData, VehicleIdentity } from '../../shared/types'
import type { ServerMessage } from '../../shared/types'
import {
  appendGpsTrackPoint,
  isTrackableGpsFix,
  type GpsTrackOrigin,
  type GpsTrackPoint,
} from '../utils/gpsTrack'

export type StatusSeverity = 'emergency' | 'alert' | 'critical' | 'error' | 'warning' | 'notice' | 'info' | 'debug'

export interface StatusLogEntry {
  id: number
  severity: StatusSeverity
  text: string
  time: number
}

export interface CommandAckState {
  command: number
  result: number
  requestId?: string
  progress?: number
  terminal?: boolean
  time: number
}

export type OperationErrorState = Extract<ServerMessage, { type: 'operation_error' }>['data'] & { time: number }

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
  gpsTrack: GpsTrackPoint[]
  gpsTrackOrigin: GpsTrackOrigin | null
  battery: BatteryData | null
  /** Latest BATTERY_STATUS values keyed by MAVLink battery instance. */
  batteries: Map<number, BatteryData>
  batteryLastUpdate: Map<number, number>
  // Which message currently feeds `battery`: BATTERY_STATUS is authoritative,
  // SYS_STATUS is only a fallback while BATTERY_STATUS is absent/stale.
  batterySource: 'battery_status' | 'sys_status' | null
  status: VehicleStatus | null
  ekfStatus: EkfStatusData | null
  rcChannels: RcChannelsData | null
  motorOutputs: MotorOutputData | null
  autopilotVersion: AutopilotVersionData | null
  // Selected vehicle identity from the backend 'target'/'status' messages.
  // Kept independent of the parameter set and cleared on target reset or
  // disconnect so a reconnected vehicle never reuses a stale profile.
  vehicleIdentity: VehicleIdentity | null
  preflightCheck: boolean | null
  sensorsHealthy: boolean | null
  // Autopilot mainloop load in percent from SYS_STATUS; null until received.
  cpuLoad: number | null
  unhealthySensorMask: number
  unhealthySensors: string[]
  altitude: number
  relativeAlt: number
  groundSpeed: number
  airSpeed: number
  climbRate: number
  heading: number
  throttle: number
  globalPosition: GlobalPositionData | null
  statusLogs: StatusLogEntry[]
  lastOperationError: OperationErrorState | null
  lastCommandAck: CommandAckState | null
  // Timestamp (Date.now()) of the last update per field. 0 = never received OR
  // explicitly marked stale by markAllStale() on disconnect. UI uses isStale()
  // to decide whether to grey out / freeze rendering.
  lastUpdate: Record<TelemetryField, number>
  setAttitude: (data: AttitudeData) => void
  setGps: (data: GpsData) => void
  clearGpsTrack: () => void
  recenterGpsTrack: () => void
  setBattery: (data: BatteryData) => void
  setStatus: (data: VehicleStatus) => void
  setEkfStatus: (data: EkfStatusData) => void
  setRcChannels: (data: RcChannelsData) => void
  setMotorOutputs: (data: MotorOutputData) => void
  setAutopilotVersion: (data: AutopilotVersionData | null) => void
  setVehicleIdentity: (identity: VehicleIdentity | null) => void
  setVfrHud: (data: VfrHudData) => void
  setGlobalPosition: (data: GlobalPositionData) => void
  setSysStatus: (data: SysStatusData) => void
  addStatusLog: (severity: number, text: string) => void
  setOperationError: (error: Omit<OperationErrorState, 'time'>) => void
  setCommandAck: (ack: Omit<CommandAckState, 'time'>) => void
  clearStatusLogs: () => void
  // Called on link drop: keep the last values (so the UI can show "frozen"
  // state in grey) but force every field to be considered stale.
  markAllStale: () => void
  // Selector: true if the field has not been updated within its threshold.
  isStale: (field: TelemetryField, thresholdMs?: number) => boolean
  isBatteryStale: (id: number, thresholdMs?: number) => boolean
}

const severityNames: StatusSeverity[] = ['emergency', 'alert', 'critical', 'error', 'warning', 'notice', 'info', 'debug']
let statusLogIdCounter = 0

const zeroLastUpdate = (): Record<TelemetryField, number> => ({
  attitude: 0, gps: 0, battery: 0, status: 0, ekfStatus: 0,
  rcChannels: 0, motorOutputs: 0, vfrHud: 0, globalPosition: 0, sysStatus: 0,
})

export function isValidBatteryVoltage(value: number | null): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

export const useTelemetryStore = create<TelemetryState>((set, get) => ({
  attitude: null,
  gps: null,
  gpsTrack: [],
  gpsTrackOrigin: null,
  battery: null,
  batteries: new Map(),
  batteryLastUpdate: new Map(),
  batterySource: null,
  status: null,
  ekfStatus: null,
  rcChannels: null,
  motorOutputs: null,
  autopilotVersion: null,
  vehicleIdentity: null,
  preflightCheck: null,
  sensorsHealthy: null,
  cpuLoad: null,
  unhealthySensorMask: 0,
  unhealthySensors: [],
  altitude: 0,
  relativeAlt: 0,
  groundSpeed: 0,
  airSpeed: 0,
  climbRate: 0,
  heading: 0,
  throttle: 0,
  globalPosition: null,
  statusLogs: [],
  lastOperationError: null,
  lastCommandAck: null,
  lastUpdate: zeroLastUpdate(),
  setAttitude: (data) => set((state) => ({ attitude: data, lastUpdate: { ...state.lastUpdate, attitude: Date.now() } })),
  setGps: (data) => set((state) => {
    const now = Date.now()
    const gpsTrack = appendGpsTrackPoint(state.gpsTrack, data, now)
    return {
      gps: data,
      gpsTrack,
      gpsTrackOrigin: state.gpsTrackOrigin ?? (isTrackableGpsFix(data) ? { lat: data.lat, lon: data.lon } : null),
      lastUpdate: { ...state.lastUpdate, gps: now },
    }
  }),
  clearGpsTrack: () => set({ gpsTrack: [], gpsTrackOrigin: null }),
  recenterGpsTrack: () => set((state) => {
    const latest = state.gpsTrack[state.gpsTrack.length - 1]
    if (latest) return { gpsTrackOrigin: { lat: latest.lat, lon: latest.lon } }
    return isTrackableGpsFix(state.gps)
      ? { gpsTrackOrigin: { lat: state.gps.lat, lon: state.gps.lon } }
      : {}
  }),
  // Keep each BATTERY_STATUS instance intact. In particular, do not fill an
  // unknown field from the previously displayed battery: independent battery
  // IDs may be interleaved on the same MAVLink link.
  setBattery: (data) => set((state) => {
    const normalized: BatteryData = {
      ...data,
      voltage: isValidBatteryVoltage(data.voltage) ? data.voltage : null,
      cell_voltages: data.cell_voltages.map((voltage) =>
        isValidBatteryVoltage(voltage) ? voltage : null),
    }
    const now = Date.now()
    const batteries = new Map(state.batteries)
    const batteryLastUpdate = new Map(state.batteryLastUpdate)
    batteries.set(normalized.id, normalized)
    batteryLastUpdate.set(normalized.id, now)
    const primaryId = batteries.has(0) ? 0 : Math.min(...batteries.keys())
    return {
      batteries,
      batteryLastUpdate,
      battery: batteries.get(primaryId) ?? normalized,
      batterySource: 'battery_status',
      lastUpdate: { ...state.lastUpdate, battery: now },
    }
  }),
  setStatus: (data) => set((state) => ({
    status: data,
    // The heartbeat-derived status carries the authoritative identity; keep
    // the store copy in sync so profile-driven UI follows reconnects.
    vehicleIdentity: data.identity ?? state.vehicleIdentity,
    lastUpdate: { ...state.lastUpdate, status: Date.now() },
  })),
  setEkfStatus: (data) => set((state) => ({ ekfStatus: data, lastUpdate: { ...state.lastUpdate, ekfStatus: Date.now() } })),
  setRcChannels: (data) => set((state) => ({ rcChannels: data, lastUpdate: { ...state.lastUpdate, rcChannels: Date.now() } })),
  setMotorOutputs: (data) => set((state) => ({ motorOutputs: data, lastUpdate: { ...state.lastUpdate, motorOutputs: Date.now() } })),
  setAutopilotVersion: (data) => set({ autopilotVersion: data }),
  setVehicleIdentity: (identity) => set(identity
    ? { vehicleIdentity: identity }
    : {
        vehicleIdentity: null,
        battery: null,
        batteries: new Map(),
        batteryLastUpdate: new Map(),
        batterySource: null,
      }),
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
  setSysStatus: (data) => set((state) => {
    const now = Date.now()
    // MAVLink recommends BATTERY_STATUS over the ambiguous SYS_STATUS fields.
    // Only use SYS_STATUS as a fallback when no recent BATTERY_STATUS exists.
    // The source flag distinguishes a fresh fallback stamp from a real
    // BATTERY_STATUS stamp, so fallback data keeps refreshing every cycle.
    const batteryStatusFresh = state.batterySource === 'battery_status'
      && now - state.lastUpdate.battery <= STALE_THRESHOLDS.battery
    // Only synthesize a fallback battery when SYS_STATUS carries a valid
    // voltage; otherwise a monitor-less ArduPilot would show 0.0 V · 99%.
    const sysStatusHasVoltage = isValidBatteryVoltage(data.voltageBattery)
    const fallbackBattery: BatteryData | null = batteryStatusFresh
      ? state.battery
      : sysStatusHasVoltage
        ? {
            id: 0,
            voltage: data.voltageBattery,
            cell_voltages: [],
            current: data.currentBattery,
            remaining: data.batteryRemaining,
            consumed_mah: null,
          }
        : null
    return {
      battery: fallbackBattery,
      ...(fallbackBattery && !batteryStatusFresh
        ? {
            batteries: new Map(state.batteries).set(0, fallbackBattery),
            batteryLastUpdate: new Map(state.batteryLastUpdate).set(0, now),
          }
        : {}),
      batterySource: batteryStatusFresh
        ? state.batterySource
        : sysStatusHasVoltage ? 'sys_status' : state.batterySource,
      preflightCheck: data.preflightCheck,
      sensorsHealthy: data.sensorsHealthy,
      cpuLoad: data.cpuLoad,
      unhealthySensorMask: data.unhealthySensorMask,
      unhealthySensors: data.unhealthySensors,
      lastUpdate: {
        ...state.lastUpdate,
        sysStatus: now,
        // The fallback is fresh data: stamp the battery timestamp too so
        // consumers that only check it (e.g. RealtimeChart) do not grey out
        // live fallback values.
        ...(batteryStatusFresh || !sysStatusHasVoltage ? {} : { battery: now }),
      },
    }
  }),
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
  setCommandAck: (ack) => set({ lastCommandAck: { ...ack, time: Date.now() } }),
  setOperationError: (error) => set({ lastOperationError: { ...error, time: Date.now() } }),
  clearStatusLogs: () => set({ statusLogs: [] }),
  markAllStale: () => set((state) => ({
    lastUpdate: zeroLastUpdate(),
    batteryLastUpdate: new Map([...state.batteryLastUpdate.keys()].map((id) => [id, 0])),
  })),
  isStale: (field, thresholdMs) => {
    const ts = get().lastUpdate[field]
    if (ts === 0) return true
    const threshold = thresholdMs ?? STALE_THRESHOLDS[field]
    return Date.now() - ts > threshold
  },
  isBatteryStale: (id, thresholdMs) => {
    const ts = get().batteryLastUpdate.get(id) ?? 0
    if (ts === 0) return true
    return Date.now() - ts > (thresholdMs ?? STALE_THRESHOLDS.battery)
  },
}))
