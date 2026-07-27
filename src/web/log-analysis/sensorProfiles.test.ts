import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  resolveVectors,
  resolveScalars,
  decodeClippingBits,
} from './px4/sensorProfiles.js'
import { StreamingSeriesCollector } from '../utils/ulogAnalysis.js'

describe('resolveVectors – semantic field selection', () => {
  it('selects accelerometer_m_s2 and gyro_rad from sensor_combined', () => {
    const fields = new Set([
      'timestamp',
      'gyro_rad[0]', 'gyro_rad[1]', 'gyro_rad[2]',
      'gyro_integral_dt',
      'accelerometer_timestamp_relative',
      'accelerometer_m_s2[0]', 'accelerometer_m_s2[1]', 'accelerometer_m_s2[2]',
      'accelerometer_integral_dt',
      'accelerometer_clipping', 'gyro_clipping',
    ])
    const vectors = resolveVectors('sensor_combined', fields)
    assert.equal(vectors.length, 2)
    const accel = vectors.find((v) => v.kind === 'acceleration')!
    const gyro = vectors.find((v) => v.kind === 'angularRate')!
    assert.deepEqual(accel.fields, ['accelerometer_m_s2[0]', 'accelerometer_m_s2[1]', 'accelerometer_m_s2[2]'])
    assert.equal(accel.unit, 'm/s²')
    assert.deepEqual(gyro.fields, ['gyro_rad[0]', 'gyro_rad[1]', 'gyro_rad[2]'])
    assert.equal(gyro.unit, 'rad/s')
  })

  it('never falls back to "first three numeric fields"', () => {
    // sensor_combined with the integral/clipping fields FIRST — a naive
    // Object.keys().slice(0,3) would pick those; profiles must not.
    const fields = new Set([
      'gyro_integral_dt', 'accelerometer_integral_dt', 'accelerometer_clipping',
    ])
    const vectors = resolveVectors('sensor_combined', fields)
    assert.equal(vectors.length, 0, 'incomplete triplets must resolve to nothing')
  })

  it('selects x/y/z from modern sensor_accel and xyz[] from older logs', () => {
    const modern = resolveVectors('sensor_accel', new Set(['timestamp', 'x', 'y', 'z', 'temperature']))
    assert.equal(modern.length, 1)
    assert.deepEqual(modern[0]!.fields, ['x', 'y', 'z'])

    const older = resolveVectors('sensor_accel', new Set(['timestamp', 'xyz[0]', 'xyz[1]', 'xyz[2]']))
    assert.equal(older.length, 1)
    assert.deepEqual(older[0]!.fields, ['xyz[0]', 'xyz[1]', 'xyz[2]'])
  })

  it('prefers x/y/z over xyz[] when both exist', () => {
    const both = resolveVectors('sensor_accel', new Set(['x', 'y', 'z', 'xyz[0]', 'xyz[1]', 'xyz[2]']))
    assert.deepEqual(both[0]!.fields, ['x', 'y', 'z'])
  })

  it('resolves magnetometer fields with the profile unit', () => {
    const mag = resolveVectors('sensor_mag', new Set(['x', 'y', 'z']))
    assert.equal(mag.length, 1)
    assert.equal(mag[0]!.kind, 'magneticField')
    assert.equal(mag[0]!.unit, 'Gs')

    const older = resolveVectors('sensor_mag', new Set(['magnetometer_ga[0]', 'magnetometer_ga[1]', 'magnetometer_ga[2]']))
    assert.deepEqual(older[0]!.fields, ['magnetometer_ga[0]', 'magnetometer_ga[1]', 'magnetometer_ga[2]'])
  })

  it('unknown topics resolve to nothing', () => {
    assert.deepEqual(resolveVectors('some_topic', new Set(['x', 'y', 'z'])), [])
  })
})

describe('resolveScalars – explicit units per measurement', () => {
  it('resolves sensor_baro pressure and temperature separately', () => {
    const scalars = resolveScalars('sensor_baro', new Set(['timestamp', 'pressure', 'temperature']))
    assert.equal(scalars.length, 2)
    const pressure = scalars.find((s) => s.kind === 'pressure')!
    const temperature = scalars.find((s) => s.kind === 'temperature')!
    assert.equal(pressure.field, 'pressure')
    assert.equal(pressure.unit, 'Pa')
    assert.equal(temperature.unit, '°C')
  })

  it('resolves vehicle_air_data pressure/altitude/temperature with official fields', () => {
    const scalars = resolveScalars('vehicle_air_data', new Set([
      'baro_pressure_pa', 'baro_alt_meter', 'baro_temp_celcius',
    ]))
    assert.equal(scalars.length, 3)
    assert.equal(scalars.find((s) => s.kind === 'altitude')!.field, 'baro_alt_meter')
    assert.equal(scalars.find((s) => s.kind === 'altitude')!.unit, 'm')
  })

  it('missing fields simply resolve to fewer scalars, never zero-filled', () => {
    const scalars = resolveScalars('sensor_baro', new Set(['pressure']))
    assert.equal(scalars.length, 1)
    assert.equal(scalars[0]!.kind, 'pressure')
  })
})

describe('decodeClippingBits', () => {
  it('decodes per-axis clipping bits', () => {
    assert.deepEqual(decodeClippingBits(0), [false, false, false])
    assert.deepEqual(decodeClippingBits(1), [true, false, false])
    assert.deepEqual(decodeClippingBits(2), [false, true, false])
    assert.deepEqual(decodeClippingBits(4), [false, false, true])
    assert.deepEqual(decodeClippingBits(7), [true, true, true])
  })
})

describe('StreamingSeriesCollector – full-log bounded downsampling', () => {
  it('covers the complete time range, not just the first N samples', () => {
    const collector = new StreamingSeriesCollector(200)
    const n = 10_000
    for (let i = 0; i <= n; i++) {
      collector.push(i / 100, Math.sin(i / 50))
    }
    const { times } = collector.toSeries()
    assert.ok(times.length <= 500, `bounded output, got ${times.length}`)
    assert.equal(times[0], 0, 'first point preserved')
    assert.ok(times[times.length - 1]! >= n / 100 * 0.999, 'last point preserved')
  })

  it('preserves extrema (a spike near the end survives downsampling)', () => {
    const collector = new StreamingSeriesCollector(100)
    const n = 50_000
    for (let i = 0; i <= n; i++) {
      // Flat signal with one huge spike at 99% of the log
      collector.push(i / 1000, i === Math.floor(n * 0.99) ? 42 : 0.5)
    }
    const { values } = collector.toSeries()
    assert.ok(values.includes(42), 'spike must survive envelope downsampling')
  })

  it('marks NaN stretches as gaps', () => {
    const collector = new StreamingSeriesCollector(1000)
    for (let i = 0; i < 300; i++) {
      collector.push(i / 10, i >= 100 && i < 200 ? NaN : 1.0)
    }
    const result = collector.toSeries()
    assert.equal(result.hasGaps, true)
    assert.ok(result.values.some((v) => Number.isNaN(v)), 'gap markers break the line')
  })

  it('passes small series through losslessly', () => {
    const collector = new StreamingSeriesCollector(2000)
    for (let i = 0; i < 10; i++) collector.push(i, i * 2)
    const { times, values } = collector.toSeries()
    assert.equal(times.length, 10)
    assert.deepEqual(values, times.map((t) => t * 2))
  })
})
