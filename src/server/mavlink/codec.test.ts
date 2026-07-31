import assert from 'node:assert/strict'
import { MavLinkProtocolV2, ardupilotmega, common } from 'node-mavlink'
import { decode, MavlinkCodecSession, type MavlinkMessage } from './codec'

// ---------------------------------------------------------------------------
// Dialect registry: MAG_CAL_PROGRESS (191) exists only in the ardupilotmega
// dialect and must decode through real serialized frames; MAG_CAL_REPORT
// (192) already lives in common and must keep decoding there (regression).
// ---------------------------------------------------------------------------

function roundTrip(message: Parameters<MavLinkProtocolV2['serialize']>[0]): MavlinkMessage {
  // Serialize with a real FC identity (sys 1 / comp 1) so source ids survive.
  const frame = new MavLinkProtocolV2(1, 1).serialize(message, 7)
  const session = new MavlinkCodecSession()
  const received: MavlinkMessage[] = []
  session.on('message', (msg: MavlinkMessage) => received.push(msg))
  session.write(frame)
  session.destroy()
  assert.equal(received.length, 1, 'expected exactly one decoded frame (CRC must validate)')
  return received[0]
}

// -- MAG_CAL_PROGRESS (191, ardupilotmega) ------------------------------------
{
  const progress = new ardupilotmega.MagCalProgress()
  progress.compassId = 1
  progress.calMask = 0b011
  progress.calStatus = 2 // MAG_CAL_RUNNING_STEP_ONE
  progress.attempt = 1
  progress.completionPct = 55
  progress.completionMask = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
  progress.directionX = 0.25
  progress.directionY = -0.5
  progress.directionZ = 1.0

  const wire = roundTrip(progress)
  assert.equal(wire.msgId, 191)
  assert.equal(wire.sysId, 1, 'source system id must be preserved')
  assert.equal(wire.compId, 1, 'source component id must be preserved')

  const decoded = decode<ardupilotmega.MagCalProgress>(191, wire.payload)
  assert.ok(decoded, 'MAG_CAL_PROGRESS (191) must be registered in the codec REGISTRY')
  assert.equal(decoded.compassId, 1)
  assert.equal(decoded.calMask, 0b011)
  assert.equal(decoded.calStatus, 2)
  assert.equal(decoded.attempt, 1)
  assert.equal(decoded.completionPct, 55)
}

// -- MAG_CAL_REPORT (192, common) regression ----------------------------------
{
  const report = new common.MagCalReport()
  report.compassId = 0
  report.calMask = 0b001
  report.calStatus = 4 // MAG_CAL_SUCCESS
  report.autosaved = 0
  report.fitness = 7.25
  report.ofsX = 12.5
  report.ofsY = -34.75
  report.ofsZ = 5.125

  const wire = roundTrip(report)
  assert.equal(wire.msgId, 192)

  const decoded = decode<common.MagCalReport>(192, wire.payload)
  assert.ok(decoded, 'MAG_CAL_REPORT (192) must keep decoding via common')
  // The registered class must stay the common dialect one, not be shadowed
  // by a whole-dialect ardupilotmega spread.
  assert.ok(decoded instanceof common.MagCalReport)
  assert.equal(decoded.compassId, 0)
  assert.equal(decoded.calStatus, 4)
  assert.equal(decoded.autosaved, 0)
  assert.ok(Math.abs(decoded.fitness - 7.25) < 1e-6)
  assert.ok(Math.abs(decoded.ofsX - 12.5) < 1e-6)
  assert.ok(Math.abs(decoded.ofsY - -34.75) < 1e-6)
  assert.ok(Math.abs(decoded.ofsZ - 5.125) < 1e-6)
}

// -- RANGEFINDER (173, ardupilotmega) legacy sensor fallback ------------------
{
  const rangefinder = new ardupilotmega.RangeFinder()
  rangefinder.distance = 1.23
  rangefinder.voltage = 5

  const wire = roundTrip(rangefinder)
  assert.equal(wire.msgId, 173)

  const decoded = decode<ardupilotmega.RangeFinder>(173, wire.payload)
  assert.ok(decoded, 'RANGEFINDER (173) must be registered in the codec REGISTRY')
  assert.ok(decoded instanceof ardupilotmega.RangeFinder)
  assert.ok(Math.abs(decoded.distance - 1.23) < 1e-6)
  assert.equal(decoded.voltage, 5)
}

console.log('codec dialect registry checks passed')
