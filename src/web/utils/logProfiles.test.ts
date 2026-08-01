import assert from 'node:assert/strict'
import { buildVehicleIdentity } from '../../shared/vehicleProfiles'
import { logSupport } from './logProfiles'

const px4 = buildVehicleIdentity(12, 2)
const arducopter = buildVehicleIdentity(3, 2)
const arduplane = buildVehicleIdentity(3, 1)
const unknown = buildVehicleIdentity(0, 0)

// PX4 profile offers MAVFTP ULog browsing and .ulg analysis.
const px4Log = logSupport(px4)
assert.equal(px4Log.format, 'ulog')
assert.equal(px4Log.browse, true)
assert.equal(px4Log.analyze, true)
assert.equal(px4Log.allowDelete, true)
assert.equal(px4Log.deleteScope, 'per-file')
assert.equal(px4Log.logPath, '/fs/microsd/log')

// ArduPilot profile reports DataFlash: id-addressed list/download over
// LOG_REQUEST_* (no filesystem path) and erase-all-only deletion.
const apLog = logSupport(arducopter)
assert.equal(apLog.format, 'dataflash')
assert.equal(apLog.browse, true)
assert.equal(apLog.analyze, true)
assert.equal(apLog.allowDelete, true)
assert.equal(apLog.deleteScope, 'erase-all')
assert.equal(apLog.logPath, null)

// Unimplemented ArduPilot classes keep DataFlash browsing/analysis read-only.
const planeLog = logSupport(arduplane)
assert.equal(planeLog.format, 'dataflash')
assert.equal(planeLog.browse, true)
assert.equal(planeLog.analyze, true)
assert.equal(planeLog.allowDelete, false)
assert.equal(planeLog.deleteScope, 'none')
assert.equal(planeLog.logPath, null)

// Unknown profile offers neither destructive log deletion nor analysis.
for (const identity of [unknown, null]) {
  const log = logSupport(identity)
  assert.equal(log.analyze, false)
  assert.equal(log.allowDelete, false)
  assert.equal(log.deleteScope, 'none')
  assert.equal(log.browse, false)
  assert.equal(log.logPath, null)
}

console.log('logProfiles checks passed')
