import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { MavlinkBridge } from './MavlinkBridge'
import { MavlinkParser } from './MavlinkParser'

class FakeConnection extends EventEmitter {
  frames: Buffer[] = []

  write(frame: Buffer) {
    this.frames.push(frame)
  }
}

const connection = new FakeConnection()
const bridge = new MavlinkBridge(connection as never)

bridge.handleClientMessage({
  type: 'command',
  cmd: 'MAV_CMD_COMPONENT_ARM_DISARM',
  params: [1, 0, 0, 0, 0, 0, 0],
})
const commandPayload = connection.frames[0].subarray(10, 43)
assert.equal(commandPayload.readFloatLE(0), 1)
assert.equal(commandPayload.readUInt16LE(28), 400)
assert.equal(commandPayload[30], 1)
assert.equal(commandPayload[31], 1)

bridge.handleClientMessage({
  type: 'param_set',
  data: { id: 'TEST_PARAM', value: 12.5, paramType: 9 },
})
const paramPayload = connection.frames[1].subarray(10, 33)
assert.equal(paramPayload.readFloatLE(0), 12.5)
assert.equal(paramPayload.subarray(6, 16).toString('ascii'), 'TEST_PARAM')

bridge.handleClientMessage({
  type: 'rc_channels_override',
  data: { ch1: 1001, ch2: 1002, ch3: 1003, ch4: 1004, ch5: 1005, ch6: 1006, ch7: 1007, ch8: 1008 },
})
const rcPayload = connection.frames[2].subarray(10, 48)
assert.equal(rcPayload.readUInt16LE(0), 1001)
assert.equal(rcPayload.readUInt16LE(14), 1008)
assert.equal(rcPayload[16], 1)
assert.equal(rcPayload[17], 1)

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
const [vfrMessage] = parser.parse(truncatedVfrFrame)
assert.equal(vfrMessage.payload.length, 20)
;(bridge as unknown as { handleMessage: (message: unknown) => void }).handleMessage(vfrMessage)

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

// BATTERY_STATUS wire layout (common.xml): id(u8)@0 + current_consumed(i32)@4
// + energy_consumed(i32)@8 + temperature(i16)@12 + voltages[10](u16)@14 +
// current_battery(i16)@34 + battery_remaining(i8)@36.
// The previous code read consumed_mah from offset 0 (the `id` byte) - garbage.
const batteryPayload = Buffer.alloc(37)
batteryPayload[0] = 0                          // id
batteryPayload.writeInt32LE(1234, 4)           // current_consumed (mAh)
batteryPayload.writeInt16LE(2500, 12)          // temperature
// Two cells at 3.7V (3700 mV) each -> total 7.4V
;[3700, 3700, 0, 0, 0, 0, 0, 0, 0, 0].forEach((v, i) => {
  batteryPayload.writeUInt16LE(v, 14 + i * 2)
})
batteryPayload.writeInt16LE(1500, 34)          // current_battery (centi-A -> 15.0A)
batteryPayload.writeInt8(82, 36)               // battery_remaining (%)
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

bridge.destroy()
console.log('MAVLink frame layout and motor telemetry checks passed')
