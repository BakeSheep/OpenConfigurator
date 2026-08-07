// Declarative, profile-selected parameter groups for the specialized editor
// pages (PID, EKF sources, serial ports, board orientation). Field bounds are
// conservative UI limits; the complete parameter page always keeps raw-value
// editing available. ArduPilot gains keep ArduPilot naming - they are never
// renamed to PX4 semantics.
import type { ParamData, VehicleIdentity } from '../../shared/types'
import i18next from 'i18next'

const t = i18next.t.bind(i18next)

export interface ParameterFieldDefinition {
  id: string
  label: string
  min: number
  max: number
  step: number
  unit?: string
  hint: string
  /** True when the FC applies the value only after reboot. */
  rebootRequired?: boolean
}

export interface ParameterGroupDefinition {
  id: string
  title: string
  params: ParameterFieldDefinition[]
}

export interface SelectFieldDefinition {
  id: string
  label: string
  options: Array<{ value: number; label: string }>
  hint?: string
  rebootRequired?: boolean
}

// --------------------------------------------------------------------------
// PX4 multicopter PID groups (moved verbatim from PidTuningPage).
// --------------------------------------------------------------------------
const px4RateAxis = (axis: 'ROLL' | 'PITCH' | 'YAW'): ParameterFieldDefinition[] => {
  const prefix = `MC_${axis}RATE`
  const intLim = axis === 'ROLL' ? 'MC_RR_INT_LIM' : axis === 'PITCH' ? 'MC_PR_INT_LIM' : 'MC_YR_INT_LIM'
  return [
    { id: `${prefix}_K`, label: 'K', min: 0, max: 5, step: 0.05, hint: 'metadata.profile.pid.rate.K.hint' },
    { id: `${prefix}_P`, label: 'P', min: 0, max: 0.6, step: 0.01, hint: 'metadata.profile.pid.rate.P.hint' },
    { id: `${prefix}_I`, label: 'I', min: 0, max: 1, step: 0.01, hint: 'metadata.profile.pid.rate.I.hint' },
    { id: `${prefix}_D`, label: 'D', min: 0, max: 0.03, step: 0.0005, hint: 'metadata.profile.pid.rate.D.hint' },
    { id: `${prefix}_FF`, label: 'FF', min: 0, max: 2, step: 0.01, hint: 'metadata.profile.pid.rate.FF.hint' },
    { id: intLim, label: 'I Limit', min: 0, max: 1, step: 0.05, hint: 'metadata.profile.pid.rate.ILimit.hint' },
    { id: `${prefix}_MAX`, label: 'Max Rate', min: 0, max: 1800, step: 5, unit: '°/s', hint: 'metadata.profile.pid.rate.MaxRate.hint' },
  ]
}

