import assert from 'node:assert/strict'
import { ByteBuffer } from '../platform/ByteBuffer'
import {
  MavLinkPacketSignature,
  MavLinkProtocolV2,
  ardupilotmega,
  common,
  minimal,
  decode,
  MavlinkCodecSession,
  type MavlinkMessage,
} from './codec'

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

// ---------------------------------------------------------------------------
// Signing: graceful per-source enforcement (OCSA-003) and the symmetric
// first-contact timestamp window (OCSA-013). All frames are real serialized
// MAVLink 2 so CRC, signature and replay bookkeeping run for real.
// ---------------------------------------------------------------------------

const SIGNING_KEY = MavLinkPacketSignature.key('codec signing test key')
const OTHER_KEY = MavLinkPacketSignature.key('a key held by someone else')

function makeHeartbeat(): minimal.Heartbeat {
  const heartbeat = new minimal.Heartbeat()
  heartbeat.customMode = 0x03040000
  heartbeat.type = 2
  heartbeat.autopilot = 12
  heartbeat.baseMode = 0 as never
  heartbeat.systemStatus = 4
  heartbeat.mavlinkVersion = 3
  return heartbeat
}

let signingClockMs = Date.now()
/** Strictly increasing signing timestamps, mirroring how the session spaces
 * its own outbound signatures so rapid successive frames never share a value. */
function nextSigningTimestampMs(): number {
  signingClockMs = Math.max(Date.now(), signingClockMs + 100)
  return signingClockMs
}

function unsignedFrame(sysId: number, compId: number, seq: number): ByteBuffer {
  return new MavLinkProtocolV2(sysId, compId).serialize(makeHeartbeat(), seq)
}

function signedFrame(
  sysId: number,
  compId: number,
  seq: number,
  timestampMs: number = nextSigningTimestampMs(),
  key: Uint8Array = SIGNING_KEY,
  linkId = 0,
): ByteBuffer {
  const protocol = new MavLinkProtocolV2(sysId, compId, MavLinkProtocolV2.IFLAG_SIGNED)
  return protocol.sign(protocol.serialize(makeHeartbeat(), seq), linkId, key, timestampMs)
}

function attach(session: MavlinkCodecSession): {
  received: MavlinkMessage[]
  rejections: string[]
} {
  const received: MavlinkMessage[] = []
  const rejections: string[] = []
  session.on('message', (message: MavlinkMessage) => received.push(message))
  session.on('packetRejected', (reason: string) => rejections.push(reason))
  return { received, rejections }
}

function lastReason(rejections: string[]): string | undefined {
  return rejections[rejections.length - 1]
}

/** Swallow (and capture) the startup signing warning while constructing. */
function captureWarnings<T>(action: () => T): { result: T; warnings: string[] } {
  const warnings: string[] = []
  const originalWarn = console.warn
  console.warn = (...parts: unknown[]) => warnings.push(parts.map(String).join(' '))
  try {
    return { result: action(), warnings }
  } finally {
    console.warn = originalWarn
  }
}

// -- OCSA-003: key set + REQUIRE off learns per source ------------------------
{
  const { result: session, warnings } = captureWarnings(() => new MavlinkCodecSession({
    signing: { key: SIGNING_KEY, linkId: 0 },
  }))
  // The browser-local runtime has no environment surface; the legacy
  // MAVLINK_SIGNING_REQUIRE warning does not apply, so nothing must warn.
  assert.equal(warnings.length, 0, 'per-source enforcement must not warn at init')
  const { received, rejections } = attach(session)

  // Source 1:1 proves it signs; enforcement arms for that source only.
  session.write(signedFrame(1, 1, 0))
  assert.equal(received.length, 1)
  assert.equal(received[0].signed, true)

  session.write(unsignedFrame(1, 1, 1))
  assert.equal(received.length, 1, 'unsigned traffic from a proven signing source is refused')
  assert.equal(session.stats.rejectedPackets, 1)
  assert.deepEqual(rejections, ['unsigned_packet_downgrade'])

  // A foreign-key signature neither passes nor poisons the learned state.
  session.write(signedFrame(1, 1, 2, nextSigningTimestampMs(), OTHER_KEY))
  assert.equal(received.length, 1)
  assert.equal(session.stats.rejectedPackets, 2)
  assert.deepEqual(rejections, ['unsigned_packet_downgrade', 'invalid_signature'])

  // Properly signed frames still flow after the downgrade attempts.
  session.write(signedFrame(1, 1, 3))
  assert.equal(received.length, 2)

  // Source 2:1 never signed a single frame: its unsigned frames keep flowing.
  session.write(unsignedFrame(2, 1, 4))
  assert.equal(received.length, 3)
  assert.equal(received[2].signed, false)

  // Its first validly signed frame arms enforcement for that source too.
  session.write(signedFrame(2, 1, 5))
  assert.equal(received.length, 4)
  session.write(unsignedFrame(2, 1, 6))
  assert.equal(received.length, 4, 'learning is per (sysid, compid), never global')
  assert.equal(session.stats.rejectedPackets, 3)

  // Learned requirements are security state like the replay watermarks:
  // reset() (physical reconnect) must not un-arm them.
  session.reset()
  session.write(unsignedFrame(2, 1, 7))
  assert.equal(received.length, 4, 'a session reset must not un-learn a signing source')

  session.destroy()
}

