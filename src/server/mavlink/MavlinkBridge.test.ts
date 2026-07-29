import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import {
  common,
  minimal,
  standard,
  MavLinkPacketSignature,
  MavLinkProtocolV1,
  MavLinkProtocolV2,
} from 'node-mavlink'
import { MavlinkBridge } from './MavlinkBridge'
import { MavlinkCodecSession, type MavlinkMessage } from './codec'

const wait = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds))

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail('timed out waiting for asynchronous condition')
    await wait(5)
  }
}

function last<T>(values: T[]): T | undefined {
  return values.length > 0 ? values[values.length - 1] : undefined
}

function findLast<T>(values: T[], predicate: (value: T) => boolean): T | undefined {
  for (let index = values.length - 1; index >= 0; index--) {
    if (predicate(values[index])) return values[index]
  }
  return undefined
}

function makeHeartbeat(autopilot = 12): minimal.Heartbeat {
  const heartbeat = new minimal.Heartbeat()
  heartbeat.customMode = 0x03040000
  heartbeat.type = 2
  heartbeat.autopilot = autopilot
  heartbeat.baseMode = 0 as never
  heartbeat.systemStatus = 4
  heartbeat.mavlinkVersion = 3
  return heartbeat
}

function heartbeatPayload(
  autopilot = 12,
  type = autopilot === 8 ? 18 : 2,
  customMode = 0x03040000,
): Buffer {
  const payload = Buffer.alloc(9)
  payload.writeUInt32LE(customMode >>> 0, 0)
  payload[4] = type
  payload[5] = autopilot
  payload[7] = 4
  payload[8] = 3
  return payload
}

function frameMessageId(frame: Buffer): number {
  return frame[0] === MavLinkProtocolV2.START_BYTE
    ? frame.readUIntLE(7, 3)
    : frame[5]
}

function framePayload(frame: Buffer): Buffer {
  const offset = frame[0] === MavLinkProtocolV2.START_BYTE ? 10 : 6
  return frame.subarray(offset, offset + frame[1])
}

