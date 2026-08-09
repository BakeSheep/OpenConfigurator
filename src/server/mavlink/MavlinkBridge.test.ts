import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import {
  common,
  minimal,
  standard,
  ardupilotmega,
  MavLinkPacketSignature,
  MavLinkProtocolV1,
  MavLinkProtocolV2,
} from 'node-mavlink'
import { MavlinkBridge } from './MavlinkBridge'
import { MavlinkCodecSession, type MavlinkMessage } from './codec'

const wait = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds))
const ALL_MOTOR_TEST_QUEUE_TAGS = Array.from(
  { length: 12 },
  (_, index) => `motor-test-start:${index + 1}`,
)

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
  writeQueueTags: Array<string | undefined> = []
  cancelledQueueTags: string[] = []
  status = 'connected'
  config: { type: 'serial' | 'bluetooth' } = { type: 'serial' }
  vehicleReady = false
  bytesReceived = 0
  bytesSent = 0
  heartbeatNotifications = 0
  activityNotifications = 0

  write(frame: Buffer, priority = 'normal', queueTag?: string): boolean {
    this.frames.push(frame)
    this.writePriorities.push(priority)
    this.writeQueueTags.push(queueTag)
    this.bytesSent += frame.length
    return true
  }

  cancelQueuedWrites(queueTag: string): number {
    this.cancelledQueueTags.push(queueTag)
    return 0
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
  commandQuarantineUntil: Map<number, number>
  pendingParamSets: Map<string, unknown>
  parameterValues: Map<string, number>
  cacheParameterValue: (id: string, value: number) => boolean
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
for (const messageId of [27, 100, 106, 132, 173]) {
  assert.ok(initialCommandFrames.some((frame) => {
    const payload = framePayload(frame)
    return payload.readUInt16LE(28) === 511 && payload.readFloatLE(0) === messageId
  }), `expected telemetry interval request for MAVLink message #${messageId}`)
}

const serialFramesBeforeShell = connection.frames.filter((frame) => frameMessageId(frame) === 126).length
bridge.handleClientMessage({ type: 'shell_open', requestId: 'shell-open-test' })
assert.equal(findLast(messages, (message) => message.type === 'shell_status')?.data.active, false)
assert.equal(findLast(messages, (message) => message.type === 'shell_status')?.data.reason, 'probing')
assert.ok(
  connection.frames.filter((frame) => frameMessageId(frame) === 126).length >= serialFramesBeforeShell + 1,
  'PX4 shell probe must use SERIAL_CONTROL',
)
const shellReply = Buffer.alloc(79)
shellReply[6] = 10
shellReply[7] = 1
shellReply[8] = 5
Buffer.from('nsh> ', 'ascii').copy(shellReply, 9)
inject(bridge, 126, shellReply)
assert.equal(findLast(messages, (message) => message.type === 'shell_status')?.data.active, true)
assert.equal(findLast(messages, (message) => message.type === 'shell_output')?.data.text, 'nsh> ')
bridge.handleClientMessage({ type: 'shell_write', data: { text: 'ver hw\r' } })
assert.ok(
  connection.frames.filter((frame) => frameMessageId(frame) === 126).length >= serialFramesBeforeShell + 2,
  'PX4 shell probe and input must use SERIAL_CONTROL',
)
bridge.handleClientMessage({ type: 'shell_close' })
assert.equal(findLast(messages, (message) => message.type === 'shell_status')?.data.active, false)

const initialAttitudeInterval = findLast(initialCommandFrames, (frame) => {
  const payload = framePayload(frame)
  return payload.readUInt16LE(28) === 511 && payload.readFloatLE(0) === 30
})
const initialOpticalFlowInterval = findLast(initialCommandFrames, (frame) => {
  const payload = framePayload(frame)
  return payload.readUInt16LE(28) === 511 && payload.readFloatLE(0) === 106
})
assert.equal(framePayload(initialAttitudeInterval!).readFloatLE(4), 125_000)
assert.equal(framePayload(initialOpticalFlowInterval!).readFloatLE(4), 500_000)

bridge.handleClientMessage({
  type: 'message_rates_set',
  requestId: 'rates-custom',
  data: { attitude: 4, position: 2, sensors: 2, rc: 2, status: 1, hud: 1, auxiliary: 1 },
})
const customIntervalFrames = connection.frames.filter((frame) => frameMessageId(frame) === 76)
const customAttitudeInterval = findLast(customIntervalFrames, (frame) => {
  const payload = framePayload(frame)
  return payload.readUInt16LE(28) === 511 && payload.readFloatLE(0) === 30
})
const customOpticalFlowInterval = findLast(customIntervalFrames, (frame) => {
  const payload = framePayload(frame)
  return payload.readUInt16LE(28) === 511 && payload.readFloatLE(0) === 106
})
assert.equal(framePayload(customAttitudeInterval!).readFloatLE(4), 250_000)
assert.equal(framePayload(customOpticalFlowInterval!).readFloatLE(4), 1_000_000)
assert.equal(findLast(messages, (message) => message.type === 'message_rates')?.data.auxiliary, 1)

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
const motorQueueCancelStart = connection.cancelledQueueTags.length
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
assert.deepEqual(
  startedActuatorFrames.map((frame) => connection.writeQueueTags[connection.frames.indexOf(frame)]),
  ['motor-test-start:1', 'motor-test-start:2'],
)
assert.deepEqual(
  connection.cancelledQueueTags.slice(motorQueueCancelStart),
  ['motor-test-start:1', 'motor-test-start:2'],
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
const cancelBeforeStop3 = connection.cancelledQueueTags.length
bridge.handleClientMessage({
  type: 'motor_test',
  requestId: 'motor-stop-3',
  data: { instance: 3, throttle: 0, duration: 0 },
})
assert.equal(actuatorFrameCount() - actuatorStart, 3)
assert.deepEqual(
  connection.cancelledQueueTags.slice(cancelBeforeStop3),
  ['motor-test-start:3'],
)
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
const cancelBeforeStop4 = connection.cancelledQueueTags.length
bridge.handleClientMessage({
  type: 'motor_test',
  requestId: 'motor-stop-4',
  data: { instance: 4, throttle: 0, duration: 0 },
})
assert.equal(actuatorFrameCount() - actuatorStart, 4)
assert.deepEqual(
  connection.cancelledQueueTags.slice(cancelBeforeStop4),
  ['motor-test-start:4'],
)
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

// The browser's ALL slider crosses the WS boundary once, then the bridge
// fans out validated 1-based instances without command-ACK correlation.
const batchActuatorStart = actuatorFrameCount()
const cancelBeforeBatchStart = connection.cancelledQueueTags.length
bridge.handleClientMessage({
  type: 'motor_test_batch',
  requestId: 'motor-all-start',
  data: {
    instances: [1, 2, 3, 4],
    throttle: 20,
    duration: 2,
    propsRemoved: true,
  },
})
const batchStartFrames = connection.frames.filter((frame) =>
  frameMessageId(frame) === 76 && framePayload(frame).readUInt16LE(28) === 310
).slice(batchActuatorStart)
assert.equal(batchStartFrames.length, 4)
assert.deepEqual(
  batchStartFrames.map((frame) => framePayload(frame).readFloatLE(16)),
  [1101, 1102, 1103, 1104],
)
assert.deepEqual(
  batchStartFrames.map((frame) => connection.writePriorities[connection.frames.indexOf(frame)]),
  ['high', 'high', 'high', 'high'],
)
assert.deepEqual(
  batchStartFrames.map((frame) => connection.writeQueueTags[connection.frames.indexOf(frame)]),
  [
    'motor-test-start:1',
    'motor-test-start:2',
    'motor-test-start:3',
    'motor-test-start:4',
  ],
)
assert.deepEqual(
  connection.cancelledQueueTags.slice(cancelBeforeBatchStart),
  [
    'motor-test-start:1',
    'motor-test-start:2',
    'motor-test-start:3',
    'motor-test-start:4',
  ],
)
assert.equal(
  messages.filter((message) => message.type === 'motor_test_status'
    && message.data.requestId === 'motor-all-start'
    && message.data.action === 'start').length,
  4,
)
const cancelBeforeBatchStop = connection.cancelledQueueTags.length
bridge.handleClientMessage({
  type: 'motor_test_batch',
  requestId: 'motor-all-stop',
  data: { instances: [1, 2, 3, 4], throttle: 0, duration: 0 },
})
const batchStopFrames = connection.frames.filter((frame) =>
  frameMessageId(frame) === 76 && framePayload(frame).readUInt16LE(28) === 310
).slice(batchActuatorStart + 4)
assert.equal(batchStopFrames.length, 4)
assert.deepEqual(
  connection.cancelledQueueTags.slice(cancelBeforeBatchStop),
  [
    'motor-test-start:1',
    'motor-test-start:2',
    'motor-test-start:3',
    'motor-test-start:4',
  ],
)
assert.ok(batchStopFrames.every((frame) => Number.isNaN(framePayload(frame).readFloatLE(0))))
assert.deepEqual(
  batchStopFrames.map((frame) => connection.writePriorities[connection.frames.indexOf(frame)]),
  ['critical', 'critical', 'critical', 'critical'],
)

// Reboot is a semantic, disarmed-only command encoded as PREFLIGHT_REBOOT_SHUTDOWN.
const rebootFramesBefore = connection.frames.filter((frame) => frameMessageId(frame) === 76).length
const rebootResult = bridge.handleClientMessage({
  type: 'reboot_vehicle',
  requestId: 'reboot-1',
  safetyConfirmation: 'reboot_flight_controller',
})
assert.equal(rebootResult.vehicleRebootQueued, true)
const rebootFrames = connection.frames.filter((frame) => frameMessageId(frame) === 76)
assert.equal(rebootFrames.length, rebootFramesBefore + 1)
const rebootPayload = framePayload(rebootFrames[rebootFrames.length - 1])
assert.equal(rebootPayload.readUInt16LE(28), 246)
assert.equal(rebootPayload.readFloatLE(0), 1)
inject(bridge, 77, commandAckPayload(246, 0))

// A reboot can keep USB open while the FC loses its message-interval setup.
// Even if the FC stops heartbeats immediately, the first post-reboot heartbeat
// must renegotiate all streams rather than depending on a final stale frame.
const intervalFramesBeforeRebootRecovery = connection.frames.filter((frame) => {
  if (frameMessageId(frame) !== 76) return false
  const payload = framePayload(frame)
  return payload.readUInt16LE(28) === 511
}).length
connection.vehicleReady = false
inject(bridge, 0, heartbeatPayload(), 42, 1)
assert.equal(connection.vehicleReady, true)
assert.ok(connection.frames.filter((frame) => {
  if (frameMessageId(frame) !== 76) return false
  return framePayload(frame).readUInt16LE(28) === 511
}).length > intervalFramesBeforeRebootRecovery)

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
assert.equal(bridge.getParameterValue('TEST_PARAM'), 11.5)
assert.equal(bridge.getParameterValue('BAD_VALUE'), null)
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

// Semantic vehicle configuration derives MAV_PARAM_TYPE from the validated
// server cache and requires a matching PARAM_VALUE before accepting the UI write.
inject(bridge, 22, paramValuePayload('NAV_RCL_ACT', 1))
const configFramesBefore = connection.frames.filter((frame) => frameMessageId(frame) === 23).length
bridge.handleClientMessage({
  type: 'vehicle_config_set', requestId: 'cfg-rcl', feature: 'safety',
  data: { id: 'NAV_RCL_ACT', value: 2 },
})
assert.equal(connection.frames.filter((frame) => frameMessageId(frame) === 23).length, configFramesBefore + 1)
inject(bridge, 22, paramValuePayload('NAV_RCL_ACT', 2))
assert.ok(messages.some((message) => message.type === 'vehicle_config_set_result'
  && message.data.requestId === 'cfg-rcl' && message.data.accepted))

inject(bridge, 22, paramValuePayload('COM_LOW_BAT_ACT', 2))
const reductionFramesBefore = connection.frames.filter((frame) => frameMessageId(frame) === 23).length
bridge.handleClientMessage({
  type: 'vehicle_config_set', requestId: 'cfg-reduce', feature: 'safety',
  data: { id: 'COM_LOW_BAT_ACT', value: 0 },
})
assert.equal(connection.frames.filter((frame) => frameMessageId(frame) === 23).length, reductionFramesBefore)
assert.ok(messages.some((message) => message.type === 'vehicle_config_set_result'
  && message.data.requestId === 'cfg-reduce' && message.data.reason === 'safety_confirmation_required'))

// PX4 airframe application is a verified two-parameter transaction. The
// reboot command is not queued until both echoes match.
inject(bridge, 22, paramValuePayload('SYS_AUTOSTART', 4001))
inject(bridge, 22, paramValuePayload('SYS_AUTOCONFIG', 0))
;(bridge as unknown as PrivateBridge).commandQuarantineUntil.delete(246)
const rebootCommandsBeforeAirframe = connection.frames.filter((frame) => frameMessageId(frame) === 76
  && framePayload(frame).readUInt16LE(28) === 246).length
bridge.handleClientMessage({
  type: 'airframe_apply', requestId: 'frame-px4', safetyConfirmation: 'apply_airframe',
  data: { family: 'px4', autostartId: 5001 },
})
inject(bridge, 22, paramValuePayload('SYS_AUTOSTART', 5001))
assert.equal(connection.frames.filter((frame) => frameMessageId(frame) === 76
  && framePayload(frame).readUInt16LE(28) === 246).length, rebootCommandsBeforeAirframe)
inject(bridge, 22, paramValuePayload('SYS_AUTOCONFIG', 1))
assert.equal(connection.frames.filter((frame) => frameMessageId(frame) === 76
  && framePayload(frame).readUInt16LE(28) === 246).length, rebootCommandsBeforeAirframe + 1)
assert.ok(messages.some((message) => message.type === 'airframe_apply_status'
  && message.data.requestId === 'frame-px4' && message.data.phase === 'rebooting'))
connection.vehicleReady = false
inject(bridge, 0, heartbeatPayload(), 42, 1)

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

const flowWithoutGyroPayload = Buffer.from(flowPayload)
flowWithoutGyroPayload.writeFloatLE(Number.NaN, 20)
flowWithoutGyroPayload.writeFloatLE(Number.NaN, 24)
flowWithoutGyroPayload.writeFloatLE(Number.NaN, 28)
inject(bridge, 106, flowWithoutGyroPayload)
const flowWithoutGyro = findLast(
  messages,
  (message) => message.type === 'sensor' && message.msgType === 'OPTICAL_FLOW_RAD',
)?.data
assert.equal(flowWithoutGyro.integrated_xgyro_rad, null)
assert.equal(flowWithoutGyro.integrated_ygyro_rad, null)
assert.equal(flowWithoutGyro.integrated_zgyro_rad, null)
assert.equal(flowWithoutGyro.flow_comp_m_x, null)
assert.equal(flowWithoutGyro.flow_comp_m_y, null)

// Camera/rangefinder peripherals commonly publish under their own component
// id. The selected autopilot is component 1, but same-system sensor components
// must still be accepted.
const legacyFlowPayload = Buffer.alloc(34)
legacyFlowPayload.writeFloatLE(0.12, 8)
legacyFlowPayload.writeFloatLE(-0.08, 12)
legacyFlowPayload.writeFloatLE(1.75, 16)
legacyFlowPayload.writeInt16LE(14, 20)
legacyFlowPayload.writeInt16LE(-9, 22)
legacyFlowPayload[24] = 7
legacyFlowPayload[25] = 180
;(bridge as unknown as PrivateBridge).messageIntervalSupport = 'supported'
const siblingIntervalFramesBefore = connection.frames.length
inject(bridge, 100, legacyFlowPayload, 42, 158)
const siblingIntervalFrame = findLast(
  connection.frames.slice(siblingIntervalFramesBefore),
  (frame) => {
    if (frameMessageId(frame) !== 76) return false
    const payload = framePayload(frame)
    return payload.readUInt16LE(28) === 511
      && payload.readFloatLE(0) === 100
      && payload[31] === 158
  },
)
assert.ok(siblingIntervalFrame, 'a sibling sensor emitter receives its own interval request')
const legacyFlow = findLast(
  messages,
  (message) => message.type === 'sensor' && message.msgType === 'OPTICAL_FLOW',
)?.data
assert.equal(legacyFlow.source, 'OPTICAL_FLOW')
assert.equal(legacyFlow.flow_x, 14)
assert.equal(legacyFlow.flow_y, -9)
assert.ok(Math.abs(legacyFlow.flow_comp_m_x - 0.12) < 1e-6)
assert.equal(legacyFlow.quality, 180)
assert.ok(Math.abs(legacyFlow.ground_distance - 1.75) < 1e-6)

const foreignSensorMessagesBefore = messages.filter((message) =>
  message.type === 'sensor' && message.msgType === 'OPTICAL_FLOW'
).length
inject(bridge, 100, legacyFlowPayload, 43, 158)
assert.equal(messages.filter((message) =>
  message.type === 'sensor' && message.msgType === 'OPTICAL_FLOW'
).length, foreignSensorMessagesBefore, 'sensor frames from another system must remain isolated')

const estimatorPayload = Buffer.alloc(44)
estimatorPayload.writeUInt16LE(0x1234, 42)
inject(bridge, 230, estimatorPayload)
assert.equal(
  findLast(messages, (message) => message.type === 'ekf_status')
    ?.data.gps_check_fail_flags,
  null,
)

const distancePayload = Buffer.alloc(14)
distancePayload.writeUInt16LE(20, 4)
distancePayload.writeUInt16LE(600, 6)
distancePayload.writeUInt16LE(125, 8)
inject(bridge, 132, distancePayload, 42, 196)
assert.equal(
  findLast(
    messages,
    (message) => message.type === 'sensor' && message.msgType === 'DISTANCE_SENSOR',
  )?.data.signal_quality,
  null,
)
assert.equal(findLast(
  messages,
  (message) => message.type === 'sensor' && message.msgType === 'DISTANCE_SENSOR',
)?.data.current_distance, 125)

const rangefinderPayload = Buffer.alloc(8)
rangefinderPayload.writeFloatLE(2.34, 0)
rangefinderPayload.writeFloatLE(5, 4)
inject(bridge, 173, rangefinderPayload, 42, 195)
const rangefinder = findLast(
  messages,
  (message) => message.type === 'sensor' && message.msgType === 'RANGEFINDER',
)?.data
assert.equal(rangefinder.source, 'RANGEFINDER')
assert.equal(rangefinder.current_distance, 234)
assert.equal(rangefinder.min_distance, 0)
assert.equal(rangefinder.max_distance, 0)
assert.equal(rangefinder.signal_quality, null)

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
const cancelBeforeTargetSwitch = connection.cancelledQueueTags.length
bridge.handleClientMessage({
  type: 'select_target',
  requestId: 'select-43',
  data: { systemId: 43, componentId: 1 },
})
assert.equal((bridge as unknown as PrivateBridge).targetSysId, 43)
assert.deepEqual(
  connection.cancelledQueueTags.slice(cancelBeforeTargetSwitch),
  ALL_MOTOR_TEST_QUEUE_TAGS,
)
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

// IN_PROGRESS and per-message failures are not proof that the interval command
// itself is unsupported. A later accepted ACK from the same batch wins.
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
    'unknown',
  )
  assert.equal(
    fallbackConnection.frames.filter((frame) => frameMessageId(frame) === 66).length,
    legacyBeforeProgress,
  )
  inject(fallbackBridge, 77, commandAckPayload(511, 0), 8, 1)
  assert.equal(
    (fallbackBridge as unknown as PrivateBridge).messageIntervalSupport,
    'supported',
  )
  assert.equal(
    fallbackConnection.frames.filter((frame) => frameMessageId(frame) === 66).length,
    legacyBeforeProgress,
  )
  fallbackBridge.destroy()
}
// If no interval request is ever accepted, bounded retries still converge to
// REQUEST_DATA_STREAM for old stacks that genuinely lack command 511.
{
  const timeoutFallbackConnection = new FakeConnection()
  const timeoutFallbackBridge = new MavlinkBridge(timeoutFallbackConnection as never, {
    codec: { protocol: 'v2' },
    commandTimeoutMs: 20,
    versionRetryMs: 20,
  })
  inject(timeoutFallbackBridge, 0, heartbeatPayload(), 8, 1)
  await waitFor(() =>
    (timeoutFallbackBridge as unknown as PrivateBridge).messageIntervalSupport === 'unsupported',
  )
  assert.ok(timeoutFallbackConnection.frames.filter(
    (frame) => frameMessageId(frame) === 66,
  ).length >= 7)
  timeoutFallbackBridge.destroy()
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
  assert.ok(countIntervalFrames() - intervalFramesBeforeReboot >= 12)
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

  // ArduPilot motor test uses MAV_CMD_DO_MOTOR_TEST (209): motor 1 at 5% for
  // 2 s is [1, 0, 5, 2, 0, 0, 0]; PX4's command 310 is never sent.
  const apMotorFrames = () => apConnection.frames.filter((frame) =>
    frameMessageId(frame) === 76 && framePayload(frame).readUInt16LE(28) === 209
  )
  const cancelBeforeNoProps = apConnection.cancelledQueueTags.length
  apBridge.handleClientMessage({
    type: 'motor_test',
    requestId: 'ap-motor-noprops',
    data: { instance: 1, throttle: 5, duration: 2 },
  })
  assert.equal(apMotorFrames().length, 0)
  assert.deepEqual(
    apConnection.cancelledQueueTags.slice(cancelBeforeNoProps),
    ['motor-test-start:1'],
  )
  assert.equal(
    findLast(apMessages, (message) => message.type === 'operation_error'
      && message.data.requestId === 'ap-motor-noprops')?.data.code,
    'props_confirmation_required',
  )
  apBridge.handleClientMessage({
    type: 'motor_test',
    requestId: 'ap-motor-1',
    data: { instance: 1, throttle: 5, duration: 2, propsRemoved: true },
  })
  assert.equal(apMotorFrames().length, 1)
  {
    const payload = framePayload(apMotorFrames()[0])
    assert.equal(payload.readFloatLE(0), 1)   // 1-based motor instance
    assert.equal(payload.readFloatLE(4), 0)   // MOTOR_TEST_THROTTLE_PERCENT
    assert.equal(payload.readFloatLE(8), 5)   // throttle percent
    assert.equal(payload.readFloatLE(12), 2)  // bounded timeout seconds
  }
  assert.equal(
    apConnection.writePriorities[apConnection.frames.indexOf(apMotorFrames()[0])],
    'high',
  )
  assert.ok(apMessages.some((message) => message.type === 'motor_test_status'
    && message.data.requestId === 'ap-motor-1'
    && message.data.action === 'start'
    && message.data.status === 'sent_unconfirmed'))
  apBridge.handleClientMessage({
    type: 'motor_test',
    requestId: 'ap-motor-stop',
    data: { instance: 1, throttle: 0, duration: 0 },
  })
  assert.equal(apMotorFrames().length, 2)
  {
    const payload = framePayload(apMotorFrames()[1])
    assert.equal(payload.readFloatLE(0), 1)
    assert.equal(payload.readFloatLE(8), 0)
    assert.equal(payload.readFloatLE(12), 0)
  }
  assert.equal(
    apConnection.writePriorities[apConnection.frames.indexOf(apMotorFrames()[1])],
    'critical',
  )
  assert.equal(
    apConnection.frames.filter((frame) =>
      frameMessageId(frame) === 76 && framePayload(frame).readUInt16LE(28) === 310
    ).length,
    0,
  )

  apBridge.handleClientMessage({
    type: 'motor_test_batch',
    requestId: 'ap-motor-all-start',
    data: {
      instances: [1, 2, 3],
      throttle: 7,
      duration: 2,
      propsRemoved: true,
    },
  })
  assert.equal(apMotorFrames().length, 5)
  assert.deepEqual(
    apMotorFrames().slice(2).map((frame) => framePayload(frame).readFloatLE(0)),
    [1, 2, 3],
  )
  apBridge.handleClientMessage({
    type: 'motor_test_batch',
    requestId: 'ap-motor-all-stop',
    data: { instances: [1, 2, 3], throttle: 0, duration: 0 },
  })
  assert.equal(apMotorFrames().length, 8)
  assert.ok(apMotorFrames().slice(5).every((frame) => (
    framePayload(frame).readFloatLE(8) === 0
    && framePayload(frame).readFloatLE(12) === 0
  )))

  // While armed, motor-test starts are refused before serialization; stop
  // commands remain allowed.
  const armedHeartbeat = heartbeatPayload(3, 2, 0)
  armedHeartbeat[6] = 0x80
  const cancelBeforeArmedHeartbeat = apConnection.cancelledQueueTags.length
  inject(apBridge, 0, armedHeartbeat, 55, 1)
  assert.deepEqual(
    apConnection.cancelledQueueTags.slice(cancelBeforeArmedHeartbeat),
    ALL_MOTOR_TEST_QUEUE_TAGS,
  )
  const cancelBeforeArmedReject = apConnection.cancelledQueueTags.length
  apBridge.handleClientMessage({
    type: 'motor_test',
    requestId: 'ap-motor-armed',
    data: { instance: 1, throttle: 5, duration: 2, propsRemoved: true },
  })
  assert.equal(apMotorFrames().length, 8)
  assert.deepEqual(
    apConnection.cancelledQueueTags.slice(cancelBeforeArmedReject),
    ['motor-test-start:1'],
  )
  assert.equal(
    findLast(apMessages, (message) => message.type === 'operation_error'
      && message.data.requestId === 'ap-motor-armed')?.data.code,
    'vehicle_armed',
  )
  apBridge.handleClientMessage({
    type: 'motor_test',
    requestId: 'ap-motor-armed-stop',
    data: { instance: 1, throttle: 0, duration: 0 },
  })
  assert.equal(apMotorFrames().length, 9)
  // Calibration is bench-only: createCalibrationSession refuses while armed
  // (session flows are owned by the CalibrationSessionManager, which calls
  // this factory directly instead of routing start_calibration to the bridge).
  const calFrames = () => apConnection.frames.filter((frame) => {
    if (frameMessageId(frame) !== 76) return false
    const command = framePayload(frame).readUInt16LE(28)
    return command === 241 || command === 42424
  })
  const startCal = (kind: string, requestId: string) => {
    const snapshots: any[] = []
    const session = (apBridge as any).createCalibrationSession({
      sessionId: `sess-${requestId}`,
      requestId,
      kind,
      ownerClientId: 'test-owner',
      emitSnapshot: (snapshot: any) => snapshots.push(snapshot),
    })
    session?.start()
    return { session, snapshots }
  }
  const calFramesBeforeArmed = calFrames().length
  const armedCal = startCal('gyro', 'ap-cal-armed')
  assert.equal(armedCal.session, null)
  assert.equal(calFrames().length, calFramesBeforeArmed)
  assert.equal(
    findLast(apMessages, (message) => message.type === 'operation_error'
      && message.data.requestId === 'ap-cal-armed')?.data.code,
    'vehicle_armed',
  )
  inject(apBridge, 0, heartbeatPayload(3, 2, 0), 55, 1)

  // ArduCopter calibration encodings via MAV_CMD_PREFLIGHT_CALIBRATION(241):
  // gyro=param1, baro=param3, accel(six-position)=param5=1 (bug fix: was 2),
  // simple accel=param5=4, level=param5=2. Onboard mag uses DO_START_MAG_CAL.
  const preflightFrames = () => apConnection.frames.filter((frame) =>
    frameMessageId(frame) === 76 && framePayload(frame).readUInt16LE(28) === 241
  )
  const gyroCal = startCal('gyro', 'ap-cal-gyro')
  assert.equal(preflightFrames().length, 1)
  assert.equal(framePayload(preflightFrames()[0]).readFloatLE(0), 1)
  assert.equal(gyroCal.snapshots[0]?.phase, 'starting')
  inject(apBridge, 77, commandAckPayload(241, 0), 55, 1)
  await wait(45)
  // gyro one-shot: an ACCEPTED ACK yields accepted/ack_only, never verified.
  assert.equal(last(gyroCal.snapshots)?.phase, 'accepted')
  assert.equal(last(gyroCal.snapshots)?.verification, 'ack_only')

  const baroCal = startCal('baro', 'ap-cal-baro')
  assert.equal(preflightFrames().length, 2)
  assert.equal(framePayload(preflightFrames()[1]).readFloatLE(8), 1)
  inject(apBridge, 77, commandAckPayload(241, 0), 55, 1)
  await wait(45)

  // accel is the six-position flow now: param5=1 (previously mis-encoded as 2).
  const accelCal = startCal('accel', 'ap-cal-accel')
  assert.equal(preflightFrames().length, 3)
  assert.equal(framePayload(preflightFrames()[2]).readFloatLE(16), 1)
  assert.equal(accelCal.session?.cancelSupported, false)
  // Terminate it so the single-session invariant does not block the next start.
  accelCal.session?.terminate('test_cleanup', 'test')

  const simpleCal = startCal('accel_simple', 'ap-cal-simple')
  assert.equal(preflightFrames().length, 4)
  assert.equal(framePayload(preflightFrames()[3]).readFloatLE(16), 4)
  simpleCal.session?.terminate('test_cleanup', 'test')

  const levelCal = startCal('level', 'ap-cal-level')
  assert.equal(preflightFrames().length, 5)
  assert.equal(framePayload(preflightFrames()[4]).readFloatLE(16), 2)
  levelCal.session?.terminate('test_cleanup', 'test')

  // Onboard mag calibration is now supported: it sends DO_START_MAG_CAL(42424),
  // not a PREFLIGHT_CALIBRATION frame.
  const magFramesBefore = apConnection.frames.filter((frame) =>
    frameMessageId(frame) === 76 && framePayload(frame).readUInt16LE(28) === 42424
  ).length
  const magCal = startCal('mag', 'ap-cal-mag')
  assert.notEqual(magCal.session, null)
  assert.equal(
    apConnection.frames.filter((frame) =>
      frameMessageId(frame) === 76 && framePayload(frame).readUInt16LE(28) === 42424
    ).length,
    magFramesBefore + 1,
  )
  assert.equal(preflightFrames().length, 5, 'mag must not send a PREFLIGHT_CALIBRATION frame')
  magCal.session?.terminate('test_cleanup', 'test')

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
  // The one-shot version message is cached so late-joining WS clients can be
  // replayed the firmware snapshot (page refresh after the FC handshake).
  const cachedVersion = apBridge.getAutopilotVersionMessage()
  assert.equal(cachedVersion?.type, 'autopilot_version')
  assert.equal((cachedVersion as { data: { firmwareLabel: string } }).data.firmwareLabel, 'ArduPilot v4.7.0')

  // ArduPilot telemetry edge cases (synthetic minimal fixtures):
  // SYS_STATUS with a PreArm-check bit present but unhealthy must surface
  // preflightCheck=false and remain blocking.
  const sysStatusPayload = Buffer.alloc(31)
  const PREARM_BIT = 0x10000000
  const GYRO_BIT = 0x00000001
  sysStatusPayload.writeUInt32LE(PREARM_BIT | GYRO_BIT, 0)  // present
  sysStatusPayload.writeUInt32LE(PREARM_BIT | GYRO_BIT, 4)  // enabled
  sysStatusPayload.writeUInt32LE(GYRO_BIT, 8)               // health: prearm NOT healthy
  sysStatusPayload.writeUInt16LE(0, 14)                     // voltage 0 = no monitor
  sysStatusPayload.writeInt16LE(-1, 16)                     // current unknown
  sysStatusPayload.writeInt8(97, 30)                        // battery_remaining 97%
  inject(apBridge, 1, sysStatusPayload, 55, 1)
  const apSysStatus = findLast(apMessages, (message) =>
    message.type === 'telemetry' && message.msgType === 'SYS_STATUS')?.data
  assert.equal(apSysStatus.preflightCheck, false)
  // A monitor-less 0 mV must not become a healthy 0.0 V / 97%.
  assert.equal(apSysStatus.voltageBattery, null)
  assert.equal(apSysStatus.batteryRemaining, null)

  // BATTERY_STATUS with all-unknown voltages reports voltage null (no pack).
  const apBatteryPayload = Buffer.alloc(36)
  apBatteryPayload.writeInt32LE(-1, 0)                      // current unknown
  for (let cell = 0; cell < 10; cell += 1) apBatteryPayload.writeUInt16LE(0xffff, 10 + cell * 2)
  apBatteryPayload.writeInt16LE(-1, 30)                     // temperature unknown
  apBatteryPayload[32] = 0                                  // id 0
  apBatteryPayload.writeInt8(-1, 35)                        // remaining unknown
  inject(apBridge, 147, apBatteryPayload, 55, 1)
  const apBattery = findLast(apMessages, (message) =>
    message.type === 'telemetry' && message.msgType === 'BATTERY_STATUS')?.data
  assert.equal(apBattery.voltage, null)
  assert.equal(apBattery.remaining, null)

  // ESTIMATOR_STATUS (#230) surfaces an EKF status report for the panel.
  // MAVLink v2 reorders fields by type size: uint64 time_usec, then the eight
  // float ratios, then the uint16 flags at the end (offset 40).
  const estimatorPayload = Buffer.alloc(42)
  estimatorPayload.writeFloatLE(0.3, 8)     // vel_ratio
  estimatorPayload.writeUInt16LE(0x1f, 40)  // flags (health bits set)
  inject(apBridge, 230, estimatorPayload, 55, 1)
  const apEkf = findLast(apMessages, (message) => message.type === 'ekf_status')?.data
  assert.equal(apEkf.health_flags, 0x1f)

  // A connection status change resets the target; the identity must be
  // cleared so a different vehicle on reconnect cannot inherit the profile.
  ;(apBridge as unknown as { onStatusChange: (status: string) => void }).onStatusChange('disconnected')
  const resetTarget = findLast(apMessages, (message) => message.type === 'target' && message.data.reason === 'reset')
  assert.equal(resetTarget.data.identity, null)
  assert.equal(resetTarget.data.systemId, null)
  apBridge.destroy()
}

