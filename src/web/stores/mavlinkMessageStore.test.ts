import assert from 'node:assert/strict'
import {
  isMavlinkMessageLive,
  measuredMavlinkHz,
  recordMavlinkRuntimeEvent,
  useMavlinkMessageStore,
} from './mavlinkMessageStore'

useMavlinkMessageStore.getState().reset()

for (const now of [10_000, 10_500, 11_000]) {
  recordMavlinkRuntimeEvent({
    type: 'sensor',
    msgType: 'RAW_IMU',
    data: { units: 'raw', xmag: now },
  }, now)
}

let raw = useMavlinkMessageStore.getState().messages.RAW_IMU
assert.equal(raw.totalCount, 3)
assert.deepEqual(raw.latestData, { units: 'raw', xmag: 11_000 })
assert.equal(isMavlinkMessageLive(raw, 11_100), true)
assert.equal(measuredMavlinkHz(raw, 11_100), 2)
assert.equal(isMavlinkMessageLive(raw, 15_000), false)
assert.equal(measuredMavlinkHz(raw, 15_000), null)

recordMavlinkRuntimeEvent({
  type: 'status',
  data: {
    armed: false,
    mode: 'Hold',
    modeId: 0,
    systemStatus: 3,
    failsafe: 'unknown',
    identity: {
      autopilotId: 12,
      vehicleTypeId: 2,
      family: 'px4',
      vehicleClass: 'copter',
    },
  },
}, 20_000)
assert.equal(useMavlinkMessageStore.getState().messages.HEARTBEAT.totalCount, 1)

recordMavlinkRuntimeEvent({
  type: 'motor_outputs',
  data: { time_usec: 1, port: 0, outputs: [1_000, 1_100] },
}, 20_100)
assert.equal(useMavlinkMessageStore.getState().messages.SERVO_OUTPUT_RAW.totalCount, 1)

recordMavlinkRuntimeEvent({ type: 'message_rates', data: {
  attitude: 8,
  position: 2,
  sensors: 2,
  rc: 2,
  status: 1,
  hud: 1,
  auxiliary: 2,
} }, 20_200)
assert.equal(Object.keys(useMavlinkMessageStore.getState().messages).length, 3)

useMavlinkMessageStore.getState().reset()
assert.deepEqual(useMavlinkMessageStore.getState().messages, {})

console.log('mavlinkMessageStore checks passed')
