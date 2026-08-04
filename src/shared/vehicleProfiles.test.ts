import assert from 'node:assert/strict'
import {
  classifyAutopilot,
  classifyVehicleType,
  buildVehicleIdentity,
  decodeFlightMode,
  formatFirmwareLabel,
  availableModes,
  encodeModeCommand,
  vehicleCapabilities,
  supportsCalibrationKind,
} from './vehicleProfiles'

// ---------------------------------------------------------------------------
// MAV_AUTOPILOT family classification.
// ---------------------------------------------------------------------------
assert.equal(classifyAutopilot(3), 'ardupilot')
assert.equal(classifyAutopilot(12), 'px4')
assert.equal(classifyAutopilot(8), 'unknown')   // MAV_AUTOPILOT_INVALID
assert.equal(classifyAutopilot(0), 'unknown')   // GENERIC must not imply PX4
assert.equal(classifyAutopilot(-1), 'unknown')
assert.equal(classifyAutopilot(255), 'unknown')

// ---------------------------------------------------------------------------
// MAV_TYPE vehicle class classification.
// ---------------------------------------------------------------------------
assert.equal(classifyVehicleType(2), 'copter')   // QUADROTOR
assert.equal(classifyVehicleType(13), 'copter')  // HEXAROTOR
assert.equal(classifyVehicleType(14), 'copter')  // OCTOROTOR
assert.equal(classifyVehicleType(15), 'copter')  // TRICOPTER
assert.equal(classifyVehicleType(3), 'copter')   // COAXIAL
assert.equal(classifyVehicleType(4), 'copter')   // HELICOPTER
assert.equal(classifyVehicleType(1), 'plane')    // FIXED_WING
assert.equal(classifyVehicleType(10), 'rover')   // GROUND_ROVER
assert.equal(classifyVehicleType(11), 'rover')   // SURFACE_BOAT
assert.equal(classifyVehicleType(12), 'sub')     // SUBMARINE
assert.equal(classifyVehicleType(5), 'tracker')  // ANTENNA_TRACKER
assert.equal(classifyVehicleType(6), 'unknown')  // GCS
assert.equal(classifyVehicleType(0), 'unknown')  // GENERIC
assert.equal(classifyVehicleType(999), 'unknown')

// ---------------------------------------------------------------------------
// Identity construction keeps the raw ids for auditability.
// ---------------------------------------------------------------------------
const arducopter = buildVehicleIdentity(3, 2)
assert.deepEqual(arducopter, {
  autopilotId: 3,
  vehicleTypeId: 2,
  family: 'ardupilot',
  vehicleClass: 'copter',
})
const px4Copter = buildVehicleIdentity(12, 2)
assert.equal(px4Copter.family, 'px4')
assert.equal(px4Copter.vehicleClass, 'copter')
const unknownIdentity = buildVehicleIdentity(0, 0)
assert.equal(unknownIdentity.family, 'unknown')
assert.equal(unknownIdentity.vehicleClass, 'unknown')

// ---------------------------------------------------------------------------
// ArduCopter custom_mode decoding (raw mode numbers).
// ---------------------------------------------------------------------------
assert.equal(decodeFlightMode('ardupilot', 'copter', 0).name, 'Stabilize')
assert.equal(decodeFlightMode('ardupilot', 'copter', 1).name, 'Acro')
assert.equal(decodeFlightMode('ardupilot', 'copter', 2).name, 'AltHold')
assert.equal(decodeFlightMode('ardupilot', 'copter', 3).name, 'Auto')
assert.equal(decodeFlightMode('ardupilot', 'copter', 4).name, 'Guided')
assert.equal(decodeFlightMode('ardupilot', 'copter', 5).name, 'Loiter')
assert.equal(decodeFlightMode('ardupilot', 'copter', 6).name, 'RTL')
assert.equal(decodeFlightMode('ardupilot', 'copter', 9).name, 'Land')
assert.equal(decodeFlightMode('ardupilot', 'copter', 16).name, 'PosHold')
assert.equal(decodeFlightMode('ardupilot', 'copter', 0).id, 0)
assert.equal(decodeFlightMode('ardupilot', 'copter', 6).id, 6)

