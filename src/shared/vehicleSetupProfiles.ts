import type { ParamData } from './types'
import type { VehicleIdentity } from './vehicleProfiles'

export type VehicleConfigFeature = 'flight_modes' | 'power' | 'safety'
export type VehicleConfigValueKind = 'number' | 'enum' | 'channel' | 'bitmask'

export interface VehicleConfigField {
  id: string
  label: string
  group: string
  kind: VehicleConfigValueKind
  unit?: string
  min?: number
  max?: number
  step?: number
}

export interface BatteryConfigInstance {
  index: number
  prefix: string
  label: string
  parameterIds: string[]
}

const PX4_FLIGHT_MODE_FIELDS: VehicleConfigField[] = [
  { id: 'RC_MAP_FLTMODE', label: 'Flight mode channel', group: 'Six-position modes', kind: 'channel', min: 0, max: 18, step: 1 },
  ...Array.from({ length: 6 }, (_, index): VehicleConfigField => ({
    id: `COM_FLTMODE${index + 1}`,
    label: `Mode ${index + 1}`,
    group: 'Six-position modes',
    kind: 'enum',
  })),
  ...[
    ['RC_MAP_ARM_SW', 'Arm switch'],
    ['RC_MAP_GEAR_SW', 'Landing gear switch'],
    ['RC_MAP_KILL_SW', 'Emergency kill switch'],
    ['RC_MAP_LOITER_SW', 'Loiter switch'],
    ['RC_MAP_OFFB_SW', 'Offboard switch'],
    ['RC_MAP_RETURN_SW', 'Return switch'],
    ['RC_MAP_TRANS_SW', 'VTOL transition switch'],
    ['RC_MAP_FLAPS', 'Flaps channel'],
  ].map(([id, label]): VehicleConfigField => ({ id, label, group: 'Dedicated switches', kind: 'channel', min: 0, max: 18, step: 1 })),
]

const ARDU_FLIGHT_MODE_FIELDS: VehicleConfigField[] = [
  { id: 'FLTMODE_CH', label: 'Flight mode channel', group: 'Six-position modes', kind: 'channel', min: 0, max: 16, step: 1 },
  ...Array.from({ length: 6 }, (_, index): VehicleConfigField => ({
    id: `FLTMODE${index + 1}`,
    label: `Mode ${index + 1}`,
    group: 'Six-position modes',
    kind: 'enum',
  })),
  { id: 'SIMPLE', label: 'Simple mode slots', group: 'Mode modifiers', kind: 'bitmask', min: 0, max: 63, step: 1 },
  { id: 'SUPER_SIMPLE', label: 'Super Simple slots', group: 'Mode modifiers', kind: 'bitmask', min: 0, max: 63, step: 1 },
]

const PX4_SAFETY_FIELDS: VehicleConfigField[] = [
  { id: 'COM_LOW_BAT_ACT', label: 'Low battery action', group: 'Battery failsafe', kind: 'enum' },
  { id: 'BAT_LOW_THR', label: 'Low battery threshold', group: 'Battery failsafe', kind: 'number', min: 0, max: 1, step: 0.01 },
  { id: 'BAT_CRIT_THR', label: 'Critical battery threshold', group: 'Battery failsafe', kind: 'number', min: 0, max: 1, step: 0.01 },
  { id: 'BAT_EMERGEN_THR', label: 'Emergency battery threshold', group: 'Battery failsafe', kind: 'number', min: 0, max: 1, step: 0.01 },
  { id: 'NAV_RCL_ACT', label: 'RC loss action', group: 'Link loss', kind: 'enum' },
  { id: 'COM_RC_LOSS_T', label: 'RC loss timeout', group: 'Link loss', kind: 'number', unit: 's', min: 0, max: 60, step: 0.1 },
  { id: 'NAV_DLL_ACT', label: 'Data link loss action', group: 'Link loss', kind: 'enum' },
  { id: 'COM_DL_LOSS_T', label: 'Data link loss timeout', group: 'Link loss', kind: 'number', unit: 's', min: 0, max: 300, step: 0.1 },
  { id: 'RTL_RETURN_ALT', label: 'RTL return altitude', group: 'Return & landing', kind: 'number', unit: 'm', min: 0, max: 10000, step: 0.5 },
  { id: 'RTL_LAND_DELAY', label: 'RTL land delay', group: 'Return & landing', kind: 'number', unit: 's', min: -1, max: 3600, step: 1 },
  { id: 'RTL_DESCEND_ALT', label: 'RTL descend altitude', group: 'Return & landing', kind: 'number', unit: 'm', min: -1, max: 10000, step: 0.5 },
  { id: 'MPC_LAND_SPEED', label: 'Landing speed', group: 'Return & landing', kind: 'number', unit: 'm/s', min: 0.1, max: 10, step: 0.1 },
  { id: 'COM_DISARM_LAND', label: 'Auto-disarm after landing', group: 'Return & landing', kind: 'number', unit: 's', min: -1, max: 300, step: 0.5 },
]

