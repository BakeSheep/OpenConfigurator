// Framework-agnostic vehicle profile classification shared by the Worker and
// the React UI. The profile is selected exclusively from HEARTBEAT identity
// (autopilot + type); parameters or STATUSTEXT strings are never authoritative
// for stack selection because they may be stale or shared across stacks.
import { PX4_MODES } from './constants'

export type AutopilotFamily = 'px4' | 'ardupilot' | 'unknown'
export type VehicleClass = 'copter' | 'plane' | 'rover' | 'sub' | 'tracker' | 'unknown'
export type CalibrationKind = 'accel' | 'accel_simple' | 'gyro' | 'mag' | 'baro' | 'level'

export interface VehicleIdentity {
  /** Raw MAV_AUTOPILOT value from HEARTBEAT. */
  autopilotId: number
  /** Raw MAV_TYPE value from HEARTBEAT. */
  vehicleTypeId: number
  family: AutopilotFamily
  vehicleClass: VehicleClass
}

export interface FlightModeInfo {
  /** Value suitable for HEARTBEAT.custom_mode comparison / mode selection. */
  id: number
  name: string
  /** false = fallback label; write capabilities must never key off it. */
  known: boolean
}

// MAV_AUTOPILOT: only positively identified stacks map to a family. Anything
// else (GENERIC, INVALID, reserved) is 'unknown' - never inferred as PX4.
const MAV_AUTOPILOT_ARDUPILOTMEGA = 3
const MAV_AUTOPILOT_PX4 = 12

export function classifyAutopilot(autopilotId: number): AutopilotFamily {
  if (autopilotId === MAV_AUTOPILOT_ARDUPILOTMEGA) return 'ardupilot'
  if (autopilotId === MAV_AUTOPILOT_PX4) return 'px4'
  return 'unknown'
}

// MAV_TYPE → coarse vehicle class. Values not listed (GCS, onboard
// controller, gimbal, ...) are not vehicles and classify as 'unknown'.
const MAV_TYPE_CLASSES: Record<number, VehicleClass> = {
  1: 'plane',    // FIXED_WING
  2: 'copter',   // QUADROTOR
  3: 'copter',   // COAXIAL
  4: 'copter',   // HELICOPTER
  5: 'tracker',  // ANTENNA_TRACKER
  10: 'rover',   // GROUND_ROVER
  11: 'rover',   // SURFACE_BOAT
  12: 'sub',     // SUBMARINE
  13: 'copter',  // HEXAROTOR
  14: 'copter',  // OCTOROTOR
  15: 'copter',  // TRICOPTER
  19: 'plane',   // VTOL_TAILSITTER_DUOROTOR
  20: 'plane',   // VTOL_TAILSITTER_QUADROTOR
  21: 'plane',   // VTOL_TILTROTOR
  22: 'plane',   // VTOL_FIXEDROTOR
  23: 'plane',   // VTOL_TAILSITTER
  24: 'plane',   // VTOL_TILTWING
  25: 'plane',   // VTOL_RESERVED5
  29: 'copter',  // DODECAROTOR
  35: 'copter',  // DECAROTOR
}

export function classifyVehicleType(vehicleTypeId: number): VehicleClass {
  return MAV_TYPE_CLASSES[vehicleTypeId] ?? 'unknown'
}

export function buildVehicleIdentity(autopilotId: number, vehicleTypeId: number): VehicleIdentity {
  return {
    autopilotId,
    vehicleTypeId,
    family: classifyAutopilot(autopilotId),
    vehicleClass: classifyVehicleType(vehicleTypeId),
  }
}

// ArduCopter custom_mode values are plain flight-mode numbers (Copter
// FLTMODE parameter values). Source: ArduPilot COPTER_MODE enum.
export const ARDUCOPTER_MODES: Record<number, string> = {
  0: 'Stabilize',
  1: 'Acro',
  2: 'AltHold',
  3: 'Auto',
  4: 'Guided',
  5: 'Loiter',
  6: 'RTL',
  7: 'Circle',
  9: 'Land',
  11: 'Drift',
  13: 'Sport',
  14: 'Flip',
  15: 'AutoTune',
  16: 'PosHold',
  17: 'Brake',
  18: 'Throw',
  19: 'Avoid_ADSB',
  20: 'Guided_NoGPS',
  21: 'Smart_RTL',
  22: 'FlowHold',
  23: 'Follow',
  24: 'ZigZag',
  25: 'SystemID',
  26: 'AutoRotate',
  27: 'Auto RTL',
  28: 'Turtle',
}

