import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { MavlinkBridge } from './MavlinkBridge'
import { MavlinkParser } from './MavlinkParser'

class FakeConnection extends EventEmitter {
  frames: Buffer[] = []

  write(frame: Buffer) {
    this.frames.push(frame)
  }

  notifyAutopilotHeartbeat() {}
}

const connection = new FakeConnection()
const bridge = new MavlinkBridge(connection as never)
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

let sysStatusData: { preflightCheck: boolean | null; sensorsHealthy: boolean | null; sensorsHealth: number; batteryRemaining: number } | undefined
bridge.on('message', (message) => {
  if (message.type === 'telemetry' && message.msgType === 'SYS_STATUS') {
    sysStatusData = message.data
  }
})
const sysStatusPayload = Buffer.alloc(31)
sysStatusPayload.writeUInt32LE(0x10000000, 0)
sysStatusPayload.writeUInt32LE(0x10000000, 4)
sysStatusPayload.writeUInt32LE(0x10000000, 8)
sysStatusPayload.writeInt8(67, 18)
;(bridge as unknown as { handleMessage: (message: unknown) => void }).handleMessage({
  msgId: 1, payload: sysStatusPayload, seq: 0, sysId: 42, compId: 1,
})
assert.equal(sysStatusData?.preflightCheck, true)
assert.equal(sysStatusData?.sensorsHealthy, true)
assert.equal(sysStatusData?.sensorsHealth, 0x10000000)
assert.equal(sysStatusData?.batteryRemaining, 67)

bridge.handleClientMessage({
  type: 'param_set',
  data: { id: 'TEST_PARAM', value: 12.5, paramType: 9 },
})
const paramPayload = lastFrame().subarray(10, 33)
assert.equal(paramPayload.readFloatLE(0), 12.5)
assert.equal(paramPayload.subarray(6, 16).toString('ascii'), 'TEST_PARAM')

bridge.handleClientMessage({
  type: 'rc_channels_override',
  data: { ch1: 1001, ch2: 1002, ch3: 1003, ch4: 1004, ch5: 1005, ch6: 1006, ch7: 1007, ch8: 1008 },
})
const rcPayload = lastFrame().subarray(10, 48)
assert.equal(rcPayload.readUInt16LE(0), 1001)
assert.equal(rcPayload.readUInt16LE(14), 1008)
assert.equal(rcPayload[16], 42)
assert.equal(rcPayload[17], 1)

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
// be restored to its 20-byte base size before fixed-offset decoding.
const parser = new MavlinkParser()
const fullVfrFrame = parser.encode(74, Buffer.alloc(20))
const truncatedVfrFrame = Buffer.concat([
  Buffer.from(fullVfrFrame.subarray(0, 10)),
  fullVfrFrame.subarray(10, 26),
  fullVfrFrame.subarray(fullVfrFrame.length - 2),
])
truncatedVfrFrame[1] = 16
const crc = (parser as any).crc16(Buffer.concat([truncatedVfrFrame.subarray(1, 10), truncatedVfrFrame.subarray(10, 26)]), 20)
truncatedVfrFrame[26] = crc & 0xff
truncatedVfrFrame[27] = (crc >> 8) & 0xff
const [vfrMessage] = parser.parse(truncatedVfrFrame)
assert.equal(vfrMessage.payload.length, 20)
;(bridge as unknown as { handleMessage: (message: unknown) => void }).handleMessage(vfrMessage)

// AUTOPILOT_VERSION commonly truncates to just the non-zero capability bytes.
// Restore its 60-byte base payload before reading the uint64 capability bitmap.
const fullVersionPayload = Buffer.alloc(60)
fullVersionPayload.writeBigUInt64LE(16n, 0)
const fullVersionFrame = parser.encode(148, fullVersionPayload)
const truncatedVersionFrame = Buffer.concat([
  Buffer.from(fullVersionFrame.subarray(0, 10)),
  fullVersionFrame.subarray(10, 11),
  Buffer.alloc(2),
])
truncatedVersionFrame[1] = 1
const versionCrc = (parser as any).crc16(
  Buffer.concat([truncatedVersionFrame.subarray(1, 10), truncatedVersionFrame.subarray(10, 11)]),
  178,
)
truncatedVersionFrame[11] = versionCrc & 0xff
truncatedVersionFrame[12] = (versionCrc >> 8) & 0xff
const [versionMessage] = parser.parse(truncatedVersionFrame)
assert.equal(versionMessage.payload.length, 60)
assert.equal(versionMessage.payload.readBigUInt64LE(0), 16n)

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
bridge.handleClientMessage({ type: 'param_request_list' })
const paramListFrame = connection.frames[connection.frames.length - 1]
assert.equal(paramListFrame[7], 21)
assert.equal(paramListFrame[10], 42)
assert.equal(paramListFrame[11], 1)

const internalBridge = bridge as unknown as {
  paramExpectedCount: number
  paramIndices: Set<number>
  paramDownloadActive: boolean
  retryMissingParams: () => void
}
internalBridge.paramExpectedCount = 3
internalBridge.paramIndices = new Set([0, 2])
internalBridge.paramDownloadActive = true
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

bridge.destroy()
console.log('MAVLink frame layout and motor telemetry checks passed')
