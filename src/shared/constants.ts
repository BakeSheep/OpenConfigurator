// MAVLink constants and command IDs

export const MAVLINK_COMMANDS = {
  MAV_CMD_NAV_TAKEOFF: 22,
  MAV_CMD_NAV_LAND: 21,
  MAV_CMD_NAV_RETURN_TO_LAUNCH: 20,
  MAV_CMD_DO_SET_MODE: 176,
  MAV_CMD_DO_MOTOR_TEST: 209,
  MAV_CMD_ACTUATOR_TEST: 310,
  MAV_CMD_PREFLIGHT_CALIBRATION: 241,
  MAV_CMD_PREFLIGHT_REBOOT_SHUTDOWN: 246,
  MAV_CMD_COMPONENT_ARM_DISARM: 400,
  MAV_CMD_DO_SET_SERVO: 183,
  MAV_CMD_SET_MESSAGE_INTERVAL: 511,
  MAV_CMD_REQUEST_MESSAGE: 512,
  // ArduPilot onboard compass calibration (ardupilotmega dialect commands).
  MAV_CMD_DO_START_MAG_CAL: 42424,
  MAV_CMD_DO_ACCEPT_MAG_CAL: 42425,
  MAV_CMD_DO_CANCEL_MAG_CAL: 42426,
  // ArduPilot interactive accel calibration position request/confirm.
  MAV_CMD_ACCELCAL_VEHICLE_POS: 42429,
} as const

// ACCELCAL_VEHICLE_POS enum: positions 1..6 are requested by the FC during
// the interactive six-position accel calibration; SUCCESS/FAILED are the
// terminal sentinels carried in the same COMMAND_LONG param1 field.
export const ACCELCAL_VEHICLE_POS = {
  LEVEL: 1,
  LEFT: 2,
  RIGHT: 3,
  NOSEDOWN: 4,
  NOSEUP: 5,
  BACK: 6,
  SUCCESS: 16777215,
  FAILED: 16777216,
} as const

// MAG_CAL_STATUS enum used by MAG_CAL_PROGRESS/MAG_CAL_REPORT. Values >= 5
// are terminal failure states with a specific cause.
export const MAG_CAL_STATUS = {
  NOT_STARTED: 0,
  WAITING_TO_START: 1,
  RUNNING_STEP_ONE: 2,
  RUNNING_STEP_TWO: 3,
  SUCCESS: 4,
  FAILED: 5,
  BAD_ORIENTATION: 6,
  BAD_RADIUS: 7,
} as const

export const PX4_MODES = {
  // The ids are stable OpenConfigurator wire ids. mainMode/subMode and the
  // QGC flags mirror PX4's px4_custom_mode.h and PX4FirmwarePlugin.cc.
  MANUAL: { id: 1, mainMode: 1, subMode: 0, name: 'Manual', qgcSettable: true, multiRotor: true, fixedWing: true },
  STABILIZED: { id: 10, mainMode: 7, subMode: 0, name: 'Stabilized', qgcSettable: true, multiRotor: true, fixedWing: true },
  ACRO: { id: 8, mainMode: 5, subMode: 0, name: 'Acro', qgcSettable: true, multiRotor: true, fixedWing: true },
  RATTITUDE: { id: 7, mainMode: 8, subMode: 0, name: 'Rattitude', qgcSettable: true, multiRotor: true, fixedWing: true },
  ALTCTL: { id: 2, mainMode: 2, subMode: 0, name: 'Altitude', qgcSettable: true, multiRotor: true, fixedWing: true },
  OFFBOARD: { id: 9, mainMode: 6, subMode: 0, name: 'Offboard', qgcSettable: true, multiRotor: true, fixedWing: true },
  SIMPLE: { id: 15, mainMode: 9, subMode: 0, name: 'Simple', qgcSettable: false, multiRotor: true, fixedWing: false },
  POSCTL: { id: 3, mainMode: 3, subMode: 0, name: 'Position', qgcSettable: true, multiRotor: true, fixedWing: true },
  POSCTL_SLOW: { id: 11, mainMode: 3, subMode: 2, name: 'Position Slow', qgcSettable: true, multiRotor: true, fixedWing: false },
  ALTITUDE_CRUISE: { id: 13, mainMode: 11, subMode: 0, name: 'Altitude Cruise', qgcSettable: true, multiRotor: false, fixedWing: true },
  POSCTL_ORBIT: { id: 16, mainMode: 3, subMode: 1, name: 'Orbit', qgcSettable: false, multiRotor: false, fixedWing: false },
  AUTO_LOITER: { id: 5, mainMode: 4, subMode: 3, name: 'Hold', qgcSettable: true, multiRotor: true, fixedWing: true },
  AUTO_MISSION: { id: 4, mainMode: 4, subMode: 4, name: 'Mission', qgcSettable: true, multiRotor: true, fixedWing: true },
  AUTO_RTL: { id: 6, mainMode: 4, subMode: 5, name: 'Return', qgcSettable: true, multiRotor: true, fixedWing: true },
  AUTO_FOLLOW_TARGET: { id: 18, mainMode: 4, subMode: 8, name: 'Follow Me', qgcSettable: false, multiRotor: true, fixedWing: false },
  AUTO_LAND: { id: 12, mainMode: 4, subMode: 6, name: 'Land', qgcSettable: false, multiRotor: true, fixedWing: true },
  AUTO_PRECLAND: { id: 14, mainMode: 4, subMode: 9, name: 'Precision Land', qgcSettable: true, multiRotor: true, fixedWing: false },
  AUTO_READY: { id: 19, mainMode: 4, subMode: 1, name: 'Ready', qgcSettable: false, multiRotor: true, fixedWing: true },
  AUTO_TAKEOFF: { id: 20, mainMode: 4, subMode: 2, name: 'Takeoff', qgcSettable: false, multiRotor: true, fixedWing: true },
  AUTO_VTOL_TAKEOFF: { id: 21, mainMode: 4, subMode: 10, name: 'VTOL Takeoff', qgcSettable: false, multiRotor: false, fixedWing: true },
  TERMINATION: { id: 17, mainMode: 10, subMode: 0, name: 'Termination', qgcSettable: false, multiRotor: true, fixedWing: true },
  AUTO_GUIDED_COURSE: { id: 22, mainMode: 4, subMode: 11, name: 'Guided Course', qgcSettable: false, multiRotor: false, fixedWing: true },
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
  { value: 0, label: 'sensor.type.barometer' },
  { value: 1, label: 'GPS' },
  { value: 2, label: 'sensor.type.rangeFinder' },
  { value: 3, label: 'sensor.type.vision' },
] as const