// -- OCSA-003: REQUIRE=1 keeps its global semantics ---------------------------
{
  const { result: session, warnings } = captureWarnings(() => new MavlinkCodecSession({
    signing: { key: SIGNING_KEY, linkId: 0, requireSigned: true },
  }))
  assert.equal(warnings.length, 0, 'global enforcement needs no downgrade warning')
  const { received, rejections } = attach(session)

  session.write(unsignedFrame(3, 1, 0))
  assert.equal(
    received.length,
    0,
    'requireSigned rejects unsigned frames even before any learning happened',
  )
  assert.equal(session.stats.rejectedPackets, 1)
  assert.deepEqual(rejections, ['unsigned_packet'])

  const accepted = signedFrame(3, 1, 1)
  session.write(accepted)
  assert.equal(received.length, 1)
  assert.equal(received[0].signed, true)

  session.write(accepted)
  assert.equal(received.length, 1, 'exact replays stay rejected')
  assert.equal(lastReason(rejections), 'signature_replay')

  session.write(signedFrame(3, 1, 2, nextSigningTimestampMs(), OTHER_KEY))
  assert.equal(received.length, 1, 'foreign-key signatures stay rejected')
  assert.equal(session.stats.rejectedPackets, 3)

  session.destroy()
}

// -- OCSA-013: far-future first contact cannot poison the watermark -----------
{
  const session = new MavlinkCodecSession({
    signing: { key: SIGNING_KEY, linkId: 0, requireSigned: true },
  })
  const { received, rejections } = attach(session)
  const normalTimestamp = nextSigningTimestampMs()

  session.write(signedFrame(4, 1, 0, Date.now() + 60 * 60 * 1000))
  assert.equal(received.length, 0, 'a far-future first contact must be rejected')
  assert.deepEqual(rejections, ['signature_future'])

  // The poisoned timestamp never became the watermark, so ordinary traffic
  // from the same (sysid, compid, linkId) keeps flowing instead of every
  // follow-up being misclassified as a replay.
  session.write(signedFrame(4, 1, 1, normalTimestamp))
  assert.equal(received.length, 1)
  session.write(signedFrame(4, 1, 2, normalTimestamp + 100))
  assert.equal(received.length, 2)

  // The upper bound also applies after a normal watermark exists.
  session.write(signedFrame(4, 1, 3, Date.now() + 60 * 60 * 1000))
  assert.equal(received.length, 2, 'a later far-future frame must be rejected')
  assert.equal(lastReason(rejections), 'signature_future')
  session.write(signedFrame(4, 1, 4, normalTimestamp + 200))
  assert.equal(received.length, 3, 'the rejected later frame must not poison the watermark')

  // Moderate skew inside the window stays acceptable on first contact...
  const skewedSession = new MavlinkCodecSession({
    signing: { key: SIGNING_KEY, linkId: 0, requireSigned: true },
  })
  const skewed = attach(skewedSession)
  skewedSession.write(signedFrame(5, 1, 0, Date.now() + 20_000))
  assert.equal(skewed.received.length, 1, 'future skew inside the tolerance is accepted')
  // ...and then acts as the watermark like any accepted first contact.
  skewedSession.write(signedFrame(5, 1, 1, Date.now() + 19_000))
  assert.equal(skewed.received.length, 1)
  assert.equal(lastReason(skewed.rejections), 'signature_replay')
  skewedSession.destroy()

  // allowStaleFirstPacket only ever relaxed staleness; it must not reopen the
  // future-poisoning hole.
  const lenientSession = new MavlinkCodecSession({
    signing: { key: SIGNING_KEY, linkId: 0, requireSigned: true, allowStaleFirstPacket: true },
  })
  const lenient = attach(lenientSession)
  lenientSession.write(signedFrame(6, 1, 0, Date.now() + 60 * 60 * 1000))
  assert.equal(lenient.received.length, 0, 'allowStaleFirstPacket must not disable the future bound')
  lenientSession.write(signedFrame(6, 1, 1))
  assert.equal(lenient.received.length, 1, 'the rejected frame left no poisoned watermark')
  lenientSession.destroy()

  session.destroy()
}

// -- First-contact staleness regression --------------------------------------
{
  const staleTimestampMs = Date.now() - 24 * 60 * 60 * 1000

  const secureSession = new MavlinkCodecSession({
    signing: { key: SIGNING_KEY, linkId: 0, requireSigned: true },
  })
  const secure = attach(secureSession)
  secureSession.write(signedFrame(7, 1, 0, staleTimestampMs))
  assert.equal(secure.received.length, 0, 'stale first contact must stay rejected')
  assert.deepEqual(secure.rejections, ['signature_stale'])
  secureSession.destroy()

  // The explicit no-RTC compatibility switch keeps working, watermark included.
  const noRtcSession = new MavlinkCodecSession({
    signing: { key: SIGNING_KEY, linkId: 0, requireSigned: true, allowStaleFirstPacket: true },
  })
  const noRtc = attach(noRtcSession)
  noRtcSession.write(signedFrame(8, 1, 0, staleTimestampMs))
  assert.equal(noRtc.received.length, 1, 'allowStaleFirstPacket compatibility path intact')
  noRtcSession.write(signedFrame(8, 1, 1, staleTimestampMs))
  assert.equal(noRtc.received.length, 1, 'the stale first packet established the watermark')
  assert.equal(lastReason(noRtc.rejections), 'signature_replay')
  noRtcSession.destroy()
}

console.log('codec dialect registry and signing checks passed')