// A same-target identity change invalidates every queued motor start before
// the new (possibly read-only) profile can inherit old commands.
{
  const identityConnection = new FakeConnection()
  const identityBridge = new MavlinkBridge(identityConnection as never, {
    codec: { protocol: 'v2' },
    commandTimeoutMs: 20,
    versionRetryMs: 20,
  })
  inject(identityBridge, 0, heartbeatPayload(3, 2, 0), 68, 1)
  identityBridge.handleClientMessage({
    type: 'motor_test',
    requestId: 'identity-motor',
    data: { instance: 1, throttle: 5, duration: 2, propsRemoved: true },
  })
  const cancelBeforeIdentityChange = identityConnection.cancelledQueueTags.length
  inject(identityBridge, 0, heartbeatPayload(3, 1, 0), 68, 1)
  assert.deepEqual(
    identityConnection.cancelledQueueTags.slice(cancelBeforeIdentityChange),
    ALL_MOTOR_TEST_QUEUE_TAGS,
  )
  assert.equal(identityBridge.vehicleIdentity?.vehicleClass, 'plane')
  identityBridge.destroy()
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

  // Every capability-gated write surface refuses before serialization: arm,
  // calibration and motor test produce no COMMAND_LONG frames at all.
  const commandFramesBeforeGated = genericConnection.frames.filter(
    (frame) => frameMessageId(frame) === 76,
  ).length
  genericBridge.handleClientMessage({
    type: 'command',
    requestId: 'generic-arm',
    cmd: 'MAV_CMD_COMPONENT_ARM_DISARM',
    params: [1, 0, 0, 0, 0, 0, 0],
    safetyConfirmation: 'arm',
  })
  genericBridge.handleClientMessage({
    type: 'command',
    requestId: 'generic-cal',
    cmd: 'MAV_CMD_PREFLIGHT_CALIBRATION',
    params: [1, 0, 0, 0, 0, 0, 0],
  })
  genericBridge.handleClientMessage({
    type: 'motor_test',
    requestId: 'generic-motor',
    data: { instance: 1, throttle: 0, duration: 0 },
  })
  genericBridge.handleClientMessage({
    type: 'motor_test_batch',
    requestId: 'generic-motor-batch',
    data: { instances: [1, 2, 3, 4], throttle: 0, duration: 0 },
  })
  assert.equal(
    genericConnection.frames.filter((frame) => frameMessageId(frame) === 76).length,
    commandFramesBeforeGated,
  )
  for (const [requestId, code] of [
    ['generic-arm', 'unsupported_vehicle_profile'],
    ['generic-cal', 'unsupported_vehicle_profile'],
    ['generic-motor', 'unsupported_motor_test'],
    ['generic-motor-batch', 'unsupported_motor_test'],
  ] as const) {
    const error = findLast(
      genericMessages,
      (message) => message.type === 'operation_error' && message.data.requestId === requestId,
    )
    assert.equal(error?.data.code, code, `expected ${code} for ${requestId}`)
  }
  // Calibration also refuses to create a session for an unknown profile:
  // createCalibrationSession returns null and serializes no 241 frame.
  const cal241Before = genericConnection.frames.filter((frame) =>
    frameMessageId(frame) === 76 && framePayload(frame).readUInt16LE(28) === 241
  ).length
  const genericCalSession = (genericBridge as any).createCalibrationSession({
    sessionId: 'sess-generic-cal2',
    requestId: 'generic-cal2',
    kind: 'gyro',
    ownerClientId: 'test-owner',
    emitSnapshot: () => {},
  })
  assert.equal(genericCalSession, null)
  assert.equal(
    genericConnection.frames.filter((frame) =>
      frameMessageId(frame) === 76 && framePayload(frame).readUInt16LE(28) === 241
    ).length,
    cal241Before,
  )
  assert.equal(
    findLast(genericMessages, (message) => message.type === 'operation_error'
      && message.data.requestId === 'generic-cal2')?.data.code,
    'unsupported_vehicle_profile',
  )

  const genericMutationFrames = genericConnection.frames.length
  genericBridge.handleClientMessage({
    type: 'param_set',
    requestId: 'generic-param',
    data: { id: 'TEST_PARAM', value: 1, paramType: 9 },
  })
  genericBridge.handleClientMessage({
    type: 'manual_control',
    requestId: 'generic-manual',
    data: { x: 0, y: 0, z: 0, r: 0 },
  })
  const genericRebootResult = genericBridge.handleClientMessage({
    type: 'reboot_vehicle',
    requestId: 'generic-reboot',
    safetyConfirmation: 'reboot_flight_controller',
  })
  assert.equal(genericRebootResult.vehicleRebootQueued, false)
  genericBridge.handleClientMessage({
    type: 'message_rates_set',
    requestId: 'generic-rates',
    data: { attitude: 8, position: 2, sensors: 2, rc: 2, status: 1, hud: 1, auxiliary: 2 },
  })
  genericBridge.handleClientMessage({
    type: 'fs_delete',
    requestId: 'generic-delete',
    data: { entries: [{ path: '/fs/microsd/log/a.ulg', kind: 'file' }] },
    safetyConfirmation: 'delete_files',
  })
  genericBridge.handleClientMessage({
    type: 'log_erase',
    requestId: 'generic-erase',
    safetyConfirmation: 'erase_all_logs',
  })
  await wait(0)
  assert.equal(genericConnection.frames.length, genericMutationFrames)
  for (const requestId of ['generic-param', 'generic-manual', 'generic-reboot', 'generic-rates']) {
    assert.equal(
      findLast(genericMessages, (message) => message.type === 'operation_error'
        && message.data.requestId === requestId)?.data.code,
      'unsupported_vehicle_profile',
    )
  }
  assert.equal(
    findLast(genericMessages, (message) => message.type === 'fs_op_error'
      && message.data.requestId === 'generic-delete')?.data.code,
    'unsupported_vehicle_profile',
  )
  assert.equal(
    findLast(genericMessages, (message) => message.type === 'log_op_error'
      && message.data.requestId === 'generic-erase')?.data.code,
    'unsupported_vehicle_profile',
  )
  genericBridge.destroy()
}

