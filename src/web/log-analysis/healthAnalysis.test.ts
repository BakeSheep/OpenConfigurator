import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { UlogFixtureBuilder } from './testing/ulogFixtureBuilder.js'
import { UlogDocument } from './parser/UlogDocument.js'
import { ModuleRegistry } from './engine/moduleRegistry.js'
import { runAnalysis } from './engine/runAnalysis.js'
import { estimatorModule } from './modules/estimator.js'
import {
  sensorsModule,
  periodogram,
  analyzeVibration,
  AdaptiveGapDetector,
  FullLogVibrationCollector,
} from './modules/sensors.js'
import { failsafeModule } from './modules/failsafe.js'
import { systemHealthModule } from './modules/systemHealth.js'

// ─── Helper: build registry and run analysis ────────────────────────────────

function createRegistry(): ModuleRegistry {
  const registry = new ModuleRegistry()
  registry.register(estimatorModule)
  registry.register(sensorsModule)
  registry.register(failsafeModule)
  registry.register(systemHealthModule)
  return registry
}

async function analyzeBuffer(buf: ArrayBuffer) {
  const doc = await UlogDocument.open(buf)
  const registry = createRegistry()
  const result = await runAnalysis(doc, registry)
  return { doc, result }
}

/** Metrics of one module inside a merged section result. */
function moduleMetrics(
  section: { moduleResults: Array<{ moduleId: string; metrics: Record<string, unknown> }> },
  moduleId: string,
): Record<string, unknown> {
  return section.moduleResults.find((m) => m.moduleId === moduleId)?.metrics ?? {}
}

/** All chart views across a section's chart families. */
function sectionViews(section: { chartFamilies: Array<{ views: Array<{ id: string; unit: string }> }> }) {
  return section.chartFamilies.flatMap((f) => f.views)
}

// ─── Periodogram unit tests ─────────────────────────────────────────────────

describe('periodogram', () => {
  it('detects correct peak frequency for a pure sine wave', () => {
    const sampleRate = 256 // Hz — power of 2 for clean DFT bins
    const duration = 1.0 // second
    const N = Math.floor(sampleRate * duration)
    const freq = 20 // Hz — exact bin: k=20*256/256=20 → bin index 20
    const signal: number[] = []
    for (let i = 0; i < N; i++) {
      signal.push(Math.sin(2 * Math.PI * freq * i / sampleRate))
    }

    const { frequencies, power } = periodogram(signal, sampleRate)
    assert.ok(frequencies.length > 0, 'should produce frequency bins')

    // Find peak
    let peakIdx = 0
    let peakPower = 0
    for (let i = 0; i < power.length; i++) {
      if (power[i]! > peakPower) {
        peakPower = power[i]!
        peakIdx = i
      }
    }

    const peakFreq = frequencies[peakIdx]!
    assert.ok(
      Math.abs(peakFreq - freq) < sampleRate / N,
      `Peak frequency ${peakFreq.toFixed(1)} Hz should be within 1 bin of ${freq} Hz`,
    )
  })

  it('returns accurate amplitude for a known sine wave', () => {
    const sampleRate = 256
    const N = 256
    const amplitude = 2.0
    const freq = 10 // Hz
    const signal: number[] = []
    for (let i = 0; i < N; i++) {
      signal.push(amplitude * Math.sin(2 * Math.PI * freq * i / sampleRate))
    }

    const { frequencies, power } = periodogram(signal, sampleRate)

    // Find the amplitude at the signal frequency
    let peakAmplitude = 0
    for (let i = 0; i < power.length; i++) {
      const amp = Math.sqrt(power[i]!)
      if (amp > peakAmplitude) peakAmplitude = amp
    }

    // The Hann window reduces peak amplitude slightly, but it should be
    // within ~50% of the true amplitude (theoretical Hann loss is ~1.5 dB)
    assert.ok(
      peakAmplitude > amplitude * 0.4 && peakAmplitude < amplitude * 1.5,
      `Peak amplitude ${peakAmplitude.toFixed(3)} should be close to ${amplitude}`,
    )
  })

  it('returns empty arrays for trivial input', () => {
    const { frequencies, power } = periodogram([], 100)
    assert.equal(frequencies.length, 0)
    assert.equal(power.length, 0)
  })
})

