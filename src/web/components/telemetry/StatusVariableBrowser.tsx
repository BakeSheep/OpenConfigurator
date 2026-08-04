import { useEffect, useMemo, useRef, useState } from 'react'
import Icon from '../ui/Icon'
import { useConnectionStore, type LinkStats } from '../../stores/connectionStore'
import {
  isMavlinkMessageLive,
  measuredMavlinkHz,
  useMavlinkMessageStore,
  type MavlinkMessageSample,
} from '../../stores/mavlinkMessageStore'
import { useSensorStore } from '../../stores/sensorStore'
import { useTelemetryStore } from '../../stores/telemetryStore'
import type { ImuData, RcChannelsData } from '../../../shared/types'
import { statusGroupDescription, statusVariableDescription } from '../../utils/statusVariableMetadata'

interface StatusEntry {
  name: string
  value: string | null
  unit?: string
}

export interface StatusGroup {
  name: string
  entries: StatusEntry[]
}

type TelemetrySnapshot = ReturnType<typeof useTelemetryStore.getState>
type SensorSnapshot = ReturnType<typeof useSensorStore.getState>
type MessageSnapshot = Record<string, MavlinkMessageSample>

// High-rate telemetry arrives at tens of Hz. Subscribing to the whole stores
// would rebuild the entire variable tree for every message, so the browser
// (and the dashboard custom board) samples a snapshot at a fixed interval.
export const STATUS_SNAPSHOT_INTERVAL_MS = 500

export function readStatusVariableSnapshot() {
  return {
    telemetry: useTelemetryStore.getState(),
    sensors: useSensorStore.getState(),
    messages: useMavlinkMessageStore.getState().messages,
    linkStats: useConnectionStore.getState().linkStats,
    sampledAt: Date.now(),
  }
}

export type StatusVariableSnapshot = ReturnType<typeof readStatusVariableSnapshot>

const RAD2DEG = 180 / Math.PI

function num(value: number | null | undefined, digits = 4): string | null {
  if (value == null || !Number.isFinite(value)) return null
  return value.toFixed(digits)
}

function int(value: number | null | undefined): string | null {
  if (value == null || !Number.isFinite(value)) return null
  return String(Math.round(value))
}

function bool(value: boolean | null | undefined): string | null {
  if (value == null) return null
  return value ? 'true' : 'false'
}

interface CompassStreamDefinition {
  group: string
  msgType: 'SCALED_IMU' | 'RAW_IMU' | 'HIGHRES_IMU' | 'SCALED_IMU2' | 'SCALED_IMU3'
  unit: 'mG' | 'count'
  unitLabel: 'normalized' | 'raw'
}

const COMPASS_STREAMS: readonly CompassStreamDefinition[] = [
  { group: 'COMPASS_SCALED_IMU', msgType: 'SCALED_IMU', unit: 'mG', unitLabel: 'normalized' },
  { group: 'COMPASS_RAW_IMU', msgType: 'RAW_IMU', unit: 'count', unitLabel: 'raw' },
  { group: 'COMPASS_HIGHRES_IMU', msgType: 'HIGHRES_IMU', unit: 'mG', unitLabel: 'normalized' },
  { group: 'COMPASS_SCALED_IMU2', msgType: 'SCALED_IMU2', unit: 'mG', unitLabel: 'normalized' },
  { group: 'COMPASS_SCALED_IMU3', msgType: 'SCALED_IMU3', unit: 'mG', unitLabel: 'normalized' },
]

function compassData(sample: MavlinkMessageSample | undefined, nowMs: number): ImuData | null {
  if (!sample || !isMavlinkMessageLive(sample, nowMs)) return null
  if (sample.latestData === null || typeof sample.latestData !== 'object' || Array.isArray(sample.latestData)) return null
  const data = sample.latestData as Partial<ImuData>
  if (![data.xmag, data.ymag, data.zmag].every((value) => typeof value === 'number' && Number.isFinite(value))) {
    return null
  }
  return data as ImuData
}