// Undocumented ArduCopter mode numbers fall back without inventing a name.
assert.equal(decodeFlightMode('ardupilot', 'copter', 200).name, 'Mode 200')
assert.equal(decodeFlightMode('ardupilot', 'copter', 200).known, false)

// Unimplemented ArduPilot vehicle classes must not borrow the copter table.
assert.equal(decodeFlightMode('ardupilot', 'plane', 0).name, 'Mode 0')
assert.equal(decodeFlightMode('ardupilot', 'plane', 0).known, false)
assert.equal(decodeFlightMode('ardupilot', 'rover', 5).known, false)
assert.equal(decodeFlightMode('ardupilot', 'unknown', 3).known, false)

// ---------------------------------------------------------------------------
// PX4 packed main/sub-mode decoding is preserved for every vehicle class.
// ---------------------------------------------------------------------------
assert.equal(decodeFlightMode('px4', 'copter', 0x04040000).name, 'Mission')
assert.equal(decodeFlightMode('px4', 'copter', 0x03040000).name, 'Hold')
assert.equal(decodeFlightMode('px4', 'copter', 0x05040000).name, 'RTL')
assert.equal(decodeFlightMode('px4', 'copter', 0x00010000).name, 'Manual')
assert.equal(decodeFlightMode('px4', 'copter', 0x00030000).name, 'Position')
assert.equal(decodeFlightMode('px4', 'unknown', 0x00010000).name, 'Manual')
// Legacy heartbeat that carries only the main mode in the low bits.
assert.equal(decodeFlightMode('px4', 'copter', 1).name, 'Manual')
// Unknown main/sub combinations degrade to the raw description.
assert.equal(decodeFlightMode('px4', 'copter', 0x63000000 | 0x090000).name, 'Mode 9.99')
assert.equal(decodeFlightMode('px4', 'copter', 0x63000000 | 0x090000).known, false)

// ---------------------------------------------------------------------------
// Unknown families never decode a stack-specific layout.
// ---------------------------------------------------------------------------
assert.equal(decodeFlightMode('unknown', 'copter', 5).name, 'Mode 5')
assert.equal(decodeFlightMode('unknown', 'copter', 5).id, 5)
assert.equal(decodeFlightMode('unknown', 'copter', 5).known, false)

// ---------------------------------------------------------------------------
// Firmware label formatting is family-aware and never hardcodes PX4.
// ---------------------------------------------------------------------------
assert.equal(formatFirmwareLabel('ardupilot', '4.7.0'), 'ArduPilot v4.7.0')
assert.equal(formatFirmwareLabel('px4', '1.17.0'), 'PX4 v1.17.0')
assert.equal(formatFirmwareLabel('unknown', '2.0.1'), 'Autopilot v2.0.1')

// ---------------------------------------------------------------------------
// Profile-driven mode lists: only commonly safe, understood modes for the
// first ArduCopter release; PX4 keeps its existing list; unknown gets none.
// ---------------------------------------------------------------------------
const apModes = availableModes(arducopter)
assert.deepEqual(
  apModes.map((mode) => mode.name),
  ['Stabilize', 'AltHold', 'Loiter', 'PosHold', 'Auto', 'Guided', 'RTL', 'Land', 'Acro'],
)
assert.equal(apModes.find((mode) => mode.name === 'Loiter')?.id, 5)
assert.equal(apModes.find((mode) => mode.name === 'Stabilize')?.id, 0)
assert.ok(availableModes(px4Copter).some((mode) => mode.name === 'Position'))
assert.ok(availableModes(px4Copter).some((mode) => mode.name === 'Mission'))
assert.deepEqual(availableModes(unknownIdentity), [])
assert.deepEqual(availableModes(null), [])
assert.deepEqual(availableModes(buildVehicleIdentity(3, 1)), []) // ArduPlane deferred

