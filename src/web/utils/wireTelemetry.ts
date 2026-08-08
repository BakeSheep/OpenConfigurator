import type {
  AttitudeData,
  BaroData,
  BatteryData,
  DistanceSensorData,
  GlobalPositionData,
  GpsData,
  ImuData,
  OpticalFlowData,
  SysStatusData,
  VfrHudData,
} from '../../shared/types'

type WireRecord = Record<string, unknown>

function record(value: unknown): WireRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as WireRecord
    : null
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function optionalFinite(value: unknown): number | null | undefined {
  return value === null ? null : finite(value) ?? undefined
}

function booleanOrNull(value: unknown): boolean | null | undefined {
  return value === null || typeof value === 'boolean' ? value : undefined
}

function allFinite(source: WireRecord, keys: readonly string[]): boolean {
  return keys.every((key) => finite(source[key]) !== null)
}

export function parseAttitudeData(value: unknown): AttitudeData | null {
  const data = record(value)
  if (!data || !allFinite(data, ['roll', 'pitch', 'yaw', 'rollspeed', 'pitchspeed', 'yawspeed', 'time_boot_ms'])) return null
  return {
    roll: finite(data.roll)!, pitch: finite(data.pitch)!, yaw: finite(data.yaw)!,
    rollspeed: finite(data.rollspeed)!, pitchspeed: finite(data.pitchspeed)!,
    yawspeed: finite(data.yawspeed)!, time_boot_ms: finite(data.time_boot_ms)!,
  }
}

export function parseGpsData(value: unknown): GpsData | null {
  const data = record(value)
  if (!data || !allFinite(data, ['fix_type', 'lat', 'lon', 'alt'])) return null
  const eph = optionalFinite(data.eph)
  const epv = optionalFinite(data.epv)
  const vel = optionalFinite(data.vel)
  const cog = optionalFinite(data.cog)
  const satellites = optionalFinite(data.satellites_visible)
  if ([eph, epv, vel, cog, satellites].some((field) => field === undefined)) return null
  return {
    fix_type: finite(data.fix_type)!, lat: finite(data.lat)!, lon: finite(data.lon)!, alt: finite(data.alt)!,
    eph: eph!, epv: epv!, vel: vel!, cog: cog!, satellites_visible: satellites!,
  }
}

export function parseBatteryData(value: unknown): BatteryData | null {
  const data = record(value)
  if (!data || !allFinite(data, ['id']) || !Array.isArray(data.cell_voltages)) return null
  const voltage = optionalFinite(data.voltage)
  const current = optionalFinite(data.current)
  const remaining = optionalFinite(data.remaining)
  const consumed = optionalFinite(data.consumed_mah)
  const cells = data.cell_voltages.map(optionalFinite)
  if ([voltage, current, remaining, consumed, ...cells].some((field) => field === undefined)) return null
  return {
    id: finite(data.id)!, voltage: voltage!, current: current!, remaining: remaining!,
    consumed_mah: consumed!, cell_voltages: cells as Array<number | null>,
  }
}

export function parseSysStatusData(value: unknown): SysStatusData | null {
  const data = record(value)
  if (!data || !allFinite(data, [
    'cpuLoad', 'sensorsPresent', 'sensorsEnabled', 'sensorsHealth', 'unhealthySensorMask',
  ]) || !Array.isArray(data.unhealthySensors) || !data.unhealthySensors.every((item) => typeof item === 'string')) return null
  const voltage = optionalFinite(data.voltageBattery)
  const current = optionalFinite(data.currentBattery)
  const remaining = optionalFinite(data.batteryRemaining)
  const healthy = booleanOrNull(data.sensorsHealthy)
  const preflight = booleanOrNull(data.preflightCheck)
  if ([voltage, current, remaining, healthy, preflight].some((field) => field === undefined)) return null
  return {
    voltageBattery: voltage!, currentBattery: current!, batteryRemaining: remaining!,
    cpuLoad: finite(data.cpuLoad)!, sensorsPresent: finite(data.sensorsPresent)!,
    sensorsEnabled: finite(data.sensorsEnabled)!, sensorsHealth: finite(data.sensorsHealth)!,
    sensorsHealthy: healthy!, preflightCheck: preflight!,
    unhealthySensorMask: finite(data.unhealthySensorMask)!,
    unhealthySensors: [...data.unhealthySensors] as string[],
  }
}

export function parseVfrHudData(value: unknown): VfrHudData | null {
  const data = record(value)
  if (!data || !allFinite(data, ['airspeed', 'groundspeed', 'alt', 'climb', 'heading', 'throttle'])) return null
  return {
    airspeed: finite(data.airspeed)!, groundspeed: finite(data.groundspeed)!, alt: finite(data.alt)!,
    climb: finite(data.climb)!, heading: finite(data.heading)!, throttle: finite(data.throttle)!,
  }
}