// PX4 packs custom_mode as reserved[0..15] | main_mode[16..23] |
// sub_mode[24..31]. Auto modes share main_mode=4 and differ by sub-mode.
function decodePx4Mode(customMode: number): FlightModeInfo {
  const raw = customMode >>> 0
  const mainMode = raw > 0xffff ? (raw >>> 16) & 0xff : raw
  const subMode = raw > 0xffff ? (raw >>> 24) & 0xff : 0
  const exact = Object.values(PX4_MODES).find((mode) =>
    mode.mainMode === mainMode && mode.subMode === subMode
  )
  // Only fall back to a main-only entry when the heartbeat actually carries
  // no sub-mode. A packed but unknown sub-mode must remain unknown rather than
  // being mislabeled as the main mode (for example Simple 9.99).
  const mainOnly = subMode === 0
    ? Object.values(PX4_MODES).find((mode) => mode.mainMode === mainMode && mode.subMode === 0)
    : undefined
  const mode = exact ?? mainOnly
  if (mode) return { id: mode.id, name: mode.name, known: true }
  return {
    id: raw,
    name: `Mode ${mainMode}${subMode ? `.${subMode}` : ''}`,
    known: false,
  }
}

/**
 * Decode HEARTBEAT.custom_mode according to the selected vehicle profile.
 * Unknown families/classes yield a raw fallback label with known=false;
 * callers must not enable write behavior for unknown modes.
 */
export function decodeFlightMode(
  family: AutopilotFamily,
  vehicleClass: VehicleClass,
  customMode: number,
): FlightModeInfo {
  if (family === 'px4') {
    // PX4 uses one packed layout across all vehicle types.
    return decodePx4Mode(customMode)
  }
  if (family === 'ardupilot' && vehicleClass === 'copter') {
    const raw = customMode >>> 0
    const name = ARDUCOPTER_MODES[raw]
    if (name !== undefined) return { id: raw, name, known: true }
    return { id: raw, name: `Mode ${raw}`, known: false }
  }
  // Unknown family, or an ArduPilot vehicle class without an implemented
  // mode table (plane/rover/sub/tracker): display-only raw fallback.
  const raw = customMode >>> 0
  return { id: raw, name: `Mode ${raw}`, known: false }
}

/** Family-aware firmware label; never claims PX4 for an unknown stack. */
export function formatFirmwareLabel(family: AutopilotFamily, version: string): string {
  switch (family) {
    case 'ardupilot': return `ArduPilot v${version}`
    case 'px4': return `PX4 v${version}`
    default: return `Autopilot v${version}`
  }
}

export interface FlightModeOption {
  /** Value carried by the semantic set_flight_mode client message. */
  id: number
  name: string
}

/**
 * Modes this GCS offers for the selected profile. An empty list means mode
 * switching is not supported for the vehicle (UI must explain, not hide).
 */
export function availableModes(identity: VehicleIdentity | null): FlightModeOption[] {
  if (!identity) return []
  if (identity.family === 'px4') {
    // QGC treats a pure fixed wing and a multirotor as distinct filters. VTOL,
    // rover, sub and generic PX4 vehicles use QGC's "other" path and receive
    // every mode marked canBeSet.
    const pureFixedWing = identity.vehicleTypeId === 1
    const multiRotor = identity.vehicleClass === 'copter'
    return Object.values(PX4_MODES)
      .filter((mode) => mode.qgcSettable)
      .filter((mode) => !pureFixedWing || mode.fixedWing)
      .filter((mode) => !multiRotor || mode.multiRotor)
      .map((mode) => ({ id: mode.id, name: mode.name }))
  }
  if (identity.family === 'ardupilot' && identity.vehicleClass === 'copter') {
    // QGC marks every mode in its ArduCopter table as canBeSet. Numeric object
    // keys enumerate in ascending mode order, matching the firmware enum.
    return Object.entries(ARDUCOPTER_MODES).map(([id, name]) => ({ id: Number(id), name }))
  }
  return []
}

export type ModeCommandEncoding =
  | { ok: true; params: [number, number, number, number, number, number, number] }
  | { ok: false; code: 'unsupported_vehicle_profile' | 'unknown_mode'; message: string }

/**
 * Encode MAV_CMD_DO_SET_MODE parameters for the selected profile. Rejects
 * before serialization when the profile is unknown/unimplemented or the mode
 * is not part of the vetted selectable list - stale or cross-stack mode
 * numbers must never reach the serial link.
 */
export function encodeModeCommand(
  identity: VehicleIdentity | null,
  modeId: number,
): ModeCommandEncoding {
  if (!identity || identity.family === 'unknown') {
    return {
      ok: false,
      code: 'unsupported_vehicle_profile',
      message: 'errors.encode.unknownVehicleType',
    }
  }
  if (identity.family === 'px4') {
    const mode = Object.values(PX4_MODES).find((candidate) => candidate.id === modeId)
    const selectable = availableModes(identity).some((candidate) => candidate.id === modeId)
    if (!mode || !selectable) {
      return { ok: false, code: 'unknown_mode', message: 'errors.encode.unknownPx4Mode' }
    }
    // PX4: param1=CUSTOM_MODE_ENABLED, param2=main mode, param3=sub mode.
    return { ok: true, params: [1, mode.mainMode, mode.subMode, 0, 0, 0, 0] }
  }
  if (identity.vehicleClass === 'copter') {
    if (ARDUCOPTER_MODES[modeId] === undefined) {
      return { ok: false, code: 'unknown_mode', message: 'errors.encode.unsupportedArduCopterMode' }
    }
    // ArduPilot: param1=MAV_MODE_FLAG_CUSTOM_MODE_ENABLED(1), param2=raw
    // flight-mode number, param3=0.
    return { ok: true, params: [1, modeId, 0, 0, 0, 0, 0] }
  }
  return {
    ok: false,
    code: 'unsupported_vehicle_profile',
    message: 'errors.encode.modeNotSupported',
  }
}

