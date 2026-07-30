import assert from 'node:assert/strict'
import type { ParamData } from '../../shared/types'
import { buildVehicleIdentity } from '../../shared/vehicleProfiles'
import { buildFrameConfigView, motorFunctionOptions, type FrameOutputChannel } from './vehicleConfig'

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

// ---------------------------------------------------------------------------
// ArduCopter Quad/X: FRAME_CLASS/FRAME_TYPE + SERVOx_FUNCTION + MOT_PWM_TYPE.
// ---------------------------------------------------------------------------
const arducopterQuadX = params({
  FRAME_CLASS: 1,
  FRAME_TYPE: 1,
  SERVO1_FUNCTION: 33,
  SERVO2_FUNCTION: 34,
  SERVO3_FUNCTION: 35,
  SERVO4_FUNCTION: 36,
  MOT_PWM_TYPE: 6,
})
const apView = buildFrameConfigView(arducopter, arducopterQuadX)
assert.ok(apView)
assert.equal(apView.name, 'Quad / X')
assert.equal(apView.motorCount, 4)
assert.equal(apView.outputChannels.length, 4)
for (let motor = 1; motor <= 4; motor += 1) {
  const output: FrameOutputChannel = apView.outputChannels[motor - 1]
  assert.equal(output.paramId, `SERVO${motor}_FUNCTION`)
  assert.equal(output.label, `SERVO${motor}`)
  assert.equal(output.functionValue, 32 + motor)
  assert.equal(output.motorInstance, motor)
  assert.equal(output.port, 0)
  assert.equal(output.channel, motor)
}
assert.equal(apView.protocolLabel, 'DShot600')
assert.equal(apView.frameSource, 'FRAME_CLASS 1 / FRAME_TYPE 1')

// Unknown output function values are preserved, never rewritten.
const apWithAux = buildFrameConfigView(arducopter, params({
  FRAME_CLASS: 1,
  FRAME_TYPE: 1,
  SERVO1_FUNCTION: 33,
  SERVO2_FUNCTION: 34,
  SERVO3_FUNCTION: 35,
  SERVO4_FUNCTION: 36,
  SERVO5_FUNCTION: 51,   // RCIN passthrough - not a motor
  SERVO6_FUNCTION: 0,
}))
assert.ok(apWithAux)
assert.equal(apWithAux.outputChannels.length, 6)
assert.equal(apWithAux.outputChannels[4].functionValue, 51)
assert.equal(apWithAux.outputChannels[4].motorInstance, null)
assert.equal(apWithAux.outputChannels[5].functionValue, 0)
assert.equal(apWithAux.outputChannels[5].motorInstance, null)
// No MOT_PWM_TYPE parameter -> the protocol is reported unknown, not PWM.
assert.equal(apWithAux.protocolLabel, '未知')

// ArduPilot motor output ids split after Motor8: 33..40 then 82..85.
const apOptions = motorFunctionOptions('ardupilot', 4)
assert.deepEqual(apOptions[0], { value: 0, label: 'Disabled' })
assert.deepEqual(apOptions[1], { value: 33, label: 'Motor 1' })
assert.deepEqual(apOptions[4], { value: 36, label: 'Motor 4' })
assert.equal(apOptions.length, 5)
const apTwelveOptions = motorFunctionOptions('ardupilot', 12)
assert.deepEqual(apTwelveOptions[8], { value: 40, label: 'Motor 8' })
assert.deepEqual(apTwelveOptions[9], { value: 82, label: 'Motor 9' })
assert.deepEqual(apTwelveOptions[12], { value: 85, label: 'Motor 12' })

const apDodeca = buildFrameConfigView(arducopter, params({
  FRAME_CLASS: 12,
  FRAME_TYPE: 0,
  SERVO9_FUNCTION: 82,
  SERVO10_FUNCTION: 83,
  SERVO11_FUNCTION: 84,
  SERVO12_FUNCTION: 85,
  SERVO13_FUNCTION: 41,
}))
assert.ok(apDodeca)
assert.deepEqual(apDodeca.outputChannels.map((output) => output.motorInstance), [9, 10, 11, 12, null])


// Frame classes beyond quad resolve their documented motor counts.
const hexa = buildFrameConfigView(arducopter, params({ FRAME_CLASS: 2, FRAME_TYPE: 0 }))
assert.ok(hexa)
assert.equal(hexa.name, 'Hexa / Plus')
assert.equal(hexa.motorCount, 6)
// Undocumented class keeps the raw value visible without inventing a count.
const unknownFrame = buildFrameConfigView(arducopter, params({ FRAME_CLASS: 99, FRAME_TYPE: 0 }))
assert.ok(unknownFrame)
assert.equal(unknownFrame.motorCount, null)
assert.ok(unknownFrame.name.includes('99'))

// ---------------------------------------------------------------------------
// PX4 fixture continues using SYS_AUTOSTART, PWM_MAIN_FUNCx and CA_ROTOR_COUNT.
// ---------------------------------------------------------------------------
const px4QuadX = params({
  SYS_AUTOSTART: 4001,
  CA_ROTOR_COUNT: 4,
  PWM_MAIN_FUNC1: 101,
  PWM_MAIN_FUNC2: 102,
  PWM_MAIN_FUNC3: 103,
  PWM_MAIN_FUNC4: 104,
  PWM_MAIN_TIM0: -3,
})
const px4View = buildFrameConfigView(px4, px4QuadX)
assert.ok(px4View)
assert.equal(px4View.name, 'Generic Quadrotor X')
assert.equal(px4View.motorCount, 4)
assert.equal(px4View.outputChannels.length, 4)
for (let motor = 1; motor <= 4; motor += 1) {
  const output: FrameOutputChannel = px4View.outputChannels[motor - 1]
  assert.equal(output.paramId, `PWM_MAIN_FUNC${motor}`)
  assert.equal(output.motorInstance, motor)
  assert.equal(output.port, 0)
}
assert.equal(px4View.frameSource, 'SYS_AUTOSTART 4001')
const px4Options = motorFunctionOptions('px4', 4)
assert.deepEqual(px4Options[1], { value: 101, label: 'Motor 1' })

// Unknown family has no frame adapter.
assert.equal(buildFrameConfigView(buildVehicleIdentity(0, 0), px4QuadX), null)
assert.equal(buildFrameConfigView(null, px4QuadX), null)

console.log('vehicleConfig frame/actuator adapter checks passed')