// ---------------------------------------------------------------------------
// Server-side MAV_CMD_DO_SET_MODE parameter encoding by profile.
// ---------------------------------------------------------------------------
// ArduCopter Loiter: param1=CUSTOM_MODE_ENABLED, param2=raw mode, param3=0.
const apLoiter = encodeModeCommand(arducopter, 5)
assert.equal(apLoiter.ok, true)
if (apLoiter.ok) assert.deepEqual(apLoiter.params, [1, 5, 0, 0, 0, 0, 0])

// PX4 Position keeps the packed main/sub-mode encoding (main 3, sub 0).
const px4Position = encodeModeCommand(px4Copter, 3)
assert.equal(px4Position.ok, true)
if (px4Position.ok) assert.deepEqual(px4Position.params, [1, 3, 0, 0, 0, 0, 0])

// PX4 Mission (id 4) → main 4, sub 4.
const px4Mission = encodeModeCommand(px4Copter, 4)
assert.equal(px4Mission.ok, true)
if (px4Mission.ok) assert.deepEqual(px4Mission.params, [1, 4, 4, 0, 0, 0, 0])

// Unknown family / missing identity / unimplemented class: reject before
// anything reaches the serial link.
assert.deepEqual(encodeModeCommand(null, 0), {
  ok: false,
  code: 'unsupported_vehicle_profile',
  message: '尚未识别飞控类型，无法安全编码飞行模式',
})
assert.equal(encodeModeCommand(unknownIdentity, 0).ok, false)
assert.equal(encodeModeCommand(buildVehicleIdentity(3, 1), 0).ok, false) // plane
const apUnknownMode = encodeModeCommand(arducopter, 14) // Flip not exposed
assert.equal(apUnknownMode.ok, false)
if (!apUnknownMode.ok) assert.equal(apUnknownMode.code, 'unknown_mode')
const px4UnknownMode = encodeModeCommand(px4Copter, 99)
assert.equal(px4UnknownMode.ok, false)
if (!px4UnknownMode.ok) assert.equal(px4UnknownMode.code, 'unknown_mode')

// ---------------------------------------------------------------------------
// Capability matrix: computed from family + vehicle class only. Parameters
// must never authorize a safety-critical command.
// ---------------------------------------------------------------------------
const px4Caps = vehicleCapabilities(px4Copter)
assert.equal(px4Caps.writeOperations, true)
assert.equal(px4Caps.setMode, true)
assert.equal(px4Caps.arm, true)
assert.equal(px4Caps.guidedTakeoff, true)
assert.equal(px4Caps.calibrate, true)
assert.equal(px4Caps.motorTest, 'actuator-test')
assert.equal(px4Caps.frameConfig, true)
assert.equal(px4Caps.actuatorConfig, true)
assert.equal(px4Caps.pidConfig, true)
assert.equal(px4Caps.ekfConfig, true)
assert.equal(px4Caps.serialConfig, true)
assert.equal(px4Caps.gpsConfig, true)
assert.equal(px4Caps.logFormat, 'ulog')
assert.equal(px4Caps.mavlinkShell, 'px4-nsh')

const apCopterCaps = vehicleCapabilities(arducopter)
assert.equal(apCopterCaps.writeOperations, true)
assert.equal(apCopterCaps.setMode, true)
assert.equal(apCopterCaps.arm, true)
assert.equal(apCopterCaps.guidedTakeoff, true)
assert.equal(apCopterCaps.calibrate, true)
assert.equal(apCopterCaps.motorTest, 'motor-test')
assert.equal(apCopterCaps.frameConfig, true)
assert.equal(apCopterCaps.actuatorConfig, true)
assert.equal(apCopterCaps.pidConfig, true)
assert.equal(apCopterCaps.ekfConfig, true)
assert.equal(apCopterCaps.serialConfig, true)
assert.equal(apCopterCaps.gpsConfig, true)
assert.equal(apCopterCaps.logFormat, 'dataflash')
assert.equal(apCopterCaps.mavlinkShell, 'none')