/**
 * Per-profile operation capabilities. Computed exclusively from the
 * HEARTBEAT-classified family and vehicle class - the presence of a
 * parameter must never authorize a safety-critical command, because
 * parameters may be stale or shared across stacks.
 */
export interface VehicleCapabilities {
  /** Any operation that mutates the selected flight controller. */
  writeOperations: boolean
  setMode: boolean
  arm: boolean
  guidedTakeoff: boolean
  calibrate: boolean
  motorTest: 'actuator-test' | 'motor-test' | 'none'
  frameConfig: boolean
  actuatorConfig: boolean
  pidConfig: boolean
  ekfConfig: boolean
  serialConfig: boolean
  gpsConfig: boolean
  airframeSelection: boolean
  radioCalibration: boolean
  flightModeConfig: boolean
  powerConfig: boolean
  safetyConfig: boolean
  logFormat: 'ulog' | 'dataflash' | 'unknown'
  /** Interactive shell exposed by the selected firmware over MAVLink. */
  mavlinkShell: 'px4-nsh' | 'none'
}

const READ_ONLY_CAPABILITIES: VehicleCapabilities = {
  writeOperations: false,
  setMode: false,
  arm: false,
  guidedTakeoff: false,
  calibrate: false,
  motorTest: 'none',
  frameConfig: false,
  actuatorConfig: false,
  pidConfig: false,
  ekfConfig: false,
  serialConfig: false,
  gpsConfig: false,
  airframeSelection: false,
  radioCalibration: false,
  flightModeConfig: false,
  powerConfig: false,
  safetyConfig: false,
  logFormat: 'unknown',
  mavlinkShell: 'none',
}

export function vehicleCapabilities(identity: VehicleIdentity | null): VehicleCapabilities {
  if (!identity) return { ...READ_ONLY_CAPABILITIES }
  if (identity.family === 'px4') {
    // Existing, regression-covered PX4 behavior across all vehicle types.
    return {
      writeOperations: true,
      setMode: true,
      arm: true,
      guidedTakeoff: true,
      calibrate: true,
      motorTest: 'actuator-test',
      frameConfig: true,
      actuatorConfig: true,
      pidConfig: true,
      ekfConfig: true,
      serialConfig: true,
      gpsConfig: true,
      airframeSelection: true,
      radioCalibration: true,
      flightModeConfig: true,
      powerConfig: true,
      safetyConfig: true,
      logFormat: 'ulog',
      mavlinkShell: 'px4-nsh',
    }
  }
  if (identity.family === 'ardupilot') {
    if (identity.vehicleClass === 'copter') {
      return {
        writeOperations: true,
        setMode: true,
        arm: true,
        guidedTakeoff: true,
        calibrate: true,
        motorTest: 'motor-test',
        frameConfig: true,
        actuatorConfig: true,
        pidConfig: true,
        ekfConfig: true,
        serialConfig: true,
        gpsConfig: true,
        airframeSelection: true,
        radioCalibration: true,
        flightModeConfig: true,
        powerConfig: true,
        safetyConfig: true,
        logFormat: 'dataflash',
        mavlinkShell: 'none',
      }
    }
    // Plane/Rover/Sub/Tracker: explicitly read-only until tested; the log
    // format is still a fact of the ArduPilot stack.
    return { ...READ_ONLY_CAPABILITIES, logFormat: 'dataflash' }
  }
  return { ...READ_ONLY_CAPABILITIES }
}

// Explicit family × vehicleClass × kind calibration matrix. PX4 flows are
// firmware-driven via MAV_CMD_PREFLIGHT_CALIBRATION and cover every vehicle
// class; 'accel_simple' is ArduPilot-only (241 p5=4). ArduCopter additionally
// gets the interactive six-position accel (42429) and onboard mag flows
// (42424/42425/42426). Everything else stays read-only.
const PX4_CALIBRATION_KINDS: ReadonlySet<CalibrationKind> =
  new Set(['accel', 'gyro', 'mag', 'baro', 'level'])
const ARDUCOPTER_CALIBRATION_KINDS: ReadonlySet<CalibrationKind> =
  new Set(['accel', 'accel_simple', 'gyro', 'mag', 'baro', 'level'])

/** Per-kind calibration gate shared by the browser and command encoder. */
export function supportsCalibrationKind(identity: VehicleIdentity | null, kind: CalibrationKind): boolean {
  if (!identity || !vehicleCapabilities(identity).calibrate) return false
  if (identity.family === 'px4') return PX4_CALIBRATION_KINDS.has(kind)
  if (identity.family === 'ardupilot' && identity.vehicleClass === 'copter') {
    return ARDUCOPTER_CALIBRATION_KINDS.has(kind)
  }
  return false
}
