import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { MavlinkBridge } from './MavlinkBridge'

class FakeConnection extends EventEmitter {
  frames: Buffer[] = []
  status = 'connected'
  config = { type: 'serial' }

  write(frame: Buffer) {
    this.frames.push(frame)
  }

  notifyAutopilotHeartbeat() {}
  notifyAutopilotActivity() {}
}

const connection = new FakeConnection()
const bridge = new MavlinkBridge(connection as never)
bridge.setMaxListeners(20)
const lastFrame = (offset = 1) => connection.frames[connection.frames.length - offset]

bridge.handleClientMessage({
  type: 'command',
  cmd: 'MAV_CMD_COMPONENT_ARM_DISARM',
  params: [1, 0, 0, 0, 0, 0, 0],
})
const commandPayload = lastFrame().subarray(10, 43)
assert.equal(commandPayload.readFloatLE(0), 1)
assert.equal(commandPayload.readUInt16LE(28), 400)
assert.equal(commandPayload[30], 1)
assert.equal(commandPayload[31], 1)

// Ignore heartbeats from non-autopilot components. A companion computer,
// camera, or gimbal must not steal the command target from the flight
// controller when it shares the same MAVLink system.
const componentHeartbeat = Buffer.alloc(9)
componentHeartbeat[4] = 18 // MAV_TYPE_ONBOARD_CONTROLLER
componentHeartbeat[5] = 8  // MAV_AUTOPILOT_INVALID
;(bridge as unknown as { handleMessage: (message: unknown) => void }).handleMessage({
  msgId: 0, payload: componentHeartbeat, seq: 0, sysId: 42, compId: 191,
})
bridge.handleClientMessage({
  type: 'command',
  cmd: 'MAV_CMD_COMPONENT_ARM_DISARM',
  params: [0, 0, 0, 0, 0, 0, 0],
})
const postComponentHeartbeatPayload = lastFrame().subarray(10, 43)
assert.equal(postComponentHeartbeatPayload[30], 1)
assert.equal(postComponentHeartbeatPayload[31], 1)

const autopilotHeartbeat = Buffer.alloc(9)
autopilotHeartbeat.writeUInt32LE(0x03040000, 0) // PX4 main=4, sub=3 (Hold)
autopilotHeartbeat[4] = 2 // MAV_TYPE_QUADROTOR
autopilotHeartbeat[5] = 12 // MAV_AUTOPILOT_PX4
let heartbeatStatus: { mode: string; modeId: number } | undefined
bridge.on('message', (message) => {
  if (message.type === 'status') heartbeatStatus = message.data
})
;(bridge as unknown as { handleMessage: (message: unknown) => void }).handleMessage({
  msgId: 0, payload: autopilotHeartbeat, seq: 0, sysId: 42, compId: 1,
})
assert.equal(heartbeatStatus?.mode, 'Hold')
assert.equal(heartbeatStatus?.modeId, 5)
const commandFramesAfterHeartbeat = connection.frames
  .filter((frame) => frame[7] === 76)
  .map((frame) => frame.subarray(10, 43))
const versionRequestPayload = commandFramesAfterHeartbeat.find((payload) =>
  payload.readUInt16LE(28) === 512 && payload.readFloatLE(0) === 148
)
assert.ok(versionRequestPayload)
assert.equal(versionRequestPayload.readUInt16LE(28), 512)
assert.equal(versionRequestPayload.readFloatLE(0), 148)
const requestedMessageIds = commandFramesAfterHeartbeat
  .filter((payload) => payload.readUInt16LE(28) === 511)
  .map((payload) => payload.readFloatLE(0))
assert.ok(requestedMessageIds.includes(26))
assert.ok(requestedMessageIds.includes(105))
assert.ok(requestedMessageIds.includes(116))
assert.ok(requestedMessageIds.includes(129))
bridge.handleClientMessage({
  type: 'command',
  cmd: 'MAV_CMD_COMPONENT_ARM_DISARM',
  params: [0, 0, 0, 0, 0, 0, 0],
})
const postAutopilotHeartbeatPayload = lastFrame().subarray(10, 43)
assert.equal(postAutopilotHeartbeatPayload[30], 42)
assert.equal(postAutopilotHeartbeatPayload[31], 1)

