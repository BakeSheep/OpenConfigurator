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

// PX4 exposes ESC passthrough UARTs on SERIAL_CONTROL device ids 20..27
// (one per DShot output). Provenance is Pending until hardware-verified;
// see docs/ESC-PROTOCOL-SOURCES.md. Kept as an inclusive range so validation
// and the transport share one definition.
export const PX4_ESC_SERIAL_CONTROL_DEVICE_MIN = 20
export const PX4_ESC_SERIAL_CONTROL_DEVICE_MAX = 27

// ESC bootloader / passthrough baud rate (AM32 half-duplex and PX4 UART).
export const ESC_SERIAL_BAUD_RATE = 19200