// ---------------------------------------------------------------------------
// Codec sessions: real v1/v2 framing, bounded garbage, negotiation and signing.
// ---------------------------------------------------------------------------
{
  const session = new MavlinkCodecSession({ protocol: 'auto', maxBufferedBytes: 512 })
  const received: MavlinkMessage[] = []
  session.on('message', (message) => received.push(message))

  const v1 = new MavLinkProtocolV1(42, 1).serialize(makeHeartbeat(), 7)
  session.write(v1.subarray(0, 4))
  session.write(v1.subarray(4))
  assert.equal(received.length, 1)
  assert.equal(received[0].version, 1)
  assert.equal(received[0].payload.length, 9)
  assert.equal(session.serialize(makeHeartbeat())[0], MavLinkProtocolV1.START_BYTE)

  const vfr = new common.VfrHud()
  vfr.airspeed = 12.5
  vfr.groundspeed = 0
  vfr.alt = 0
  vfr.climb = 0
  vfr.heading = 0
  vfr.throttle = 0
  const truncatedV2 = new MavLinkProtocolV2(42, 1).serialize(vfr, 8)
  assert.ok(truncatedV2[1] < common.VfrHud.PAYLOAD_LENGTH)
  session.write(truncatedV2)
  assert.equal(last(received)?.version, 2)
  assert.equal(last(received)?.payload.length, truncatedV2[1])
  assert.equal(session.protocolVersion, 2)
  assert.equal(session.serialize(makeHeartbeat())[0], MavLinkProtocolV2.START_BYTE)
  const sequenceProtocol = new MavLinkProtocolV2(42, 1)
  session.write(sequenceProtocol.serialize(makeHeartbeat(), 12))
  assert.equal(session.stats.rxSequenceLost, 3)
  session.write(sequenceProtocol.serialize(makeHeartbeat(), 0))
  assert.equal(session.stats.rxOutOfOrder, 1)
  session.write(sequenceProtocol.serialize(makeHeartbeat(), 1))
  assert.equal(session.stats.rxOutOfOrder, 1)

  const independent = new MavlinkCodecSession({ protocol: 'v2' })
  assert.equal(independent.serialize(makeHeartbeat())[4], 0)
  assert.equal(independent.serialize(makeHeartbeat())[4], 1)
  const secondIndependent = new MavlinkCodecSession({ protocol: 'v2' })
  assert.equal(secondIndependent.serialize(makeHeartbeat())[4], 0)

  const noiseSession = new MavlinkCodecSession({ protocol: 'auto', maxBufferedBytes: 512 })
  const noiseMessages: MavlinkMessage[] = []
  noiseSession.on('message', (message) => noiseMessages.push(message))
  noiseSession.write(Buffer.alloc(1024 * 1024, 0x55))
  assert.equal(noiseSession.stats.bufferedBytes, 0)
  assert.equal(noiseSession.stats.garbageBytes, 1024 * 1024)

  // A normal serial data event may coalesce well over 4 KiB of complete
  // frames. The ingress bound applies only to residual garbage/partials.
  const burstSession = new MavlinkCodecSession({ protocol: 'v2', maxBufferedBytes: 512 })
  let burstPackets = 0
  burstSession.on('message', () => { burstPackets++ })
  const burst = Buffer.concat(Array.from(
    { length: 300 },
    (_, sequence) => new MavLinkProtocolV2(42, 1).serialize(
      makeHeartbeat(),
      sequence & 0xff,
    ),
  ))
  assert.ok(burst.length > 4096)
  burstSession.write(burst)
  assert.equal(burstPackets, 300)
  assert.equal(burstSession.stats.bufferedBytes, 0)
  assert.equal(burstSession.stats.garbageBytes, 0)

  // A fragmented FTP frame can contain what looks like a complete MAVLink
  // frame inside its binary file data. The codec must wait for the outer known
  // frame instead of resynchronizing into its payload.
  const binarySession = new MavlinkCodecSession({ protocol: 'v2', maxBufferedBytes: 512 })
  const binaryMessages: MavlinkMessage[] = []
  binarySession.on('message', (message) => binaryMessages.push(message))
  const embeddedFrame = new MavLinkProtocolV2(77, 1).serialize(makeHeartbeat(), 55)
  const ftpPayload = Buffer.alloc(251, 0x41)
  embeddedFrame.copy(ftpPayload, 40)
  const ftpMessage = new common.FileTransferProtocol()
  ftpMessage.targetNetwork = 0
  ftpMessage.targetSystem = 255
  ftpMessage.targetComponent = 190
  ftpMessage.payload = Array.from(ftpPayload) as unknown as typeof ftpMessage.payload
  const binaryFrame = new MavLinkProtocolV2(42, 1).serialize(ftpMessage, 54)
  const fragmentEnd = 10 + 40 + embeddedFrame.length
  assert.ok(fragmentEnd < binaryFrame.length)
  binarySession.write(binaryFrame.subarray(0, fragmentEnd))
  assert.equal(binaryMessages.length, 0, 'partial FTP frame must remain buffered')
  binarySession.write(binaryFrame.subarray(fragmentEnd))
  assert.equal(binaryMessages.length, 1)
  assert.equal(binaryMessages[0].msgId, 110)
  assert.ok(binaryMessages[0].payload.includes(embeddedFrame))

  // A false STX claiming a 255-byte payload must not block a valid frame that
  // is already complete later in the same chunk.
  const v2Heartbeat = new MavLinkProtocolV2(42, 1).serialize(makeHeartbeat(), 9)
  noiseSession.write(Buffer.concat([Buffer.from([0xfd, 0xff, 0, 0, 0]), v2Heartbeat]))
  assert.equal(noiseMessages.length, 1)

  const corrupted = Buffer.from(v2Heartbeat)
  corrupted[10] ^= 0x01
  noiseSession.write(corrupted)
  assert.ok(noiseSession.stats.crcErrors >= 1)
  noiseSession.write(v2Heartbeat)
  assert.equal(noiseMessages.length, 2)

  const unsupportedFlags = new MavLinkProtocolV2(42, 1, 0x02)
    .serialize(makeHeartbeat(), 10)
  const rejectedBefore = noiseSession.stats.rejectedPackets
  noiseSession.write(unsupportedFlags)
  assert.equal(noiseSession.stats.rejectedPackets, rejectedBefore + 1)

  const rebuildsBefore = noiseSession.stats.parserRebuilds
  ;(noiseSession as unknown as { parser: EventEmitter }).parser.emit(
    'error',
    new Error('synthetic parser failure'),
  )
  assert.equal(noiseSession.stats.parserRebuilds, rebuildsBefore + 1)

  const signingKey = MavLinkPacketSignature.key('OpenConfigurator protocol test')
  const signedSession = new MavlinkCodecSession({
    signing: { key: signingKey, linkId: 7, requireSigned: true },
  })
  const signedMessages: MavlinkMessage[] = []
  signedSession.on('message', (message) => signedMessages.push(message))
  const signingProtocol = new MavLinkProtocolV2(
    42,
    1,
    MavLinkProtocolV2.IFLAG_SIGNED,
  )
  const unsignedSignedFrame = signingProtocol.serialize(makeHeartbeat(), 11)
  const signedFrame = signingProtocol.sign(
    unsignedSignedFrame,
    7,
    signingKey,
    Date.now(),
  )
  signedSession.write(signedFrame)
  signedSession.write(signedFrame)
  assert.equal(signedMessages.length, 1)
  assert.equal(signedMessages[0].signed, true)
  assert.equal(signedSession.stats.rejectedPackets, 1)
  signedSession.reset()
  signedSession.write(signedFrame)
  assert.equal(
    signedMessages.length,
    1,
    'a physical-session reset must not make a recorded signed frame valid again',
  )
  assert.equal(signedSession.stats.rejectedPackets, 1)

  // A no-RTC flight controller signs with a timestamp far in the past. First
  // contact must accept the cryptographically valid frame and establish the
  // replay watermark; an equal-or-older follow-up is then rejected as replay.
  const staleSigningSession = new MavlinkCodecSession({
    signing: { key: signingKey, linkId: 7, requireSigned: true, allowStaleFirstPacket: true },
  })
  let staleSigningMessages = 0
  staleSigningSession.on('message', () => { staleSigningMessages++ })
  const staleTimestampMs = Date.now() - 24 * 60 * 60 * 1000
  staleSigningSession.write(signingProtocol.sign(
    signingProtocol.serialize(makeHeartbeat(), 12),
    7,
    signingKey,
    staleTimestampMs,
  ))
  assert.equal(staleSigningMessages, 1, 'first contact from a no-RTC source must be accepted')
  assert.equal(staleSigningSession.stats.rejectedPackets, 0)
  staleSigningSession.write(signingProtocol.sign(
    signingProtocol.serialize(makeHeartbeat(), 13),
    7,
    signingKey,
    staleTimestampMs,
  ))
  assert.equal(
    staleSigningMessages,
    1,
    'a same-timestamp frame is a replay once the watermark exists',
  )
  assert.equal(staleSigningSession.stats.rejectedPackets, 1)
  const secureFirstContact = new MavlinkCodecSession({
    signing: { key: signingKey, linkId: 7, requireSigned: true },
  })
  let secureFirstContactMessages = 0
  secureFirstContact.on('message', () => { secureFirstContactMessages++ })
  secureFirstContact.write(signingProtocol.sign(
    signingProtocol.serialize(makeHeartbeat(), 11),
    7,
    signingKey,
    staleTimestampMs,
  ))
  assert.equal(secureFirstContactMessages, 0, 'secure default must reject a stale first packet')
  assert.equal(secureFirstContact.stats.rejectedPackets, 1)
  for (let index = 0; index < 300; index++) {
    const systemId = (index % 250) + 1
    const componentId = Math.floor(index / 250) + 1
    const protocol = new MavLinkProtocolV2(
      systemId,
      componentId,
      MavLinkProtocolV2.IFLAG_SIGNED,
    )
    signedSession.write(protocol.sign(
      protocol.serialize(makeHeartbeat(), index & 0xff),
      7,
      signingKey,
      Date.now() + index + 1000,
    ))
  }
  const boundedSigningSession = signedSession as unknown as {
    replayTimestamps: Map<string, number>
    lastRxSeq: Map<string, number>
  }
  assert.ok(boundedSigningSession.replayTimestamps.size <= 256)
  assert.ok(boundedSigningSession.lastRxSeq.size <= 256)

  const dyingSession = new MavlinkCodecSession({ protocol: 'v2' })
  const dyingParser = (dyingSession as unknown as { parser: EventEmitter }).parser
  dyingSession.on('parserError', () => dyingSession.destroy())
  dyingParser.emit('error', new Error('destroy during parser recovery'))
  await Promise.resolve()
  assert.equal(dyingSession.stats.parserRebuilds, 0)
  assert.equal(dyingSession.eventNames().length, 0)
  assert.equal(dyingParser.eventNames().length, 0)
  dyingSession.write(v2Heartbeat)
  assert.throws(() => dyingSession.serialize(makeHeartbeat()), /destroyed/)

  session.destroy()
  independent.destroy()
  secondIndependent.destroy()
  noiseSession.destroy()
  burstSession.destroy()
  signedSession.destroy()
  staleSigningSession.destroy()
}

class FakeConnection extends EventEmitter {
  frames: Buffer[] = []
  writePriorities: string[] = []
  status = 'connected'
  config: { type: 'serial' | 'bluetooth' } = { type: 'serial' }
  vehicleReady = false
  bytesReceived = 0
  bytesSent = 0
  heartbeatNotifications = 0
  activityNotifications = 0

  write(frame: Buffer, priority = 'normal'): boolean {
    this.frames.push(frame)
    this.writePriorities.push(priority)
    this.bytesSent += frame.length
    return true
  }

  feed(frame: Buffer): void {
    this.bytesReceived += frame.length
    this.emit('data', frame)
  }

  notifyAutopilotHeartbeat(): void {
    this.heartbeatNotifications++
    this.vehicleReady = true
  }

  notifyAutopilotActivity(): void {
    this.activityNotifications++
  }
}

type PrivateBridge = {
  handleMessage: (message: MavlinkMessage) => void
  targetSysId: number | null
  targetCompId: number | null
  pendingCommands: Map<number, unknown>
  pendingParamSets: Map<string, unknown>
  paramDownloadActive: boolean
  discoveredTargets: Map<string, unknown>
  paramEncoding: string
  messageIntervalSupport: string
}

function inject(
  bridge: MavlinkBridge,
  msgId: number,
  payload: Buffer,
  sysId = 42,
  compId = 1,
): void {
  ;(bridge as unknown as PrivateBridge).handleMessage({
    msgId,
    payload,
    seq: 0,
    sysId,
    compId,
    version: 2,
  })
}

function commandAckPayload(
  command: number,
  result: number,
  targetSystem = 255,
  targetComponent = 190,
  progress = 0xff,
): Buffer {
  const payload = Buffer.alloc(10)
  payload.writeUInt16LE(command, 0)
  payload[2] = result
  payload[3] = progress
  payload[8] = targetSystem
  payload[9] = targetComponent
  return payload
}

