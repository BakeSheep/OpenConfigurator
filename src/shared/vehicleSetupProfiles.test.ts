import assert from 'node:assert/strict'
import test from 'node:test'
import type { ParamData } from './types'
import { ARDUCOPTER_FRAME_OPTIONS, PX4_AIRFRAMES, getPx4AirframeInfo, isSupportedArduCopterFrame } from './airframes'
import { buildVehicleIdentity, vehicleCapabilities } from './vehicleProfiles'
import {
  arduFlightModeSlot,
  calibratedMultiplier,
  calibratedPx4FlightModeSlot,
  discoverBatteryConfigs,
  isAllowedVehicleConfigParameter,
  isSafetyReduction,
  validateVehicleConfigValue,
} from './vehicleSetupProfiles'

const px4 = buildVehicleIdentity(12, 2)
const copter = buildVehicleIdentity(3, 2)
const plane = buildVehicleIdentity(3, 1)
const param = (id: string, value = 0): ParamData => ({ id, value, type: 9, param_count: 1, param_index: 0 })

test('setup capability matrix only enables PX4 and ArduCopter', () => {
  for (const identity of [px4, copter]) {
    const caps = vehicleCapabilities(identity)
    assert.equal(caps.airframeSelection, true)
    assert.equal(caps.radioCalibration, true)
    assert.equal(caps.flightModeConfig, true)
    assert.equal(caps.powerConfig, true)
    assert.equal(caps.safetyConfig, true)
  }
  assert.equal(vehicleCapabilities(plane).airframeSelection, false)
  assert.equal(vehicleCapabilities(null).safetyConfig, false)
})

test('generated PX4 and ArduCopter airframe catalogs preserve only known choices', () => {
  assert.equal(PX4_AIRFRAMES.length, 56)
  assert.equal(new Set(PX4_AIRFRAMES.map((entry) => entry.autostartId)).size, PX4_AIRFRAMES.length)
  assert.equal(getPx4AirframeInfo(4001)?.name, 'Generic Quadcopter')
  assert.equal(getPx4AirframeInfo(99999), null)
  assert.ok(ARDUCOPTER_FRAME_OPTIONS.length > 20)
  assert.equal(isSupportedArduCopterFrame(1, 1), true)
  assert.equal(isSupportedArduCopterFrame(6, 1), false)
})

test('battery instance discovery follows PX4 and ArduPilot prefixes', () => {
  const px4Params = new Map([param('BAT1_SOURCE'), param('BAT1_CAPACITY'), param('BAT3_SOURCE')].map((item) => [item.id, item]))
  assert.deepEqual(discoverBatteryConfigs(px4, px4Params).map((item) => item.prefix), ['BAT1_', 'BAT3_'])
  const apParams = new Map([param('BATT_MONITOR'), param('BATT2_MONITOR'), param('BATTA_MONITOR')].map((item) => [item.id, item]))
  assert.deepEqual(discoverBatteryConfigs(copter, apParams).map((item) => item.prefix), ['BATT_', 'BATT2_', 'BATTA_'])
})

test('server whitelist is firmware scoped and safety reductions require confirmation', () => {
  assert.equal(isAllowedVehicleConfigParameter(px4, 'flight_modes', 'RC_MAP_FLTMODE'), true)
  assert.equal(isAllowedVehicleConfigParameter(px4, 'flight_modes', 'FLTMODE_CH'), false)
  assert.equal(isAllowedVehicleConfigParameter(copter, 'power', 'BATTA_VOLT_MULT'), true)
  assert.equal(isAllowedVehicleConfigParameter(plane, 'power', 'BATT_MONITOR'), false)
  assert.equal(isSafetyReduction('NAV_RCL_ACT', 2, 0), true)
  assert.equal(isSafetyReduction('NAV_RCL_ACT', 2, 3), true)
  assert.equal(isSafetyReduction('ARMING_CHECK', 1, 0), true)
  assert.equal(isSafetyReduction('ARMING_CHECK', 1, 3), false)
  assert.equal(isSafetyReduction('ARMING_CHECK', 3, 1), true)
  assert.equal(isSafetyReduction('BAT_LOW_THR', 0.2, 0.15), true)
  assert.equal(isSafetyReduction('BAT_LOW_THR', 0.2, 0.25), false)
  assert.equal(isSafetyReduction('COM_RC_LOSS_T', 0.5, 2), true)
  assert.equal(isSafetyReduction('COM_RC_LOSS_T', 2, 0.5), false)
  assert.equal(isSafetyReduction('FS_EKF_THRESH', 0.8, 0.9), true)
  assert.equal(isSafetyReduction('BATT_FS_LOW_VOLT', 14, 13), true)
  assert.equal(isSafetyReduction('BATT_FS_LOW_VOLT', 13, 14), false)
  assert.equal(isSafetyReduction('FS_OPTIONS', 0, 1), true)
})

test('battery threshold ordering and switch slot math match QGC behavior', () => {
  const values = new Map([
    ['BAT_LOW_THR', { value: 0.2 }],
    ['BAT_CRIT_THR', { value: 0.1 }],
    ['BAT_EMERGEN_THR', { value: 0.05 }],
  ])
  assert.equal(validateVehicleConfigValue(px4, 'safety', 'BAT_CRIT_THR', 0.25, values), '电池阈值必须满足：紧急 ≤ 严重 ≤ 低电量')
  assert.equal(ardupilotSlot(1200), 0)
  assert.equal(ardupilotSlot(1750), 5)
  assert.equal(calibratedPx4FlightModeSlot(1500, 1000, 2000, 1500, false), 3)
  assert.equal(calibratedPx4FlightModeSlot(1000, 1000, 2000, 1500, true), 5)
  assert.equal(calibratedMultiplier(12.3, 12, 10), 10.25)
  assert.equal(calibratedMultiplier(12.3, 0, 10), null)
})

function ardupilotSlot(pwm: number): number | null {
  return arduFlightModeSlot(pwm)
}