// AUTOPILOT_VERSION capabilities are authoritative. Once C-cast is negotiated,
// a later PX4 heartbeat must not overwrite it with the vendor-based fallback.
const cCastVersionPayload = Buffer.alloc(60)
cCastVersionPayload.writeBigUInt64LE(131072n, 0)
;(bridge as unknown as { handleMessage: (message: unknown) => void }).handleMessage({
  msgId: 148, payload: cCastVersionPayload, seq: 0, sysId: 42, compId: 1,
})
;(bridge as unknown as { handleMessage: (message: unknown) => void }).handleMessage({
  msgId: 0, payload: autopilotHeartbeat, seq: 0, sysId: 42, compId: 1,
})
assert.equal((bridge as unknown as { paramEncoding: string }).paramEncoding, 'c-cast')

const bytewiseVersionPayload = Buffer.alloc(60)
bytewiseVersionPayload.writeBigUInt64LE(16n, 0)
;(bridge as unknown as { handleMessage: (message: unknown) => void }).handleMessage({
  msgId: 148, payload: bytewiseVersionPayload, seq: 0, sysId: 42, compId: 1,
})
assert.equal((bridge as unknown as { paramEncoding: string }).paramEncoding, 'bytewise')

let autopilotVersionData: { boardId: number; boardName: string; firmwareLabel: string } | undefined
bridge.on('message', (message) => {
  if (message.type === 'autopilot_version') autopilotVersionData = message.data
})
const identifiedVersionPayload = Buffer.alloc(60)
identifiedVersionPayload.writeBigUInt64LE(16n, 0)
identifiedVersionPayload.writeUInt32LE((1 << 24) | (17 << 16), 16)
identifiedVersionPayload.writeUInt32LE(1179 << 16, 28)
;(bridge as unknown as { handleMessage: (message: unknown) => void }).handleMessage({
  msgId: 148, payload: identifiedVersionPayload, seq: 0, sysId: 42, compId: 1,
})
assert.equal(autopilotVersionData?.boardId, 1179)
assert.equal(autopilotVersionData?.boardName, 'MicoAir743v2')
assert.equal(autopilotVersionData?.firmwareLabel, 'PX4 v1.17.0')

let secondaryImuData: { instance: number; xacc: number } | undefined
bridge.on('message', (message) => {
  if (message.type === 'sensor' && message.msgType === 'SCALED_IMU2') {
    secondaryImuData = message.data
  }
})
const scaledImu2Payload = Buffer.alloc(24)
scaledImu2Payload.writeInt16LE(1250, 4)
;(bridge as unknown as { handleMessage: (message: unknown) => void }).handleMessage({
  msgId: 116, payload: scaledImu2Payload, seq: 0, sysId: 42, compId: 1,
})
assert.equal(secondaryImuData?.instance, 1)
assert.equal(secondaryImuData?.xacc, 1.25)

let sysStatusData: {
  preflightCheck: boolean | null
  sensorsHealthy: boolean | null
  sensorsHealth: number
  batteryRemaining: number
  unhealthySensorMask: number
  unhealthySensors: string[]
} | undefined
bridge.on('message', (message) => {
  if (message.type === 'telemetry' && message.msgType === 'SYS_STATUS') {
    sysStatusData = message.data
  }
})
const sysStatusPayload = Buffer.alloc(31)
sysStatusPayload.writeUInt32LE(0x10000000, 0)
sysStatusPayload.writeUInt32LE(0x10000000, 4)
sysStatusPayload.writeUInt32LE(0x10000000, 8)
// battery_remaining lives at wire offset 30 (uint16 group precedes it). The
// prior hand-rolled parser mistakenly read offset 18 (drop_rate_comm).
sysStatusPayload.writeInt8(67, 30)
;(bridge as unknown as { handleMessage: (message: unknown) => void }).handleMessage({
  msgId: 1, payload: sysStatusPayload, seq: 0, sysId: 42, compId: 1,
})
assert.equal(sysStatusData?.preflightCheck, true)
assert.equal(sysStatusData?.sensorsHealthy, true)
assert.equal(sysStatusData?.sensorsHealth, 0x10000000)
assert.equal(sysStatusData?.batteryRemaining, 67)
assert.equal(sysStatusData?.unhealthySensorMask, 0)
assert.deepEqual(sysStatusData?.unhealthySensors, [])

const rcFailureStatusPayload = Buffer.alloc(31)
rcFailureStatusPayload.writeUInt32LE(0x00010000, 0)
rcFailureStatusPayload.writeUInt32LE(0x00010000, 4)
rcFailureStatusPayload.writeUInt32LE(0, 8)
;(bridge as unknown as { handleMessage: (message: unknown) => void }).handleMessage({
  msgId: 1, payload: rcFailureStatusPayload, seq: 0, sysId: 42, compId: 1,
})
assert.equal(sysStatusData?.sensorsHealthy, false)
assert.equal(sysStatusData?.unhealthySensorMask, 0x00010000)
assert.deepEqual(sysStatusData?.unhealthySensors, ['RC 输入'])