// ─── analyzeVibration tests ─────────────────────────────────────────────────

describe('analyzeVibration', () => {
  it('returns null for too few samples', () => {
    const samples = Array.from({ length: 10 }, (_, i) => ({
      timeSec: i * 0.01,
      value: Math.sin(i),
    }))
    const result = analyzeVibration(samples)
    assert.equal(result, null)
  })

  it('detects vibration peak frequency and amplitude', () => {
    const sampleRate = 250
    const duration = 1.0
    const N = Math.floor(sampleRate * duration)
    const vibFreq = 30 // Hz
    const vibAmplitude = 3.0
    const samples: Array<{ timeSec: number; value: number }> = []
    for (let i = 0; i < N; i++) {
      samples.push({
        timeSec: i / sampleRate,
        value: vibAmplitude * Math.sin(2 * Math.PI * vibFreq * i / sampleRate),
      })
    }

    const result = analyzeVibration(samples, sampleRate)
    assert.ok(result, 'should return a result')
    assert.ok(
      Math.abs(result.peakFrequencyHz - vibFreq) < 5,
      `Peak frequency ${result.peakFrequencyHz.toFixed(1)} should be near ${vibFreq} Hz`,
    )
    assert.ok(result.peakAmplitude > 0, 'peak amplitude should be positive')
  })

  it('splits at gaps and processes each window', () => {
    const sampleRate = 250
    const samples: Array<{ timeSec: number; value: number }> = []
    // First window: 0.5s at 30 Hz
    for (let i = 0; i < 125; i++) {
      samples.push({
        timeSec: i / sampleRate,
        value: 2.0 * Math.sin(2 * Math.PI * 30 * i / sampleRate),
      })
    }
    // Gap of 0.2s
    // Second window: 0.5s at 30 Hz
    const gapStart = 0.5 + 0.2
    for (let i = 0; i < 125; i++) {
      samples.push({
        timeSec: gapStart + i / sampleRate,
        value: 2.0 * Math.sin(2 * Math.PI * 30 * i / sampleRate),
      })
    }

    const result = analyzeVibration(samples, sampleRate)
    assert.ok(result, 'should return a result even with gap')
    assert.ok(
      Math.abs(result.peakFrequencyHz - 30) < 5,
      `Peak frequency ${result.peakFrequencyHz.toFixed(1)} should be near 30 Hz`,
    )
  })
})

// ─── Adaptive sensor cadence and full-log vibration regressions ─────────────

describe('AdaptiveGapDetector', () => {
  it('does not flag a stable 10 Hz magnetometer or barometer as gaps', () => {
    const detector = new AdaptiveGapDetector()
    let gaps = 0
    for (let i = 0; i < 200; i++) {
      if (detector.push(i * 0.1)) gaps++
    }
    assert.equal(gaps, 0)
    assert.ok(Math.abs(detector.medianIntervalSec! - 0.1) < 1e-9)
  })

  it('flags intervals far beyond the learned cadence without poisoning it', () => {
    const detector = new AdaptiveGapDetector()
    let time = 0
    for (let i = 0; i < 20; i++) {
      detector.push(time)
      time += 0.01
    }
    assert.equal(detector.push(time + 0.2), true)
    assert.ok(Math.abs(detector.medianIntervalSec! - 0.01) < 1e-9)
  })
})

describe('FullLogVibrationCollector', () => {
  it('detects vibration that begins after the former 10000-sample cutoff', () => {
    const sampleRate = 200
    const collector = new FullLogVibrationCollector(1024)
    for (let i = 0; i < 12_000; i++) collector.push(i / sampleRate, 0)
    for (let i = 12_000; i < 16_096; i++) {
      collector.push(i / sampleRate, 8 * Math.sin(2 * Math.PI * 42 * i / sampleRate))
    }
    const result = collector.finish()
    assert.ok(result)
    assert.ok(Math.abs(result.peakFrequencyHz - 42) < 3, `peak=${result.peakFrequencyHz}`)
    assert.ok(result.peakAmplitude > 3, `amplitude=${result.peakAmplitude}`)
    assert.equal(collector.sampleCount, 16_096)
  })
})
// ─── Estimator module tests ─────────────────────────────────────────────────

