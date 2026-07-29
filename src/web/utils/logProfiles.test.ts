import assert from 'node:assert/strict'
import { buildVehicleIdentity } from '../../shared/vehicleProfiles'
import { logSupport } from './logProfiles'

const px4 = buildVehicleIdentity(12, 2)
const arducopter = buildVehicleIdentity(3, 2)
const unknown = buildVehicleIdentity(0, 0)

// PX4 profile offers MAVFTP ULog browsing and .ulg analysis.
const px4Log = logSupport(px4)
assert.equal(px4Log.format, 'ulog')
assert.equal(px4Log.browse, true)
assert.equal(px4Log.analyze, true)
assert.equal(px4Log.allowDelete, true)
assert.equal(px4Log.logPath, '/fs/microsd/log')

// ArduPilot profile reports DataFlash and does not navigate to /fs/microsd/log.
const apLog = logSupport(arducopter)
assert.equal(apLog.format, 'dataflash')
assert.equal(apLog.browse, false)
assert.equal(apLog.analyze, false)
assert.equal(apLog.allowDelete, false)
assert.equal(apLog.logPath, null)

// Unknown profile offers neither destructive log deletion nor analysis.
for (const identity of [unknown, null]) {
  const log = logSupport(identity)
  assert.equal(log.analyze, false)
  assert.equal(log.allowDelete, false)
  assert.equal(log.browse, false)
  assert.equal(log.logPath, null)
}

console.log('logProfiles checks passed')