function paramValuePayload(
  id: string,
  value: number,
  type = 9,
  count = 1,
  index = 0,
): Buffer {
  const payload = Buffer.alloc(25)
  if (type === 9) payload.writeFloatLE(value, 0)
  else payload.writeInt32LE(value, 0)
  payload.writeUInt16LE(count, 4)
  payload.writeUInt16LE(index, 6)
  Buffer.from(id, 'ascii').copy(payload, 8, 0, 16)
  payload[24] = type
  return payload
}

// ---------------------------------------------------------------------------
// Bridge target selection, transactions, fallbacks and telemetry semantics.
// ---------------------------------------------------------------------------
const connection = new FakeConnection()
const bridge = new MavlinkBridge(connection as never, {
  codec: { protocol: 'v2' },
  commandTimeoutMs: 20,
  paramSetTimeoutMs: 20,
  versionRetryMs: 20,
})
bridge.setMaxListeners(30)
const messages: any[] = []
bridge.on('message', (message) => messages.push(message))

const framesBeforeHeartbeat = connection.frames.length
;(bridge as unknown as { sendHeartbeat: () => void }).sendHeartbeat()
assert.equal(connection.frames.length, framesBeforeHeartbeat + 1)
assert.equal(connection.writePriorities[connection.writePriorities.length - 1], 'high')

// Mutating operations are rejected until a validated autopilot heartbeat.
const framesBeforeUnreadyCommand = connection.frames.length
bridge.handleClientMessage({
  type: 'command',
  requestId: 'arm-before-ready',
  cmd: 'MAV_CMD_COMPONENT_ARM_DISARM',
  params: [1, 0, 0, 0, 0, 0, 0],
  safetyConfirmation: 'arm',
})
assert.equal(connection.frames.length, framesBeforeUnreadyCommand)
assert.equal(last(messages)?.data.code, 'target_not_ready')

// Companion/camera heartbeats do not qualify as a target.
inject(bridge, 0, heartbeatPayload(8), 42, 191)
assert.equal((bridge as unknown as PrivateBridge).targetSysId, null)

inject(bridge, 0, heartbeatPayload(), 42, 1)
assert.equal((bridge as unknown as PrivateBridge).targetSysId, 42)
assert.equal((bridge as unknown as PrivateBridge).targetCompId, 1)
assert.equal(connection.vehicleReady, true)
assert.equal(connection.heartbeatNotifications, 1)
assert.ok(messages.some((message) => message.type === 'status' && message.data.mode === 'Hold'))
// The selected heartbeat classifies the vehicle profile and surfaces it on
// both the status stream and the target lifecycle.
const px4Status = findLast(messages, (message) => message.type === 'status')
assert.equal(px4Status.data.identity.family, 'px4')
assert.equal(px4Status.data.identity.vehicleClass, 'copter')
assert.equal(px4Status.data.identity.autopilotId, 12)
assert.equal(px4Status.data.identity.vehicleTypeId, 2)
const selectedTarget = findLast(messages, (message) => message.type === 'target' && message.data.reason === 'selected')
assert.equal(selectedTarget.data.identity.family, 'px4')
assert.ok(selectedTarget.data.discovered.every((entry: { type: number }) => typeof entry.type === 'number'))

const initialCommandFrames = connection.frames.filter((frame) => frameMessageId(frame) === 76)
assert.ok(initialCommandFrames.some((frame) => {
  const payload = framePayload(frame)
  return payload.readUInt16LE(28) === 512 && payload.readFloatLE(0) === 148
}))
assert.ok(initialCommandFrames.some((frame) => {
  const payload = framePayload(frame)
  return payload.readUInt16LE(28) === 511 && payload.readFloatLE(0) === 105
}))
for (const messageId of [106, 132]) {
  assert.ok(initialCommandFrames.some((frame) => {
    const payload = framePayload(frame)
    return payload.readUInt16LE(28) === 511 && payload.readFloatLE(0) === messageId
  }), `expected telemetry interval request for MAVLink message #${messageId}`)
}

// Semantic mode change: the server encodes PX4 Position (id 3) as packed
// main/sub-mode parameters [1, 3, 0, ...] on MAV_CMD_DO_SET_MODE.
bridge.handleClientMessage({
  type: 'set_flight_mode',
  requestId: 'px4-mode-position',
  data: { modeId: 3 },
})
const px4ModeFrame = findLast(
  connection.frames.filter((frame) => frameMessageId(frame) === 76),
  (frame) => framePayload(frame).readUInt16LE(28) === 176,
)
assert.ok(px4ModeFrame)
{
  const payload = framePayload(px4ModeFrame)
  assert.equal(payload.readFloatLE(0), 1)
  assert.equal(payload.readFloatLE(4), 3)
  assert.equal(payload.readFloatLE(8), 0)
}
// Unvetted mode ids are rejected before serialization.
const modeFramesBeforeBadMode = connection.frames.filter((frame) =>
  frameMessageId(frame) === 76 && framePayload(frame).readUInt16LE(28) === 176
).length
bridge.handleClientMessage({
  type: 'set_flight_mode',
  requestId: 'px4-mode-bad',
  data: { modeId: 99 },
})
assert.equal(
  connection.frames.filter((frame) =>
    frameMessageId(frame) === 76 && framePayload(frame).readUInt16LE(28) === 176
  ).length,
  modeFramesBeforeBadMode,
)
assert.equal(
  findLast(messages, (message) => message.type === 'operation_error'
    && message.data.requestId === 'px4-mode-bad')?.data.code,
  'unknown_mode',
)
// Resolve the pending DO_SET_MODE transaction so later tests are unaffected,
// then wait out the post-ACK settling quarantine window (commandTimeoutMs).
inject(bridge, 77, commandAckPayload(176, 0))
await wait(45)

// A second autopilot is discovered but cannot steal status/liveness/target.
const statusCountBeforeSecondTarget = messages.filter((message) => message.type === 'status').length
inject(bridge, 0, heartbeatPayload(), 43, 1)
assert.equal((bridge as unknown as PrivateBridge).targetSysId, 42)
assert.equal(
  messages.filter((message) => message.type === 'status').length,
  statusCountBeforeSecondTarget,
)
assert.equal(connection.heartbeatNotifications, 1)
const activityBeforeForeignTelemetry = connection.activityNotifications
inject(bridge, 30, Buffer.alloc(28), 43, 1)
assert.equal(connection.activityNotifications, activityBeforeForeignTelemetry)
inject(bridge, 200, Buffer.alloc(4), 43, 1)
assert.equal(connection.activityNotifications, activityBeforeForeignTelemetry)
inject(bridge, 200, Buffer.alloc(4), 42, 1)
assert.equal(connection.activityNotifications, activityBeforeForeignTelemetry + 1)
inject(bridge, 30, Buffer.alloc(28), 42, 1)
assert.equal(connection.activityNotifications, activityBeforeForeignTelemetry + 2)

// COMMAND_LONG carries the selected target. ACK extensions addressed to a
// different GCS must not complete the local transaction.
bridge.handleClientMessage({
  type: 'command',
  requestId: 'arm-1',
  cmd: 'MAV_CMD_COMPONENT_ARM_DISARM',
  params: [1, 0, 0, 0, 0, 0, 0],
  safetyConfirmation: 'arm',
})
const armFrame = findLast(
  connection.frames.filter((frame) => frameMessageId(frame) === 76),
  (frame) => framePayload(frame).readUInt16LE(28) === 400,
)
assert.ok(armFrame)
assert.equal(connection.writePriorities[connection.frames.indexOf(armFrame)], 'high')
assert.equal(framePayload(armFrame)[30], 42)
assert.equal(framePayload(armFrame)[31], 1)