// ArduPlane retains DataFlash browsing, while every mutation uses the same
// default-deny write capability as the other unimplemented ArduPilot classes.
{
  const planeConnection = new FakeConnection()
  const planeBridge = new MavlinkBridge(planeConnection as never, {
    codec: { protocol: 'v2' },
    commandTimeoutMs: 20,
    versionRetryMs: 20,
  })
  const planeMessages: any[] = []
  planeBridge.on('message', (message) => planeMessages.push(message))
  inject(planeBridge, 0, heartbeatPayload(3, 1, 0), 67, 1)

  planeBridge.handleClientMessage({ type: 'log_list', requestId: 'plane-list' })
  assert.ok(planeConnection.frames.some((frame) => frameMessageId(frame) === 117))

  const mutationIds = new Set([23, 69, 76, 110, 121])
  const mutationFrameCount = () => planeConnection.frames.filter(
    (frame) => mutationIds.has(frameMessageId(frame)),
  ).length
  const beforeMutations = mutationFrameCount()
  planeBridge.handleClientMessage({
    type: 'param_set',
    requestId: 'plane-param',
    data: { id: 'TEST_PARAM', value: 1, paramType: 9 },
  })
  planeBridge.handleClientMessage({
    type: 'manual_control',
    requestId: 'plane-manual',
    data: { x: 0, y: 0, z: 0, r: 0 },
  })
  const planeRebootResult = planeBridge.handleClientMessage({
    type: 'reboot_vehicle',
    requestId: 'plane-reboot',
    safetyConfirmation: 'reboot_flight_controller',
  })
  assert.equal(planeRebootResult.vehicleRebootQueued, false)
  planeBridge.handleClientMessage({
    type: 'message_rates_set',
    requestId: 'plane-rates',
    data: { attitude: 8, position: 2, sensors: 2, rc: 2, status: 1, hud: 1, auxiliary: 2 },
  })
  planeBridge.handleClientMessage({
    type: 'fs_delete',
    requestId: 'plane-delete',
    data: { entries: [{ path: '/fs/microsd/log/a.bin', kind: 'file' }] },
    safetyConfirmation: 'delete_files',
  })
  planeBridge.handleClientMessage({
    type: 'log_erase',
    requestId: 'plane-erase',
    safetyConfirmation: 'erase_all_logs',
  })
  await wait(0)
  assert.equal(mutationFrameCount(), beforeMutations)
  for (const requestId of ['plane-param', 'plane-manual', 'plane-reboot', 'plane-rates']) {
    assert.equal(
      findLast(planeMessages, (message) => message.type === 'operation_error'
        && message.data.requestId === requestId)?.data.code,
      'unsupported_vehicle_profile',
    )
  }
  assert.equal(
    findLast(planeMessages, (message) => message.type === 'fs_op_error'
      && message.data.requestId === 'plane-delete')?.data.code,
    'unsupported_vehicle_profile',
  )
  assert.equal(
    findLast(planeMessages, (message) => message.type === 'log_op_error'
      && message.data.requestId === 'plane-erase')?.data.code,
    'unsupported_vehicle_profile',
  )
  planeBridge.destroy()
}

