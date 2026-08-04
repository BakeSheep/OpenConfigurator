import assert from 'node:assert/strict'
import { buildGroups } from './StatusVariableBrowser'
import { useConnectionStore } from '../../stores/connectionStore'
import { useMavlinkMessageStore } from '../../stores/mavlinkMessageStore'
import { useSensorStore } from '../../stores/sensorStore'
import { useTelemetryStore } from '../../stores/telemetryStore'

function entryValue(groups: ReturnType<typeof buildGroups>, groupName: string, entryName: string): string | null {
  const group = groups.find((candidate) => candidate.name === groupName)
  assert.ok(group, `missing status group ${groupName}`)
  const entry = group.entries.find((candidate) => candidate.name === entryName)
  assert.ok(entry, `missing ${groupName}.${entryName}`)
  return entry.value
}

useMavlinkMessageStore.getState().reset()
for (const now of [10_000, 10_500, 11_000]) {
  useMavlinkMessageStore.getState().record('SCALED_IMU', {
    instance: 0,
    units: 'normalized',
    xacc: 0,
    yacc: 0,
    zacc: 1,
    xgyro: 0,
    ygyro: 0,
    zgyro: 0,
    xmag: 30,
    ymag: 40,
    zmag: 120,
    temperature: 31.5,
  }, now)
}

const firstGroups = buildGroups(
  useTelemetryStore.getState(),
  useSensorStore.getState(),
  useConnectionStore.getState().linkStats,
  useMavlinkMessageStore.getState().messages,
  11_100,
)
const canonicalNames = [
  'Vehicle', 'Battery0', 'Clock', 'DistanceSensor', 'EscStatus0', 'EstimatorStatus',
  'Generator', 'Gps', 'Gps2', 'GpsAggregate', 'Hygrometer', 'LocalPosition',
  'LocalPositionSetpoint', 'Rpm', 'Setpoint', 'Temperature', 'Terrain', 'Vibration',
  'Wind', 'Efi',
]
assert.equal(
  firstGroups.filter((group) => canonicalNames.includes(group.name)).reduce((total, group) => total + group.entries.length, 0),
  192,
)
for (const name of canonicalNames) {
  const group = firstGroups.find((candidate) => candidate.name === name)
  assert.ok(group && group.entries.length > 0, `${name} must exist even when its firmware message is unavailable`)
}
assert.equal(entryValue(firstGroups, 'COMPASS_SCALED_IMU', 'status'), 'live')
assert.equal(entryValue(firstGroups, 'COMPASS_SCALED_IMU', 'receiveHz'), '2.0')
assert.equal(entryValue(firstGroups, 'COMPASS_SCALED_IMU', 'xmag'), '30.0000')
assert.equal(entryValue(firstGroups, 'COMPASS_SCALED_IMU', 'fieldStrength'), '130.0000')
assert.equal(entryValue(firstGroups, 'COMPASS_RAW_IMU', 'status'), 'waiting')
assert.equal(entryValue(firstGroups, 'COMPASS_RAW_IMU', 'units'), 'raw')
assert.equal(entryValue(firstGroups, 'COMPASS_RAW_IMU', 'xmag'), null)

useMavlinkMessageStore.getState().record('RAW_IMU', {
  instance: 0,
  units: 'raw',
  xacc: 100,
  yacc: 200,
  zacc: 300,
  xgyro: 10,
  ygyro: 20,
  zgyro: 30,
  xmag: 2_048,
  ymag: -512,
  zmag: 1_024,
  temperature: 32,
}, 12_000)
const secondGroups = buildGroups(
  useTelemetryStore.getState(),
  useSensorStore.getState(),
  null,
  useMavlinkMessageStore.getState().messages,
  12_100,
)
assert.equal(entryValue(secondGroups, 'COMPASS_RAW_IMU', 'status'), 'live')
assert.equal(entryValue(secondGroups, 'COMPASS_RAW_IMU', 'xmag'), '2048.0000')
assert.equal(entryValue(secondGroups, 'COMPASS_RAW_IMU', 'fieldStrength'), '2346.2788')

useMavlinkMessageStore.getState().reset()
console.log('StatusVariableBrowser compass groups passed')
