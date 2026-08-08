// Unit tests for the pure ULog analysis primitives. Run directly:
// npm run test:ulog  (tsx src/web/utils/ulogAnalysis.test.ts)
import assert from 'node:assert/strict'
import {
  EnvelopeCollector,
  appendBoundedTransition,
  VibrationAnalyzer,
  VIBRATION_FFT_SIZE,
  buildSegments,
  computeSaturationPct,
  downsampleMinMax,
  fftRadix2,
  parsePx4DirectoryDate,
  parsePx4FileDate,
  parsePx4LogPathDate,
  quaternionToEuler,
  normalizeUlogTimestamp,
} from './ulogAnalysis'

assert.equal(normalizeUlogTimestamp(Number.NaN), null)
assert.equal(normalizeUlogTimestamp(undefined), null)
assert.equal(normalizeUlogTimestamp(0), null)
assert.equal(normalizeUlogTimestamp(123.9), 123n)
assert.equal(normalizeUlogTimestamp(456n), 456n)

{
  const transitions: Array<{ label: string }> = []
  assert.equal(appendBoundedTransition(transitions, { label: 'A' }, (a, b) => a.label === b.label, 2), 'appended')
  assert.equal(appendBoundedTransition(transitions, { label: 'A' }, (a, b) => a.label === b.label, 2), 'unchanged')
  assert.equal(appendBoundedTransition(transitions, { label: 'B' }, (a, b) => a.label === b.label, 2), 'appended')
  assert.equal(appendBoundedTransition(transitions, { label: 'C' }, (a, b) => a.label === b.label, 2), 'full')
  assert.deepEqual(transitions, [{ label: 'A' }, { label: 'B' }])
}

// ---------------------------------------------------------------------------
// Quaternion -> Euler
// ---------------------------------------------------------------------------

{
  assert.equal(
    parsePx4LogPathDate('/fs/microsd/log/2026-07-25/10_30_00.ulg'),
    Date.UTC(2026, 6, 25, 10, 30, 0),
  )
  assert.equal(parsePx4LogPathDate('/fs/microsd/log/sess113/log110.ulg'), null)
}

{
  const identity = quaternionToEuler(1, 0, 0, 0)
  assert.ok(Math.abs(identity.roll) < 1e-9)
  assert.ok(Math.abs(identity.pitch) < 1e-9)
  assert.ok(Math.abs(identity.yaw) < 1e-9)

  // 90 deg yaw: q = [cos(45deg), 0, 0, sin(45deg)]
  const yaw90 = quaternionToEuler(Math.SQRT1_2, 0, 0, Math.SQRT1_2)
  assert.ok(Math.abs(yaw90.yaw - Math.PI / 2) < 1e-6)
  // 30 deg roll
  const roll30 = quaternionToEuler(Math.cos(Math.PI / 12), Math.sin(Math.PI / 12), 0, 0)
  assert.ok(Math.abs(roll30.roll - Math.PI / 6) < 1e-6)
}

// ---------------------------------------------------------------------------
// Min/max downsampling preserves spikes and bounds the output size.
// ---------------------------------------------------------------------------
{
  const times = Array.from({ length: 100_000 }, (_, index) => index / 100)
  const values = times.map(() => 0)
  values[54_321] = 42 // a single spike must survive downsampling
  values[54_400] = -17
  const result = downsampleMinMax(times, values, 4000)
  assert.ok(result.times.length <= 4000)
  assert.ok(result.values.includes(42), 'positive spike must be preserved')
  assert.ok(result.values.includes(-17), 'negative spike must be preserved')
  // Times remain sorted.
  for (let index = 1; index < result.times.length; index++) {
    assert.ok(result.times[index] >= result.times[index - 1])
  }
  // Short series pass through untouched.
  const short = downsampleMinMax([1, 2, 3], [4, 5, 6], 4000)
  assert.deepEqual(short, { times: [1, 2, 3], values: [4, 5, 6] })
}

// ---------------------------------------------------------------------------
// FFT: a pure sine must produce a single dominant bin at its frequency.
// ---------------------------------------------------------------------------
{
  const n = 1024
  const sampleRate = 512 // Hz
  const signalHz = 64
  const re = new Float64Array(n)
  const im = new Float64Array(n)
  for (let index = 0; index < n; index++) {
    re[index] = Math.sin((2 * Math.PI * signalHz * index) / sampleRate)
  }
  fftRadix2(re, im)
  let peakBin = 0
  let peakAmp = 0
  for (let bin = 1; bin < n / 2; bin++) {
    const amp = Math.hypot(re[bin], im[bin])
    if (amp > peakAmp) {
      peakAmp = amp
      peakBin = bin
    }
  }
  const peakHz = (peakBin * sampleRate) / n
  assert.equal(peakHz, signalHz)
  // Amplitude of a unit sine across N samples is N/2 in the raw FFT.
  assert.ok(Math.abs(peakAmp - n / 2) / (n / 2) < 0.01)
}