inject(bridge, 77, commandAckPayload(400, 0, 99, 1))
assert.equal((bridge as unknown as PrivateBridge).pendingCommands.has(400), true)
// target fields are optional extensions; progress may be the only extension
// left in a trailing-zero-truncated v2 ACK.
inject(bridge, 77, commandAckPayload(400, 5, 0, 0, 45).subarray(0, 4))
const progressAck = findLast(
  messages,
  (message) => message.type === 'command_ack' && message.data.command === 400,
)
assert.equal(progressAck.data.requestId, 'arm-1')
assert.equal(progressAck.data.progress, 45)
assert.equal(progressAck.data.terminal, false)
inject(bridge, 77, commandAckPayload(400, 0))
assert.equal((bridge as unknown as PrivateBridge).pendingCommands.has(400), false)

// Emergency disarm bypasses the same-command ACK quarantine. It is delivered
// immediately but deliberately not opened as a correlatable transaction.
const armDisarmFramesBeforeEmergency = connection.frames.filter((frame) =>
  frameMessageId(frame) === 76 && framePayload(frame).readUInt16LE(28) === 400
).length
bridge.handleClientMessage({
  type: 'command',
  requestId: 'emergency-disarm',
  cmd: 'MAV_CMD_COMPONENT_ARM_DISARM',
  params: [0, 0, 0, 0, 0, 0, 0],
  safetyConfirmation: 'disarm',
})
assert.equal(
  connection.frames.filter((frame) =>
    frameMessageId(frame) === 76 && framePayload(frame).readUInt16LE(28) === 400
  ).length,
  armDisarmFramesBeforeEmergency + 1,
)
assert.equal((bridge as unknown as PrivateBridge).pendingCommands.has(400), false)
assert.equal(connection.writePriorities[connection.writePriorities.length - 1], 'critical')
inject(bridge, 77, commandAckPayload(400, 0))
const staleDisarmAck = findLast(
  messages,
  (message) => message.type === 'command_ack' && message.data.command === 400,
)
assert.equal(staleDisarmAck.data.requestId, undefined)
assert.equal(staleDisarmAck.data.stale, true)

// Normal-risk commands retry once with confirmation incremented, then timeout.
const modeFramesBefore = connection.frames.filter((frame) =>
  frameMessageId(frame) === 76 && framePayload(frame).readUInt16LE(28) === 176
).length
bridge.handleClientMessage({
  type: 'command',
  requestId: 'mode-timeout',
  cmd: 'MAV_CMD_DO_SET_MODE',
  params: [1, 4, 3, 0, 0, 0, 0],
})
bridge.handleClientMessage({
  type: 'command',
  requestId: 'mode-concurrent',
  cmd: 'MAV_CMD_DO_SET_MODE',
  params: [1, 4, 4, 0, 0, 0, 0],
})
assert.ok(messages.some((message) =>
  message.type === 'operation_error'
  && message.data.requestId === 'mode-concurrent'
  && message.data.code === 'command_busy'
))
await waitFor(() => messages.some((message) =>
  message.type === 'operation_error'
  && message.data.requestId === 'mode-timeout'
  && message.data.code === 'command_timeout'
))
bridge.handleClientMessage({
  type: 'command',
  requestId: 'mode-after-timeout',
  cmd: 'MAV_CMD_DO_SET_MODE',
  params: [1, 4, 4, 0, 0, 0, 0],
})
assert.ok(messages.some((message) =>
  message.type === 'operation_error'
  && message.data.requestId === 'mode-after-timeout'
  && message.data.code === 'command_result_uncertain'
))
inject(bridge, 77, commandAckPayload(176, 0))
const staleModeAck = findLast(
  messages,
  (message) => message.type === 'command_ack' && message.data.command === 176,
)
assert.equal(staleModeAck.data.requestId, undefined)
assert.equal(staleModeAck.data.stale, true)
const modeFrames = connection.frames.filter((frame) =>
  frameMessageId(frame) === 76 && framePayload(frame).readUInt16LE(28) === 176
).slice(modeFramesBefore)
assert.equal(modeFrames.length, 2)
assert.equal(framePayload(modeFrames[0])[32] ?? 0, 0)
assert.equal(framePayload(modeFrames[1])[32], 1)
assert.ok(messages.some((message) =>
  message.type === 'operation_error'
  && message.data.requestId === 'mode-timeout'
  && message.data.code === 'command_timeout'
))

// ACTUATOR_TEST ACK cannot identify the motor instance. Safe motor commands
// are dispatched immediately, with an explicit sent_unconfirmed status for
// each request; ACKs remain deliberately uncorrelated so a delayed ACK can
// never be assigned to another motor request.
const actuatorFrameCount = () => connection.frames.filter((frame) =>
  frameMessageId(frame) === 76 && framePayload(frame).readUInt16LE(28) === 310
).length
const actuatorStart = actuatorFrameCount()
bridge.handleClientMessage({
  type: 'motor_test',
  requestId: 'motor-1',
  data: { instance: 1, throttle: 15, duration: 2, propsRemoved: true },
})
bridge.handleClientMessage({
  type: 'motor_test',
  requestId: 'motor-2',
  data: { instance: 2, throttle: 15, duration: 2, propsRemoved: true },
})
assert.equal(actuatorFrameCount() - actuatorStart, 2)
const startedActuatorFrames = connection.frames.filter((frame) =>
  frameMessageId(frame) === 76 && framePayload(frame).readUInt16LE(28) === 310
).slice(actuatorStart)
assert.deepEqual(
  startedActuatorFrames.map((frame) => connection.writePriorities[connection.frames.indexOf(frame)]),
  ['high', 'high'],
)
assert.ok(messages.some((message) =>
  message.type === 'motor_test_status'
  && message.data.requestId === 'motor-1'
  && message.data.action === 'start'
  && message.data.status === 'sent_unconfirmed'
))
assert.ok(messages.some((message) =>
  message.type === 'motor_test_status'
  && message.data.requestId === 'motor-2'
  && message.data.action === 'start'
))
bridge.handleClientMessage({
  type: 'motor_test',
  requestId: 'motor-stop-3',
  data: { instance: 3, throttle: 0, duration: 0 },
})
assert.equal(actuatorFrameCount() - actuatorStart, 3)
assert.equal(connection.writePriorities[connection.writePriorities.length - 1], 'critical')
assert.ok(messages.some((message) =>
  message.type === 'motor_test_status'
  && message.data.requestId === 'motor-stop-3'
  && message.data.action === 'stop'
))
let latestActuator = findLast(
  connection.frames.filter((frame) => frameMessageId(frame) === 76),
  (frame) => framePayload(frame).readUInt16LE(28) === 310,
)
assert.ok(latestActuator)
assert.ok(Number.isNaN(framePayload(latestActuator).readFloatLE(0)))
assert.equal(framePayload(latestActuator).readFloatLE(16), 1103)
bridge.handleClientMessage({
  type: 'motor_test',
  requestId: 'motor-stop-4',
  data: { instance: 4, throttle: 0, duration: 0 },
})
assert.equal(actuatorFrameCount() - actuatorStart, 4)
latestActuator = findLast(
  connection.frames.filter((frame) => frameMessageId(frame) === 76),
  (frame) => framePayload(frame).readUInt16LE(28) === 310,
)
assert.equal(framePayload(latestActuator!).readFloatLE(16), 1104)
inject(bridge, 77, commandAckPayload(310, 0))
const uncorrelatedMotorAck = findLast(
  messages,
  (message) => message.type === 'command_ack' && message.data.command === 310,
)
assert.equal(uncorrelatedMotorAck.data.requestId, undefined)