describe('estimator module', () => {
  it('processes estimator_status with multi-instance', async () => {
    const buf = new UlogFixtureBuilder()
      .addFormat(200, 'estimator_status', [
        { type: 'uint64_t', fieldName: 'timestamp' },
        { type: 'float', fieldName: 'pos_test_ratio' },
        { type: 'float', fieldName: 'vel_test_ratio' },
        { type: 'float', fieldName: 'hagl_test_ratio' },
        { type: 'uint32_t', fieldName: 'filter_fault_flags' },
        { type: 'uint8_t', fieldName: 'dead_reckoning' },
      ])
      .addFormat(201, 'estimator_status', [
        { type: 'uint64_t', fieldName: 'timestamp' },
        { type: 'float', fieldName: 'pos_test_ratio' },
        { type: 'float', fieldName: 'vel_test_ratio' },
        { type: 'float', fieldName: 'hagl_test_ratio' },
        { type: 'uint32_t', fieldName: 'filter_fault_flags' },
        { type: 'uint8_t', fieldName: 'dead_reckoning' },
      ])
      .addSubscription(200, 0)
      .addSubscription(201, 1)
      // Instance 0: high innovation ratio, no faults
      .addData(200, 1_000_000n, {
        timestamp: 1_000_000,
        pos_test_ratio: 1.5,
        vel_test_ratio: 0.3,
        hagl_test_ratio: 0.2,
        filter_fault_flags: 0,
        dead_reckoning: 0,
      })
      // Instance 1: normal ratios, filter fault
      .addData(201, 1_000_000n, {
        timestamp: 1_000_000,
        pos_test_ratio: 0.1,
        vel_test_ratio: 0.2,
        hagl_test_ratio: 0.1,
        filter_fault_flags: 3,
        dead_reckoning: 0,
      })
      .build()

    const { result } = await analyzeBuffer(buf)
    const estimatorSection = result.sections['estimator']
    assert.ok(estimatorSection, 'estimator section should exist')
    assert.ok(
      estimatorSection.moduleResults.some((m) => m.moduleId === 'estimator'),
      'estimator module identity is preserved in moduleResults',
    )

    // Should have findings for high test ratio and filter fault
    const highRatioFindings = estimatorSection.findings.filter(f =>
      f.title.includes('新息检验比过高')
    )
    assert.ok(highRatioFindings.length > 0, 'should detect high test ratio')

    const faultFindings = estimatorSection.findings.filter(f =>
      f.title.includes('滤波器故障')
    )
    assert.ok(faultFindings.length > 0, 'should detect filter fault')
    assert.equal(faultFindings[0]!.severity, 'critical')
  })

  it('detects dead reckoning periods', async () => {
    const buf = new UlogFixtureBuilder()
      .addFormat(200, 'estimator_status', [
        { type: 'uint64_t', fieldName: 'timestamp' },
        { type: 'float', fieldName: 'pos_test_ratio' },
        { type: 'uint32_t', fieldName: 'filter_fault_flags' },
        { type: 'uint8_t', fieldName: 'dead_reckoning' },
      ])
      .addSubscription(200, 0)
      .addData(200, 1_000_000n, {
        timestamp: 1_000_000,
        pos_test_ratio: 0.1,
        filter_fault_flags: 0,
        dead_reckoning: 1,
      })
      .addData(200, 3_000_000n, {
        timestamp: 3_000_000,
        pos_test_ratio: 0.1,
        filter_fault_flags: 0,
        dead_reckoning: 1,
      })
      .addData(200, 5_000_000n, {
        timestamp: 5_000_000,
        pos_test_ratio: 0.1,
        filter_fault_flags: 0,
        dead_reckoning: 0,
      })
      .build()

    const { result } = await analyzeBuffer(buf)
    const estimatorSection = result.sections['estimator']
    assert.ok(estimatorSection, 'estimator section should exist')

    const drFindings = estimatorSection.findings.filter(f =>
      f.title.includes('航位推算')
    )
    assert.ok(drFindings.length > 0, 'should detect dead reckoning')
  })

  it('handles ekf2_innovations alias', async () => {
    const buf = new UlogFixtureBuilder()
      .addFormat(200, 'ekf2_innovations', [
        { type: 'uint64_t', fieldName: 'timestamp' },
        { type: 'float', fieldName: 'pos_test_ratio' },
        { type: 'uint32_t', fieldName: 'filter_fault_flags' },
        { type: 'uint8_t', fieldName: 'dead_reckoning' },
      ])
      .addSubscription(200, 0)
      .addData(200, 1_000_000n, {
        timestamp: 1_000_000,
        pos_test_ratio: 0.5,
        filter_fault_flags: 0,
        dead_reckoning: 0,
      })
      .build()

    const { result } = await analyzeBuffer(buf)
    const estimatorSection = result.sections['estimator']
    assert.ok(estimatorSection, 'estimator section should exist with ekf2_innovations alias')
  })
})

