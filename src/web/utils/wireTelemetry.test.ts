import assert from 'node:assert/strict'
import test from 'node:test'
import {
  parseBatteryData,
  parseGpsData,
  parseImuData,
  parseOpticalFlowData,
} from './wireTelemetry'

test('wire telemetry rejects malformed and non-finite fields', () => {
  assert.equal(parseGpsData({ fix_type: 3, lat: 'bad', lon: 1, alt: 2 }), null)
  assert.equal(parseImuData({
    xacc: Number.NaN, yacc: 0, zacc: 1, xgyro: 0, ygyro: 0, zgyro: 0,
    xmag: 0, ymag: 0, zmag: 0, temperature: null,
  }), null)
  assert.equal(parseBatteryData({
    id: 0, voltage: 12, cell_voltages: [4, undefined], current: null,
    remaining: null, consumed_mah: null,
  }), null)
})

test('wire telemetry preserves valid nullable values', () => {
  assert.deepEqual(parseBatteryData({
    id: 2, voltage: null, cell_voltages: [4.1, null], current: null,
    remaining: 80, consumed_mah: 120,
  }), {
    id: 2, voltage: null, cell_voltages: [4.1, null], current: null,
    remaining: 80, consumed_mah: 120,
  })

  const optical = parseOpticalFlowData({
    source: 'OPTICAL_FLOW_RAD', integration_time_us: 10, integrated_x_rad: 0.1,
    integrated_y_rad: 0.2, integrated_xgyro_rad: null, integrated_ygyro_rad: null,
    integrated_zgyro_rad: null, temperature_c: null, time_delta_distance_us: 0,
    distance_m: null, flow_x: 0.1, flow_y: 0.2, flow_comp_m_x: null,
    flow_comp_m_y: null, quality: 100, ground_distance: null, sensor_id: 1,
  })
  assert.equal(optical?.source, 'OPTICAL_FLOW_RAD')
  assert.equal(optical?.distance_m, null)
})
