// One-off: generate a realistic multi-topic PX4 ULog for manual UI
// verification of the corrected log-analysis workspace. Writes .tmp-verify/demo.ulg.
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { UlogFixtureBuilder } from '../src/web/log-analysis/testing/ulogFixtureBuilder.ts'

const SEC = 1_000_000
const b = new UlogFixtureBuilder()

b.addFormat(100, 'vehicle_attitude', [
  { type: 'uint64_t', fieldName: 'timestamp' },
  { type: 'float[4]', fieldName: 'q' },
])
b.addFormat(101, 'vehicle_attitude_setpoint', [
  { type: 'uint64_t', fieldName: 'timestamp' },
  { type: 'float[4]', fieldName: 'q_d' },
])
b.addFormat(102, 'vehicle_status', [
  { type: 'uint64_t', fieldName: 'timestamp' },
  { type: 'uint8_t', fieldName: 'arming_state' },
  { type: 'uint8_t', fieldName: 'nav_state' },
])
b.addFormat(103, 'actuator_motors', [
  { type: 'uint64_t', fieldName: 'timestamp' },
  { type: 'float[12]', fieldName: 'control' },
])
b.addFormat(104, 'vehicle_angular_velocity', [
  { type: 'uint64_t', fieldName: 'timestamp' },
  { type: 'float[3]', fieldName: 'xyz' },
])
b.addFormat(105, 'vehicle_rates_setpoint', [
  { type: 'uint64_t', fieldName: 'timestamp' },
  { type: 'float', fieldName: 'roll' },
  { type: 'float', fieldName: 'pitch' },
  { type: 'float', fieldName: 'yaw' },
])
b.addFormat(120, 'sensor_combined', [
  { type: 'uint64_t', fieldName: 'timestamp' },
  { type: 'float[3]', fieldName: 'gyro_rad' },
  { type: 'float[3]', fieldName: 'accelerometer_m_s2' },
  { type: 'uint8_t', fieldName: 'accelerometer_clipping' },
  { type: 'uint8_t', fieldName: 'gyro_clipping' },
])
b.addFormat(121, 'sensor_mag', [
  { type: 'uint64_t', fieldName: 'timestamp' },
  { type: 'float', fieldName: 'x' },
  { type: 'float', fieldName: 'y' },
  { type: 'float', fieldName: 'z' },
])
b.addFormat(122, 'sensor_baro', [
  { type: 'uint64_t', fieldName: 'timestamp' },
  { type: 'float', fieldName: 'pressure' },
  { type: 'float', fieldName: 'temperature' },
])
b.addFormat(123, 'battery_status', [
  { type: 'uint64_t', fieldName: 'timestamp' },
  { type: 'float', fieldName: 'voltage_v' },
  { type: 'float', fieldName: 'current_a' },
  { type: 'uint8_t', fieldName: 'cell_count' },
])
b.addFormat(130, 'vehicle_gps_position', [
  { type: 'uint64_t', fieldName: 'timestamp' },
  { type: 'uint8_t', fieldName: 'fix_type' },
  { type: 'uint8_t', fieldName: 'satellites_used' },
  { type: 'float', fieldName: 'eph' },
  { type: 'float', fieldName: 'epv' },
])
b.addFormat(140, 'estimator_status', [
  { type: 'uint64_t', fieldName: 'timestamp' },
  { type: 'float', fieldName: 'pos_test_ratio' },
  { type: 'float', fieldName: 'vel_test_ratio' },
])

for (const [msgId, multiId] of [
  [100, 0], [101, 0], [102, 0], [103, 0], [104, 0], [105, 0],
  [120, 0], [121, 0], [122, 0], [123, 0], [130, 0], [140, 0],
]) {
  b.addSubscription(msgId, multiId)
}
b.addParameter('CA_ROTOR_COUNT', 4)
b.addInformation('sys_name', 'PX4')
b.addInformation('ver_hw', 'PIXHAWK_V6X')

const duration = 120
const armedStart = 8
const armedEnd = 112