const PX4_PID_GROUPS: ParameterGroupDefinition[] = [
  { id: 'roll-rate', title: 'metadata.profile.pid.rollRate.title', params: px4RateAxis('ROLL') },
  { id: 'pitch-rate', title: 'metadata.profile.pid.pitchRate.title', params: px4RateAxis('PITCH') },
  { id: 'yaw-rate', title: 'metadata.profile.pid.yawRate.title', params: px4RateAxis('YAW') },
  {
    id: 'attitude',
    title: 'metadata.profile.pid.attitude.title',
    params: [
      { id: 'MC_ROLL_P', label: 'metadata.profile.pid.attitude.rollP.label', min: 0, max: 12, step: 0.1, hint: 'metadata.profile.pid.attitude.rollP.hint' },
      { id: 'MC_PITCH_P', label: 'metadata.profile.pid.attitude.pitchP.label', min: 0, max: 12, step: 0.1, hint: 'metadata.profile.pid.attitude.pitchP.hint' },
      { id: 'MC_YAW_P', label: 'metadata.profile.pid.attitude.yawP.label', min: 0, max: 5, step: 0.1, hint: 'metadata.profile.pid.attitude.yawP.hint' },
      { id: 'MC_YAW_WEIGHT', label: 'Yaw Weight', min: 0, max: 1, step: 0.05, hint: 'metadata.profile.pid.attitude.yawWeight.hint' },
    ],
  },
  {
    id: 'position',
    title: 'metadata.profile.pid.position.title',
    params: [
      { id: 'MPC_XY_P', label: 'XY P', min: 0, max: 2, step: 0.05, hint: 'metadata.profile.pid.position.xyP.hint' },
      { id: 'MPC_XY_VEL_P_ACC', label: 'XY Vel P', min: 0, max: 5, step: 0.05, hint: 'metadata.profile.pid.position.xyVelP.hint' },
      { id: 'MPC_XY_VEL_I_ACC', label: 'XY Vel I', min: 0, max: 5, step: 0.05, hint: 'metadata.profile.pid.position.xyVelI.hint' },
      { id: 'MPC_XY_VEL_D_ACC', label: 'XY Vel D', min: 0, max: 2, step: 0.05, hint: 'metadata.profile.pid.position.xyVelD.hint' },
      { id: 'MPC_XY_CRUISE', label: 'Cruise Speed', min: 0, max: 20, step: 0.5, unit: 'm/s', hint: 'metadata.profile.pid.position.cruiseSpeed.hint' },
      { id: 'MPC_XY_VEL_MAX', label: 'Max XY Speed', min: 0, max: 20, step: 0.5, unit: 'm/s', hint: 'metadata.profile.pid.position.maxXySpeed.hint' },
      { id: 'MPC_ACC_HOR', label: 'Acceleration', min: 0, max: 15, step: 0.5, unit: 'm/s²', hint: 'metadata.profile.pid.position.acceleration.hint' },
      { id: 'MPC_ACC_HOR_MAX', label: 'Max Acceleration', min: 0, max: 15, step: 0.5, unit: 'm/s²', hint: 'metadata.profile.pid.position.maxAcceleration.hint' },
    ],
  },
  {
    id: 'altitude',
    title: 'metadata.profile.pid.altitude.title',
    params: [
      { id: 'MPC_Z_P', label: 'Z P', min: 0, max: 1.5, step: 0.05, hint: 'metadata.profile.pid.altitude.zP.hint' },
      { id: 'MPC_Z_VEL_P_ACC', label: 'Z Vel P', min: 0, max: 15, step: 0.1, hint: 'metadata.profile.pid.altitude.zVelP.hint' },
      { id: 'MPC_Z_VEL_I_ACC', label: 'Z Vel I', min: 0, max: 3, step: 0.05, hint: 'metadata.profile.pid.altitude.zVelI.hint' },
      { id: 'MPC_Z_VEL_D_ACC', label: 'Z Vel D', min: 0, max: 2, step: 0.05, hint: 'metadata.profile.pid.altitude.zVelD.hint' },
      { id: 'MPC_THR_HOVER', label: 'Hover Throttle', min: 0, max: 0.8, step: 0.01, hint: 'metadata.profile.pid.altitude.hoverThrottle.hint' },
      { id: 'MPC_THR_MIN', label: 'Min Throttle', min: 0, max: 1, step: 0.01, hint: 'metadata.profile.pid.altitude.minThrottle.hint' },
      { id: 'MPC_THR_MAX', label: 'Max Throttle', min: 0, max: 1, step: 0.01, hint: 'metadata.profile.pid.altitude.maxThrottle.hint' },
    ],
  },
  {
    id: 'mission',
    title: 'metadata.profile.pid.mission.title',
    params: [
      { id: 'MPC_Z_VEL_MAX_UP', label: 'Climb Speed', min: 0, max: 8, step: 0.1, unit: 'm/s', hint: 'metadata.profile.pid.mission.climbSpeed.hint' },
      { id: 'MPC_Z_VEL_MAX_DN', label: 'Descent Speed', min: 0, max: 4, step: 0.1, unit: 'm/s', hint: 'metadata.profile.pid.mission.descentSpeed.hint' },
      { id: 'MPC_ACC_UP_MAX', label: 'Climb Accel', min: 0, max: 15, step: 0.5, unit: 'm/s²', hint: 'metadata.profile.pid.mission.climbAccel.hint' },
      { id: 'MPC_ACC_DOWN_MAX', label: 'Descent Accel', min: 0, max: 15, step: 0.5, unit: 'm/s²', hint: 'metadata.profile.pid.mission.descentAccel.hint' },
      { id: 'MPC_TKO_SPEED', label: 'Takeoff Speed', min: 0, max: 5, step: 0.1, unit: 'm/s', hint: 'metadata.profile.pid.mission.takeoffSpeed.hint' },
      { id: 'MPC_LAND_SPEED', label: 'Land Speed', min: 0, max: 3, step: 0.1, unit: 'm/s', hint: 'metadata.profile.pid.mission.landSpeed.hint' },
      { id: 'MPC_MAN_TILT_MAX', label: 'Manual Tilt', min: 0, max: 90, step: 1, unit: '°', hint: 'metadata.profile.pid.mission.manualTilt.hint' },
      { id: 'MPC_MAN_Y_MAX', label: 'Manual Yaw Rate', min: 0, max: 400, step: 5, unit: '°/s', hint: 'metadata.profile.pid.mission.manualYawRate.hint' },
    ],
  },
  {
    id: 'filters',
    title: 'metadata.profile.pid.filters.title',
    params: [
      { id: 'IMU_GYRO_CUTOFF', label: 'metadata.profile.pid.filters.gyroCutoff.label', min: 0, max: 1000, step: 5, unit: 'Hz', hint: 'metadata.profile.pid.filters.gyroCutoff.hint' },
      { id: 'IMU_DGYRO_CUTOFF', label: 'D Gyro Filter', min: 0, max: 1000, step: 5, unit: 'Hz', hint: 'metadata.profile.pid.filters.dGyroCutoff.hint' },
      { id: 'IMU_ACCEL_CUTOFF', label: 'metadata.profile.pid.filters.accelCutoff.label', min: 0, max: 1000, step: 5, unit: 'Hz', hint: 'metadata.profile.pid.filters.accelCutoff.hint' },
    ],
  },
]

