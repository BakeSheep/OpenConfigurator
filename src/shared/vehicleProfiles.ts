// Framework-agnostic vehicle profile classification shared by the backend and
// the React UI. The profile is selected exclusively from HEARTBEAT identity
// (autopilot + type); parameters or STATUSTEXT strings are never authoritative
// for stack selection because they may be stale or shared across stacks.
import { PX4_MODES } from './constants'

export type AutopilotFamily = 'px4' | 'ardupilot' | 'unknown'
export type VehicleClass = 'copter' | 'plane' | 'rover' | 'sub' | 'tracker' | 'unknown'

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
  const mainOnly = Object.values(PX4_MODES).find((mode) =>
    mode.mainMode === mainMode && mode.subMode === 0
  )
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