for (let t = 0; t <= duration; t++) {
  const armed = t >= armedStart && t < armedEnd
  b.addData(102, BigInt(t * SEC), {
    timestamp: t * SEC,
    arming_state: armed ? 2 : 1,
    nav_state: t < 20 ? 2 : t < 90 ? 3 : 5,
  })
  b.addData(123, BigInt(t * SEC), {
    timestamp: t * SEC,
    voltage_v: 12.6 - t * 0.01,
    current_a: 8 + 3 * Math.abs(Math.sin(t / 5)),
    cell_count: 3,
  })
  b.addData(130, BigInt(t * SEC), {
    timestamp: t * SEC,
    fix_type: t < 4 ? 1 : 3,
    satellites_used: t < 4 ? 3 : 14,
    eph: t < 4 ? 8 : 0.9,
    epv: t < 4 ? 12 : 1.4,
  })
  b.addData(140, BigInt(t * SEC), {
    timestamp: t * SEC,
    pos_test_ratio: 0.2 + 0.05 * Math.sin(t / 8),
    vel_test_ratio: 0.3 + 0.05 * Math.cos(t / 6),
  })
}

for (let i = 0; i <= duration * 20; i++) {
  const t = i / 20
  const armed = t >= armedStart && t < armedEnd
  const roll = 0.08 * Math.sin(t / 2)
  const rollSp = 0.08 * Math.sin(t / 2 + 0.15)
  b.addData(100, BigInt(Math.round(t * SEC)), {
    timestamp: Math.round(t * SEC),
    'q[0]': Math.cos(roll / 2), 'q[1]': Math.sin(roll / 2), 'q[2]': 0, 'q[3]': 0,
  })
  b.addData(101, BigInt(Math.round(t * SEC)), {
    timestamp: Math.round(t * SEC),
    'q_d[0]': Math.cos(rollSp / 2), 'q_d[1]': Math.sin(rollSp / 2), 'q_d[2]': 0, 'q_d[3]': 0,
  })
  b.addData(104, BigInt(Math.round(t * SEC)), {
    timestamp: Math.round(t * SEC),
    'xyz[0]': 0.1 * Math.sin(t), 'xyz[1]': 0.1 * Math.cos(t), 'xyz[2]': 0.02,
  })
  b.addData(105, BigInt(Math.round(t * SEC)), {
    timestamp: Math.round(t * SEC),
    roll: 0.1 * Math.sin(t + 0.1), pitch: 0.1 * Math.cos(t), yaw: 0.01,
  })
  const motor = { timestamp: Math.round(t * SEC) }
  for (let ch = 0; ch < 12; ch++) {
    motor[`control[${ch}]`] = armed && ch < 4 ? 0.45 + 0.1 * Math.sin(t + ch) : NaN
  }
  b.addData(103, BigInt(Math.round(t * SEC)), motor)
}

for (let i = 0; i <= duration * 50; i++) {
  const t = i / 50
  b.addData(120, BigInt(Math.round(t * SEC)), {
    timestamp: Math.round(t * SEC),
    'gyro_rad[0]': 0.01 * Math.sin(t * 3), 'gyro_rad[1]': 0.01 * Math.cos(t * 3), 'gyro_rad[2]': 0.004,
    'accelerometer_m_s2[0]': 0.15 * Math.sin(t * 2), 'accelerometer_m_s2[1]': 0.12 * Math.cos(t * 2), 'accelerometer_m_s2[2]': -9.81,
    accelerometer_clipping: 0, gyro_clipping: 0,
  })
}
for (let i = 0; i <= duration * 10; i++) {
  const t = i / 10
  b.addData(121, BigInt(Math.round(t * SEC)), {
    timestamp: Math.round(t * SEC), x: 0.22, y: 0.05, z: 0.41,
  })
  b.addData(122, BigInt(Math.round(t * SEC)), {
    timestamp: Math.round(t * SEC), pressure: 101_325 - t * 2, temperature: 25 + t * 0.01,
  })
}

const buffer = b.build()
const outDir = resolve('.tmp-verify')
mkdirSync(outDir, { recursive: true })
const outFile = resolve(outDir, 'demo.ulg')
writeFileSync(outFile, Buffer.from(buffer))
console.log(`Wrote ${outFile} (${buffer.byteLength} bytes)`)