console.log('MAVLink codec, transaction, target and telemetry checks passed')

// ---------------------------------------------------------------------------
// ESC session protocol pause/resume (ADR-003/005).
// ---------------------------------------------------------------------------
{
  const pauseConnection = new FakeConnection()
  const pauseBridge = new MavlinkBridge(pauseConnection as never, {
    codec: { protocol: 'v2' },
    commandTimeoutMs: 20,
    paramSetTimeoutMs: 20,
    versionRetryMs: 20,
  })

  // Serialized heartbeat frames from sysid 42 (ArduPilot) exercise the real
  // data -> codec -> handleMessage path so we can observe intake attach/detach.
  const hbProtocol = new MavLinkProtocolV2(42, 1)
  const hbFrame = (seq: number) => hbProtocol.serialize(makeHeartbeat(3), seq)

  // Before pause, bytes on the data event discover the target.
  pauseConnection.emit('data', hbFrame(0))
  assert.ok((pauseBridge as unknown as PrivateBridge).discoveredTargets.size >= 1,
    'target discovered before pause')

  // Pause detaches the intake and stops the GCS heartbeat (ADR-003/005).
  pauseBridge.pauseProtocol('esc_session')
  assert.equal(pauseBridge.isProtocolPaused, true)
  ;(pauseBridge as unknown as PrivateBridge).discoveredTargets.clear()
  pauseConnection.emit('data', hbFrame(1))
  assert.equal((pauseBridge as unknown as PrivateBridge).discoveredTargets.size, 0,
    'paused bridge must not parse raw bytes')

  // While paused, GCS heartbeats stop: no outbound frames are produced.
  const framesAfterPause = pauseConnection.frames.length
  pauseConnection.emit('data', Buffer.from([0x2f, 0x30, 0x00]))
  assert.equal(pauseConnection.frames.length, framesAfterPause,
    'paused bridge must not respond to raw bytes')

  // A status change to connected must NOT re-arm MAVLink while paused (ADR-005).
  pauseConnection.emit('statusChange', 'connected')
  assert.equal(pauseConnection.frames.length, framesAfterPause,
    'paused bridge must not restart the heartbeat on statusChange')

  // Resume re-attaches intake and restarts the heartbeat, without faking readiness.
  pauseBridge.resumeProtocol()
  assert.equal(pauseBridge.isProtocolPaused, false)
  const framesAfterResume = pauseConnection.frames.length
  ;(pauseBridge as unknown as { sendHeartbeat: () => void }).sendHeartbeat()
  assert.ok(pauseConnection.frames.length > framesAfterResume, 'resume restores GCS heartbeat')

  // After resume the codec parses again: a valid heartbeat re-discovers targets.
  ;(pauseBridge as unknown as PrivateBridge).discoveredTargets.clear()
  pauseConnection.emit('data', hbFrame(2))
  assert.ok((pauseBridge as unknown as PrivateBridge).discoveredTargets.size >= 1,
    'resumed bridge processes MAVLink messages again')

  // Idempotency.
  pauseBridge.resumeProtocol()
  assert.equal(pauseBridge.isProtocolPaused, false)
  pauseBridge.pauseProtocol('esc_session')
  pauseBridge.pauseProtocol('esc_session')
  assert.equal(pauseBridge.isProtocolPaused, true)
  pauseBridge.resumeProtocol()

  pauseBridge.destroy()
  console.log('MAVLink ESC pause/resume checks passed')
}