// ArduPlane/Rover/Sub/Tracker are explicit read-only profiles until tested.
for (const typeId of [1, 10, 12, 5]) {
  const caps = vehicleCapabilities(buildVehicleIdentity(3, typeId))
  assert.equal(caps.writeOperations, false)
  assert.equal(caps.setMode, false)
  assert.equal(caps.arm, false)
  assert.equal(caps.guidedTakeoff, false)
  assert.equal(caps.calibrate, false)
  assert.equal(caps.motorTest, 'none')
  assert.equal(caps.frameConfig, false)
  assert.equal(caps.actuatorConfig, false)
  assert.equal(caps.pidConfig, false)
  assert.equal(caps.ekfConfig, false)
  assert.equal(caps.serialConfig, false)
  assert.equal(caps.gpsConfig, false)
  assert.equal(caps.logFormat, 'dataflash')
  assert.equal(caps.mavlinkShell, 'none')
}

// Unknown family / missing identity: every write capability defaults false.
for (const identity of [unknownIdentity, null]) {
  const caps = vehicleCapabilities(identity)
  assert.equal(caps.writeOperations, false)
  assert.equal(caps.setMode, false)
  assert.equal(caps.arm, false)
  assert.equal(caps.guidedTakeoff, false)
  assert.equal(caps.calibrate, false)
  assert.equal(caps.motorTest, 'none')
  assert.equal(caps.frameConfig, false)
  assert.equal(caps.actuatorConfig, false)
  assert.equal(caps.pidConfig, false)
  assert.equal(caps.ekfConfig, false)
  assert.equal(caps.serialConfig, false)
  assert.equal(caps.gpsConfig, false)
  assert.equal(caps.logFormat, 'unknown')
  assert.equal(caps.mavlinkShell, 'none')
}

// Per-kind calibration matrix: explicit family × vehicleClass × kind. PX4
// keeps its firmware-driven flows (no simple accel); ArduCopter gains the
// interactive accel, simple accel, level and onboard mag flows.
const ALL_CALIBRATION_KINDS = ['accel', 'accel_simple', 'gyro', 'mag', 'baro', 'level'] as const
assert.equal(supportsCalibrationKind(px4Copter, 'accel'), true)
assert.equal(supportsCalibrationKind(px4Copter, 'gyro'), true)
assert.equal(supportsCalibrationKind(px4Copter, 'mag'), true)
assert.equal(supportsCalibrationKind(px4Copter, 'baro'), true)
assert.equal(supportsCalibrationKind(px4Copter, 'level'), true)
// PX4 has no ArduPilot-style simple accel calibration (p5=4).
assert.equal(supportsCalibrationKind(px4Copter, 'accel_simple'), false)
// PX4 support is family-wide (any vehicle class).
assert.equal(supportsCalibrationKind(buildVehicleIdentity(12, 1), 'accel'), true)
for (const kind of ALL_CALIBRATION_KINDS) {
  assert.equal(supportsCalibrationKind(arducopter, kind), true, `arducopter ${kind}`)
}
// Unimplemented ArduPilot vehicle classes stay fully read-only.
for (const typeId of [1, 10, 12, 5]) {
  for (const kind of ALL_CALIBRATION_KINDS) {
    assert.equal(
      supportsCalibrationKind(buildVehicleIdentity(3, typeId), kind),
      false,
      `ardupilot type ${typeId} ${kind}`,
    )
  }
}
for (const kind of ALL_CALIBRATION_KINDS) {
  assert.equal(supportsCalibrationKind(unknownIdentity, kind), false, `unknown ${kind}`)
  assert.equal(supportsCalibrationKind(null, kind), false, `null ${kind}`)
}

console.log('vehicleProfiles classification and mode decoding checks passed')