// --------------------------------------------------------------------------
// ArduCopter PID groups (ArduPilot 4.x parameter naming, conservative bounds
// from the official parameter documentation).
// --------------------------------------------------------------------------
const arduRateAxis = (axis: 'RLL' | 'PIT' | 'YAW'): ParameterFieldDefinition[] => {
  const prefix = `ATC_RAT_${axis}`
  const isYaw = axis === 'YAW'
  return [
    { id: `${prefix}_P`, label: 'P', min: 0, max: isYaw ? 2.5 : 0.5, step: 0.005, hint: 'metadata.profile.pid.arduRate.P.hint' },
    { id: `${prefix}_I`, label: 'I', min: 0, max: isYaw ? 1 : 2, step: 0.005, hint: 'metadata.profile.pid.arduRate.I.hint' },
    { id: `${prefix}_D`, label: 'D', min: 0, max: 0.05, step: 0.0005, hint: 'metadata.profile.pid.arduRate.D.hint' },
    { id: `${prefix}_FF`, label: 'FF', min: 0, max: 0.5, step: 0.001, hint: 'metadata.profile.pid.arduRate.FF.hint' },
    { id: `${prefix}_IMAX`, label: 'I Max', min: 0, max: 1, step: 0.05, hint: 'metadata.profile.pid.arduRate.imax.hint' },
    { id: `${prefix}_FLTD`, label: 'D Filter', min: 0, max: 100, step: 1, unit: 'Hz', hint: 'metadata.profile.pid.arduRate.dFilter.hint' },
  ]
}