// ---------------------------------------------------------------------------
// PX4 calibration session wiring: STATUSTEXT [cal] reassembly feeds the
// session, the start command is sent exactly once (no pendingCommands
// retransmit), CAL_MAG_SIDES gates mag sides, and cancel emits an all-zero 241.
// ---------------------------------------------------------------------------
{
  function statustextPayload(severity: number, text: string): Buffer {
    const payload = Buffer.alloc(54)
    payload[0] = severity
    Buffer.from(text, 'ascii').copy(payload, 1, 0, 50)
    return payload
  }

  const calConnection = new FakeConnection()
  const calBridge = new MavlinkBridge(calConnection as never, {
    codec: { protocol: 'v2' },
    commandTimeoutMs: 20,
    versionRetryMs: 20,
  })
  // PX4 quad heartbeat (autopilot 12), disarmed.
  inject(calBridge, 0, heartbeatPayload(12, 2, 0x03040000), 55, 1)

  const preflight241 = () => calConnection.frames.filter((frame) =>
    frameMessageId(frame) === 76 && framePayload(frame).readUInt16LE(28) === 241
  )
  const snapshots: any[] = []
  const session = (calBridge as any).createCalibrationSession({
    sessionId: 'sess-px4-accel',
    requestId: 'px4-accel',
    kind: 'accel',
    ownerClientId: 'owner',
    emitSnapshot: (snapshot: any) => snapshots.push(snapshot),
  })
  assert.notEqual(session, null)
  session.start()
  assert.equal(preflight241().length, 1)
  assert.equal(framePayload(preflight241()[0]).readFloatLE(16), 1, 'PX4 accel = param5=1')
  assert.equal(last(snapshots)?.phase, 'starting')
  assert.equal(last(snapshots)?.cancelSupported, true)

  // STATUSTEXT [cal] lines drive the wizard state through the bridge reassembly
  // path and the parser.
  inject(calBridge, 253, statustextPayload(6, '[cal] calibration started: 2 accel'), 55, 1)
  assert.equal(last(snapshots)?.phase, 'running')
  assert.deepEqual(last(snapshots)?.sides, {
    down: 'pending', up: 'pending', left: 'pending',
    right: 'pending', front: 'pending', back: 'pending',
  })
  inject(calBridge, 253, statustextPayload(6, '[cal] down orientation detected'), 55, 1)
  assert.equal(last(snapshots)?.sides?.down, 'active')
  inject(calBridge, 253, statustextPayload(6, '[cal] down side done, rotate to a different side'), 55, 1)
  assert.equal(last(snapshots)?.sides?.down, 'done')
  inject(calBridge, 253, statustextPayload(6, '[cal] calibration done: accel'), 55, 1)
  assert.equal(last(snapshots)?.phase, 'done')
  assert.equal(last(snapshots)?.verification, 'verified')
  // The start command was serialized exactly once: no retransmit ever restarts
  // the calibration on the FC.
  assert.equal(preflight241().length, 1)

  // A wrong-source STATUSTEXT (different system id) must not touch the session.
  // Start a fresh session to observe this.
  const snapshots2: any[] = []
  const session2 = (calBridge as any).createCalibrationSession({
    sessionId: 'sess-px4-gyro',
    requestId: 'px4-gyro',
    kind: 'gyro',
    ownerClientId: 'owner',
    emitSnapshot: (snapshot: any) => snapshots2.push(snapshot),
  })
  session2.start()
  const beforeWrongSource = snapshots2.length
  inject(calBridge, 253, statustextPayload(6, '[cal] calibration done: gyro'), 99, 1)
  assert.equal(snapshots2.length, beforeWrongSource, 'STATUSTEXT from a non-selected source is ignored')
  // Cancel sends a single all-zero 241 frame.
  const before241 = preflight241().length
  const cancelResult = session2.cancel()
  assert.equal(cancelResult.ok, true)
  assert.equal(preflight241().length, before241 + 1)
  const cancelFrame = preflight241()[preflight241().length - 1]
  for (let offset = 0; offset <= 24; offset += 4) {
    assert.equal(framePayload(cancelFrame).readFloatLE(offset), 0, 'cancel params must be all zero')
  }

  calBridge.destroy()
  console.log('MAVLink PX4 calibration session wiring checks passed')
}