// ─── Sensors module tests ───────────────────────────────────────────────────

describe('sensors module', () => {
  it('processes multi-instance accel data', async () => {
    const buf = new UlogFixtureBuilder()
      .addFormat(300, 'sensor_accel', [
        { type: 'uint64_t', fieldName: 'timestamp' },
        { type: 'float[3]', fieldName: 'xyz' },
        { type: 'float', fieldName: 'temperature' },
      ])
      .addFormat(301, 'sensor_accel', [
        { type: 'uint64_t', fieldName: 'timestamp' },
        { type: 'float[3]', fieldName: 'xyz' },
        { type: 'float', fieldName: 'temperature' },
      ])
      .addSubscription(300, 0)
      .addSubscription(301, 1)
      .addData(300, 1_000_000n, {
        timestamp: 1_000_000,
        'xyz[0]': 0.1,
        'xyz[1]': 0.2,
        'xyz[2]': 9.81,
        temperature: 35.0,
      })
      .addData(301, 1_000_000n, {
        timestamp: 1_000_000,
        'xyz[0]': 1.5,
        'xyz[1]': 2.0,
        'xyz[2]': 9.5,
        temperature: 40.0,
      })
      .build()

    const { result } = await analyzeBuffer(buf)
    const sensorsSection = result.sections['sensors-power']
    assert.ok(sensorsSection, 'sensors-power section should exist')
    assert.ok(
      moduleMetrics(sensorsSection, 'sensors')['accelInstanceCount'] === 2,
      'should detect 2 accel instances',
    )
    const imuFamily = sensorsSection.chartFamilies.find((family) => family.id === 'imu')
    assert.ok(imuFamily)
    assert.ok(imuFamily.views.some((view) => view.id === 'accel-0'), 'instance 0 remains selectable')
    assert.ok(imuFamily.views.some((view) => view.id === 'accel-1'), 'instance 1 remains selectable')
  })

  it('does not report stable 10 Hz barometer samples as gaps', async () => {
    const builder = new UlogFixtureBuilder()
      .addFormat(302, 'sensor_baro', [
        { type: 'uint64_t', fieldName: 'timestamp' },
        { type: 'float', fieldName: 'pressure' },
        { type: 'float', fieldName: 'temperature' },
      ])
      .addSubscription(302, 0)

    for (let i = 0; i < 200; i++) {
      const timestamp = 1_000_000 + i * 100_000
      builder.addData(302, BigInt(timestamp), {
        timestamp,
        pressure: 101_325,
        temperature: 25,
      })
    }

    const { result } = await analyzeBuffer(builder.build())
    const findings = result.sections['sensors-power']?.findings ?? []
    assert.equal(findings.filter((finding) => finding.id.endsWith('-gaps')).length, 0)
  })

  it('detects clipping events', async () => {
    const buf = new UlogFixtureBuilder()
      .addFormat(300, 'sensor_accel', [
        { type: 'uint64_t', fieldName: 'timestamp' },
        { type: 'float[3]', fieldName: 'xyz' },
        { type: 'uint16_t', fieldName: 'clip_counter' },
      ])
      .addSubscription(300, 0)
      .addData(300, 1_000_000n, {
        timestamp: 1_000_000,
        'xyz[0]': 0.1,
        'xyz[1]': 0.2,
        'xyz[2]': 9.81,
        clip_counter: 5,
      })
      .build()

    const { result } = await analyzeBuffer(buf)
    const sensorsSection = result.sections['sensors-power']
    assert.ok(sensorsSection, 'sensors-power section should exist')

    const clipFindings = sensorsSection.findings.filter(f =>
      f.title.includes('削波')
    )
    assert.ok(clipFindings.length > 0, 'should detect clipping')
    assert.equal(clipFindings[0]!.severity, 'warning')
  })

  it('detects instance inconsistency', async () => {
    const buf = new UlogFixtureBuilder()
      .addFormat(300, 'sensor_accel', [
        { type: 'uint64_t', fieldName: 'timestamp' },
        { type: 'float[3]', fieldName: 'xyz' },
      ])
      .addFormat(301, 'sensor_accel', [
        { type: 'uint64_t', fieldName: 'timestamp' },
        { type: 'float[3]', fieldName: 'xyz' },
      ])
      .addSubscription(300, 0)
      .addSubscription(301, 1)
      // Instance 0: normal values
      .addData(300, 1_000_000n, {
        timestamp: 1_000_000,
        'xyz[0]': 0.1,
        'xyz[1]': 0.2,
        'xyz[2]': 9.81,
      })
      // Instance 1: very different values
      .addData(301, 1_000_000n, {
        timestamp: 1_000_000,
        'xyz[0]': 5.0,
        'xyz[1]': 5.0,
        'xyz[2]': 5.0,
      })
      .build()

    const { result } = await analyzeBuffer(buf)
    const sensorsSection = result.sections['sensors-power']
    assert.ok(sensorsSection, 'sensors-power section should exist')

    const inconsistencyFindings = sensorsSection.findings.filter(f =>
      f.title.includes('不一致')
    )
    assert.ok(inconsistencyFindings.length > 0, 'should detect instance inconsistency')
  })

  it('handles sensor_combined topic', async () => {
    const buf = new UlogFixtureBuilder()
      .addFormat(300, 'sensor_combined', [
        { type: 'uint64_t', fieldName: 'timestamp' },
        { type: 'float[3]', fieldName: 'accelerometer_m_s2' },
        { type: 'float[3]', fieldName: 'gyro_rad' },
      ])
      .addSubscription(300, 0)
      .addData(300, 1_000_000n, {
        timestamp: 1_000_000,
        'accelerometer_m_s2[0]': 0.1,
        'accelerometer_m_s2[1]': 0.2,
        'accelerometer_m_s2[2]': 9.8,
        'gyro_rad[0]': 0.01,
        'gyro_rad[1]': 0.02,
        'gyro_rad[2]': 0.03,
      })
      .build()

    const { result } = await analyzeBuffer(buf)
    const sensorsSection = result.sections['sensors-power']
    assert.ok(sensorsSection, 'sensors-power section should exist')
    assert.ok(
      (moduleMetrics(sensorsSection, 'sensors')['combinedSamples'] as number) > 0,
      'should have combined samples',
    )
  })
})