const ARDUCOPTER_PID_GROUPS: ParameterGroupDefinition[] = [
  { id: 'roll-rate', title: 'metadata.profile.pid.arduRollRate.title', params: arduRateAxis('RLL') },
  { id: 'pitch-rate', title: 'metadata.profile.pid.arduPitchRate.title', params: arduRateAxis('PIT') },
  { id: 'yaw-rate', title: 'metadata.profile.pid.arduYawRate.title', params: arduRateAxis('YAW') },
  {
    id: 'attitude',
    title: 'metadata.profile.pid.arduAttitude.title',
    params: [
      { id: 'ATC_ANG_RLL_P', label: 'metadata.profile.pid.arduAttitude.rollP.label', min: 0, max: 12, step: 0.1, hint: 'metadata.profile.pid.arduAttitude.rollP.hint' },
      { id: 'ATC_ANG_PIT_P', label: 'metadata.profile.pid.arduAttitude.pitchP.label', min: 0, max: 12, step: 0.1, hint: 'metadata.profile.pid.arduAttitude.pitchP.hint' },
      { id: 'ATC_ANG_YAW_P', label: 'metadata.profile.pid.arduAttitude.yawP.label', min: 0, max: 12, step: 0.1, hint: 'metadata.profile.pid.arduAttitude.yawP.hint' },
      { id: 'ATC_INPUT_TC', label: 'Input TC', min: 0, max: 1, step: 0.01, unit: 's', hint: 'metadata.profile.pid.arduAttitude.inputTc.hint' },
    ],
  },
  {
    id: 'position',
    title: 'metadata.profile.pid.arduPosition.title',
    params: [
      { id: 'PSC_POSXY_P', label: 'XY P', min: 0, max: 2, step: 0.05, hint: 'metadata.profile.pid.arduPosition.xyP.hint' },
      { id: 'PSC_VELXY_P', label: 'XY Vel P', min: 0, max: 6, step: 0.05, hint: 'metadata.profile.pid.arduPosition.xyVelP.hint' },
      { id: 'PSC_VELXY_I', label: 'XY Vel I', min: 0, max: 1, step: 0.01, hint: 'metadata.profile.pid.arduPosition.xyVelI.hint' },
      { id: 'PSC_VELXY_D', label: 'XY Vel D', min: 0, max: 1, step: 0.01, hint: 'metadata.profile.pid.arduPosition.xyVelD.hint' },
    ],
  },
  {
    id: 'altitude',
    title: 'metadata.profile.pid.arduAltitude.title',
    params: [
      { id: 'PSC_POSZ_P', label: 'Z P', min: 0, max: 3, step: 0.05, hint: 'metadata.profile.pid.arduAltitude.zP.hint' },
      { id: 'PSC_VELZ_P', label: 'Z Vel P', min: 0, max: 8, step: 0.1, hint: 'metadata.profile.pid.arduAltitude.zVelP.hint' },
      { id: 'PSC_ACCZ_P', label: 'Z Accel P', min: 0, max: 1.5, step: 0.01, hint: 'metadata.profile.pid.arduAltitude.zAccelP.hint' },
      { id: 'PSC_ACCZ_I', label: 'Z Accel I', min: 0, max: 3, step: 0.05, hint: 'metadata.profile.pid.arduAltitude.zAccelI.hint' },
      { id: 'MOT_THST_HOVER', label: 'Hover Throttle', min: 0, max: 0.8, step: 0.01, hint: 'metadata.profile.pid.arduAltitude.hoverThrottle.hint' },
    ],
  },
  {
    id: 'mission',
    title: 'metadata.profile.pid.arduMission.title',
    params: [
      { id: 'WPNAV_SPEED', label: 'WP Speed', min: 20, max: 2000, step: 10, unit: 'cm/s', hint: 'metadata.profile.pid.arduMission.wpSpeed.hint' },
      { id: 'WPNAV_SPEED_UP', label: 'Climb Speed', min: 10, max: 1000, step: 10, unit: 'cm/s', hint: 'metadata.profile.pid.arduMission.climbSpeed.hint' },
      { id: 'WPNAV_SPEED_DN', label: 'Descent Speed', min: 10, max: 500, step: 10, unit: 'cm/s', hint: 'metadata.profile.pid.arduMission.descentSpeed.hint' },
      { id: 'WPNAV_RADIUS', label: 'WP Radius', min: 5, max: 1000, step: 5, unit: 'cm', hint: 'metadata.profile.pid.arduMission.wpRadius.hint' },
      { id: 'WPNAV_ACCEL', label: 'WP Accel', min: 50, max: 500, step: 10, unit: 'cm/s²', hint: 'metadata.profile.pid.arduMission.wpAccel.hint' },
      { id: 'LAND_SPEED', label: 'Land Speed', min: 30, max: 200, step: 5, unit: 'cm/s', hint: 'metadata.profile.pid.arduMission.landSpeed.hint' },
      { id: 'PILOT_SPEED_UP', label: 'Pilot Climb', min: 50, max: 500, step: 10, unit: 'cm/s', hint: 'metadata.profile.pid.arduMission.pilotClimb.hint' },
      { id: 'ANGLE_MAX', label: 'Max Angle', min: 1000, max: 8000, step: 100, unit: 'c°', hint: 'metadata.profile.pid.arduMission.maxAngle.hint' },
    ],
  },
  {
    id: 'filters',
    title: 'metadata.profile.pid.arduFilters.title',
    params: [
      { id: 'INS_GYRO_FILTER', label: 'metadata.profile.pid.arduFilters.gyroFilter.label', min: 0, max: 256, step: 1, unit: 'Hz', hint: 'metadata.profile.pid.arduFilters.gyroFilter.hint' },
      { id: 'INS_ACCEL_FILTER', label: 'metadata.profile.pid.arduFilters.accelFilter.label', min: 0, max: 256, step: 1, unit: 'Hz', hint: 'metadata.profile.pid.arduFilters.accelFilter.hint' },
      { id: 'ATC_THR_MIX_MAN', label: 'Thr Mix Manual', min: 0.1, max: 0.9, step: 0.01, hint: 'metadata.profile.pid.arduFilters.thrMixManual.hint' },
    ],
  },
]

