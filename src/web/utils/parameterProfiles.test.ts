import assert from 'node:assert/strict'
import type { ParamData } from '../../shared/types'
import { buildVehicleIdentity } from '../../shared/vehicleProfiles'
import {
  pidGroups,
  ekfSourceFields,
  boardOrientationField,
  ardupilotSerialPorts,
  ARDUPILOT_SERIAL_PROTOCOLS,
  ARDUPILOT_SERIAL_BAUDS,
} from './parameterProfiles'

function params(values: Record<string, number>): Map<string, ParamData> {
  const map = new Map<string, ParamData>()
  let index = 0
  for (const [id, value] of Object.entries(values)) {
    map.set(id, { id, value, type: 9, param_count: Object.keys(values).length, param_index: index })
    index += 1
  }
  return map
}

const arducopter = buildVehicleIdentity(3, 2)
const px4 = buildVehicleIdentity(12, 2)
const unknown = buildVehicleIdentity(0, 0)

// ---------------------------------------------------------------------------
// ArduCopter PID groups: rate-loop gains keep ArduPilot naming and semantics.
// ---------------------------------------------------------------------------
const apGroups = pidGroups(arducopter)
const apIds = new Set(apGroups.flatMap((group) => group.params.map((field) => field.id)))
for (const suffix of ['P', 'I', 'D', 'FF']) {
  assert.ok(apIds.has(`ATC_RAT_RLL_${suffix}`), `missing ATC_RAT_RLL_${suffix}`)
  assert.ok(apIds.has(`ATC_RAT_PIT_${suffix}`), `missing ATC_RAT_PIT_${suffix}`)
  assert.ok(apIds.has(`ATC_RAT_YAW_${suffix}`), `missing ATC_RAT_YAW_${suffix}`)
}
// No PX4 identifiers may leak into the ArduPilot profile.
assert.ok(![...apIds].some((id) => id.startsWith('MC_') || id.startsWith('MPC_')))
// Conservative UI bounds exist on every field.
for (const group of apGroups) {
  for (const field of group.params) {
    assert.ok(field.max > field.min, `${field.id} needs bounds`)
    assert.ok(field.step > 0, `${field.id} needs a step`)
  }
}

// PX4 groups remain unchanged in naming.
const px4Groups = pidGroups(px4)
const px4Ids = new Set(px4Groups.flatMap((group) => group.params.map((field) => field.id)))
assert.ok(px4Ids.has('MC_ROLLRATE_P'))
assert.ok(px4Ids.has('MC_PITCHRATE_I'))
assert.ok(px4Ids.has('MC_YAWRATE_D'))
assert.ok(px4Ids.has('MPC_XY_P'))
assert.ok(![...px4Ids].some((id) => id.startsWith('ATC_')))

// Unknown profiles expose no PID editor groups.
assert.deepEqual(pidGroups(unknown), [])
assert.deepEqual(pidGroups(null), [])

// ---------------------------------------------------------------------------
// EKF3 source configuration (ArduPilot) - selects, never auto-writing
// AHRS_EKF_TYPE or EK3_ENABLE.
// ---------------------------------------------------------------------------
const apEkf = ekfSourceFields(arducopter)
assert.deepEqual(
  apEkf.map((field) => field.id),
  ['EK3_SRC1_POSXY', 'EK3_SRC1_VELXY', 'EK3_SRC1_POSZ', 'EK3_SRC1_VELZ', 'EK3_SRC1_YAW'],
)
for (const field of apEkf) {
  assert.ok(field.options.length > 0)
  assert.ok(field.rebootRequired)
}
assert.ok(!apEkf.some((field) => field.id === 'AHRS_EKF_TYPE' || field.id === 'EK3_ENABLE'))
// PX4 keeps its dedicated EKF2 panel; no select-based source fields here.
assert.deepEqual(ekfSourceFields(px4), [])
assert.deepEqual(ekfSourceFields(unknown), [])

// ---------------------------------------------------------------------------
// Board orientation binds to the profile parameter.
// ---------------------------------------------------------------------------
assert.equal(boardOrientationField(arducopter)?.id, 'AHRS_ORIENTATION')
assert.equal(boardOrientationField(px4)?.id, 'SENS_BOARD_ROT')
assert.equal(boardOrientationField(unknown), null)
assert.equal(boardOrientationField(null), null)
const orientationOptions = boardOrientationField(arducopter)!.options
assert.ok(orientationOptions.some((option) => option.value === 0 && /none/i.test(option.label)))
assert.ok(orientationOptions.some((option) => option.value === 4)) // Yaw180

// ---------------------------------------------------------------------------
// ArduPilot serial ports map only SERIALx_* parameters actually present.
// ---------------------------------------------------------------------------
const serialParams = params({
  SERIAL1_PROTOCOL: 2,
  SERIAL1_BAUD: 57,
  SERIAL2_PROTOCOL: 23,
  SERIAL2_BAUD: 115,
  SERIAL4_PROTOCOL: 5,
  SERIAL4_BAUD: 230,
  SR1_EXT_STAT: 4,
  SR1_POSITION: 4,
})
const ports = ardupilotSerialPorts(serialParams)
assert.deepEqual(ports.map((port) => port.index), [1, 2, 4])
assert.equal(ports[0].protocolParam, 'SERIAL1_PROTOCOL')
assert.equal(ports[0].baudParam, 'SERIAL1_BAUD')
// SRx_* stream rates are surfaced read-only per port.
assert.deepEqual(ports[0].streamRateParams, ['SR1_EXT_STAT', 'SR1_POSITION'])
assert.deepEqual(ports[1].streamRateParams, [])
// Known protocol/baud labels exist; unknown values are preserved by the UI.
assert.ok(ARDUPILOT_SERIAL_PROTOCOLS.some(([value]) => value === 2))
assert.ok(ARDUPILOT_SERIAL_BAUDS.some(([value]) => value === 57))
assert.deepEqual(ardupilotSerialPorts(params({})), [])

console.log('parameterProfiles checks passed')
