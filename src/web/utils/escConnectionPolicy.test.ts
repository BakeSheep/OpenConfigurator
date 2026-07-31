import assert from 'node:assert/strict'
import test from 'node:test'
import { buildVehicleIdentity } from '../../shared/vehicleProfiles'
import {
  escModeAllowedForProfile,
  passthroughParamWriteError,
} from './escConnectionPolicy'

test('ESC passthrough follows the writable vehicle profile without blocking direct serial', () => {
  const arducopter = buildVehicleIdentity(3, 2)
  const arduplane = buildVehicleIdentity(3, 1)
  const px4 = buildVehicleIdentity(12, 2)
  const unknown = buildVehicleIdentity(0, 2)

  assert.equal(escModeAllowedForProfile(arducopter, 'ardupilot_passthrough'), true)
  assert.equal(escModeAllowedForProfile(arduplane, 'ardupilot_passthrough'), false)
  assert.equal(escModeAllowedForProfile(px4, 'ardupilot_passthrough'), false)

  assert.equal(escModeAllowedForProfile(px4, 'px4_serial_control'), true)
  assert.equal(escModeAllowedForProfile(arducopter, 'px4_serial_control'), false)
  assert.equal(escModeAllowedForProfile(unknown, 'px4_serial_control'), false)
  assert.equal(escModeAllowedForProfile(null, 'px4_serial_control'), false)

  for (const identity of [arducopter, arduplane, px4, unknown, null]) {
    assert.equal(escModeAllowedForProfile(identity, 'direct'), true)
  }
})

test('passthrough setup consumes only its matching param_set boundary error', () => {
  const matching = {
    operation: 'param_set',
    requestId: 'esc-setup-current',
    message: '当前飞控类型为只读配置',
  }
  assert.equal(
    passthroughParamWriteError('esc-setup-current', matching),
    matching.message,
  )
  assert.equal(
    passthroughParamWriteError('esc-setup-current', {
      ...matching,
      requestId: 'esc-setup-stale',
    }),
    null,
  )
  assert.equal(
    passthroughParamWriteError('esc-setup-current', {
      ...matching,
      operation: 'reboot_vehicle',
    }),
    null,
  )
  assert.equal(passthroughParamWriteError(null, matching), null)
})
