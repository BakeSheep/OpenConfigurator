import assert from 'node:assert/strict'
import type { ImuData } from '../../shared/types'
import { useSensorStore } from './sensorStore'
import { MAG_FIELD_MAX_GAUSS } from '../utils/magInterference'

// ---------------------------------------------------------------------------
// Mag unit tracking + real-time interference advisory. SCALED_IMU/HIGHRES_IMU deliver
// mGauss (units:'normalized'); RAW_IMU delivers raw counts (units:'raw') that
// must never be treated as mGauss. UI writes are throttled, classification is
// debounced, and all state clears on disconnect.
// ---------------------------------------------------------------------------

function imu(overrides: Partial<ImuData> = {}): ImuData {
  return {
    instance: 0,
    units: 'normalized',
    xacc: 0, yacc: 0, zacc: 1,
    xgyro: 0, ygyro: 0, zgyro: 0,
    xmag: 450, ymag: 0, zmag: 0, // 450 mGauss = 0.45 G (healthy)
    temperature: 25,
    ...overrides,
  }
}

function resetStore(): void {
  useSensorStore.getState().markAllOffline()
  useSensorStore.setState({ magData: null, magSource: null, magInterference: null })
}

// -- normalized source is recorded as mgauss and feeds the estimator ----------
resetStore()
let now = 100_000
for (let i = 0; i < 20; i++) {
  useSensorStore.getState().setImu(imu(), 0, 'SCALED_IMU', now + i * 50)
}
assert.equal(useSensorStore.getState().magSource?.unit, 'mgauss')
const healthy = useSensorStore.getState().magInterference
assert.ok(healthy, 'interference advisory should be populated')
assert.ok(Math.abs((healthy?.fieldGauss ?? 0) - 0.45) < 1e-6)
assert.equal(healthy?.warning, false)

// -- RAW_IMU is raw counts: it must NOT be fed to the estimator as mgauss -----
resetStore()
now = 200_000
// Raw counts far larger than any Gauss value; if mistakenly treated as mGauss
// the field would be enormous and warn. It must be marked 'raw' and ignored.
for (let i = 0; i < 20; i++) {
  useSensorStore.getState().setImu(imu({ units: 'raw', xmag: 3200, ymag: 100, zmag: 50 }), 0, 'RAW_IMU', now + i * 50)
}
assert.equal(useSensorStore.getState().magSource?.unit, 'raw')
assert.equal(
  useSensorStore.getState().magInterference,
  null,
  'raw counts must not produce an interference reading',
)

// -- strong interference (high field) warns -----------------------------------
resetStore()
now = 300_000
// 9000 mGauss = 9 G, well above MAX.
for (let i = 0; i < 20; i++) {
  useSensorStore.getState().setImu(imu({ xmag: 9000 }), 0, 'HIGHRES_IMU', now + i * 50)
}
const strong = useSensorStore.getState().magInterference
assert.ok(strong)
assert.ok((strong?.fieldGauss ?? 0) > MAG_FIELD_MAX_GAUSS)
assert.equal(strong?.warning, true)

// -- lower-priority RAW_IMU may still supply the only valid temperature -----
resetStore()
now = 400_000
useSensorStore.getState().setImu(imu({ temperature: null }), 0, 'HIGHRES_IMU', now)
useSensorStore.getState().setImu(
  imu({ units: 'raw', xmag: 100, temperature: 36.5 }),
  0,
  'RAW_IMU',
  now + 20,
)
assert.equal(
  useSensorStore.getState().imus[0]?.temperature,
  36.5,
  'RAW_IMU temperature must survive motion-source arbitration',
)
assert.equal(useSensorStore.getState().sensorHealth.imu, 'ok')
assert.equal(useSensorStore.getState().lastUpdate.imu, now + 20)

// A valid lower-priority frame still proves the sensor is live even when its
// motion fields are intentionally not allowed to replace HIGHRES_IMU.
useSensorStore.setState((state) => ({
  sensorHealth: { ...state.sensorHealth, imu: 'offline', mag: 'offline' },
  lastUpdate: { ...state.lastUpdate, imu: 0 },
}))
useSensorStore.getState().setImu(
  imu({ units: 'raw', temperature: null }),
  0,
  'RAW_IMU',
  now + 40,
)
assert.equal(useSensorStore.getState().sensorHealth.imu, 'ok')
assert.equal(useSensorStore.getState().sensorHealth.mag, 'ok')
assert.equal(useSensorStore.getState().lastUpdate.imu, now + 40)

// -- disconnect clears the advisory and window --------------------------------
useSensorStore.getState().markAllOffline()
assert.equal(useSensorStore.getState().magInterference, null)
assert.equal(useSensorStore.getState().magSource, null)

// Legacy RANGEFINDER has no min/max or signal quality fields. A positive live
// distance is valid and must not be rejected because those values are absent.
useSensorStore.getState().setDistanceSensor({
  source: 'RANGEFINDER',
  current_distance: 123,
  min_distance: 0,
  max_distance: 0,
  signal_quality: null,
  type: 0,
  id: 0,
  orientation: 25,
})
assert.equal(useSensorStore.getState().sensorHealth.rangefinder, 'ok')
assert.equal(useSensorStore.getState().distanceSensor?.current_distance, 123)

console.log('sensorStore mag interference checks passed')
