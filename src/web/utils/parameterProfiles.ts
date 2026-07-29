// Declarative, profile-selected parameter groups for the specialized editor
// pages (PID, EKF sources, serial ports, board orientation). Field bounds are
// conservative UI limits; the complete parameter page always keeps raw-value
// editing available. ArduPilot gains keep ArduPilot naming - they are never
// renamed to PX4 semantics.
import type { ParamData, VehicleIdentity } from '../../shared/types'

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
    { id: `${prefix}_K`, label: 'K', min: 0, max: 5, step: 0.05, hint: '整体增益系数，同时缩放 P/I/D' },
    { id: `${prefix}_P`, label: 'P', min: 0, max: 0.6, step: 0.01, hint: '角速度误差的即时修正力度' },
    { id: `${prefix}_I`, label: 'I', min: 0, max: 1, step: 0.01, hint: '补偿持续偏差与重心偏移' },
    { id: `${prefix}_D`, label: 'D', min: 0, max: 0.03, step: 0.0005, hint: '抑制快速变化与高频振荡' },
    { id: `${prefix}_FF`, label: 'FF', min: 0, max: 2, step: 0.01, hint: '前馈：直接叠加目标角速度' },
    { id: intLim, label: 'I Limit', min: 0, max: 1, step: 0.05, hint: '积分限幅，防止积分饱和' },
    { id: `${prefix}_MAX`, label: 'Max Rate', min: 0, max: 1800, step: 5, unit: '°/s', hint: '该轴允许的最大角速度' },
  ]
}