// Malformed PARAM_VALUE packets never reach the cache or transaction layer.
const paramMessagesBeforeMalformed = messages.filter((message) => message.type === 'param').length
inject(bridge, 22, Buffer.alloc(24))
const unsupportedParamType = paramValuePayload('BAD_TYPE', 1)
unsupportedParamType[24] = 99
inject(bridge, 22, unsupportedParamType)
const nonFiniteParam = paramValuePayload('BAD_VALUE', 1)
nonFiniteParam.writeFloatLE(Number.NaN, 0)
inject(bridge, 22, nonFiniteParam)
const invalidIdParam = paramValuePayload('BAD_ID', 1)
invalidIdParam[8] = 0x01
inject(bridge, 22, invalidIdParam)
assert.equal(
  messages.filter((message) => message.type === 'param').length,
  paramMessagesBeforeMalformed,
)

// PARAM_SET validates inputs, waits through stale mismatched broadcasts for a
// matching echo, and carries requestId through the final result.
bridge.handleClientMessage({
  type: 'param_set',
  requestId: 'param-ok',
  data: { id: 'TEST_PARAM', value: 12.5, paramType: 9 },
})
const paramSetFrame = findLast(
  connection.frames.filter((frame) => frameMessageId(frame) === 23),
  (frame) => framePayload(frame).subarray(6, 16).toString('ascii') === 'TEST_PARAM',
)
assert.ok(paramSetFrame)
assert.equal(framePayload(paramSetFrame).readFloatLE(0), 12.5)
const paramResultsBeforeMismatch = messages.filter(
  (message) => message.type === 'param_set_result',
).length
inject(bridge, 22, paramValuePayload('TEST_PARAM', 11.5))
assert.equal(
  messages.filter((message) => message.type === 'param_set_result').length,
  paramResultsBeforeMismatch,
)
assert.equal((bridge as unknown as PrivateBridge).pendingParamSets.has('TEST_PARAM'), true)
inject(bridge, 22, paramValuePayload('TEST_PARAM', 12.5))
const successfulParamSet = findLast(
  messages,
  (message) => message.type === 'param_set_result' && message.data.requestId === 'param-ok',
)
assert.equal(successfulParamSet.data.accepted, true)
assert.equal(successfulParamSet.data.acceptedValue, 12.5)

const framesBeforeInvalidParam = connection.frames.length
bridge.handleClientMessage({
  type: 'param_set',
  requestId: 'param-invalid',
  data: { id: '参数', value: 1, paramType: 9 },
})
assert.equal(connection.frames.length, framesBeforeInvalidParam)
assert.ok(messages.some((message) =>
  message.type === 'operation_error'
  && message.data.requestId === 'param-invalid'
  && message.data.code === 'invalid_param'
))

// C-cast transports must reject integer values that float32 would silently
// round; bytewise PARAM encoding remains able to carry the full 32-bit range.
;(bridge as unknown as PrivateBridge).paramEncoding = 'c-cast'
const paramFramesBeforeUnrepresentable = connection.frames.filter(
  (frame) => frameMessageId(frame) === 23,
).length
bridge.handleClientMessage({
  type: 'param_set',
  requestId: 'param-unrepresentable',
  data: { id: 'UINT32_MAX', value: 0xffffffff, paramType: 5 },
})
assert.equal(
  connection.frames.filter((frame) => frameMessageId(frame) === 23).length,
  paramFramesBeforeUnrepresentable,
)
assert.ok(messages.some((message) =>
  message.type === 'operation_error'
  && message.data.requestId === 'param-unrepresentable'
  && message.data.code === 'invalid_param'
  && /float32/.test(message.data.message)
))
;(bridge as unknown as PrivateBridge).paramEncoding = 'bytewise'

bridge.handleClientMessage({
  type: 'param_set',
  requestId: 'param-timeout',
  data: { id: 'TIMEOUT_PARAM', value: 2, paramType: 9 },
})
inject(bridge, 22, paramValuePayload('TIMEOUT_PARAM', 3))
await waitFor(() => messages.some((message) =>
  message.type === 'param_set_result' && message.data.requestId === 'param-timeout'
))
const timedOutParam = findLast(
  messages,
  (message) =>
    message.type === 'param_set_result' && message.data.requestId === 'param-timeout',
)
assert.equal(timedOutParam.data.accepted, false)
assert.equal(timedOutParam.data.attempt, 3)
assert.equal(timedOutParam.data.acceptedValue, 3)
assert.equal(timedOutParam.data.reason, 'value_mismatch')

// MANUAL_CONTROL coalesces replaceable updates at the bridge boundary.
const manualBefore = connection.frames.filter((frame) => frameMessageId(frame) === 69).length
bridge.handleClientMessage({
  type: 'manual_control',
  data: { x: 10, y: 20, z: 30, r: 40 },
})
bridge.handleClientMessage({
  type: 'manual_control',
  data: { x: 700, y: -200, z: 650, r: 900, buttons: 5 },
})
await wait(0)
const manualFrames = connection.frames.filter((frame) => frameMessageId(frame) === 69)
assert.equal(manualFrames.length - manualBefore, 1)
assert.equal(framePayload(last(manualFrames)!).readInt16LE(0), 700)
assert.equal(framePayload(last(manualFrames)!).readInt16LE(2), -200)

// Real, truncated MAVLink 2 STATUSTEXT: id=7 is represented by only its low
// byte (wire payload length 52). It must still start a chunk assembly.
let assembledText: string | undefined
bridge.on('message', (message) => {
  if (message.type === 'statustext') assembledText = message.data.text
})
const firstText = new common.StatusText()
firstText.severity = 4
firstText.text = 'A'.repeat(50)
firstText.id = 7
firstText.chunkSeq = 0
const firstTextFrame = new MavLinkProtocolV2(42, 1).serialize(firstText, 30)
assert.equal(firstTextFrame[1], 52)
connection.feed(firstTextFrame)
assert.equal(assembledText, undefined)
const lastText = new common.StatusText()
lastText.severity = 4
lastText.text = ' complete'
lastText.id = 7
lastText.chunkSeq = 1
connection.feed(new MavLinkProtocolV2(42, 1).serialize(lastText, 31))
assert.equal(assembledText, `${'A'.repeat(50)} complete`)

// Assemble bytes first, then decode UTF-8: the three-byte character is split
// across chunk boundaries and must not turn into replacement characters.
const euroBytes = Buffer.from('€', 'utf8')
const utf8First = Buffer.alloc(53)
utf8First[0] = 4
Buffer.from('B'.repeat(49), 'ascii').copy(utf8First, 1)
utf8First[50] = euroBytes[0]
utf8First.writeUInt16LE(8, 51)
inject(bridge, 253, utf8First)
const utf8Last = Buffer.alloc(54)
utf8Last[0] = 4
utf8Last[1] = euroBytes[1]
utf8Last[2] = euroBytes[2]
utf8Last.writeUInt16LE(8, 51)
utf8Last[53] = 1
inject(bridge, 253, utf8Last)
assert.equal(assembledText, `${'B'.repeat(49)}€`)