// ─── Failsafe module tests ──────────────────────────────────────────────────

describe('failsafe module', () => {
  it('detects RC loss transitions', async () => {
    const buf = new UlogFixtureBuilder()
      .addFormat(400, 'failsafe', [
        { type: 'uint64_t', fieldName: 'timestamp' },
        { type: 'uint8_t', fieldName: 'failsafe_active' },
        { type: 'uint8_t', fieldName: 'rc_loss' },
        { type: 'uint8_t', fieldName: 'data_link_lost' },
      ])
      .addSubscription(400, 0)
      // Normal state
      .addData(400, 1_000_000n, {
        timestamp: 1_000_000,
        failsafe_active: 0,
        rc_loss: 0,
        data_link_lost: 0,
      })
      // RC loss starts
      .addData(400, 2_000_000n, {
        timestamp: 2_000_000,
        failsafe_active: 1,
        rc_loss: 1,
        data_link_lost: 0,
      })
      // RC loss ends
      .addData(400, 3_000_000n, {
        timestamp: 3_000_000,
        failsafe_active: 0,
        rc_loss: 0,
        data_link_lost: 0,
      })
      .build()

    const { result } = await analyzeBuffer(buf)
    const eventsSection = result.sections['events-raw']
    assert.ok(eventsSection, 'events-raw section should exist')

    const rcFindings = eventsSection.findings.filter(f =>
      f.title.includes('遥控链路丢失')
    )
    assert.ok(rcFindings.length > 0, 'should detect RC loss')
    assert.equal(rcFindings[0]!.severity, 'critical')
  })

  it('detects data link loss', async () => {
    const buf = new UlogFixtureBuilder()
      .addFormat(400, 'failsafe', [
        { type: 'uint64_t', fieldName: 'timestamp' },
        { type: 'uint8_t', fieldName: 'failsafe_active' },
        { type: 'uint8_t', fieldName: 'rc_loss' },
        { type: 'uint8_t', fieldName: 'data_link_lost' },
      ])
      .addSubscription(400, 0)
      .addData(400, 1_000_000n, {
        timestamp: 1_000_000,
        failsafe_active: 0,
        rc_loss: 0,
        data_link_lost: 0,
      })
      .addData(400, 2_000_000n, {
        timestamp: 2_000_000,
        failsafe_active: 0,
        rc_loss: 0,
        data_link_lost: 1,
      })
      .addData(400, 3_000_000n, {
        timestamp: 3_000_000,
        failsafe_active: 0,
        rc_loss: 0,
        data_link_lost: 0,
      })
      .build()

    const { result } = await analyzeBuffer(buf)
    const eventsSection = result.sections['events-raw']
    assert.ok(eventsSection, 'events-raw section should exist')

    const dlFindings = eventsSection.findings.filter(f =>
      f.title.includes('数传链路丢失')
    )
    assert.ok(dlFindings.length > 0, 'should detect data link loss')
  })

  it('handles vehicle_status alias', async () => {
    const buf = new UlogFixtureBuilder()
      .addFormat(400, 'vehicle_status', [
        { type: 'uint64_t', fieldName: 'timestamp' },
        { type: 'uint8_t', fieldName: 'failsafe_active' },
        { type: 'uint8_t', fieldName: 'rc_loss' },
        { type: 'uint8_t', fieldName: 'data_link_lost' },
      ])
      .addSubscription(400, 0)
      .addData(400, 1_000_000n, {
        timestamp: 1_000_000,
        failsafe_active: 0,
        rc_loss: 0,
        data_link_lost: 0,
      })
      .build()

    const { result } = await analyzeBuffer(buf)
    const eventsSection = result.sections['events-raw']
    assert.ok(eventsSection, 'events-raw section should exist with vehicle_status alias')
  })

  it('detects battery warning level changes', async () => {
    const buf = new UlogFixtureBuilder()
      .addFormat(400, 'failsafe', [
        { type: 'uint64_t', fieldName: 'timestamp' },
        { type: 'uint8_t', fieldName: 'failsafe_active' },
        { type: 'uint8_t', fieldName: 'battery_warning' },
        { type: 'uint8_t', fieldName: 'rc_loss' },
        { type: 'uint8_t', fieldName: 'data_link_lost' },
      ])
      .addSubscription(400, 0)
      .addData(400, 1_000_000n, {
        timestamp: 1_000_000,
        failsafe_active: 0,
        battery_warning: 0,
        rc_loss: 0,
        data_link_lost: 0,
      })
      .addData(400, 2_000_000n, {
        timestamp: 2_000_000,
        failsafe_active: 0,
        battery_warning: 2,
        rc_loss: 0,
        data_link_lost: 0,
      })
      .build()

    const { result } = await analyzeBuffer(buf)
    const eventsSection = result.sections['events-raw']
    assert.ok(eventsSection, 'events-raw section should exist')

    const battFindings = eventsSection.findings.filter(f =>
      f.title.includes('电池警告')
    )
    assert.ok(battFindings.length > 0, 'should detect battery warning')
    assert.equal(battFindings[0]!.severity, 'critical') // level >= 2 → critical
  })
})