const PX4_PID_GROUPS: ParameterGroupDefinition[] = [
  { id: 'roll-rate', title: '横滚角速率', params: px4RateAxis('ROLL') },
  { id: 'pitch-rate', title: '俯仰角速率', params: px4RateAxis('PITCH') },
  { id: 'yaw-rate', title: '偏航角速率', params: px4RateAxis('YAW') },
  {
    id: 'attitude',
    title: '姿态',
    params: [
      { id: 'MC_ROLL_P', label: '横滚控制力度', min: 0, max: 12, step: 0.1, hint: '姿态外环：横滚角误差 → 目标角速度' },
      { id: 'MC_PITCH_P', label: '俯仰控制力度', min: 0, max: 12, step: 0.1, hint: '姿态外环：俯仰角误差 → 目标角速度' },
      { id: 'MC_YAW_P', label: '偏航控制力度', min: 0, max: 5, step: 0.1, hint: '姿态外环：偏航角误差 → 目标角速度' },
      { id: 'MC_YAW_WEIGHT', label: 'Yaw Weight', min: 0, max: 1, step: 0.05, hint: '偏航相对横滚/俯仰的控制优先级' },
    ],
  },
  {
    id: 'position',
    title: '位置',
    params: [
      { id: 'MPC_XY_P', label: 'XY P', min: 0, max: 2, step: 0.05, hint: '水平位置误差 → 目标速度' },
      { id: 'MPC_XY_VEL_P_ACC', label: 'XY Vel P', min: 0, max: 5, step: 0.05, hint: '水平速度环比例增益' },
      { id: 'MPC_XY_VEL_I_ACC', label: 'XY Vel I', min: 0, max: 5, step: 0.05, hint: '水平速度环积分增益（抗风）' },
      { id: 'MPC_XY_VEL_D_ACC', label: 'XY Vel D', min: 0, max: 2, step: 0.05, hint: '水平速度环微分增益' },
      { id: 'MPC_XY_CRUISE', label: 'Cruise Speed', min: 0, max: 20, step: 0.5, unit: 'm/s', hint: '任务模式默认巡航速度' },
      { id: 'MPC_XY_VEL_MAX', label: 'Max XY Speed', min: 0, max: 20, step: 0.5, unit: 'm/s', hint: '允许的最大水平速度' },
      { id: 'MPC_ACC_HOR', label: 'Acceleration', min: 0, max: 15, step: 0.5, unit: 'm/s²', hint: '定点模式水平加速度' },
      { id: 'MPC_ACC_HOR_MAX', label: 'Max Acceleration', min: 0, max: 15, step: 0.5, unit: 'm/s²', hint: '最大水平加速度' },
    ],
  },
  {
    id: 'altitude',
    title: '高度',
    params: [
      { id: 'MPC_Z_P', label: 'Z P', min: 0, max: 1.5, step: 0.05, hint: '高度误差 → 目标爬升率' },
      { id: 'MPC_Z_VEL_P_ACC', label: 'Z Vel P', min: 0, max: 15, step: 0.1, hint: '垂直速度环比例增益' },
      { id: 'MPC_Z_VEL_I_ACC', label: 'Z Vel I', min: 0, max: 3, step: 0.05, hint: '垂直速度环积分增益' },
      { id: 'MPC_Z_VEL_D_ACC', label: 'Z Vel D', min: 0, max: 2, step: 0.05, hint: '垂直速度环微分增益' },
      { id: 'MPC_THR_HOVER', label: 'Hover Throttle', min: 0, max: 0.8, step: 0.01, hint: '悬停油门估计值' },
      { id: 'MPC_THR_MIN', label: 'Min Throttle', min: 0, max: 1, step: 0.01, hint: '最小油门限制' },
      { id: 'MPC_THR_MAX', label: 'Max Throttle', min: 0, max: 1, step: 0.01, hint: '最大油门限制' },
    ],
  },
  {
    id: 'mission',
    title: '航点导航',
    params: [
      { id: 'MPC_Z_VEL_MAX_UP', label: 'Climb Speed', min: 0, max: 8, step: 0.1, unit: 'm/s', hint: '最大爬升速度' },
      { id: 'MPC_Z_VEL_MAX_DN', label: 'Descent Speed', min: 0, max: 4, step: 0.1, unit: 'm/s', hint: '最大下降速度' },
      { id: 'MPC_ACC_UP_MAX', label: 'Climb Accel', min: 0, max: 15, step: 0.5, unit: 'm/s²', hint: '最大向上加速度' },
      { id: 'MPC_ACC_DOWN_MAX', label: 'Descent Accel', min: 0, max: 15, step: 0.5, unit: 'm/s²', hint: '最大向下加速度' },
      { id: 'MPC_TKO_SPEED', label: 'Takeoff Speed', min: 0, max: 5, step: 0.1, unit: 'm/s', hint: '起飞爬升速度' },
      { id: 'MPC_LAND_SPEED', label: 'Land Speed', min: 0, max: 3, step: 0.1, unit: 'm/s', hint: '着陆下降速度' },
      { id: 'MPC_MAN_TILT_MAX', label: 'Manual Tilt', min: 0, max: 90, step: 1, unit: '°', hint: '手动模式最大倾角' },
      { id: 'MPC_MAN_Y_MAX', label: 'Manual Yaw Rate', min: 0, max: 400, step: 5, unit: '°/s', hint: '手动模式最大偏航角速度' },
    ],
  },
  {
    id: 'filters',
    title: '滤波器',
    params: [
      { id: 'IMU_GYRO_CUTOFF', label: '陀螺仪低通滤波', min: 0, max: 1000, step: 5, unit: 'Hz', hint: '陀螺仪数据低通截止频率' },
      { id: 'IMU_DGYRO_CUTOFF', label: 'D Gyro Filter', min: 0, max: 1000, step: 5, unit: 'Hz', hint: 'D 项角加速度低通截止频率' },
      { id: 'IMU_ACCEL_CUTOFF', label: '加速度低通滤波', min: 0, max: 1000, step: 5, unit: 'Hz', hint: '加速度计数据低通截止频率' },
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
    { id: `${prefix}_P`, label: 'P', min: 0, max: isYaw ? 2.5 : 0.5, step: 0.005, hint: '角速度误差的即时修正力度' },
    { id: `${prefix}_I`, label: 'I', min: 0, max: isYaw ? 1 : 2, step: 0.005, hint: '补偿持续偏差与重心偏移' },
    { id: `${prefix}_D`, label: 'D', min: 0, max: 0.05, step: 0.0005, hint: '抑制快速变化与高频振荡' },
    { id: `${prefix}_FF`, label: 'FF', min: 0, max: 0.5, step: 0.001, hint: '前馈：直接叠加目标角速度' },
    { id: `${prefix}_IMAX`, label: 'I Max', min: 0, max: 1, step: 0.05, hint: '积分限幅，防止积分饱和' },
    { id: `${prefix}_FLTD`, label: 'D Filter', min: 0, max: 100, step: 1, unit: 'Hz', hint: 'D 项低通滤波截止频率' },
  ]
}

const ARDUCOPTER_PID_GROUPS: ParameterGroupDefinition[] = [
  { id: 'roll-rate', title: '横滚角速率', params: arduRateAxis('RLL') },
  { id: 'pitch-rate', title: '俯仰角速率', params: arduRateAxis('PIT') },
  { id: 'yaw-rate', title: '偏航角速率', params: arduRateAxis('YAW') },
  {
    id: 'attitude',
    title: '姿态角',
    params: [
      { id: 'ATC_ANG_RLL_P', label: '横滚角 P', min: 0, max: 12, step: 0.1, hint: '姿态外环：横滚角误差 → 目标角速度' },
      { id: 'ATC_ANG_PIT_P', label: '俯仰角 P', min: 0, max: 12, step: 0.1, hint: '姿态外环：俯仰角误差 → 目标角速度' },
      { id: 'ATC_ANG_YAW_P', label: '偏航角 P', min: 0, max: 12, step: 0.1, hint: '姿态外环：偏航角误差 → 目标角速度' },
      { id: 'ATC_INPUT_TC', label: 'Input TC', min: 0, max: 1, step: 0.01, unit: 's', hint: '摇杆输入平滑时间常数' },
    ],
  },
  {
    id: 'position',
    title: '位置',
    params: [
      { id: 'PSC_POSXY_P', label: 'XY P', min: 0, max: 2, step: 0.05, hint: '水平位置误差 → 目标速度' },
      { id: 'PSC_VELXY_P', label: 'XY Vel P', min: 0, max: 6, step: 0.05, hint: '水平速度环比例增益' },
      { id: 'PSC_VELXY_I', label: 'XY Vel I', min: 0, max: 1, step: 0.01, hint: '水平速度环积分增益（抗风）' },
      { id: 'PSC_VELXY_D', label: 'XY Vel D', min: 0, max: 1, step: 0.01, hint: '水平速度环微分增益' },
    ],
  },
  {
    id: 'altitude',
    title: '高度',
    params: [
      { id: 'PSC_POSZ_P', label: 'Z P', min: 0, max: 3, step: 0.05, hint: '高度误差 → 目标爬升率' },
      { id: 'PSC_VELZ_P', label: 'Z Vel P', min: 0, max: 8, step: 0.1, hint: '垂直速度环比例增益' },
      { id: 'PSC_ACCZ_P', label: 'Z Accel P', min: 0, max: 1.5, step: 0.01, hint: '垂直加速度环比例增益' },
      { id: 'PSC_ACCZ_I', label: 'Z Accel I', min: 0, max: 3, step: 0.05, hint: '垂直加速度环积分增益' },
      { id: 'MOT_THST_HOVER', label: 'Hover Throttle', min: 0, max: 0.8, step: 0.01, hint: '悬停油门估计值（学习值）' },
    ],
  },
  {
    id: 'mission',
    title: '航点导航',
    params: [
      { id: 'WPNAV_SPEED', label: 'WP Speed', min: 20, max: 2000, step: 10, unit: 'cm/s', hint: '航点飞行水平速度' },
      { id: 'WPNAV_SPEED_UP', label: 'Climb Speed', min: 10, max: 1000, step: 10, unit: 'cm/s', hint: '航点最大爬升速度' },
      { id: 'WPNAV_SPEED_DN', label: 'Descent Speed', min: 10, max: 500, step: 10, unit: 'cm/s', hint: '航点最大下降速度' },
      { id: 'WPNAV_RADIUS', label: 'WP Radius', min: 5, max: 1000, step: 5, unit: 'cm', hint: '判定到达航点的半径' },
      { id: 'WPNAV_ACCEL', label: 'WP Accel', min: 50, max: 500, step: 10, unit: 'cm/s²', hint: '航点水平加速度' },
      { id: 'LAND_SPEED', label: 'Land Speed', min: 30, max: 200, step: 5, unit: 'cm/s', hint: '最终着陆下降速度' },
      { id: 'PILOT_SPEED_UP', label: 'Pilot Climb', min: 50, max: 500, step: 10, unit: 'cm/s', hint: '手动模式最大爬升速度' },
      { id: 'ANGLE_MAX', label: 'Max Angle', min: 1000, max: 8000, step: 100, unit: 'c°', hint: '最大倾角（百分之一度）' },
    ],
  },
  {
    id: 'filters',
    title: '滤波器',
    params: [
      { id: 'INS_GYRO_FILTER', label: '陀螺仪低通滤波', min: 0, max: 256, step: 1, unit: 'Hz', hint: '陀螺仪数据低通截止频率' },
      { id: 'INS_ACCEL_FILTER', label: '加速度低通滤波', min: 0, max: 256, step: 1, unit: 'Hz', hint: '加速度计数据低通截止频率' },
      { id: 'ATC_THR_MIX_MAN', label: 'Thr Mix Manual', min: 0.1, max: 0.9, step: 0.01, hint: '手动飞行时姿态与油门的优先级混合' },
    ],
  },
]

/** Profile-selected PID editor groups. Empty = page stays read-only. */
export function pidGroups(identity: VehicleIdentity | null): ParameterGroupDefinition[] {
  if (!identity) return []
  if (identity.family === 'px4') return PX4_PID_GROUPS
  if (identity.family === 'ardupilot' && identity.vehicleClass === 'copter') {
    return ARDUCOPTER_PID_GROUPS
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
  { id: 'EK3_SRC1_POSXY', label: '水平位置源', options: EK3_POSXY_OPTIONS, rebootRequired: true },
  { id: 'EK3_SRC1_VELXY', label: '水平速度源', options: EK3_VELXY_OPTIONS, rebootRequired: true },
  { id: 'EK3_SRC1_POSZ', label: '垂直位置源', options: EK3_POSZ_OPTIONS, rebootRequired: true },
  { id: 'EK3_SRC1_VELZ', label: '垂直速度源', options: EK3_VELZ_OPTIONS, rebootRequired: true },
  { id: 'EK3_SRC1_YAW', label: '偏航源', options: EK3_YAW_OPTIONS, rebootRequired: true },
]

/** EKF source configuration selects; empty for PX4 (dedicated EKF2 panel). */
export function ekfSourceFields(identity: VehicleIdentity | null): SelectFieldDefinition[] {
  if (identity?.family === 'ardupilot' && identity.vehicleClass === 'copter') {
    return ARDUPILOT_EKF_SOURCE_FIELDS
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
      label: 'IMU安装方向',
      options: ROTATION_OPTIONS,
      hint: '错误的安装方向会直接导致失控，修改前请务必确认。',
      rebootRequired: true,
    }
  }
  if (identity.family === 'ardupilot') {
    return {
      id: 'AHRS_ORIENTATION',
      label: 'IMU安装方向',
      options: ROTATION_OPTIONS,
      hint: '错误的安装方向会直接导致失控，修改前请务必确认。',
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