const ARDU_SAFETY_FIELDS: VehicleConfigField[] = [
  { id: 'FS_GCS_ENABLE', label: 'GCS loss action', group: 'Link loss', kind: 'enum' },
  { id: 'FS_THR_ENABLE', label: 'Throttle/RC loss action', group: 'Link loss', kind: 'enum' },
  { id: 'FS_THR_VALUE', label: 'Throttle loss PWM', group: 'Link loss', kind: 'number', unit: 'µs', min: 910, max: 1100, step: 1 },
  { id: 'FS_OPTIONS', label: 'Failsafe options', group: 'Link loss', kind: 'bitmask', min: 0, step: 1 },
  { id: 'FS_EKF_ACTION', label: 'EKF failsafe action', group: 'Estimator', kind: 'enum' },
  { id: 'FS_EKF_THRESH', label: 'EKF variance threshold', group: 'Estimator', kind: 'number', min: 0, max: 1, step: 0.01 },
  { id: 'RTL_ALT', label: 'RTL altitude', group: 'Return & landing', kind: 'number', unit: 'cm', min: 0, max: 800000, step: 100 },
  { id: 'RTL_LOIT_TIME', label: 'RTL loiter time', group: 'Return & landing', kind: 'number', unit: 'ms', min: 0, max: 120000, step: 100 },
  { id: 'RTL_ALT_FINAL', label: 'RTL final altitude', group: 'Return & landing', kind: 'number', unit: 'cm', min: 0, max: 800000, step: 100 },
  { id: 'ARMING_CHECK', label: 'Arming checks', group: 'Arming', kind: 'bitmask', min: 0, step: 1 },
]

const PX4_POWER_SUFFIXES = ['SOURCE', 'N_CELLS', 'CAPACITY', 'V_EMPTY', 'V_CHARGED', 'V_DIV', 'A_PER_V'] as const
const ARDU_POWER_SUFFIXES = ['MONITOR', 'CAPACITY', 'ARM_VOLT', 'VOLT_MULT', 'AMP_PERVLT', 'AMP_OFFSET'] as const

function writableIdentity(identity: VehicleIdentity | null): boolean {
  return identity?.family === 'px4'
    || (identity?.family === 'ardupilot' && identity.vehicleClass === 'copter')
}

export function setupFields(identity: VehicleIdentity | null, feature: VehicleConfigFeature): VehicleConfigField[] {
  if (!writableIdentity(identity)) return []
  if (feature === 'flight_modes') {
    return identity!.family === 'px4' ? PX4_FLIGHT_MODE_FIELDS : ARDU_FLIGHT_MODE_FIELDS
  }
  if (feature === 'safety') {
    return identity!.family === 'px4' ? PX4_SAFETY_FIELDS : ARDU_SAFETY_FIELDS
  }
  return []
}

function arduBatteryPrefix(index: number): string {
  if (index === 1) return 'BATT_'
  if (index <= 9) return `BATT${index}_`
  return `BATT${String.fromCharCode(55 + index)}_`
}

export function discoverBatteryConfigs(
  identity: VehicleIdentity | null,
  params: ReadonlyMap<string, ParamData>,
): BatteryConfigInstance[] {
  if (!writableIdentity(identity)) return []
  const result: BatteryConfigInstance[] = []
  if (identity!.family === 'px4') {
    for (let index = 1; index <= 9; index += 1) {
      const prefix = `BAT${index}_`
      const ids = PX4_POWER_SUFFIXES.map((suffix) => `${prefix}${suffix}`).filter((id) => params.has(id))
      if (ids.includes(`${prefix}SOURCE`)) result.push({ index, prefix, label: `Battery ${index}`, parameterIds: ids })
    }
    return result
  }
  for (let index = 1; index <= 19; index += 1) {
    const prefix = arduBatteryPrefix(index)
    const ids = ARDU_POWER_SUFFIXES.map((suffix) => `${prefix}${suffix}`).filter((id) => params.has(id))
    if (ids.includes(`${prefix}MONITOR`)) result.push({ index, prefix, label: `Battery ${index}`, parameterIds: ids })
  }
  return result
}