// ---------------------------------------------------------------------------
// ArduPilot interactive accel calibration wiring: inbound COMMAND_LONG(42429)
// position requests reach the session, and confirmation echoes 42429 to the
// SELECTED autopilot target (never the FC's GCS-addressed target field).
// ---------------------------------------------------------------------------
{
  function commandLongPayload(command: number, param1: number, targetSystem: number, targetComponent: number): Buffer {
    const payload = Buffer.alloc(33)
    payload.writeFloatLE(param1, 0)
    payload.writeUInt16LE(command, 28)
    payload[30] = targetSystem
    payload[31] = targetComponent
    return payload
  }

  const apAccelConnection = new FakeConnection()
  const apAccelBridge = new MavlinkBridge(apAccelConnection as never, {
    codec: { protocol: 'v2' },
    commandTimeoutMs: 20,
    versionRetryMs: 20,
  })
  // ArduCopter target from system 55, component 1.
  inject(apAccelBridge, 0, heartbeatPayload(3, 2, 0), 55, 1)

  const snapshots: any[] = []
  const session = (apAccelBridge as any).createCalibrationSession({
    sessionId: 'sess-ap-accel',
    requestId: 'ap-accel-6',
    kind: 'accel',
    ownerClientId: 'owner',
    emitSnapshot: (snapshot: any) => snapshots.push(snapshot),
  })
  assert.notEqual(session, null)
  session.start()

  const accelcalFrames = () => apAccelConnection.frames.filter((frame) =>
    frameMessageId(frame) === 76 && framePayload(frame).readUInt16LE(28) === 42429
  )
  // FC requests LEVEL (position 1), addressed to the GCS (system 255).
  inject(apAccelBridge, 76, commandLongPayload(42429, 1, 255, 190), 55, 1)
  assert.equal(last(snapshots)?.phase, 'waiting_position')
  assert.equal(last(snapshots)?.requestedPosition, 1)

  // Confirming echoes 42429 back to the SELECTED target (55/1), not 255/190.
  const confirm = session.confirmPosition(1)
  assert.equal(confirm.ok, true)
  assert.equal(accelcalFrames().length, 1)
  const confirmPayload = framePayload(accelcalFrames()[0])
  assert.equal(confirmPayload.readFloatLE(0), 1, 'param1 = confirmed position')
  assert.equal(confirmPayload.readUInt8(30), 55, 'target system must be the selected autopilot')
  assert.equal(confirmPayload.readUInt8(31), 1, 'target component must be the selected autopilot')

  // A COMMAND_LONG(42429) NOT addressed to this GCS is ignored by the session.
  inject(apAccelBridge, 76, commandLongPayload(42429, 2, 7, 8), 55, 1)
  assert.notEqual(last(snapshots)?.requestedPosition, 2, 'wrong-target position request must be ignored')

  // Success sentinel drives a verified terminal snapshot.
  inject(apAccelBridge, 76, commandLongPayload(42429, 16777215, 255, 190), 55, 1)
  assert.equal(last(snapshots)?.phase, 'done')
  assert.equal(last(snapshots)?.verification, 'verified')

  apAccelBridge.destroy()
  console.log('MAVLink ArduPilot accel calibration wiring checks passed')
}

