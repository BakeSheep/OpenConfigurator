import assert from 'node:assert/strict'
import { parameterEnumLabel, parameterEnumOptions } from './parameterEnumMetadata'

const px4 = { autopilotId: 12, vehicleTypeId: 2, family: 'px4', vehicleClass: 'copter' } as const
const arducopter = { autopilotId: 3, vehicleTypeId: 2, family: 'ardupilot', vehicleClass: 'copter' } as const
const arduplane = { autopilotId: 3, vehicleTypeId: 1, family: 'ardupilot', vehicleClass: 'plane' } as const

assert.deepEqual(parameterEnumOptions('COM_LOW_BAT_ACT', px4)?.map(({ value }) => value), [0, 2, 3])
assert.equal(parameterEnumLabel('COM_LOW_BAT_ACT', 3, px4), 'Return at critical level, land at emergency level')

// The enum from the requested legacy QGC example stays available even though
// current PX4 metadata no longer contains the BatMon driver parameter.
assert.equal(parameterEnumLabel('BATMON_DRIVER_EN', 1, px4), 'Start on default I2C addr (BATMON_ADDR_DFLT)')

// Bitmasks require multiple simultaneous selections and must not become a
// single-choice dropdown.
assert.equal(parameterEnumOptions('EKF2_GPS_CTRL', px4), null)

assert.equal(parameterEnumLabel('SERIAL1_PROTOCOL', 2, arducopter), 'MAVLink2')
assert.equal(parameterEnumLabel('MOT_PWM_TYPE', 6, arducopter), 'DShot600')
assert.equal(parameterEnumLabel('FS_EKF_THRESH', Math.fround(0.6), arducopter), 'Strict')
assert.equal(parameterEnumOptions('SERIAL1_PROTOCOL', px4), null)
assert.equal(parameterEnumOptions('SERIAL1_PROTOCOL', arduplane), null)
assert.equal(parameterEnumOptions('SERIAL1_PROTOCOL', null), null)

console.log('parameterEnumMetadata checks passed')