// AUTOPILOT_VERSION is commonly a truncated v2 payload: identity fields are
// valid even when the trailing custom-version and uid2 arrays are all zero.
const version = new standard.AutopilotVersion()
version.capabilities = 8192n as never
version.uid = 0n
version.flightSwVersion = (1 << 24) | (17 << 16)
version.middlewareSwVersion = 0
version.osSwVersion = 0
version.boardVersion = 1179 << 16
version.vendorId = 123
version.productId = 456
version.flightCustomVersion = Array(8).fill(0)
version.middlewareCustomVersion = Array(8).fill(0)
version.osCustomVersion = Array(8).fill(0)
version.uid2 = Array(18).fill(0)
const truncatedVersionFrame = new MavLinkProtocolV2(42, 1).serialize(version, 32)
assert.ok(truncatedVersionFrame[1] < 60)
connection.feed(truncatedVersionFrame)
const versionData = findLast(
  messages,
  (message) => message.type === 'autopilot_version',
)?.data
assert.equal(versionData.boardName, 'MicoAir743v2')
assert.equal(versionData.firmwareLabel, 'PX4 v1.17.0')
assert.equal(versionData.vendorId, 123)
assert.equal(versionData.productId, 456)

const extendedStatePayload = Buffer.from([2, 1])
inject(bridge, 245, extendedStatePayload)
const extendedState = findLast(
  messages,
  (message) =>
    message.type === 'telemetry' && message.msgType === 'EXTENDED_SYS_STATE',
)?.data
assert.equal(extendedState.vtol_state, 2)
assert.equal(extendedState.landed_state, 1)

// GPS unknown sentinels become null and DOP is scaled from centi-units.
const gpsPayload = Buffer.alloc(30)
gpsPayload.writeInt32LE(31_234_567, 8)
gpsPayload.writeInt32LE(121_234_567, 12)
gpsPayload.writeUInt16LE(250, 20)
gpsPayload.writeUInt16LE(0xffff, 22)
gpsPayload.writeUInt16LE(0xffff, 24)
gpsPayload.writeUInt16LE(0xffff, 26)
gpsPayload[28] = 3
gpsPayload[29] = 0xff
inject(bridge, 24, gpsPayload)
const gps = findLast(
  messages,
  (message) => message.type === 'telemetry' && message.msgType === 'GPS_RAW_INT',
)?.data
assert.equal(gps.eph, 2.5)
assert.equal(gps.epv, null)
assert.equal(gps.vel, null)
assert.equal(gps.cog, null)
assert.equal(gps.satellites_visible, null)

// Battery instance and extension cells are preserved; unknown measurements are
// null and independent batteries are not combined.
const batteryPayload = Buffer.alloc(54)
batteryPayload.writeInt32LE(-1, 0)
for (let index = 0; index < 10; index++) {
  batteryPayload.writeUInt16LE(0xffff, 10 + index * 2)
}
batteryPayload.writeUInt16LE(3700, 10)
batteryPayload.writeUInt16LE(3700, 12)
batteryPayload.writeInt16LE(-1, 30)
batteryPayload[32] = 2
batteryPayload.writeInt8(-1, 35)
batteryPayload.writeUInt16LE(3800, 41)
inject(bridge, 147, batteryPayload)
const battery = findLast(
  messages,
  (message) => message.type === 'telemetry' && message.msgType === 'BATTERY_STATUS',
)?.data
assert.equal(battery.id, 2)
assert.ok(Math.abs(battery.voltage - 11.2) < 1e-9)
assert.equal(battery.cell_voltages[0], 3.7)
assert.equal(battery.cell_voltages[10], 3.8)
assert.equal(battery.current, null)
assert.equal(battery.consumed_mah, null)
assert.equal(battery.remaining, null)

const rawImuPayload = Buffer.alloc(29)
rawImuPayload.writeInt16LE(123, 8)
rawImuPayload[26] = 2
rawImuPayload.writeInt16LE(0, 27)
inject(bridge, 27, rawImuPayload)
const rawImu = findLast(
  messages,
  (message) => message.type === 'sensor' && message.msgType === 'RAW_IMU',
)?.data
assert.equal(rawImu.units, 'raw')
assert.equal(rawImu.xacc, 123)
assert.equal(rawImu.temperature, null)

const flowPayload = Buffer.alloc(44)
flowPayload.writeUInt32LE(20_000, 8)
flowPayload.writeFloatLE(0.1, 12)
flowPayload.writeFloatLE(-0.2, 16)
flowPayload.writeFloatLE(0.01, 20)
flowPayload.writeFloatLE(0.02, 24)
flowPayload.writeFloatLE(0.03, 28)
flowPayload.writeUInt32LE(5000, 32)
flowPayload.writeFloatLE(-1, 36)
flowPayload.writeInt16LE(2350, 40)
flowPayload[42] = 3
flowPayload[43] = 200
inject(bridge, 106, flowPayload)
const flow = findLast(
  messages,
  (message) => message.type === 'sensor' && message.msgType === 'OPTICAL_FLOW_RAD',
)?.data
assert.equal(flow.integration_time_us, 20_000)
assert.ok(Math.abs(flow.integrated_x_rad - 0.1) < 1e-6)
assert.ok(Math.abs(flow.integrated_zgyro_rad - 0.03) < 1e-6)
assert.equal(flow.distance_m, null)
assert.equal(flow.ground_distance, null)

const estimatorPayload = Buffer.alloc(44)
estimatorPayload.writeUInt16LE(0x1234, 42)
inject(bridge, 230, estimatorPayload)
assert.equal(
  findLast(messages, (message) => message.type === 'ekf_status')
    ?.data.gps_check_fail_flags,
  null,
)

const distancePayload = Buffer.alloc(14)
inject(bridge, 132, distancePayload)
assert.equal(
  findLast(
    messages,
    (message) => message.type === 'sensor' && message.msgType === 'DISTANCE_SENSOR',
  )?.data.signal_quality,
  null,
)

const invalidPressure = Buffer.alloc(16)
invalidPressure.writeFloatLE(0, 4)
inject(bridge, 29, invalidPressure)
assert.equal(
  findLast(
    messages,
    (message) => message.type === 'sensor' && message.msgType === 'SCALED_PRESSURE',
  )?.data.altitude,
  null,
)

// Oversized parameter counts fail the bounded transaction immediately.
const failedBeforeRestart = messages.filter((message) => message.type === 'param_failed').length
bridge.handleClientMessage({ type: 'param_request_list', requestId: 'expired-list' })
bridge.handleClientMessage({ type: 'param_request_list', requestId: 'list-too-large' })
assert.equal(
  messages.filter((message) => message.type === 'param_failed').length,
  failedBeforeRestart,
)
inject(bridge, 22, paramValuePayload('P0', 1, 9, 9000, 0))
assert.ok(messages.some((message) =>
  message.type === 'param_failed'
  && message.data.reason === 'parameter_count_exceeds_limit'
))

// SET_MESSAGE_INTERVAL unsupported -> bounded legacy REQUEST_DATA_STREAM
// fallback instead of silently losing telemetry.
const legacyBefore = connection.frames.filter((frame) => frameMessageId(frame) === 66).length
inject(bridge, 77, commandAckPayload(511, 3))
const legacyAfter = connection.frames.filter((frame) => frameMessageId(frame) === 66).length
assert.ok(legacyAfter - legacyBefore >= 7)