// Assemble the display tree from what the stores actually hold. A stale field
// (lastUpdate === 0, e.g. after disconnect) renders as "--" instead of a
// frozen number so the operator never reads dead data as live.
// Exported so DashboardPage's custom data board can offer the same variables.
export function buildGroups(
  t: TelemetrySnapshot,
  s: SensorSnapshot,
  link: LinkStats | null,
  messages: MessageSnapshot = {},
  nowMs = Date.now(),
): StatusGroup[] {
  const att = t.lastUpdate.attitude > 0 ? t.attitude : null
  const vfr = t.lastUpdate.vfrHud > 0
  const gp = t.lastUpdate.globalPosition > 0 ? t.globalPosition : null
  const hb = t.lastUpdate.status > 0 ? t.status : null
  const bat = t.lastUpdate.battery > 0 || t.lastUpdate.sysStatus > 0 ? t.battery : null
  const gps = t.lastUpdate.gps > 0 ? t.gps : null
  const ekf = t.lastUpdate.ekfStatus > 0 ? t.ekfStatus : null
  const rc = t.lastUpdate.rcChannels > 0 ? t.rcChannels : null
  const motors = t.lastUpdate.motorOutputs > 0 ? t.motorOutputs : null
  const sys = t.lastUpdate.sysStatus > 0
  const baro = s.lastUpdate.baro > 0 ? s.baro : null
  const flow = s.lastUpdate.opticalFlow > 0 ? s.opticalFlow : null
  const range = s.lastUpdate.distanceSensor > 0 ? s.distanceSensor : null
  const imuFresh = s.lastUpdate.imu > 0
  const av = t.autopilotVersion

  const estimatorFlag = (mask: number): string | null => ekf ? bool((ekf.health_flags & mask) !== 0) : null
  const now = new Date(nowMs)
  const rangeOrientationNames: Record<number, string> = {
    0: 'rotationNone', 24: 'rotationPitch90', 25: 'rotationPitch270',
    1: 'rotationYaw45', 2: 'rotationYaw90', 3: 'rotationYaw135',
    4: 'rotationYaw180', 5: 'rotationYaw225', 6: 'rotationYaw270', 7: 'rotationYaw315',
  }
  const rangeDirection = range ? rangeOrientationNames[range.orientation] : undefined

  // QGC/Mico-style canonical status catalog. Unsupported variables stay
  // visible as "--" so operators can distinguish “not supplied” from “not
  // implemented in the UI”. The 20 groups below intentionally total 192
  // variables; OpenConfigurator-specific diagnostics are appended afterwards.
  const canonicalGroups: StatusGroup[] = [
    {
      name: 'Vehicle',
      entries: [
        { name: 'airSpeed', value: vfr ? num(t.airSpeed) : null, unit: 'm/s' },
        { name: 'altitudeAboveTerr', value: null, unit: 'm' },
        { name: 'altitudeAMSL', value: vfr ? num(t.altitude) : null, unit: 'm' },
        { name: 'altitudeRelative', value: gp ? num(t.relativeAlt) : null, unit: 'm' },
        { name: 'climbRate', value: vfr ? num(t.climbRate) : null, unit: 'm/s' },
        { name: 'distanceToGCS', value: null, unit: 'm' },
        { name: 'distanceToHome', value: null, unit: 'm' },
        { name: 'distanceToNextWP', value: null, unit: 'm' },
        { name: 'flightDistance', value: null, unit: 'm' },
        { name: 'flightTime', value: null },
        { name: 'groundSpeed', value: vfr ? num(t.groundSpeed) : null, unit: 'm/s' },
        { name: 'heading', value: vfr ? num(t.heading) : null, unit: 'deg' },
        { name: 'headingFromGCS', value: null, unit: 'deg' },
        { name: 'headingFromHome', value: null, unit: 'deg' },
        { name: 'headingToHome', value: null, unit: 'deg' },
        { name: 'headingToNextWP', value: null, unit: 'deg' },
        { name: 'hobbs', value: null },
        { name: 'imuTemp', value: s.imus[0] ? num(s.imus[0].temperature, 1) : null, unit: 'C' },
        { name: 'missionItemIndex', value: null },
        { name: 'pitch', value: att ? num(att.pitch * RAD2DEG) : null, unit: 'deg' },
        { name: 'pitchRate', value: att ? num(att.pitchspeed * RAD2DEG) : null, unit: 'deg/s' },
        { name: 'roll', value: att ? num(att.roll * RAD2DEG) : null, unit: 'deg' },
        { name: 'rollRate', value: att ? num(att.rollspeed * RAD2DEG) : null, unit: 'deg/s' },
        { name: 'throttlePct', value: vfr ? int(t.throttle) : null, unit: '%' },
        { name: 'timeToHome', value: null },
        { name: 'yawRate', value: att ? num(att.yawspeed * RAD2DEG) : null, unit: 'deg/s' },
      ],
    },
    {
      name: 'Battery0',
      entries: [
        { name: 'batteryFunction', value: null }, { name: 'batteryType', value: null },
        { name: 'chargeState', value: null },
        { name: 'current', value: bat ? num(bat.current, 2) : null, unit: 'A' },
        { name: 'id', value: bat ? int(bat.id) : null },
        { name: 'instantPower', value: bat?.voltage != null && bat.current != null ? num(bat.voltage * bat.current, 2) : null, unit: 'W' },
        { name: 'mahConsumed', value: bat ? int(bat.consumed_mah) : null, unit: 'mAh' },
        { name: 'percentRemaining', value: bat ? int(bat.remaining) : null, unit: '%' },
        { name: 'temperature', value: null, unit: 'C' }, { name: 'timeRemaining', value: null },
        { name: 'timeRemainingStr', value: null },
        { name: 'voltage', value: bat ? num(bat.voltage, 2) : null, unit: 'V' },
      ],
    },
    { name: 'Clock', entries: [
      { name: 'currentDate', value: now.toLocaleDateString() },
      { name: 'currentTime', value: now.toLocaleTimeString() },
      { name: 'currentUTCTime', value: now.toISOString().slice(11, 19) },
    ] },
    { name: 'DistanceSensor', entries: [
      { name: 'maxDistance', value: range ? num(range.max_distance, 2) : null, unit: 'm' },
      { name: 'minDistance', value: range ? num(range.min_distance, 2) : null, unit: 'm' },
      ...['rotationNone', 'rotationPitch90', 'rotationPitch270', 'rotationYaw45', 'rotationYaw90',
        'rotationYaw135', 'rotationYaw180', 'rotationYaw225', 'rotationYaw270', 'rotationYaw315']
        .map((name) => ({ name, value: rangeDirection === name && range ? num(range.current_distance, 2) : null, unit: 'm' })),
    ] },
    { name: 'EscStatus0', entries: ['connectionType', 'count', 'current', 'errorCount', 'failureFlags', 'id', 'info', 'rpm', 'temperature', 'voltage'].map((name) => ({ name, value: null })) },
    { name: 'EstimatorStatus', entries: [
      { name: 'accelError', value: estimatorFlag(2048) },
      { name: 'goodAttitudeEsimate', value: estimatorFlag(1) },
      { name: 'goodConstPosModeEstimate', value: estimatorFlag(128) },
      { name: 'goodHorizPosAbsEstimate', value: estimatorFlag(16) },
      { name: 'goodHorizPosRelEstimate', value: estimatorFlag(8) },
      { name: 'goodHorizVelEstimate', value: estimatorFlag(2) },
      { name: 'goodPredHorizPosAbsEstimate', value: estimatorFlag(512) },
      { name: 'goodPredHorizPosRelEstimate', value: estimatorFlag(256) },
      { name: 'goodVertPosAbsEstimate', value: estimatorFlag(32) },
      { name: 'goodVertPosAGLEstimate', value: estimatorFlag(64) },
      { name: 'goodVertVelEstimate', value: estimatorFlag(4) },
      { name: 'gpsGlitch', value: estimatorFlag(1024) },
      { name: 'haglRatio', value: null }, { name: 'horizPosAccuracy', value: null },
      { name: 'horizPosRatio', value: ekf ? num(ekf.innovation_pos) : null },
      { name: 'magRatio', value: ekf ? num(ekf.innovation_mag) : null },
      { name: 'tasRatio', value: null }, { name: 'velRatio', value: ekf ? num(ekf.innovation_vel) : null },
      { name: 'vertPosAccuracy', value: null }, { name: 'vertPosRatio', value: ekf ? num(ekf.innovation_hgt) : null },
    ] },
    { name: 'Generator', entries: ['batCurrentSetpoint', 'batteryCurrent', 'busVoltage', 'genSpeed', 'genTemp', 'loadCurrent', 'powerGenerated', 'rectifierTemp', 'runtime', 'status', 'timeMaintenance'].map((name) => ({ name, value: null })) },
    { name: 'Gps', entries: [
      { name: 'authenticationState', value: null }, { name: 'correctionsQuality', value: null },
      { name: 'count', value: gps ? int(gps.satellites_visible) : null },
      { name: 'courseOverGround', value: gps ? num(gps.cog, 2) : null, unit: 'deg' },
      { name: 'gnssSignalQuality', value: null }, { name: 'hdop', value: gps ? num(gps.eph, 2) : null },
      { name: 'jammingState', value: null }, { name: 'lat', value: gps ? num(gps.lat, 7) : null, unit: 'deg' },
      { name: 'lock', value: gps ? int(gps.fix_type) : null }, { name: 'lon', value: gps ? num(gps.lon, 7) : null, unit: 'deg' },
      { name: 'mgrs', value: null }, { name: 'postProcessingQuality', value: null },
      { name: 'spoofingState', value: null }, { name: 'systemErrors', value: null },
      { name: 'systemQuality', value: null }, { name: 'vdop', value: gps ? num(gps.epv, 2) : null },
      { name: 'yaw', value: null, unit: 'deg' },
    ] },
    { name: 'Gps2', entries: ['authenticationState', 'correctionsQuality', 'count', 'courseOverGround', 'gnssSignalQuality', 'hdop', 'jammingState', 'lat', 'lock', 'lon', 'mgrs', 'postProcessingQuality', 'spoofingState', 'systemErrors', 'systemQuality', 'vdop', 'yaw'].map((name) => ({ name, value: null })) },
    { name: 'GpsAggregate', entries: ['authenticationState', 'isStale', 'jammingState', 'spoofingState'].map((name) => ({ name, value: null })) },
    { name: 'Hygrometer', entries: ['humidity', 'hygrometerid', 'temperature'].map((name) => ({ name, value: null })) },
    { name: 'LocalPosition', entries: ['vx', 'vy', 'vz', 'x', 'y', 'z'].map((name) => ({ name, value: null })) },
    { name: 'LocalPositionSetpoint', entries: ['vx', 'vy', 'vz', 'x', 'y', 'z'].map((name) => ({ name, value: null })) },
    { name: 'Rpm', entries: ['rpm1', 'rpm2', 'rpm3', 'rpm4', 'rpmSensor1', 'rpmSensor2'].map((name) => ({ name, value: null })) },
    { name: 'Setpoint', entries: ['pitch', 'pitchRate', 'roll', 'rollRate', 'yaw', 'yawRate'].map((name) => ({ name, value: null })) },
    { name: 'Temperature', entries: [
      { name: 'temperature1', value: s.imus[0] ? num(s.imus[0].temperature, 1) : null, unit: 'C' },
      { name: 'temperature2', value: baro ? num(baro.temperature, 1) : null, unit: 'C' },
      { name: 'temperature3', value: null, unit: 'C' },
    ] },
    { name: 'Terrain', entries: ['blocksLoaded', 'blocksPending'].map((name) => ({ name, value: null })) },
    { name: 'Vibration', entries: ['clipCount1', 'clipCount2', 'clipCount3', 'xAxis', 'yAxis', 'zAxis'].map((name) => ({ name, value: null })) },
    { name: 'Wind', entries: ['direction', 'speed', 'verticalSpeed'].map((name) => ({ name, value: null })) },
    { name: 'Efi', entries: ['baroPress', 'cylinderTemp', 'ecuIndex', 'engineLoad', 'exGasTemp', 'fuelConsumed', 'fuelFlow', 'fuelPressure', 'health', 'ignTime', 'ignVoltage', 'injTime', 'intakePress', 'intakeTemp', 'ptComp', 'rpm', 'sparkTime', 'throttleOut', 'throttlePos'].map((name) => ({ name, value: null })) },
  ]

  const groups: StatusGroup[] = []

  groups.push({
    name: 'VEHICLE',
    entries: [
      { name: 'airSpeed', value: vfr ? num(t.airSpeed) : null, unit: 'm/s' },
      { name: 'groundSpeed', value: vfr ? num(t.groundSpeed) : null, unit: 'm/s' },
      { name: 'climbRate', value: vfr ? num(t.climbRate) : null, unit: 'm/s' },
      { name: 'altitudeAMSL', value: vfr ? num(t.altitude) : null, unit: 'm' },
      { name: 'altitudeRelative', value: gp ? num(t.relativeAlt) : null, unit: 'm' },
      { name: 'heading', value: vfr ? int(t.heading) : null, unit: 'deg' },
      { name: 'throttlePct', value: vfr ? int(t.throttle) : null, unit: '%' },
      { name: 'roll', value: att ? num(att.roll * RAD2DEG) : null, unit: 'deg' },
      { name: 'pitch', value: att ? num(att.pitch * RAD2DEG) : null, unit: 'deg' },
      { name: 'yaw', value: att ? num(att.yaw * RAD2DEG) : null, unit: 'deg' },
      { name: 'rollRate', value: att ? num(att.rollspeed * RAD2DEG) : null, unit: 'deg/s' },
      { name: 'pitchRate', value: att ? num(att.pitchspeed * RAD2DEG) : null, unit: 'deg/s' },
      { name: 'yawRate', value: att ? num(att.yawspeed * RAD2DEG) : null, unit: 'deg/s' },
      { name: 'flightMode', value: hb?.mode ?? null },
      { name: 'armed', value: bool(hb ? hb.armed : null) },
      { name: 'failsafe', value: hb?.failsafe ?? null },
      { name: 'systemStatus', value: hb ? int(hb.systemStatus) : null },
    ],
  })

  groups.push({
    name: 'BATTERY0',
    entries: [
      { name: 'id', value: bat ? int(bat.id) : null },
      { name: 'voltage', value: bat ? num(bat.voltage, 2) : null, unit: 'V' },
      { name: 'current', value: bat ? num(bat.current, 2) : null, unit: 'A' },
      { name: 'percentRemaining', value: bat ? int(bat.remaining) : null, unit: '%' },
      { name: 'mahConsumed', value: bat ? int(bat.consumed_mah) : null, unit: 'mAh' },
      ...(bat?.cell_voltages ?? []).map((cell, index) => ({
        name: `cellVoltage${index + 1}`,
        value: num(cell, 3),
        unit: 'V',
      })),
    ],
  })

  groups.push({
    name: 'GPS',
    entries: [
      { name: 'fixType', value: gps ? int(gps.fix_type) : null },
      { name: 'lat', value: gps ? num(gps.lat, 7) : null, unit: 'deg' },
      { name: 'lon', value: gps ? num(gps.lon, 7) : null, unit: 'deg' },
      { name: 'altitudeMSL', value: gps ? num(gps.alt, 2) : null, unit: 'm' },
      { name: 'eph', value: gps ? num(gps.eph, 2) : null },
      { name: 'epv', value: gps ? num(gps.epv, 2) : null },
      { name: 'velocity', value: gps ? num(gps.vel, 2) : null, unit: 'm/s' },
      { name: 'courseOverGround', value: gps ? num(gps.cog, 2) : null, unit: 'deg' },
      { name: 'satellitesVisible', value: gps ? int(gps.satellites_visible) : null },
    ],
  })

  groups.push({
    name: 'POSITION',
    entries: [
      { name: 'lat', value: gp ? num(gp.lat, 7) : null, unit: 'deg' },
      { name: 'lon', value: gp ? num(gp.lon, 7) : null, unit: 'deg' },
      { name: 'alt', value: gp ? num(gp.alt, 2) : null, unit: 'm' },
      { name: 'relativeAlt', value: gp ? num(gp.relative_alt, 2) : null, unit: 'm' },
      { name: 'vx', value: gp ? num(gp.vx, 2) : null, unit: 'm/s' },
      { name: 'vy', value: gp ? num(gp.vy, 2) : null, unit: 'm/s' },
      { name: 'vz', value: gp ? num(gp.vz, 2) : null, unit: 'm/s' },
      { name: 'hdg', value: gp ? num(gp.hdg, 2) : null, unit: 'deg' },
    ],
  })

  const imuInstances = Object.keys(s.imus).map(Number).sort((a, b) => a - b)
  for (const instance of imuInstances.length > 0 ? imuInstances : [0]) {
    const imu = imuFresh ? s.imus[instance] ?? null : null
    groups.push({
      name: `IMU${instance}`,
      entries: [
        { name: 'xacc', value: imu ? num(imu.xacc) : null },
        { name: 'yacc', value: imu ? num(imu.yacc) : null },
        { name: 'zacc', value: imu ? num(imu.zacc) : null },
        { name: 'xgyro', value: imu ? num(imu.xgyro) : null },
        { name: 'ygyro', value: imu ? num(imu.ygyro) : null },
        { name: 'zgyro', value: imu ? num(imu.zgyro) : null },
        { name: 'xmag', value: imu ? num(imu.xmag) : null },
        { name: 'ymag', value: imu ? num(imu.ymag) : null },
        { name: 'zmag', value: imu ? num(imu.zmag) : null },
        { name: 'temperature', value: imu ? num(imu.temperature, 1) : null, unit: 'C' },
      ],
    })
  }

  for (const stream of COMPASS_STREAMS) {
    const sample = messages[stream.msgType]
    const live = isMavlinkMessageLive(sample, nowMs)
    const data = compassData(sample, nowMs)
    const receiveHz = measuredMavlinkHz(sample, nowMs)
    const fieldStrength = data ? Math.hypot(data.xmag, data.ymag, data.zmag) : null
    groups.push({
      name: stream.group,
      entries: [
        { name: 'source', value: stream.msgType },
        { name: 'status', value: live ? 'live' : 'waiting' },
        { name: 'receiveHz', value: num(receiveHz, 1), unit: 'Hz' },
        { name: 'frames', value: sample ? int(sample.totalCount) : null },
        { name: 'instance', value: data ? int(data.instance ?? 0) : null },
        { name: 'units', value: stream.unitLabel },
        { name: 'xmag', value: data ? num(data.xmag) : null, unit: stream.unit },
        { name: 'ymag', value: data ? num(data.ymag) : null, unit: stream.unit },
        { name: 'zmag', value: data ? num(data.zmag) : null, unit: stream.unit },
        { name: 'fieldStrength', value: num(fieldStrength), unit: stream.unit },
        { name: 'temperature', value: data ? num(data.temperature, 1) : null, unit: 'C' },
      ],
    })
  }

  groups.push({
    name: 'BAROMETER',
    entries: [
      { name: 'pressAbs', value: baro ? num(baro.press_abs, 2) : null, unit: 'hPa' },
      { name: 'pressDiff', value: baro ? num(baro.press_diff, 4) : null, unit: 'hPa' },
      { name: 'temperature', value: baro ? num(baro.temperature, 1) : null, unit: 'C' },
      { name: 'altitude', value: baro ? num(baro.altitude, 2) : null, unit: 'm' },
    ],
  })

  groups.push({
    name: 'DISTANCESENSOR',
    entries: [
      { name: 'currentDistance', value: range ? num(range.current_distance, 2) : null, unit: 'm' },
      { name: 'minDistance', value: range ? num(range.min_distance, 2) : null, unit: 'm' },
      { name: 'maxDistance', value: range ? num(range.max_distance, 2) : null, unit: 'm' },
      { name: 'signalQuality', value: range ? int(range.signal_quality) : null, unit: '%' },
      { name: 'type', value: range ? int(range.type) : null },
      { name: 'id', value: range ? int(range.id) : null },
      { name: 'orientation', value: range ? int(range.orientation) : null },
    ],
  })

  groups.push({
    name: 'OPTICALFLOW',
    entries: [
      { name: 'quality', value: flow ? int(flow.quality) : null },
      { name: 'integratedX', value: flow ? num(flow.integrated_x_rad) : null, unit: 'rad' },
      { name: 'integratedY', value: flow ? num(flow.integrated_y_rad) : null, unit: 'rad' },
      { name: 'integratedXGyro', value: flow ? num(flow.integrated_xgyro_rad) : null, unit: 'rad' },
      { name: 'integratedYGyro', value: flow ? num(flow.integrated_ygyro_rad) : null, unit: 'rad' },
      { name: 'integratedZGyro', value: flow ? num(flow.integrated_zgyro_rad) : null, unit: 'rad' },
      { name: 'distance', value: flow ? num(flow.distance_m, 2) : null, unit: 'm' },
      { name: 'temperature', value: flow ? num(flow.temperature_c, 1) : null, unit: 'C' },
    ],
  })

  groups.push({
    name: 'ESTIMATORSTATUS',
    entries: [
      { name: 'healthFlags', value: ekf ? `0x${ekf.health_flags.toString(16).toUpperCase()}` : null },
      { name: 'velInnovation', value: ekf ? num(ekf.innovation_vel) : null },
      { name: 'posInnovation', value: ekf ? num(ekf.innovation_pos) : null },
      { name: 'hgtInnovation', value: ekf ? num(ekf.innovation_hgt) : null },
      { name: 'magInnovation', value: ekf ? num(ekf.innovation_mag) : null },
    ],
  })

  groups.push({
    name: 'RCCHANNELS',
    entries: Array.from({ length: 18 }, (_, index): StatusEntry | null => {
      const key = `ch${index + 1}` as keyof RcChannelsData
      const value = rc ? rc[key] : null
      if (index >= 8 && value == null) return null
      return { name: key, value: int(value), unit: 'µs' }
    }).filter((entry) => entry !== null),
  })

  groups.push({
    name: 'SERVOOUTPUT',
    entries: [
      { name: 'port', value: motors ? int(motors.port) : null },
      ...(motors?.outputs ?? Array.from({ length: 8 }, () => null)).map((output, index) => ({
        name: `servo${index + 1}`,
        value: int(output),
        unit: 'µs',
      })),
    ],
  })

  groups.push({
    name: 'SYSTEM',
    entries: [
      { name: 'sensorsHealthy', value: sys ? bool(t.sensorsHealthy) : null },
      { name: 'preflightCheck', value: sys ? bool(t.preflightCheck) : null },
      {
        name: 'unhealthySensors',
        value: sys ? (t.unhealthySensors.length > 0 ? t.unhealthySensors.join(', ') : 'none') : null,
      },
    ],
  })

  groups.push({
    name: 'FIRMWARE',
    entries: [
      { name: 'boardName', value: av?.boardName ?? null },
      { name: 'boardId', value: av ? int(av.boardId) : null },
      { name: 'firmwareVersion', value: av?.firmwareVersion ?? null },
      { name: 'firmwareLabel', value: av?.firmwareLabel ?? null },
      { name: 'vendorId', value: av ? `0x${av.vendorId.toString(16).toUpperCase()}` : null },
      { name: 'productId', value: av ? `0x${av.productId.toString(16).toUpperCase()}` : null },
    ],
  })

  groups.push({
    name: 'LINK',
    entries: [
      { name: 'rxBps', value: link ? int(link.rxBps) : null, unit: 'B/s' },
      { name: 'txBps', value: link ? int(link.txBps) : null, unit: 'B/s' },
      { name: 'crcErrors', value: link ? int(link.crcErrors) : null },
      { name: 'crcErrorsPerSec', value: link ? num(link.crcErrorsPerSec, 1) : null, unit: '/s' },
      { name: 'rxPackets', value: link ? int(link.rxPackets) : null },
      { name: 'txPackets', value: link ? int(link.txPackets) : null },
      { name: 'rxSequenceLost', value: link ? int(link.rxSequenceLost) : null },
      { name: 'rxDuplicates', value: link ? int(link.rxDuplicates) : null },
      { name: 'protocolVersion', value: link?.protocolVersion != null ? `v${link.protocolVersion}` : null },
    ],
  })

  const canonicalNames = new Set(['VEHICLE', 'BATTERY0', 'GPS', 'DISTANCESENSOR', 'ESTIMATORSTATUS'])
  return [...canonicalGroups, ...groups.filter((group) => !canonicalNames.has(group.name))]
}