bridge.handleClientMessage({
  type: 'param_set',
  data: { id: 'TEST_PARAM', value: 12.5, paramType: 9 },
})
const paramPayload = lastFrame().subarray(10, 33)
assert.equal(paramPayload.readFloatLE(0), 12.5)
assert.equal(paramPayload.subarray(6, 16).toString('ascii'), 'TEST_PARAM')

bridge.handleClientMessage({
  type: 'manual_control',
  data: { x: -750, y: 250, z: 625, r: 1000, buttons: 0x0005 },
})
const manualControlFrame = lastFrame()
assert.equal(manualControlFrame[7], 69)
const manualControlPayload = manualControlFrame.subarray(10, 21)
assert.equal(manualControlPayload.readInt16LE(0), -750)
assert.equal(manualControlPayload.readInt16LE(2), 250)
assert.equal(manualControlPayload.readInt16LE(4), 625)
assert.equal(manualControlPayload.readInt16LE(6), 1000)
assert.equal(manualControlPayload.readUInt16LE(8), 0x0005)
assert.equal(manualControlPayload[10], 42)

// RC_CHANNELS wire layout stores the 18 uint16 channels immediately after
// time_boot_ms. chancount follows at offset 40 despite appearing earlier in XML.
let rcChannelsData: { ch1: number; ch2: number; ch18?: number } | undefined
bridge.on('message', (message) => {
  if (message.type === 'rc_channels') rcChannelsData = message.data
})
const rcChannelsPayload = Buffer.alloc(42)
for (let i = 0; i < 18; i++) rcChannelsPayload.writeUInt16LE(1001 + i, 4 + i * 2)
rcChannelsPayload[40] = 18
rcChannelsPayload[41] = 200
;(bridge as unknown as { handleMessage: (message: unknown) => void }).handleMessage({
  msgId: 65, payload: rcChannelsPayload, seq: 0, sysId: 42, compId: 1,
})
assert.equal(rcChannelsData?.ch1, 1001)
assert.equal(rcChannelsData?.ch2, 1002)
assert.equal(rcChannelsData?.ch18, 1018)

// MAVLink 2 STATUSTEXT chunks must be reassembled without leaking the id and
// chunk sequence extension bytes into the user-visible message.
let reassembledStatusText: string | undefined
bridge.on('message', (message) => {
  if (message.type === 'statustext') reassembledStatusText = message.data.text
})
const firstStatusChunk = Buffer.alloc(52)
firstStatusChunk[0] = 4
Buffer.from('A'.repeat(50), 'ascii').copy(firstStatusChunk, 1)
firstStatusChunk.writeUInt8(7, 51) // id low byte; id high byte + chunk_seq trimmed on the wire
;(bridge as unknown as { handleMessage: (message: unknown) => void }).handleMessage({
  msgId: 253, payload: firstStatusChunk, seq: 0, sysId: 42, compId: 1,
})
assert.equal(reassembledStatusText, undefined)
const finalStatusChunk = Buffer.alloc(54)
finalStatusChunk[0] = 4
Buffer.from(' complete', 'ascii').copy(finalStatusChunk, 1)
finalStatusChunk.writeUInt16LE(7, 51)
finalStatusChunk[53] = 1
;(bridge as unknown as { handleMessage: (message: unknown) => void }).handleMessage({
  msgId: 253, payload: finalStatusChunk, seq: 1, sysId: 42, compId: 1,
})
assert.equal(reassembledStatusText, `${'A'.repeat(50)} complete`)

bridge.handleClientMessage({
  type: 'motor_test',
  data: { instance: 1, throttle: 15, duration: 2 },
})
const motorTestPayload = lastFrame().subarray(10, 43)
assert.equal(motorTestPayload.readUInt16LE(28), 310)
assert.ok(Math.abs(motorTestPayload.readFloatLE(0) - 0.15) < 1e-6)
assert.equal(motorTestPayload.readFloatLE(4), 2)
assert.equal(motorTestPayload.readFloatLE(16), 1101)

bridge.handleClientMessage({
  type: 'motor_test',
  data: { instance: 4, throttle: 0, duration: 0 },
})
const motorStopPayload = lastFrame().subarray(10, 43)
assert.equal(motorStopPayload.readUInt16LE(28), 310)
assert.ok(Number.isNaN(motorStopPayload.readFloatLE(0)))
assert.equal(motorStopPayload.readFloatLE(16), 1104)