// Explicit selection resets readiness. Old-target ACK/telemetry cannot affect
// the new transaction until the selected target sends a fresh heartbeat.
for (let systemId = 50; systemId < 90; systemId++) {
  inject(bridge, 0, heartbeatPayload(), systemId, 1)
}
assert.ok((bridge as unknown as PrivateBridge).discoveredTargets.size <= 32)
// Refresh the desired target in case bounded discovery evicted its old entry.
inject(bridge, 0, heartbeatPayload(), 43, 1)
bridge.handleClientMessage({ type: 'param_request_list', requestId: 'switching-list' })
assert.equal((bridge as unknown as PrivateBridge).paramDownloadActive, true)
bridge.handleClientMessage({
  type: 'select_target',
  requestId: 'select-43',
  data: { systemId: 43, componentId: 1 },
})
assert.equal((bridge as unknown as PrivateBridge).targetSysId, 43)
assert.ok(messages.some((message) =>
  message.type === 'param_failed' && message.data.reason === 'target_switched'
))
const framesBeforeUnready43 = connection.frames.length
bridge.handleClientMessage({
  type: 'command',
  requestId: 'mode-before-43-heartbeat',
  cmd: 'MAV_CMD_DO_SET_MODE',
  params: [1, 4, 3, 0, 0, 0, 0],
})
assert.equal(connection.frames.length, framesBeforeUnready43)
inject(bridge, 0, heartbeatPayload(), 43, 1)
bridge.handleClientMessage({
  type: 'command',
  requestId: 'mode-43',
  cmd: 'MAV_CMD_DO_SET_MODE',
  params: [1, 4, 3, 0, 0, 0, 0],
})
const target43Command = findLast(
  connection.frames.filter((frame) => frameMessageId(frame) === 76),
  (frame) => framePayload(frame).readUInt16LE(28) === 176,
)
assert.equal(framePayload(target43Command!)[30], 43)
inject(bridge, 77, commandAckPayload(176, 0), 42, 1)
assert.equal((bridge as unknown as PrivateBridge).pendingCommands.has(176), true)
inject(bridge, 77, commandAckPayload(176, 0), 43, 1)
assert.equal((bridge as unknown as PrivateBridge).pendingCommands.has(176), false)

bridge.destroy()

// Repeated IN_PROGRESS ACKs may extend the ordinary response window, but they
// cannot extend the fixed transaction deadline forever.
{
  const progressConnection = new FakeConnection()
  const progressBridge = new MavlinkBridge(progressConnection as never, {
    codec: { protocol: 'v2' },
    commandTimeoutMs: 10,
    versionRetryMs: 20,
  })
  const progressMessages: any[] = []
  progressBridge.on('message', (message) => progressMessages.push(message))
  inject(progressBridge, 0, heartbeatPayload(), 7, 1)
  progressBridge.handleClientMessage({
    type: 'command',
    requestId: 'bounded-progress',
    cmd: 'MAV_CMD_DO_SET_MODE',
    params: [1, 4, 3, 0, 0, 0, 0],
  })

  let progressCount = 0
  const progressTicker = setInterval(() => {
    progressCount++
    inject(progressBridge, 77, commandAckPayload(176, 5, 255, 190, 50), 7, 1)
  }, 5)
  try {
    await waitFor(() => progressMessages.some((message) =>
      message.type === 'operation_error'
      && message.data.requestId === 'bounded-progress'
      && message.data.code === 'command_timeout'
    ), 500)
    assert.ok(progressCount >= 4)
    assert.equal(
      (progressBridge as unknown as PrivateBridge).pendingCommands.has(176),
      false,
    )
  } finally {
    clearInterval(progressTicker)
    progressBridge.destroy()
  }
}

// IN_PROGRESS is not terminal proof of SET_MESSAGE_INTERVAL support. A later
// terminal failure must immediately restore legacy REQUEST_DATA_STREAM.
{
  const fallbackConnection = new FakeConnection()
  const fallbackBridge = new MavlinkBridge(fallbackConnection as never, {
    codec: { protocol: 'v2' },
    commandTimeoutMs: 200,
    versionRetryMs: 200,
  })
  inject(fallbackBridge, 0, heartbeatPayload(), 8, 1)
  const legacyBeforeProgress = fallbackConnection.frames.filter(
    (frame) => frameMessageId(frame) === 66,
  ).length
  inject(fallbackBridge, 77, commandAckPayload(511, 5), 8, 1)
  assert.equal(
    (fallbackBridge as unknown as PrivateBridge).messageIntervalSupport,
    'unknown',
  )
  assert.equal(
    fallbackConnection.frames.filter((frame) => frameMessageId(frame) === 66).length,
    legacyBeforeProgress,
  )
  inject(fallbackBridge, 77, commandAckPayload(511, 4), 8, 1)
  assert.equal(
    (fallbackBridge as unknown as PrivateBridge).messageIntervalSupport,
    'unsupported',
  )
  assert.ok(
    fallbackConnection.frames.filter((frame) => frameMessageId(frame) === 66).length
      - legacyBeforeProgress >= 7,
  )
  fallbackBridge.destroy()
}

// MAVLink v2 zero-trim semantics: a trimmed SERVO_OUTPUT_RAW frame is valid
// (missing bytes are zeros), RC_CHANNELS filters UINT16_MAX/chancount
// sentinels, COMMAND_ACK extensions decode from padded v2 frames, and an FC
// reboot (time_boot_ms regression) re-requests the telemetry intervals.
{
  const trimConnection = new FakeConnection()
  const trimBridge = new MavlinkBridge(trimConnection as never, {
    codec: { protocol: 'v2' },
    commandTimeoutMs: 200,
    versionRetryMs: 200,
  })
  const trimMessages: any[] = []
  trimBridge.on('message', (message) => trimMessages.push(message))
  inject(trimBridge, 0, heartbeatPayload(), 21, 1)

  // Quad SERVO_OUTPUT_RAW: servo5..16 and port are zero, so the v2 wire
  // frame carries only 12 bytes. It must still produce motor outputs.
  const servoPayload = Buffer.alloc(12)
  servoPayload.writeUInt32LE(123_456, 0)
  for (let motor = 0; motor < 4; motor++) {
    servoPayload.writeUInt16LE(1500 + motor, 4 + motor * 2)
  }
  inject(trimBridge, 36, servoPayload, 21, 1)
  const motorMessage = findLast(trimMessages, (m) => m.type === 'motor_outputs')
  assert.ok(motorMessage)
  assert.deepEqual(motorMessage.data.outputs, [1500, 1501, 1502, 1503])

  // RC_CHANNELS: 8-channel receiver, ch9.. filled with UINT16_MAX sentinels
  // (exactly what PX4 sends) and rssi 255 = unknown.
  const rcPayload = Buffer.alloc(42)
  rcPayload.writeUInt32LE(123_456, 0)
  for (let channelIndex = 0; channelIndex < 18; channelIndex++) {
    rcPayload.writeUInt16LE(
      channelIndex < 8 ? 1000 + channelIndex : 0xffff,
      4 + channelIndex * 2,
    )
  }
  rcPayload[40] = 8
  rcPayload[41] = 255
  inject(trimBridge, 65, rcPayload, 21, 1)
  const rcMessage = findLast(trimMessages, (m) => m.type === 'rc_channels')
  assert.ok(rcMessage)
  assert.equal(rcMessage.data.ch1, 1000)
  assert.equal(rcMessage.data.ch8, 1007)
  assert.equal(rcMessage.data.ch9, null)
  assert.equal(rcMessage.data.ch18, null)
  assert.equal(rcMessage.data.rssi, null)

  // COMMAND_ACK with a zero-trimmed result_param2 tail: v2 semantics say the
  // missing bytes are zero, so the decoded value (256) must be surfaced.
  const ackPayload = Buffer.alloc(6)
  ackPayload.writeUInt16LE(511, 0)
  ackPayload[2] = 0
  ackPayload[3] = 0xff
  ackPayload.writeUInt16LE(256, 4)
  inject(trimBridge, 77, ackPayload, 21, 1)
  const ackMessage = findLast(trimMessages, (m) => m.type === 'command_ack')
  assert.ok(ackMessage)
  assert.equal(ackMessage.data.resultParam2, 256)
  assert.equal(ackMessage.data.progress, undefined)
  assert.equal(
    (trimBridge as unknown as PrivateBridge).messageIntervalSupport,
    'supported',
  )

  // FC reboot: ATTITUDE time_boot_ms regression must re-send the full
  // SET_MESSAGE_INTERVAL batch without a reconnect.
  const attitudePayload = (bootMs: number) => {
    const payload = Buffer.alloc(28)
    payload.writeUInt32LE(bootMs, 0)
    payload.writeFloatLE(0.1, 4)
    return payload
  }
  const countIntervalFrames = () => trimConnection.frames.filter((frame) =>
    frameMessageId(frame) === 76 && framePayload(frame).readUInt16LE(28) === 511
  ).length
  inject(trimBridge, 30, attitudePayload(600_000), 21, 1)
  const intervalFramesBeforeReboot = countIntervalFrames()
  inject(trimBridge, 30, attitudePayload(1_000), 21, 1)
  assert.ok(countIntervalFrames() - intervalFramesBeforeReboot >= 9)
  trimBridge.destroy()
}

