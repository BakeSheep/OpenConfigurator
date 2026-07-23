// MAVLink constants and command IDs

export const MAVLINK_COMMANDS = {
  MAV_CMD_NAV_TAKEOFF: 22,
  MAV_CMD_NAV_LAND: 21,
  MAV_CMD_NAV_RETURN_TO_LAUNCH: 20,
  MAV_CMD_DO_SET_MODE: 176,
  MAV_CMD_DO_MOTOR_TEST: 209,
  MAV_CMD_ACTUATOR_TEST: 310,
  MAV_CMD_PREFLIGHT_CALIBRATION: 241,
  MAV_CMD_COMPONENT_ARM_DISARM: 400,
  MAV_CMD_DO_SET_SERVO: 183,
  MAV_CMD_SET_MESSAGE_INTERVAL: 511,
  MAV_CMD_REQUEST_MESSAGE: 512,
} as const

export const PX4_MODES = {
  MANUAL: { id: 1, mainMode: 1, subMode: 0, name: 'Manual' },
  ALTCTL: { id: 2, mainMode: 2, subMode: 0, name: 'Altitude' },
  POSCTL: { id: 3, mainMode: 3, subMode: 0, name: 'Position' },
  AUTO_MISSION: { id: 4, mainMode: 4, subMode: 4, name: 'Mission' },
  AUTO_LOITER: { id: 5, mainMode: 4, subMode: 3, name: 'Hold' },
  AUTO_RTL: { id: 6, mainMode: 4, subMode: 5, name: 'RTL' },
  ACRO: { id: 8, mainMode: 5, subMode: 0, name: 'Acro' },
  STABILIZED: { id: 10, mainMode: 7, subMode: 0, name: 'Stabilized' },
  AUTO_LAND: { id: 12, mainMode: 4, subMode: 6, name: 'Land' },
} as const

export const MAV_RESULT = {
  ACCEPTED: 0,
  TEMPORARILY_REJECTED: 1,
  DENIED: 2,
  UNSUPPORTED: 3,
  FAILED: 4,
  IN_PROGRESS: 5,
} as const

export const SENSOR_STATUS = {
  OK: 'ok',
  WARNING: 'warning',
  ERROR: 'error',
  OFFLINE: 'offline',
} as const

export const EKF2_PARAMS = {
  EKF2_GPS_CTRL: 'EKF2_GPS_CTRL',
  EKF2_BARO_CTRL: 'EKF2_BARO_CTRL',
  EKF2_MAG_TYPE: 'EKF2_MAG_TYPE',
  EKF2_OF_CTRL: 'EKF2_OF_CTRL',
  EKF2_RNG_CTRL: 'EKF2_RNG_CTRL',
  EKF2_EV_CTRL: 'EKF2_EV_CTRL',
  EKF2_HGT_REF: 'EKF2_HGT_REF',
  EKF2_OF_POS_X: 'EKF2_OF_POS_X',
  EKF2_OF_POS_Y: 'EKF2_OF_POS_Y',
  EKF2_OF_POS_Z: 'EKF2_OF_POS_Z',
  EKF2_RNG_POS_X: 'EKF2_RNG_POS_X',
  EKF2_RNG_POS_Y: 'EKF2_RNG_POS_Y',
  EKF2_RNG_POS_Z: 'EKF2_RNG_POS_Z',
  EKF2_GPS_POS_X: 'EKF2_GPS_POS_X',
  EKF2_GPS_POS_Y: 'EKF2_GPS_POS_Y',
  EKF2_GPS_POS_Z: 'EKF2_GPS_POS_Z',
} as const

export const HGT_REF_OPTIONS = [
  { value: 0, label: '气压计 (Barometer)' },
  { value: 1, label: 'GPS' },
  { value: 2, label: '测距仪 (Range Finder)' },
  { value: 3, label: '视觉 (Vision)' },
] as const

export const BAUD_RATES = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600] as const

export const DEFAULT_BAUD_RATE = 57600