/** Translate the key-based definitions at call time (i18next is live then). */
function translateGroups(groups: readonly ParameterGroupDefinition[]): ParameterGroupDefinition[] {
  return groups.map((group) => ({
    ...group,
    title: t(group.title),
    params: group.params.map((field) => ({
      ...field,
      label: t(field.label),
      hint: t(field.hint),
    })),
  }))
}

/** Profile-selected PID editor groups. Empty = page stays read-only. */
export function pidGroups(identity: VehicleIdentity | null): ParameterGroupDefinition[] {
  if (!identity) return []
  if (identity.family === 'px4') return translateGroups(PX4_PID_GROUPS)
  if (identity.family === 'ardupilot' && identity.vehicleClass === 'copter') {
    return translateGroups(ARDUCOPTER_PID_GROUPS)
  }
  return []
}

// --------------------------------------------------------------------------
// EKF3 source selection (ArduPilot). AHRS_EKF_TYPE / EK3_ENABLE are never
// written automatically - only the SRC1 sources are configurable here.
// --------------------------------------------------------------------------
const EK3_POSXY_OPTIONS = [
  { value: 0, label: 'None' },
  { value: 3, label: 'GPS' },
  { value: 4, label: 'Beacon' },
  { value: 6, label: 'ExternalNav' },
]
const EK3_VELXY_OPTIONS = [
  { value: 0, label: 'None' },
  { value: 3, label: 'GPS' },
  { value: 5, label: 'OpticalFlow' },
  { value: 6, label: 'ExternalNav' },
  { value: 7, label: 'WheelEncoder' },
]
const EK3_POSZ_OPTIONS = [
  { value: 1, label: 'Baro' },
  { value: 2, label: 'RangeFinder' },
  { value: 3, label: 'GPS' },
  { value: 4, label: 'Beacon' },
  { value: 6, label: 'ExternalNav' },
]
const EK3_VELZ_OPTIONS = [
  { value: 0, label: 'None' },
  { value: 3, label: 'GPS' },
  { value: 6, label: 'ExternalNav' },
]
const EK3_YAW_OPTIONS = [
  { value: 0, label: 'None' },
  { value: 1, label: 'Compass' },
  { value: 2, label: 'GPS' },
  { value: 3, label: 'GPS with Compass Fallback' },
  { value: 6, label: 'ExternalNav' },
  { value: 8, label: 'GSF' },
]

const ARDUPILOT_EKF_SOURCE_FIELDS: SelectFieldDefinition[] = [
  { id: 'EK3_SRC1_POSXY', label: 'metadata.profile.ekf.posxy.label', options: EK3_POSXY_OPTIONS, rebootRequired: true },
  { id: 'EK3_SRC1_VELXY', label: 'metadata.profile.ekf.velxy.label', options: EK3_VELXY_OPTIONS, rebootRequired: true },
  { id: 'EK3_SRC1_POSZ', label: 'metadata.profile.ekf.posz.label', options: EK3_POSZ_OPTIONS, rebootRequired: true },
  { id: 'EK3_SRC1_VELZ', label: 'metadata.profile.ekf.velz.label', options: EK3_VELZ_OPTIONS, rebootRequired: true },
  { id: 'EK3_SRC1_YAW', label: 'metadata.profile.ekf.yaw.label', options: EK3_YAW_OPTIONS, rebootRequired: true },
]

/** EKF source configuration selects; empty for PX4 (dedicated EKF2 panel). */
export function ekfSourceFields(identity: VehicleIdentity | null): SelectFieldDefinition[] {
  if (identity?.family === 'ardupilot' && identity.vehicleClass === 'copter') {
    return ARDUPILOT_EKF_SOURCE_FIELDS.map((field) => ({
      ...field,
      label: t(field.label),
      ...(field.hint ? { hint: t(field.hint) } : {}),
    }))
  }
  return []
}