// Destroy cancels a scheduled MANUAL_CONTROL flush; no stale write is allowed
// to escape into a later/closed physical session.
{
  const destroyConnection = new FakeConnection()
  const destroyBridge = new MavlinkBridge(destroyConnection as never, {
    codec: { protocol: 'v2' },
    commandTimeoutMs: 20,
    versionRetryMs: 20,
  })
  inject(destroyBridge, 0, heartbeatPayload(), 9, 1)
  const before = destroyConnection.frames.filter((frame) => frameMessageId(frame) === 69).length
  destroyBridge.handleClientMessage({
    type: 'manual_control',
    data: { x: 100, y: 100, z: 500, r: 0 },
  })
  destroyBridge.destroy()
  await wait(0)
  const after = destroyConnection.frames.filter((frame) => frameMessageId(frame) === 69).length
  assert.equal(after, before)
}

// ArduPilot identity: an ArduCopter heartbeat (autopilot 3, type 2) selects
// the ardupilot/copter profile, decodes raw custom_mode values, labels the
// firmware as ArduPilot, and never survives a target reset.
{
  const apConnection = new FakeConnection()
  const apBridge = new MavlinkBridge(apConnection as never, {
    codec: { protocol: 'v2' },
    commandTimeoutMs: 20,
    versionRetryMs: 20,
  })
  const apMessages: any[] = []
  apBridge.on('message', (message) => apMessages.push(message))

  // ArduCopter Stabilize: custom_mode 0 must not decode through PX4's packed
  // main/sub layout (which used to render it as "Mode 0").
  inject(apBridge, 0, heartbeatPayload(3, 2, 0), 55, 1)
  const apStatus = findLast(apMessages, (message) => message.type === 'status')
  assert.equal(apStatus.data.mode, 'Stabilize')
  assert.equal(apStatus.data.modeId, 0)
  assert.equal(apStatus.data.identity.family, 'ardupilot')
  assert.equal(apStatus.data.identity.vehicleClass, 'copter')
  const apTarget = findLast(apMessages, (message) => message.type === 'target' && message.data.reason === 'selected')
  assert.equal(apTarget.data.identity.family, 'ardupilot')

  // RTL by raw mode number.
  inject(apBridge, 0, heartbeatPayload(3, 2, 6), 55, 1)
  assert.equal(findLast(apMessages, (message) => message.type === 'status').data.mode, 'RTL')

  // Semantic mode change encodes ArduCopter Loiter as raw custom mode 5:
  // [1, 5, 0, ...] - never PX4's packed main/sub layout.
  apBridge.handleClientMessage({
    type: 'set_flight_mode',
    requestId: 'ap-mode-loiter',
    data: { modeId: 5 },
  })
  const apModeFrame = findLast(
    apConnection.frames.filter((frame) => frameMessageId(frame) === 76),
    (frame) => framePayload(frame).readUInt16LE(28) === 176,
  )
  assert.ok(apModeFrame)
  {
    const payload = framePayload(apModeFrame)
    assert.equal(payload.readFloatLE(0), 1)
    assert.equal(payload.readFloatLE(4), 5)
    assert.equal(payload.readFloatLE(8), 0)
  }

  // AUTOPILOT_VERSION from an ArduPilot target is labeled ArduPilot, keeping
  // raw board/vendor/product fields intact.
  const apVersion = new standard.AutopilotVersion()
  apVersion.capabilities = 8192n as never
  apVersion.uid = 0n
  apVersion.flightSwVersion = (4 << 24) | (7 << 16)
  apVersion.middlewareSwVersion = 0
  apVersion.osSwVersion = 0
  apVersion.boardVersion = 1179 << 16
  apVersion.vendorId = 4660
  apVersion.productId = 22136
  apVersion.flightCustomVersion = Array(8).fill(0)
  apVersion.middlewareCustomVersion = Array(8).fill(0)
  apVersion.osCustomVersion = Array(8).fill(0)
  apVersion.uid2 = Array(18).fill(0)
  apConnection.feed(new MavLinkProtocolV2(55, 1).serialize(apVersion, 3))
  const apVersionData = findLast(apMessages, (message) => message.type === 'autopilot_version')?.data
  assert.equal(apVersionData.firmwareLabel, 'ArduPilot v4.7.0')
  assert.equal(apVersionData.family, 'ardupilot')
  assert.equal(apVersionData.vehicleClass, 'copter')
  assert.equal(apVersionData.boardName, 'MicoAir743v2')
  assert.equal(apVersionData.vendorId, 4660)
  assert.equal(apVersionData.productId, 22136)

  // A connection status change resets the target; the identity must be
  // cleared so a different vehicle on reconnect cannot inherit the profile.
  ;(apBridge as unknown as { onStatusChange: (status: string) => void }).onStatusChange('disconnected')
  const resetTarget = findLast(apMessages, (message) => message.type === 'target' && message.data.reason === 'reset')
  assert.equal(resetTarget.data.identity, null)
  assert.equal(resetTarget.data.systemId, null)
  apBridge.destroy()
}

// An unknown autopilot family (MAV_AUTOPILOT generic) is trackable but mode
// requests must be rejected before serialization - no cross-stack guessing.
{
  const genericConnection = new FakeConnection()
  const genericBridge = new MavlinkBridge(genericConnection as never, {
    codec: { protocol: 'v2' },
    commandTimeoutMs: 20,
    versionRetryMs: 20,
  })
  const genericMessages: any[] = []
  genericBridge.on('message', (message) => genericMessages.push(message))
  inject(genericBridge, 0, heartbeatPayload(0, 2, 0), 66, 1)
  assert.equal(
    findLast(genericMessages, (message) => message.type === 'status').data.identity.family,
    'unknown',
  )
  const framesBeforeMode = genericConnection.frames.filter((frame) =>
    frameMessageId(frame) === 76 && framePayload(frame).readUInt16LE(28) === 176
  ).length
  genericBridge.handleClientMessage({
    type: 'set_flight_mode',
    requestId: 'generic-mode',
    data: { modeId: 0 },
  })
  assert.equal(
    genericConnection.frames.filter((frame) =>
      frameMessageId(frame) === 76 && framePayload(frame).readUInt16LE(28) === 176
    ).length,
    framesBeforeMode,
  )
  const genericError = findLast(
    genericMessages,
    (message) => message.type === 'operation_error' && message.data.requestId === 'generic-mode',
  )
  assert.equal(genericError.data.operation, 'set_flight_mode')
  assert.equal(genericError.data.code, 'unsupported_vehicle_profile')
  genericBridge.destroy()
}

console.log('MAVLink codec, transaction, target and telemetry checks passed')
