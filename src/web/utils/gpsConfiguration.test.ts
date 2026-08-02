import assert from 'node:assert/strict'
import type { ParamData } from '../../shared/types'
import {
  ardupilotGpsNeedsSerial,
  ardupilotGpsSerialPort,
  ardupilotGpsTypeParam,
  px4GpsBaudParam,
  px4GpsDefaultPort,
} from './gpsConfiguration'

const params = new Map<string, ParamData>()
const add = (id: string, value: number) => params.set(id, {
  id, value, type: 6, param_count: 8, param_index: params.size,
})

add('GPS1_TYPE', 1)
add('GPS_TYPE', 2)
add('GPS_TYPE2', 5)
add('SERIAL3_PROTOCOL', 5)
add('SERIAL3_BAUD', 115)
add('SERIAL4_PROTOCOL', 2)
add('SERIAL4_BAUD', 57)
add('SERIAL7_PROTOCOL', 5)
add('SERIAL7_BAUD', 230)

assert.equal(px4GpsDefaultPort(1), 201)
assert.equal(px4GpsDefaultPort(2), 202)
assert.equal(px4GpsBaudParam(201), 'SER_GPS1_BAUD')
assert.equal(px4GpsBaudParam(102), 'SER_TEL2_BAUD')
assert.equal(px4GpsBaudParam(301), null, 'a port without a matching baud parameter stays read-only')

assert.equal(ardupilotGpsTypeParam(params, 1)?.id, 'GPS1_TYPE', 'current ArduPilot name wins')
assert.equal(ardupilotGpsTypeParam(params, 2)?.id, 'GPS_TYPE2', 'legacy name remains compatible')
assert.equal(ardupilotGpsSerialPort(params, 1)?.index, 3)
assert.equal(ardupilotGpsSerialPort(params, 2)?.index, 7)
assert.equal(ardupilotGpsNeedsSerial(1), true)
assert.equal(ardupilotGpsNeedsSerial(5), true)
assert.equal(ardupilotGpsNeedsSerial(9), false)
assert.equal(ardupilotGpsNeedsSerial(22), false)

console.log('GPS parameter profile checks passed')