let motorOutput: { outputs: Array<number | null> } | undefined
bridge.on('message', (message) => {
  if (message.type === 'motor_outputs') motorOutput = message.data
})
const servoPayload = Buffer.alloc(21)
servoPayload.writeUInt32LE(123, 0)
;[1100, 1200, 1300, 1400, 0, 0, 0, 0].forEach((value, index) => {
  servoPayload.writeUInt16LE(value, 4 + index * 2)
})
;(bridge as unknown as { handleMessage: (message: unknown) => void }).handleMessage({
  msgId: 36,
  payload: servoPayload,
  seq: 0,
  sysId: 1,
  compId: 1,
})
assert.ok(motorOutput)
assert.equal(motorOutput.outputs[3], 1400)

// MAVLink 2 may truncate trailing zero fields. A 16-byte VFR_HUD payload must
// be zero-padded to its 20-byte base before fixed-offset decoding.
let vfrData: { airspeed: number; heading: number } | undefined
bridge.on('message', (message) => {
  if (message.type === 'telemetry' && message.msgType === 'VFR_HUD') vfrData = message.data
})
const truncatedVfrPayload = Buffer.alloc(16)
truncatedVfrPayload.writeFloatLE(12.5, 0) // airspeed; heading (offset 16) trimmed
;(bridge as unknown as { handleMessage: (message: unknown) => void }).handleMessage({
  msgId: 74, payload: truncatedVfrPayload, seq: 0, sysId: 1, compId: 1,
})
assert.ok(vfrData)
assert.equal(vfrData.airspeed, 12.5)
assert.equal(vfrData.heading, 0)

// AUTOPILOT_VERSION often truncates to just the non-zero capability bytes.
// decode() must zero-pad to the 78-byte base before reading the uint64
// capability bitmap. Force a different encoding, then prove a truncated 8-byte
// capabilities payload re-negotiates it.
;(bridge as unknown as { paramEncoding: string }).paramEncoding = 'c-cast'
const truncatedVersionPayload = Buffer.alloc(8)
truncatedVersionPayload.writeBigUInt64LE(16n, 0) // MAV_PROTOCOL_CAPABILITY_PARAM_ENCODE_BYTEWISE
;(bridge as unknown as { handleMessage: (message: unknown) => void }).handleMessage({
  msgId: 148, payload: truncatedVersionPayload, seq: 0, sysId: 42, compId: 1,
})
assert.equal((bridge as unknown as { paramEncoding: string }).paramEncoding, 'bytewise')

// GPS_RAW_INT fields are wire-aligned by type size, not XML declaration order.
const gpsPayload = Buffer.alloc(30)
gpsPayload.writeInt32LE(31_234_567, 8)
gpsPayload.writeInt32LE(121_234_567, 12)
gpsPayload[28] = 3
gpsPayload[29] = 12
let gpsData: { fix_type: number; lat: number; satellites_visible: number } | undefined
bridge.on('message', (message) => {
  if (message.type === 'telemetry' && message.msgType === 'GPS_RAW_INT') gpsData = message.data
})
;(bridge as unknown as { handleMessage: (message: unknown) => void }).handleMessage({
  msgId: 24, payload: gpsPayload, seq: 0, sysId: 1, compId: 1,
})
assert.equal(gpsData?.fix_type, 3)
assert.equal(gpsData?.lat, 3.1234567)
assert.equal(gpsData?.satellites_visible, 12)

// PX4 commonly streams HIGHRES_IMU instead of SCALED_IMU. Normalize its SI
// units to the frontend's existing g/rad-s/milligauss representation.
const highresImuPayload = Buffer.alloc(62)
highresImuPayload.writeFloatLE(9.80665, 8)
highresImuPayload.writeFloatLE(-4.903325, 12)
highresImuPayload.writeFloatLE(0.25, 20)
highresImuPayload.writeFloatLE(0.42, 32)
highresImuPayload.writeFloatLE(24.5, 56)
let highresImuData: { xacc: number; yacc: number; xgyro: number; xmag: number; temperature: number } | undefined
bridge.on('message', (message) => {
  if (message.type === 'sensor' && message.msgType === 'HIGHRES_IMU') highresImuData = message.data
})
;(bridge as unknown as { handleMessage: (message: unknown) => void }).handleMessage({
  msgId: 105, payload: highresImuPayload, seq: 0, sysId: 1, compId: 1,
})
assert.ok(highresImuData)
assert.ok(Math.abs(highresImuData.xacc - 1) < 1e-6)
assert.ok(Math.abs(highresImuData.yacc + 0.5) < 1e-6)
assert.equal(highresImuData.xgyro, 0.25)
assert.ok(Math.abs(highresImuData.xmag - 420) < 1e-4)
assert.equal(highresImuData.temperature, 24.5)