// ─── System health module tests ─────────────────────────────────────────────

describe('system health module', () => {
  it('tracks CPU load and detects sustained high load', async () => {
    const buf = new UlogFixtureBuilder()
      .addFormat(500, 'cpuload', [
        { type: 'uint64_t', fieldName: 'timestamp' },
        { type: 'float', fieldName: 'load' },
        { type: 'uint32_t', fieldName: 'ram_usage' },
      ])
      .addSubscription(500, 0)
      // Normal load
      .addData(500, 1_000_000n, {
        timestamp: 1_000_000,
        load: 30,
        ram_usage: 50,
      })
      // High load for extended period
      .addData(500, 3_000_000n, {
        timestamp: 3_000_000,
        load: 90,
        ram_usage: 50,
      })
      .addData(500, 6_000_000n, {
        timestamp: 6_000_000,
        load: 95,
        ram_usage: 50,
      })
      .addData(500, 8_000_000n, {
        timestamp: 8_000_000,
        load: 40,
        ram_usage: 50,
      })
      .build()

    const { result } = await analyzeBuffer(buf)
    const eventsSection = result.sections['events-raw']
    assert.ok(eventsSection, 'events-raw section should exist')

    const cpuFindings = eventsSection.findings.filter(f =>
      f.title.includes('CPU 持续高负载')
    )
    assert.ok(cpuFindings.length > 0, 'should detect sustained high CPU load')
    assert.equal(cpuFindings[0]!.severity, 'warning')

    // Check chart views
    const cpuChart = sectionViews(eventsSection).find(v => v.id.includes('cpu-load'))
    assert.ok(cpuChart, 'should have CPU load chart view')
    assert.equal(cpuChart.unit, '%')
  })

  it('detects high RAM usage', async () => {
    const buf = new UlogFixtureBuilder()
      .addFormat(500, 'cpuload', [
        { type: 'uint64_t', fieldName: 'timestamp' },
        { type: 'float', fieldName: 'load' },
        { type: 'float', fieldName: 'ram_usage' },
      ])
      .addSubscription(500, 0)
      .addData(500, 1_000_000n, {
        timestamp: 1_000_000,
        load: 30,
        ram_usage: 95,
      })
      .build()

    const { result } = await analyzeBuffer(buf)
    const eventsSection = result.sections['events-raw']
    assert.ok(eventsSection, 'events-raw section should exist')

    const ramFindings = eventsSection.findings.filter(f =>
      f.title.includes('内存占用')
    )
    assert.ok(ramFindings.length > 0, 'should detect high RAM usage')
    assert.equal(ramFindings[0]!.severity, 'critical')
  })

  it('produces RAM usage chart when data available', async () => {
    const buf = new UlogFixtureBuilder()
      .addFormat(500, 'cpuload', [
        { type: 'uint64_t', fieldName: 'timestamp' },
        { type: 'float', fieldName: 'load' },
        { type: 'float', fieldName: 'ram_usage' },
      ])
      .addSubscription(500, 0)
      .addData(500, 1_000_000n, {
        timestamp: 1_000_000,
        load: 30,
        ram_usage: 45,
      })
      .addData(500, 2_000_000n, {
        timestamp: 2_000_000,
        load: 40,
        ram_usage: 55,
      })
      .build()

    const { result } = await analyzeBuffer(buf)
    const eventsSection = result.sections['events-raw']
    assert.ok(eventsSection, 'events-raw section should exist')

    const ramChart = sectionViews(eventsSection).find(v => v.id.includes('ram-usage'))
    assert.ok(ramChart, 'should have RAM usage chart view')
  })
})