// ---------------------------------------------------------------------------
// VibrationAnalyzer: streaming Welch spectrum finds the injected frequency.
// ---------------------------------------------------------------------------
{
  const analyzer = new VibrationAnalyzer()
  const sampleRate = 1000
  const signalHz = 125
  const samples = VIBRATION_FFT_SIZE * 3 // three full segments
  for (let index = 0; index < samples; index++) {
    const t = index / sampleRate
    const vibration = Math.sin(2 * Math.PI * signalHz * t)
    // Gravity offset on Z must be removed by the DC rejection.
    analyzer.addSample(t, vibration, 0, -9.81 + vibration * 0.5)
  }
  const spectrum = analyzer.result()
  assert.ok(spectrum, 'spectrum must exist after full segments')
  assert.equal(spectrum!.segments, 3)
  assert.ok(Math.abs(spectrum!.sampleRateHz - sampleRate) < 5)
  const peakIndex = spectrum!.amp[0].indexOf(Math.max(...spectrum!.amp[0]))
  assert.ok(Math.abs(spectrum!.freq[peakIndex] - signalHz) < 2, 'X axis peak at 125 Hz')
  // DC bin must not dominate the Z axis despite the -9.81 offset.
  const zPeakIndex = spectrum!.amp[2].indexOf(Math.max(...spectrum!.amp[2]))
  assert.ok(spectrum!.freq[zPeakIndex] > 1, 'gravity DC must be rejected')
}

// ---------------------------------------------------------------------------
// EnvelopeCollector keeps per-bucket extremes in time order.
// ---------------------------------------------------------------------------
{
  const collector = new EnvelopeCollector(1)
  for (let index = 0; index < 1000; index++) {
    const t = index / 100 // 10 s of 100 Hz data
    collector.add(t, Math.sin(t * 20) * (index === 500 ? 50 : 1))
  }
  const { times, values } = collector.finish()
  assert.ok(times.length <= 22, 'two points per one-second bucket')
  // The spike at t=5.0 is sin(100)*50 (about -25.3); the envelope must keep it.
  assert.ok(Math.max(...values.map(Math.abs)) >= 20, 'spike preserved by envelope')
  for (let index = 1; index < times.length; index++) {
    assert.ok(times[index] >= times[index - 1])
  }
}

// ---------------------------------------------------------------------------
// EnvelopeCollector periodically compacts very long streams without losing
// the global extrema that matter for chart inspection.
// ---------------------------------------------------------------------------
{
  const collector = new EnvelopeCollector(0.001)
  for (let index = 0; index < 50_000; index++) {
    collector.add(index * 0.002, index === 41_337 ? 1_000_000 : Math.sin(index))
  }
  const { times, values } = collector.finish()
  assert.ok(times.length < 32_000, 'streaming envelope must remain bounded')
  assert.ok(values.includes(1_000_000), 'compaction must preserve an isolated spike')
  for (let index = 1; index < times.length; index++) {
    assert.ok(times[index] >= times[index - 1])
  }
}
// ---------------------------------------------------------------------------
// Segment building merges repeats and closes intervals.
// ---------------------------------------------------------------------------
{
  const segments = buildSegments([
    { timeSec: 0, label: 'Manual' },
    { timeSec: 1, label: 'Manual' },
    { timeSec: 5, label: 'Position' },
    { timeSec: 9, label: 'Manual' },
  ], 12)
  assert.deepEqual(segments, [
    { startSec: 0, endSec: 5, label: 'Manual' },
    { startSec: 5, endSec: 9, label: 'Position' },
    { startSec: 9, endSec: 12, label: 'Manual' },
  ])
  assert.deepEqual(buildSegments([], 10), [])
}

// ---------------------------------------------------------------------------
// Actuator saturation detection for PWM and normalized outputs.
// ---------------------------------------------------------------------------
{
  // PWM style: peak > 500 -> threshold 1950.
  const pwm = [1500, 1600, 1980, 2000, 1500, 1500, 1500, 1500, 1500, 1500]
  assert.equal(computeSaturationPct(pwm), 20)
  // Normalized style: threshold 0.98.
  const normalized = [0.5, 0.6, 0.99, 1.0, 0.4]
  assert.equal(computeSaturationPct(normalized), 40)
  assert.equal(computeSaturationPct([]), 0)
}

// ---------------------------------------------------------------------------
// PX4 log naming -> modified timestamps.
// ---------------------------------------------------------------------------
{
  assert.equal(parsePx4DirectoryDate('2026-07-25'), Date.UTC(2026, 6, 25))
  assert.equal(parsePx4DirectoryDate('sess060'), null)
  assert.equal(parsePx4DirectoryDate('2026-13-99'), null)

  assert.equal(
    parsePx4FileDate('10_30_00.ulg', '2026-07-25'),
    Date.UTC(2026, 6, 25, 10, 30, 0),
  )
  assert.equal(parsePx4FileDate('10_30_00.ulg'), null, 'time-only name needs a parent date')
  assert.equal(
    parsePx4FileDate('2026-07-25_10_30_00.ulg'),
    Date.UTC(2026, 6, 25, 10, 30, 0),
  )
  assert.equal(parsePx4FileDate('log001.ulg', '2026-07-25'), null)
}

console.log('ulogAnalysis unit tests passed')