// BATTERY_STATUS generated common-dialect wire offsets (MIN_LEN=36).
const batteryPayload = Buffer.alloc(36)
batteryPayload.writeInt32LE(1234, 0)           // current_consumed (mAh)
batteryPayload.writeInt16LE(2500, 8)           // temperature
// Two cells at 3.7V (3700 mV) each -> total 7.4V
;[3700, 3700, 0, 0, 0, 0, 0, 0, 0, 0].forEach((v, i) => {
  batteryPayload.writeUInt16LE(v, 10 + i * 2)
})
batteryPayload.writeInt16LE(1500, 30)          // current_battery (centi-A -> 15.0A)
batteryPayload.writeInt8(82, 35)               // battery_remaining (%)
let batteryData: { voltage: number; current: number; consumed_mah: number; remaining: number } | undefined
bridge.on('message', (message) => {
  if (message.type === 'telemetry' && message.msgType === 'BATTERY_STATUS') batteryData = message.data
})
;(bridge as unknown as { handleMessage: (message: unknown) => void }).handleMessage({
  msgId: 147, payload: batteryPayload, seq: 0, sysId: 1, compId: 1,
})
assert.equal(batteryData?.consumed_mah, 1234)
assert.equal(batteryData?.voltage, 7.4)
assert.equal(batteryData?.current, 15.0)
assert.equal(batteryData?.remaining, 82)

// Parameter downloads recover individual missing list entries by index instead
// of remaining stuck forever after one lost PARAM_VALUE packet.
const parameterEvents: Array<{ type: string; data: any }> = []
bridge.on('message', (message) => {
  if (message.type.startsWith('param_')) parameterEvents.push(message)
})
const framesBeforeParamSync = connection.frames.length
bridge.handleClientMessage({ type: 'param_request_list' })
const paramListFrame = connection.frames[connection.frames.length - 1]
assert.equal(paramListFrame[7], 21)
assert.equal(paramListFrame[10], 42)
assert.equal(paramListFrame[11], 1)
const parameterSyncCommands = connection.frames
  .slice(framesBeforeParamSync)
  .filter((frame) => frame[7] === 76 && frame.subarray(10).readUInt16LE(28) === 511)
assert.equal(parameterSyncCommands.length, 5)
for (const frame of parameterSyncCommands) {
  assert.equal(frame.subarray(10).readFloatLE(4), 500_000)
}

const internalBridge = bridge as unknown as {
  paramExpectedCount: number
  paramIndices: Set<number>
  paramDownloadActive: boolean
  paramRetryTimer: ReturnType<typeof setTimeout> | null
  retryMissingParams: () => void
}
// The first valid list entry defines the authoritative count. A later packet
// with an inconsistent count must not make the downloader wait for a phantom
// parameter forever.
const firstCountPayload = Buffer.alloc(25)
firstCountPayload.writeUInt16LE(3, 4)
firstCountPayload.writeUInt16LE(0, 6)
Buffer.from('COUNT_FIRST', 'ascii').copy(firstCountPayload, 8)
;(bridge as unknown as { handleMessage: (message: unknown) => void }).handleMessage({
  msgId: 22, payload: firstCountPayload, seq: 0, sysId: 42, compId: 1,
})
const outlierCountPayload = Buffer.from(firstCountPayload)
outlierCountPayload.writeUInt16LE(4, 4)
outlierCountPayload.writeUInt16LE(1, 6)
Buffer.from('COUNT_OUTLIER', 'ascii').copy(outlierCountPayload, 8)
;(bridge as unknown as { handleMessage: (message: unknown) => void }).handleMessage({
  msgId: 22, payload: outlierCountPayload, seq: 0, sysId: 42, compId: 1,
})
assert.equal(internalBridge.paramExpectedCount, 3)

internalBridge.paramExpectedCount = 3
internalBridge.paramIndices = new Set([0, 2])
internalBridge.paramDownloadActive = true
if (internalBridge.paramRetryTimer) clearTimeout(internalBridge.paramRetryTimer)
internalBridge.paramRetryTimer = null
internalBridge.retryMissingParams()