// An armed heartbeat from the selected vehicle immediately terminates an
// in-progress calibration, including when another GCS performed the arming.
{
  const positionRequestPayload = (position: number): Buffer => {
    const payload = Buffer.alloc(33)
    payload.writeFloatLE(position, 0)
    payload.writeUInt16LE(42429, 28)
    payload[30] = 255
    payload[31] = 190
    return payload
  }
  const armedCalConnection = new FakeConnection()
  const armedCalBridge = new MavlinkBridge(armedCalConnection as never, {
    codec: { protocol: 'v2' },
    commandTimeoutMs: 20,
    versionRetryMs: 20,
  })
  inject(armedCalBridge, 0, heartbeatPayload(3, 2, 0), 55, 1)

  const snapshots: any[] = []
  const session = (armedCalBridge as any).createCalibrationSession({
    sessionId: 'sess-ap-armed-during-cal',
    requestId: 'ap-armed-during-cal',
    kind: 'accel',
    ownerClientId: 'owner',
    emitSnapshot: (snapshot: any) => snapshots.push(snapshot),
  })
  assert.notEqual(session, null)
  session.start()

  // Establish an actionable position-confirmation state before arming.
  inject(armedCalBridge, 76, positionRequestPayload(1), 55, 1)
  assert.equal(last(snapshots)?.phase, 'waiting_position')
  const positionFramesBeforeArm = armedCalConnection.frames.filter((frame) =>
    frameMessageId(frame) === 76 && framePayload(frame).readUInt16LE(28) === 42429).length

  const armedHeartbeat = heartbeatPayload(3, 2, 0)
  armedHeartbeat[6] = 0x80
  inject(armedCalBridge, 0, armedHeartbeat, 55, 1)

  assert.equal(last(snapshots)?.phase, 'failed')
  assert.equal(last(snapshots)?.failureCode, 'vehicle_armed')
  assert.equal((armedCalBridge as any).activeCalibration, null)
  assert.equal(session.confirmPosition(1).ok, false)
  assert.equal(
    armedCalConnection.frames.filter((frame) =>
      frameMessageId(frame) === 76 && framePayload(frame).readUInt16LE(28) === 42429).length,
    positionFramesBeforeArm,
    'no position confirmation may be sent after the vehicle arms',
  )

  armedCalBridge.destroy()
}