// ─── Full-log chart coverage regressions (no first-N retention) ───────────

describe('full-log chart coverage', () => {
  it('estimator innovation view spans the whole log, not the first 2000 samples', async () => {
    const builder = new UlogFixtureBuilder()
      .addFormat(200, 'estimator_status', [
        { type: 'uint64_t', fieldName: 'timestamp' },
        { type: 'float', fieldName: 'pos_test_ratio' },
      ])
      .addSubscription(200, 0)
    // 3000 samples over 60s — more than the 2000-point budget; the
    // recognizable rise happens in the final quarter of the log.
    const n = 3000
    for (let i = 0; i <= n; i++) {
      const t = (i / n) * 60
      builder.addData(200, BigInt(Math.round(t * 1_000_000)), {
        timestamp: Math.round(t * 1_000_000),
        pos_test_ratio: t > 45 ? 0.9 : 0.2,
      })
    }

    const { result } = await analyzeBuffer(builder.build())
    const estimatorSection = result.sections['estimator']!
    const view = sectionViews(estimatorSection).find(v => v.id.includes('innovation-ratios')) as
      | { series: Array<{ times: number[]; values: number[] }> }
      | undefined
    assert.ok(view, 'innovation view exists')
    const times = view!.series[0]!.times
    assert.ok(times.length <= 2100, `bounded output, got ${times.length}`)
    assert.ok(
      times[times.length - 1]! > 57,
      `view must cover the log end, last=${times[times.length - 1]}`,
    )
    // The late rise must be visible in the downsampled series
    assert.ok(view!.series[0]!.values.some(v => v > 0.8), 'late signal preserved')
  })

  it('CPU load view spans the whole log and skips samples without a load field', async () => {
    const builder = new UlogFixtureBuilder()
      .addFormat(500, 'cpuload', [
        { type: 'uint64_t', fieldName: 'timestamp' },
        { type: 'float', fieldName: 'load' },
        { type: 'float', fieldName: 'ram_usage' },
      ])
      .addSubscription(500, 0)
    const n = 3000
    for (let i = 0; i <= n; i++) {
      const t = (i / n) * 60
      builder.addData(500, BigInt(Math.round(t * 1_000_000)), {
        timestamp: Math.round(t * 1_000_000),
        load: 0.3 + (t > 50 ? 0.5 : 0), // fraction → %
        ram_usage: 0.4,
      })
    }

    const { result } = await analyzeBuffer(builder.build())
    const eventsSection = result.sections['events-raw']!
    const cpuView = sectionViews(eventsSection).find(v => v.id === 'cpu-load') as
      | { series: Array<{ times: number[]; values: number[] }> }
      | undefined
    assert.ok(cpuView, 'cpu view exists')
    const times = cpuView!.series[0]!.times
    assert.ok(times[times.length - 1]! > 57, `cpu view covers log end, last=${times[times.length - 1]}`)
    // Late 80% spike preserved by envelope downsampling
    assert.ok(cpuView!.series[0]!.values.some(v => v > 75), 'late CPU spike preserved')
  })
})