export function parseGlobalPositionData(value: unknown): GlobalPositionData | null {
  const data = record(value)
  if (!data || !allFinite(data, ['lat', 'lon', 'alt', 'relative_alt', 'vx', 'vy', 'vz'])) return null
  const hdg = optionalFinite(data.hdg)
  if (hdg === undefined) return null
  return {
    lat: finite(data.lat)!, lon: finite(data.lon)!, alt: finite(data.alt)!,
    relative_alt: finite(data.relative_alt)!, vx: finite(data.vx)!, vy: finite(data.vy)!,
    vz: finite(data.vz)!, hdg,
  }
}

export function parseImuData(value: unknown): ImuData | null {
  const data = record(value)
  if (!data || !allFinite(data, ['xacc', 'yacc', 'zacc', 'xgyro', 'ygyro', 'zgyro', 'xmag', 'ymag', 'zmag'])) return null
  const temperature = optionalFinite(data.temperature)
  const instance = data.instance === undefined ? undefined : finite(data.instance)
  const units = data.units
  if (temperature === undefined || instance === null || (units !== undefined && units !== 'raw' && units !== 'normalized')) return null
  return {
    ...(instance === undefined ? {} : { instance }),
    ...(units === undefined ? {} : { units }),
    xacc: finite(data.xacc)!, yacc: finite(data.yacc)!, zacc: finite(data.zacc)!,
    xgyro: finite(data.xgyro)!, ygyro: finite(data.ygyro)!, zgyro: finite(data.zgyro)!,
    xmag: finite(data.xmag)!, ymag: finite(data.ymag)!, zmag: finite(data.zmag)!, temperature,
  }
}

export function parseBaroData(value: unknown): BaroData | null {
  const data = record(value)
  if (!data || !allFinite(data, ['press_abs', 'press_diff'])) return null
  const temperature = optionalFinite(data.temperature)
  const altitude = optionalFinite(data.altitude)
  if (temperature === undefined || altitude === undefined) return null
  return { press_abs: finite(data.press_abs)!, press_diff: finite(data.press_diff)!, temperature, altitude }
}

export function parseOpticalFlowData(value: unknown): OpticalFlowData | null {
  const data = record(value)
  if (!data || !allFinite(data, [
    'integration_time_us', 'integrated_x_rad', 'integrated_y_rad', 'time_delta_distance_us',
    'flow_x', 'flow_y', 'quality', 'sensor_id',
  ])) return null
  const nullableKeys = [
    'integrated_xgyro_rad', 'integrated_ygyro_rad', 'integrated_zgyro_rad', 'temperature_c',
    'distance_m', 'flow_comp_m_x', 'flow_comp_m_y', 'ground_distance',
  ] as const
  const nullable = nullableKeys.map((key) => optionalFinite(data[key]))
  if (nullable.some((field) => field === undefined)
    || (data.source !== undefined && data.source !== 'OPTICAL_FLOW' && data.source !== 'OPTICAL_FLOW_RAD')) return null
  const [integratedXgyro, integratedYgyro, integratedZgyro, temperature, distance, flowCompX, flowCompY, groundDistance] = nullable
  return {
    ...(data.source === undefined ? {} : { source: data.source }),
    integration_time_us: finite(data.integration_time_us)!, integrated_x_rad: finite(data.integrated_x_rad)!,
    integrated_y_rad: finite(data.integrated_y_rad)!, integrated_xgyro_rad: integratedXgyro!,
    integrated_ygyro_rad: integratedYgyro!, integrated_zgyro_rad: integratedZgyro!,
    temperature_c: temperature!, time_delta_distance_us: finite(data.time_delta_distance_us)!,
    distance_m: distance!, flow_x: finite(data.flow_x)!, flow_y: finite(data.flow_y)!,
    flow_comp_m_x: flowCompX!, flow_comp_m_y: flowCompY!, quality: finite(data.quality)!,
    ground_distance: groundDistance!, sensor_id: finite(data.sensor_id)!,
  }
}

export function parseDistanceSensorData(value: unknown): DistanceSensorData | null {
  const data = record(value)
  if (!data || !allFinite(data, ['current_distance', 'min_distance', 'max_distance', 'type', 'id', 'orientation'])) return null
  const signalQuality = optionalFinite(data.signal_quality)
  if (signalQuality === undefined
    || (data.source !== undefined && data.source !== 'DISTANCE_SENSOR' && data.source !== 'RANGEFINDER')) return null
  return {
    ...(data.source === undefined ? {} : { source: data.source }),
    current_distance: finite(data.current_distance)!, min_distance: finite(data.min_distance)!,
    max_distance: finite(data.max_distance)!, signal_quality: signalQuality,
    type: finite(data.type)!, id: finite(data.id)!, orientation: finite(data.orientation)!,
  }
}