// ---------------------------------------------------------------------------
// ArduPilot compass calibration wiring: real MAG_CAL_PROGRESS(191) and
// MAG_CAL_REPORT(192) frames decode and drive the session, and accept sends
// DO_ACCEPT_MAG_CAL(42425).
// ---------------------------------------------------------------------------
{
  const messagePayload = (message: Parameters<MavLinkProtocolV2['serialize']>[0]): Buffer =>
    framePayload(new MavLinkProtocolV2(55, 1).serialize(message, 0))

  const magConnection = new FakeConnection()
  const magBridge = new MavlinkBridge(magConnection as never, {
    codec: { protocol: 'v2' },
    commandTimeoutMs: 20,
    versionRetryMs: 20,
  })
  inject(magBridge, 0, heartbeatPayload(3, 2, 0), 55, 1)

  const snapshots: any[] = []
  const session = (magBridge as any).createCalibrationSession({
    sessionId: 'sess-ap-mag',
    requestId: 'ap-mag',
    kind: 'mag',
    ownerClientId: 'owner',
    emitSnapshot: (snapshot: any) => snapshots.push(snapshot),
  })
  assert.notEqual(session, null)
  session.start()
  assert.equal(magConnection.frames.filter((frame) =>
    frameMessageId(frame) === 76 && framePayload(frame).readUInt16LE(28) === 42424).length, 1)

  // Real 191 frame -> session running with the expected mask latched.
  const progress = new ardupilotmega.MagCalProgress()
  progress.compassId = 0
  progress.calMask = 0b001
  progress.calStatus = 2
  progress.attempt = 1
  progress.completionPct = 45
  progress.completionMask = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
  inject(magBridge, 191, messagePayload(progress), 55, 1)
  assert.equal(last(snapshots)?.phase, 'running')
  assert.equal(last(snapshots)?.expectedMagMask, 0b001)
  assert.equal(last(snapshots)?.magInstances?.[0]?.pct, 45)

  // Real 192 SUCCESS report (autosave=0) -> awaiting_accept.
  const report = new common.MagCalReport()
  report.compassId = 0
  report.calMask = 0b001
  report.calStatus = 4
  report.autosaved = 0
  report.fitness = 6
  report.ofsX = 10
  report.ofsY = -5
  report.ofsZ = 20
  inject(magBridge, 192, messagePayload(report), 55, 1)
  assert.equal(last(snapshots)?.phase, 'awaiting_accept')
  assert.equal(last(snapshots)?.magInstances?.[0]?.report?.fitness, 6)

  // Accept sends DO_ACCEPT_MAG_CAL(42425).
  const accept = session.acceptMag()
  assert.equal(accept.ok, true)
  assert.equal(magConnection.frames.filter((frame) =>
    frameMessageId(frame) === 76 && framePayload(frame).readUInt16LE(28) === 42425).length, 1)

  // An autosaved report finishes the session (verified, reboot required).
  report.autosaved = 1
  inject(magBridge, 192, messagePayload(report), 55, 1)
  assert.equal(last(snapshots)?.phase, 'done')
  assert.equal(last(snapshots)?.verification, 'verified')
  assert.equal(last(snapshots)?.rebootRequired, true)

  magBridge.destroy()
  console.log('MAVLink ArduPilot compass calibration wiring checks passed')
}

// A noisy or malicious target cannot grow the parameter cache without bound.
{
  const cacheConnection = new FakeConnection()
  const cacheBridge = new MavlinkBridge(cacheConnection as never, {
    codec: { protocol: 'v2' },
  })
  const internals = cacheBridge as unknown as PrivateBridge
  for (let index = 0; index < 8192; index += 1) {
    assert.equal(internals.cacheParameterValue(`P${index}`, index), true)
  }
  assert.equal(internals.parameterValues.size, 8192)
  assert.equal(internals.cacheParameterValue('OVER_LIMIT', 1), false)
  assert.equal(internals.parameterValues.has('OVER_LIMIT'), false)
  assert.equal(internals.cacheParameterValue('P0', 99), true)
  assert.equal(internals.parameterValues.get('P0'), 99)
  cacheBridge.destroy()
}