export const BAUD_RATES = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600] as const

export const DEFAULT_BAUD_RATE = 57600

/** Default live-telemetry rates used by the message-frequency control card. */
export const DEFAULT_MESSAGE_RATES = Object.freeze({
  attitude: 8,
  position: 2,
  sensors: 2,
  rc: 2,
  status: 1,
  hud: 1,
  auxiliary: 2,
})

export const MESSAGE_RATE_OPTIONS = Object.freeze([1, 2, 4, 8, 10, 20])

/** MAVLink message ids controlled by each user-facing frequency group. */
export const MESSAGE_RATE_GROUP_IDS = Object.freeze({
  attitude: Object.freeze([30]),
  position: Object.freeze([24, 33]),
  sensors: Object.freeze([26, 27, 29, 105, 116, 129]),
  rc: Object.freeze([36, 65]),
  status: Object.freeze([1, 230, 245]),
  hud: Object.freeze([74]),
  auxiliary: Object.freeze([100, 106, 132, 147, 173, 241]),
})

// MAVLink FTP (FILE_TRANSFER_PROTOCOL, msg #110) protocol constants shared by
// the backend client implementation and its protocol tests.
export const FTP_MESSAGE_ID = 110

export const FTP_OPCODES = {
  None: 0,
  TerminateSession: 1,
  ResetSessions: 2,
  ListDirectory: 3,
  OpenFileRO: 4,
  ReadFile: 5,
  CreateFile: 6,
  WriteFile: 7,
  RemoveFile: 8,
  CreateDirectory: 9,
  RemoveDirectory: 10,
  OpenFileWO: 11,
  TruncateFile: 12,
  Rename: 13,
  CalcFileCRC32: 14,
  BurstReadFile: 15,
  Ack: 128,
  Nak: 129,
} as const

export const FTP_NAK_ERRORS = {
  None: 0,
  Fail: 1,
  FailErrno: 2,
  InvalidDataSize: 3,
  InvalidSession: 4,
  NoSessionsAvailable: 5,
  EOF: 6,
  UnknownCommand: 7,
  FileExists: 8,
  FileProtected: 9,
  FileNotFound: 10,
} as const

// ArduPilot DataFlash log transfer (LOG_REQUEST_* protocol). Only the inbound
// reply ids are needed for message routing; outbound requests (#117
// LOG_REQUEST_LIST, #119 LOG_REQUEST_DATA, #121 LOG_ERASE, #122
// LOG_REQUEST_END) are built from the mavlink-mappings message classes.
export const LOG_ENTRY_MESSAGE_ID = 118
export const LOG_DATA_MESSAGE_ID = 120

// PX4 stores ULog flight logs under this SD-card directory. The name makes the
// PX4/ULog scope explicit: ArduPilot uses DataFlash logs downloaded over the
// LOG_REQUEST_* protocol, not this MAVFTP path.
export const PX4_ULOG_LOG_DIRECTORY = '/fs/microsd/log'

/** @deprecated Use PX4_ULOG_LOG_DIRECTORY - kept for backward compatibility. */
export const FTP_DEFAULT_LOG_DIRECTORY = PX4_ULOG_LOG_DIRECTORY

// Longest device path accepted from the frontend. MAVLink FTP payload data is
// 239 bytes, so paths must leave room for the protocol header fields.
export const FTP_MAX_PATH_BYTES = 200

// -- ESC configuration ------------------------------------------------------

// SERIAL_CONTROL flags (MAVLink common). REPLY marks vehicle->GCS replies;
// RESPOND asks the vehicle to reply; EXCLUSIVE claims the UART.
export const SERIAL_CONTROL_FLAGS = {
  Reply: 1,
  Respond: 2,
  Exclusive: 4,
  Blocking: 8,
  Multi: 16,
} as const

// SERIAL_CONTROL data field is a fixed 70-byte array on the wire.
export const SERIAL_CONTROL_MAX_DATA = 70

// MAVLink SERIAL_CONTROL_DEV_SHELL. PX4 exposes its NuttX NSH console on
// device 10; this is distinct from ESC passthrough devices 20..27.
export const PX4_SHELL_SERIAL_CONTROL_DEVICE = 10

// PX4 exposes ESC passthrough UARTs on SERIAL_CONTROL device ids 20..27
// (one per DShot output). Provenance is Pending until hardware-verified;
// see docs/ESC-PROTOCOL-SOURCES.md. Kept as an inclusive range so validation
// and the transport share one definition.
export const PX4_ESC_SERIAL_CONTROL_DEVICE_MIN = 20
export const PX4_ESC_SERIAL_CONTROL_DEVICE_MAX = 27

// ESC bootloader / passthrough baud rate (AM32 half-duplex and PX4 UART).
export const ESC_SERIAL_BAUD_RATE = 19200