const paramReadFrame = connection.frames[connection.frames.length - 1]
assert.equal(paramReadFrame[7], 20)
assert.equal(paramReadFrame.subarray(10).readInt16LE(0), 1)
assert.equal(paramReadFrame[12], 42)
assert.equal(paramReadFrame[13], 1)
assert.equal(parameterEvents[parameterEvents.length - 1]?.type, 'param_retry')
assert.equal(parameterEvents[parameterEvents.length - 1]?.data.missing, 1)

const recoveredParamPayload = Buffer.alloc(25)
recoveredParamPayload.writeFloatLE(17, 0)
recoveredParamPayload.writeUInt16LE(3, 4)
recoveredParamPayload.writeUInt16LE(1, 6)
Buffer.from('RECOVERED_PARAM', 'ascii').copy(recoveredParamPayload, 8)
recoveredParamPayload[24] = 9
;(bridge as unknown as { handleMessage: (message: unknown) => void }).handleMessage({
  msgId: 22,
  payload: recoveredParamPayload,
  seq: 0,
  sysId: 42,
  compId: 1,
})
assert.equal(parameterEvents[parameterEvents.length - 1]?.type, 'param_complete')
assert.equal(parameterEvents[parameterEvents.length - 1]?.data.count, 3)

// PX4 sets MAV_PROTOCOL_CAPABILITY_PARAM_ENCODE_BYTEWISE: integer parameter
// bits must be decoded by MAV_PARAM_TYPE rather than interpreted as a float.
let decodedRotorCount: number | undefined
bridge.on('message', (message) => {
  if (message.type === 'param' && message.data.id === 'CA_ROTOR_COUNT') {
    decodedRotorCount = message.data.value
  }
})
const integerParamPayload = Buffer.alloc(25)
integerParamPayload.writeInt32LE(4, 0)
integerParamPayload.writeUInt16LE(1, 4)
integerParamPayload.writeUInt16LE(0, 6)
Buffer.from('CA_ROTOR_COUNT', 'ascii').copy(integerParamPayload, 8)
integerParamPayload[24] = 6 // MAV_PARAM_TYPE_INT32
;(bridge as unknown as { handleMessage: (message: unknown) => void }).handleMessage({
  msgId: 22,
  payload: integerParamPayload,
  seq: 0,
  sysId: 42,
  compId: 1,
})
assert.equal(decodedRotorCount, 4)

bridge.handleClientMessage({
  type: 'param_set',
  data: { id: 'SYS_AUTOSTART', value: 4001, paramType: 6 },
})
const integerParamSetFrame = connection.frames[connection.frames.length - 1]
const integerParamSetPayload = integerParamSetFrame.subarray(10, 33)
assert.equal(integerParamSetPayload.readInt32LE(0), 4001)
assert.notEqual(integerParamSetPayload.readFloatLE(0), 4001)

// Bluetooth recovery deliberately requests only four missing indices per
// stall, then rotates to the next group. This avoids a retry burst starving
// heartbeats on a 57600-baud SPP link.
connection.config = { type: 'bluetooth' }
bridge.handleClientMessage({ type: 'param_request_list' })
if (internalBridge.paramRetryTimer) clearTimeout(internalBridge.paramRetryTimer)
internalBridge.paramRetryTimer = null
internalBridge.paramExpectedCount = 10
internalBridge.paramIndices = new Set([0])
internalBridge.paramDownloadActive = true
const firstBluetoothRetryStart = connection.frames.length
internalBridge.retryMissingParams()
const firstBluetoothRetryIndices = connection.frames
  .slice(firstBluetoothRetryStart)
  .filter((frame) => frame[7] === 20)
  .map((frame) => frame.subarray(10).readInt16LE(0))
assert.deepEqual(firstBluetoothRetryIndices, [1, 2, 3, 4])

if (internalBridge.paramRetryTimer) clearTimeout(internalBridge.paramRetryTimer)
internalBridge.paramRetryTimer = null
const secondBluetoothRetryStart = connection.frames.length
internalBridge.retryMissingParams()
const secondBluetoothRetryIndices = connection.frames
  .slice(secondBluetoothRetryStart)
  .filter((frame) => frame[7] === 20)
  .map((frame) => frame.subarray(10).readInt16LE(0))
assert.deepEqual(secondBluetoothRetryIndices, [5, 6, 7, 8])

bridge.destroy()
console.log('MAVLink frame layout and motor telemetry checks passed')