// Column-major split so variables read alphabetically down each column, the
// same way MicoConfigurator / QGC lay out their status console.
function splitColumns(entries: StatusEntry[], columns: number): StatusEntry[][] {
  const rows = Math.ceil(entries.length / columns)
  return Array.from({ length: columns }, (_, index) => entries.slice(index * rows, (index + 1) * rows))
}

export default function StatusVariableBrowser({ paused = false }: { paused?: boolean }) {
  const [snapshot, setSnapshot] = useState(readStatusVariableSnapshot)
  useEffect(() => {
    const timer = window.setInterval(
      () => setSnapshot(readStatusVariableSnapshot()),
      STATUS_SNAPSHOT_INTERVAL_MS,
    )
    return () => window.clearInterval(timer)
  }, [])
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})

  const liveGroups = useMemo(
    () => buildGroups(
      snapshot.telemetry,
      snapshot.sensors,
      snapshot.linkStats,
      snapshot.messages,
      snapshot.sampledAt,
    ),
    [snapshot],
  )
  // While paused, keep rendering the snapshot captured at pause time.
  const frozenRef = useRef<StatusGroup[] | null>(null)
  if (paused) {
    if (!frozenRef.current) frozenRef.current = liveGroups
  } else {
    frozenRef.current = null
  }
  const groups = frozenRef.current ?? liveGroups
  const previousValuesRef = useRef(new Map<string, string | null>())
  const changedUntilRef = useRef(new Map<string, number>())
  const changedKeys = useMemo(() => {
    if (paused) return new Set<string>()
    const changed = changedUntilRef.current
    const previous = previousValuesRef.current
    const nowMs = snapshot.sampledAt
    for (const group of groups) {
      for (const entry of group.entries) {
        const key = `${group.name}\u0000${entry.name}`
        if (previous.has(key) && previous.get(key) !== entry.value) changed.set(key, nowMs + 1100)
        previous.set(key, entry.value)
      }
    }
    for (const [key, until] of changed) if (until <= nowMs) changed.delete(key)
    return new Set(changed.keys())
  }, [groups, paused, snapshot.sampledAt])

  const totalCount = groups.reduce((count, group) => count + group.entries.length, 0)
  const needle = query.trim().toLowerCase()
  const visibleGroups = needle
    ? groups
        .map((group) => ({
          ...group,
          entries: group.name.toLowerCase().includes(needle)
            || statusGroupDescription(group.name)?.includes(query.trim())
            ? group.entries
            : group.entries.filter((entry) =>
                entry.name.toLowerCase().includes(needle)
                || statusVariableDescription(group.name, entry.name)?.includes(query.trim()),
              ),
        }))
        .filter((group) => group.entries.length > 0)
    : groups
  const visibleCount = visibleGroups.reduce((count, group) => count + group.entries.length, 0)

  const toggleGroup = (name: string) => setCollapsed((current) => ({ ...current, [name]: !current[name] }))

  return (
    <div className="mc-statusvar">
      <div className="mc-statusvar__toolbar">
        <div className="mc-statusvar__search">
          <Icon name="search" size={14} />
          <input
            type="text"
            value={query}
            placeholder="搜索变量名或中文注释…"
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <span className="mc-statusvar__count mc-mono">{visibleCount} / {totalCount}</span>
        <span className="mc-statusvar__legend"><i />变化项</span>
      </div>

      {visibleGroups.length === 0 ? (
        <p className="mc-statusvar__empty">没有匹配 “{query.trim()}” 的状态变量</p>
      ) : (
        visibleGroups.map((group) => {
          // A live search always expands its matches.
          const isCollapsed = needle ? false : collapsed[group.name] === true
          return (
            <section key={group.name} className="mc-card mc-statusvar-group" data-collapsed={isCollapsed || undefined}>
              <header onClick={() => toggleGroup(group.name)}>
                <span className="mc-statusvar-group__chevron"><Icon name="chevronDown" size={14} /></span>
                <h3>
                  <span>{group.name}</span>
                  <small>{statusGroupDescription(group.name)}</small>
                </h3>
                <span className="mc-statusvar-group__badge mc-mono">{group.entries.length}</span>
              </header>
              {!isCollapsed && (
                <div className="mc-statusvar-grid">
                  {splitColumns(group.entries, 3).map((column, columnIndex) => (
                    <div key={columnIndex} className="mc-statusvar-col">
                      {column.map((entry) => (
                        <div
                          key={entry.name}
                          className="mc-statusvar-row"
                          data-empty={entry.value == null || undefined}
                          data-changed={changedKeys.has(`${group.name}\u0000${entry.name}`) || undefined}
                        >
                          <code>{entry.name}</code>
                          <small title={statusVariableDescription(group.name, entry.name) ?? undefined}>
                            {statusVariableDescription(group.name, entry.name) ?? ''}
                          </small>
                          <span>
                            <b>{entry.value ?? '--'}</b>
                            {entry.value != null && entry.unit && <i>{entry.unit}</i>}
                          </span>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </section>
          )
        })
      )}
    </div>
  )
}