// --------------------------------------------------------------------------
// Board orientation. Values follow the shared MAVLink ROTATION_* enum used by
// both PX4 (SENS_BOARD_ROT) and ArduPilot (AHRS_ORIENTATION).
// --------------------------------------------------------------------------
const ROTATION_OPTIONS = [
  { value: 0, label: 'None' },
  { value: 1, label: 'Yaw 45°' },
  { value: 2, label: 'Yaw 90°' },
  { value: 3, label: 'Yaw 135°' },
  { value: 4, label: 'Yaw 180°' },
  { value: 5, label: 'Yaw 225°' },
  { value: 6, label: 'Yaw 270°' },
  { value: 7, label: 'Yaw 315°' },
  { value: 8, label: 'Roll 180°' },
  { value: 12, label: 'Pitch 180°' },
  { value: 16, label: 'Roll 90°' },
  { value: 20, label: 'Roll 270°' },
  { value: 24, label: 'Pitch 90°' },
  { value: 25, label: 'Pitch 270°' },
]

/** Profile-selected board orientation parameter, or null when unsupported. */
export function boardOrientationField(identity: VehicleIdentity | null): SelectFieldDefinition | null {
  if (!identity) return null
  if (identity.family === 'px4') {
    return {
      id: 'SENS_BOARD_ROT',
      label: t('metadata.profile.boardOrientation.label'),
      options: ROTATION_OPTIONS,
      hint: t('metadata.profile.boardOrientation.hint'),
      rebootRequired: true,
    }
  }
  if (identity.family === 'ardupilot') {
    return {
      id: 'AHRS_ORIENTATION',
      label: t('metadata.profile.boardOrientation.label'),
      options: ROTATION_OPTIONS,
      hint: t('metadata.profile.boardOrientation.hint'),
      rebootRequired: true,
    }
  }
  return null
}

// --------------------------------------------------------------------------
// ArduPilot serial ports: only SERIALx_* parameters actually present in the
// downloaded set are mapped. Unknown protocol values must be preserved.
// --------------------------------------------------------------------------
export const ARDUPILOT_SERIAL_PROTOCOLS: ReadonlyArray<readonly [number, string]> = [
  [-1, 'None'],
  [1, 'MAVLink1'],
  [2, 'MAVLink2'],
  [4, 'FrSky SPort'],
  [5, 'GPS'],
  [9, 'Rangefinder'],
  [10, 'FrSky SPort Passthrough'],
  [16, 'ESC Telemetry'],
  [23, 'RCIN'],
  [28, 'Scripting'],
  [32, 'MSP'],
  [42, 'DisplayPort'],
]

// SERIALx_BAUD stores kilo-baud shorthand codes, not raw baud rates.
export const ARDUPILOT_SERIAL_BAUDS: ReadonlyArray<readonly [number, string]> = [
  [9, '9600'],
  [19, '19200'],
  [38, '38400'],
  [57, '57600'],
  [111, '111100'],
  [115, '115200'],
  [230, '230400'],
  [256, '256000'],
  [460, '460800'],
  [500, '500000'],
  [921, '921600'],
  [1500, '1500000'],
]

export interface ArduPilotSerialPort {
  index: number
  label: string
  protocolParam: string
  baudParam: string
  /** Present SRx_* stream-rate parameters, surfaced read-only. */
  streamRateParams: string[]
}

const SR_RATE_SUFFIXES = [
  'RAW_SENS', 'EXT_STAT', 'RC_CHAN', 'RAW_CTRL', 'POSITION',
  'EXTRA1', 'EXTRA2', 'EXTRA3', 'PARAMS', 'ADSB',
]

export function ardupilotSerialPorts(params: Map<string, ParamData>): ArduPilotSerialPort[] {
  const ports: ArduPilotSerialPort[] = []
  for (let index = 0; index <= 9; index += 1) {
    const protocolParam = `SERIAL${index}_PROTOCOL`
    if (!params.has(protocolParam)) continue
    ports.push({
      index,
      label: `SERIAL${index}`,
      protocolParam,
      baudParam: `SERIAL${index}_BAUD`,
      streamRateParams: SR_RATE_SUFFIXES
        .map((suffix) => `SR${index}_${suffix}`)
        .filter((id) => params.has(id)),
    })
  }
  return ports
}