// ─── Integration: partial topics ────────────────────────────────────────────

describe('integration: partial topic availability', () => {
  it('runs all modules when only some topics are present', async () => {
    const buf = new UlogFixtureBuilder()
      .addFormat(500, 'cpuload', [
        { type: 'uint64_t', fieldName: 'timestamp' },
        { type: 'float', fieldName: 'load' },
        { type: 'uint32_t', fieldName: 'ram_usage' },
      ])
      .addSubscription(500, 0)
      .addData(500, 1_000_000n, {
        timestamp: 1_000_000,
        load: 30,
        ram_usage: 50,
      })
      .build()

    const { result } = await analyzeBuffer(buf)

    // System health should be available
    const eventsSection = result.sections['events-raw']
    assert.ok(eventsSection, 'events-raw section should exist')

    // Estimator should not crash even with no data
    // (it just won't have an estimator section, or it will be empty)
    // The module runs but produces no findings
    assert.ok(result.findings !== undefined, 'findings array should exist')
  })

  it('handles empty log gracefully', async () => {
    const buf = new UlogFixtureBuilder()
      .addFormat(100, 'dummy', [
        { type: 'uint64_t', fieldName: 'timestamp' },
      ])
      .addSubscription(100, 0)
      .addData(100, 1_000_000n, { timestamp: 1_000_000 })
      .build()

    const { result } = await analyzeBuffer(buf)
    // Should not throw
    assert.ok(result.sections !== undefined, 'sections should exist')
    assert.ok(result.findings !== undefined, 'findings should exist')
  })
})