export function isAllowedVehicleConfigParameter(
  identity: VehicleIdentity | null,
  feature: VehicleConfigFeature,
  id: string,
): boolean {
  if (!writableIdentity(identity)) return false
  if (setupFields(identity, feature).some((field) => field.id === id)) return true
  if (feature === 'flight_modes' && identity!.family === 'ardupilot') {
    return /^(?:RC(?:[6-9]|1[0-6])_OPTION|CH(?:[7-9]|1[0-6])_OPT)$/.test(id)
  }
  if (feature === 'power' && identity!.family === 'px4') {
    return /^BAT[1-9]_(?:SOURCE|N_CELLS|CAPACITY|V_EMPTY|V_CHARGED|V_DIV|A_PER_V)$/.test(id)
  }
  if (feature === 'power' && identity!.family === 'ardupilot') {
    return /^BATT(?:[2-9]|[A-J])?_(?:MONITOR|CAPACITY|ARM_VOLT|VOLT_MULT|AMP_PERVLT|AMP_OFFSET)$/.test(id)
  }
  if (feature === 'safety' && identity!.family === 'ardupilot') {
    return /^BATT(?:[2-9]|[A-J])?_FS_(?:LOW|CRT)_(?:VOLT|MAH|ACT)$/.test(id)
  }
  return false
}

export function isSafetyReduction(id: string, oldValue: number, newValue: number): boolean {
  if (oldValue === newValue) return false
  if (id === 'ARMING_CHECK') return oldValue !== 0 && newValue === 0
  if (/^(?:COM_LOW_BAT_ACT|NAV_RCL_ACT|NAV_DLL_ACT|FS_GCS_ENABLE|FS_THR_ENABLE|FS_EKF_ACTION)$/.test(id)) {
    return oldValue !== 0 && newValue === 0
  }
  return /_FS_(?:LOW|CRT)_ACT$/.test(id) && oldValue !== 0 && newValue === 0
}

export function validateVehicleConfigValue(
  identity: VehicleIdentity | null,
  feature: VehicleConfigFeature,
  id: string,
  value: number,
  params: ReadonlyMap<string, Pick<ParamData, 'value'>>,
): string | null {
  if (!Number.isFinite(value)) return '配置值必须是有限数值'
  if (!isAllowedVehicleConfigParameter(identity, feature, id)) return '参数不属于当前飞控的配置白名单'
  const field = setupFields(identity, feature).find((candidate) => candidate.id === id)
  if (field?.min !== undefined && value < field.min) return `${id} 不得小于 ${field.min}`
  if (field?.max !== undefined && value > field.max) return `${id} 不得大于 ${field.max}`
  if ((field?.kind === 'channel' || field?.kind === 'bitmask') && !Number.isInteger(value)) return `${id} 必须是整数`

  if (identity?.family === 'px4' && feature === 'safety' && /^BAT_(?:LOW|CRIT|EMERGEN)_THR$/.test(id)) {
    const low = id === 'BAT_LOW_THR' ? value : params.get('BAT_LOW_THR')?.value
    const critical = id === 'BAT_CRIT_THR' ? value : params.get('BAT_CRIT_THR')?.value
    const emergency = id === 'BAT_EMERGEN_THR' ? value : params.get('BAT_EMERGEN_THR')?.value
    if ([low, critical, emergency].every(Number.isFinite) && !(emergency! <= critical! && critical! <= low!)) {
      return '电池阈值必须满足：紧急 ≤ 严重 ≤ 低电量'
    }
  }
  if (/_(?:VOLT|MAH)$/.test(id) && value < 0) return `${id} 不得为负值`
  return null
}

export function px4FlightModeSlot(pwm: number | null): number | null {
  if (pwm === null || !Number.isFinite(pwm) || pwm < 900 || pwm > 2100) return null
  return Math.max(0, Math.min(5, Math.floor(((pwm - 1000) * 6) / 1000)))
}

export function arduFlightModeSlot(pwm: number | null): number | null {
  if (pwm === null || !Number.isFinite(pwm)) return null
  const thresholds = [1230, 1360, 1490, 1620, 1749]
  const slot = thresholds.findIndex((threshold) => pwm <= threshold)
  return slot === -1 ? 5 : slot
}

export function calibratedChannelPosition(
  pwm: number | null,
  min: number,
  max: number,
  trim: number,
  reversed: boolean,
): number | null {
  if (pwm === null || !Number.isFinite(pwm) || max <= min) return null
  const normalized = pwm >= trim
    ? 0.5 + ((pwm - trim) / Math.max(1, max - trim)) * 0.5
    : ((pwm - min) / Math.max(1, trim - min)) * 0.5
  return Math.max(0, Math.min(1, reversed ? 1 - normalized : normalized))
}

export function calibratedPx4FlightModeSlot(
  pwm: number | null,
  min: number,
  max: number,
  trim: number,
  reversed: boolean,
): number | null {
  const position = calibratedChannelPosition(pwm, min, max, trim, reversed)
  return position === null ? null : Math.max(0, Math.min(5, Math.floor(position * 6)))
}

export function calibratedMultiplier(measured: number, telemetry: number, currentMultiplier: number): number | null {
  if (![measured, telemetry, currentMultiplier].every(Number.isFinite) || measured <= 0 || telemetry <= 0 || currentMultiplier <= 0) return null
  return measured * currentMultiplier / telemetry
}
