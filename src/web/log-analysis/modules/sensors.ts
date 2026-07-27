import type { AnalysisModule, AnalysisContext, ResolvedSample, ModuleResult } from '../engine/AnalysisModule.js'
import type { DiagnosticFinding, ChartSeriesGroup } from '../types.js'

// ── State types ──────────────────────────────────────────────────────────────

interface SensorInstanceState {
  instanceId: number
  topicName: string
  /** Per-axis raw samples for vibration analysis */
  axisSamples: Map<string, Array<{ timeSec: number; value: number }>>
  /** All samples for charting (bounded) */
  chartSamples: Array<{ timeSec: number; values: Record<string, number> }>
  /** Clipping counter values */
  clipCounts: Record<string, number>
  /** Temperature samples */
  temperatureSamples: Array<{ timeSec: number; value: number }>
  /** Sample times for gap detection */
  sampleTimes: number[]
}

interface SensorsState {
  sensorCombined: Array<{ timeSec: number; values: Record<string, number> }>
  accelInstances: Map<number, SensorInstanceState>
  gyroInstances: Map<number, SensorInstanceState>
  magInstances: Map<number, SensorInstanceState>
  baroInstances: Map<number, SensorInstanceState>
}

// ── Result types ─────────────────────────────────────────────────────────────

interface VibrationResult {
  axis: string
  peakFrequencyHz: number
  peakAmplitude: number
  rmsAmplitude: number
  frequencies: number[]
  amplitudes: number[]
}

interface SensorInstanceResult {
  instanceId: number
  topicName: string
  sampleCount: number
  clipCounts: Record<string, number>
  meanValues: Record<string, number>
  vibration: VibrationResult[]
  gapCount: number
}

interface SensorsResult {
  accelInstances: SensorInstanceResult[]
  gyroInstances: SensorInstanceResult[]
  magInstances: SensorInstanceResult[]
  baroInstances: SensorInstanceResult[]
  combinedSampleCount: number
}

// ── Constants ────────────────────────────────────────────────────────────────

const MAX_CHART_POINTS = 2000
const MAX_VIBRATION_POINTS = 500
/** Minimum contiguous samples needed for vibration analysis */
const MIN_VIBRATION_SAMPLES = 32
/** Gap threshold in seconds — samples farther apart than this are split */
const GAP_THRESHOLD_SEC = 0.05

// ── Vibration processing ─────────────────────────────────────────────────────

/**
 * Compute periodogram of a real-valued signal.
 * Applies Hann window with coherent-gain compensation.
 * Returns positive-frequency bins with amplitude (not power) for charting.
 */
export function periodogram(
  signal: number[],
  sampleRate: number,
): { frequencies: number[]; power: number[] } {
  const N = signal.length
  if (N < 2) return { frequencies: [], power: [] }

  // Apply Hann window
  const windowed = signal.map((x, i) => x * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1))))
  // Hann coherent gain compensation
  const hannGain = 0.5

  // Compute DFT magnitude for positive frequencies
  const nFreq = Math.floor(N / 2)
  const frequencies: number[] = []
  const power: number[] = []
  for (let k = 1; k < nFreq; k++) {
    let re = 0, im = 0
    for (let n = 0; n < N; n++) {
      const angle = -2 * Math.PI * k * n / N
      re += windowed[n] * Math.cos(angle)
      im += windowed[n] * Math.sin(angle)
    }
    const mag = Math.sqrt(re * re + im * im) / (N * hannGain)
    frequencies.push(k * sampleRate / N)
    power.push(mag * mag)
  }
  return { frequencies, power }
}

/**
 * Split a time-series into contiguous windows at gaps/dropouts.
 */
function splitAtGaps(
  times: number[],
  values: number[],
  gapThreshold: number,
): Array<{ times: number[]; values: number[] }> {
  if (times.length === 0) return []
  const windows: Array<{ times: number[]; values: number[] }> = []
  let curT: number[] = [times[0]!]
  let curV: number[] = [values[0]!]

  for (let i = 1; i < times.length; i++) {
    const dt = times[i]! - times[i - 1]!
    if (dt > gapThreshold) {
      windows.push({ times: curT, values: curV })
      curT = []
      curV = []
    }
    curT.push(times[i]!)
    curV.push(values[i]!)
  }
  if (curT.length > 0) windows.push({ times: curT, values: curV })
  return windows
}

/**
 * Resample a contiguous window to a uniform grid via linear interpolation.
 */
function resampleUniform(
  times: number[],
  values: number[],
  targetRate: number,
): { uniformValues: number[]; sampleRate: number } {
  if (times.length < 2) return { uniformValues: [], sampleRate: 0 }
  const duration = times[times.length - 1]! - times[0]!
  if (duration <= 0) return { uniformValues: [], sampleRate: 0 }

  const nSamples = Math.min(Math.floor(duration * targetRate), times.length)
  if (nSamples < 2) return { uniformValues: [], sampleRate: 0 }

  const dt = duration / (nSamples - 1)
  const sampleRate = 1 / dt
  const uniformValues: number[] = []

  let srcIdx = 0
  for (let i = 0; i < nSamples; i++) {
    const t = times[0]! + i * dt
    // Advance source index to bracket t
    while (srcIdx < times.length - 2 && times[srcIdx + 1]! < t) srcIdx++
    const t0 = times[srcIdx]!
    const t1 = times[srcIdx + 1]!
    const v0 = values[srcIdx]!
    const v1 = values[srcIdx + 1]!
    const frac = t1 > t0 ? (t - t0) / (t1 - t0) : 0
    uniformValues.push(v0 + frac * (v1 - v0))
  }

  return { uniformValues, sampleRate }
}

/**
 * Remove DC offset (subtract mean).
 */
function removeDC(signal: number[]): number[] {
  const mean = signal.reduce((a, b) => a + b, 0) / signal.length
  return signal.map(x => x - mean)
}

/**
 * Full vibration analysis pipeline for one axis.
 * 1. Split at gaps
 * 2. Resample to uniform grid
 * 3. Remove DC offset
 * 4. Apply Hann window + periodogram
 * 5. Average power across windows
 */
export function analyzeVibration(
  samples: Array<{ timeSec: number; value: number }>,
  targetRate: number = 250,
): VibrationResult | null {
  if (samples.length < MIN_VIBRATION_SAMPLES) return null

  // Sort by time
  const sorted = [...samples].sort((a, b) => a.timeSec - b.timeSec)
  const times = sorted.map(s => s.timeSec)
  const values = sorted.map(s => s.value)

  // Split at gaps
  const windows = splitAtGaps(times, values, GAP_THRESHOLD_SEC)

  // Process each window
  let avgPower: number[] | null = null
  let avgFreq: number[] | null = null
  let windowCount = 0

  for (const win of windows) {
    if (win.times.length < MIN_VIBRATION_SAMPLES) continue

    // Resample to uniform grid
    const { uniformValues, sampleRate } = resampleUniform(win.times, win.values, targetRate)
    if (uniformValues.length < MIN_VIBRATION_SAMPLES || sampleRate <= 0) continue

    // Remove DC offset
    const centered = removeDC(uniformValues)

    // Compute periodogram
    const { frequencies, power } = periodogram(centered, sampleRate)
    if (frequencies.length === 0) continue

    // Accumulate average power
    if (!avgPower || avgPower.length !== power.length) {
      avgPower = [...power]
      avgFreq = [...frequencies]
    } else {
      for (let i = 0; i < power.length; i++) {
        avgPower[i] = (avgPower[i]! * windowCount + power[i]!) / (windowCount + 1)
      }
    }
    windowCount++
  }

  if (!avgPower || !avgFreq || windowCount === 0) return null

  // Convert power to amplitude
  const amplitudes = avgPower.map(p => Math.sqrt(p))

  // Find peak
  let peakIdx = 0
  let peakPower = 0
  for (let i = 0; i < avgPower.length; i++) {
    if (avgPower[i]! > peakPower) {
      peakPower = avgPower[i]!
      peakIdx = i
    }
  }

  // Compute RMS amplitude
  const rmsAmplitude = Math.sqrt(avgPower.reduce((a, b) => a + b, 0))

  // Limit output to MAX_VIBRATION_POINTS
  let outFreq = avgFreq
  let outAmp = amplitudes
  if (outFreq.length > MAX_VIBRATION_POINTS) {
    const step = Math.ceil(outFreq.length / MAX_VIBRATION_POINTS)
    outFreq = outFreq.filter((_, i) => i % step === 0)
    outAmp = amplitudes.filter((_, i) => i % step === 0)
  }

  return {
    axis: '',
    peakFrequencyHz: avgFreq[peakIdx]!,
    peakAmplitude: amplitudes[peakIdx]!,
    rmsAmplitude,
    frequencies: outFreq,
    amplitudes: outAmp,
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function downsample(times: number[], values: number[], maxPoints: number): { times: number[]; values: number[] } {
  if (times.length <= maxPoints) return { times, values }
  const step = Math.ceil(times.length / maxPoints)
  const outT: number[] = []
  const outV: number[] = []
  for (let i = 0; i < times.length; i += step) {
    outT.push(times[i]!)
    outV.push(values[i]!)
  }
  return { times: outT, values: outV }
}

function detectGaps(sampleTimes: number[], threshold: number): number {
  let gaps = 0
  for (let i = 1; i < sampleTimes.length; i++) {
    if (sampleTimes[i]! - sampleTimes[i - 1]! > threshold) gaps++
  }
  return gaps
}

// ── Module ───────────────────────────────────────────────────────────────────

export const sensorsModule: AnalysisModule<SensorsState, SensorsResult> = {
  id: 'sensors',
  section: 'sensors-power',

  requirements: [
    {
      aliases: ['sensor_combined'],
      required: false,
      bindAs: 'sensorCombined',
    },
    {
      aliases: ['sensor_accel', 'sensor_accel_0'],
      required: false,
      bindAs: 'accel',
      multiInstance: true,
    },
    {
      aliases: ['sensor_gyro', 'sensor_gyro_0'],
      required: false,
      bindAs: 'gyro',
      multiInstance: true,
    },
    {
      aliases: ['sensor_mag', 'sensor_mag_0'],
      required: false,
      bindAs: 'mag',
      multiInstance: true,
    },
    {
      aliases: ['sensor_baro'],
      required: false,
      bindAs: 'baro',
      multiInstance: true,
    },
  ],

  create(_context: AnalysisContext): SensorsState {
    return {
      sensorCombined: [],
      accelInstances: new Map(),
      gyroInstances: new Map(),
      magInstances: new Map(),
      baroInstances: new Map(),
    }
  },

  consume(state: SensorsState, sample: ResolvedSample, bindName: string): void {
    const instanceId = sample.topic.multiId

    if (bindName === 'sensorCombined') {
      if (state.sensorCombined.length < MAX_CHART_POINTS) {
        const numericValues: Record<string, number> = {}
        for (const [k, v] of Object.entries(sample.values)) {
          if (typeof v === 'number') numericValues[k] = v
        }
        state.sensorCombined.push({ timeSec: sample.timeSec, values: numericValues })
      }
      // Check for clipping counters
      for (const [key, val] of Object.entries(sample.values)) {
        if (key.includes('clipping') && typeof val === 'number' && val > 0) {
          // Track in combined context
        }
      }
      return
    }

    // Determine which instance map to use
    let instanceMap: Map<number, SensorInstanceState>
    if (bindName === 'accel') instanceMap = state.accelInstances
    else if (bindName === 'gyro') instanceMap = state.gyroInstances
    else if (bindName === 'mag') instanceMap = state.magInstances
    else if (bindName === 'baro') instanceMap = state.baroInstances
    else return

    let inst = instanceMap.get(instanceId)
    if (!inst) {
      inst = {
        instanceId,
        topicName: sample.topic.name,
        axisSamples: new Map(),
        chartSamples: [],
        clipCounts: {},
        temperatureSamples: [],
        sampleTimes: [],
      }
      instanceMap.set(instanceId, inst)
    }

    // Track sample times for gap detection
    inst.sampleTimes.push(sample.timeSec)

    // Store chart samples (bounded)
    if (inst.chartSamples.length < MAX_CHART_POINTS) {
      const numericValues: Record<string, number> = {}
      for (const [k, v] of Object.entries(sample.values)) {
        if (typeof v === 'number') numericValues[k] = v
      }
      inst.chartSamples.push({ timeSec: sample.timeSec, values: numericValues })
    }

    // Extract per-axis samples for vibration analysis
    for (const [key, val] of Object.entries(sample.values)) {
      if (typeof val !== 'number') continue

      // Detect axis fields (e.g., x, y, z or [0], [1], [2])
      let axisName: string | null = null
      if (key.endsWith('[0]') || key === 'x' || key.endsWith('_x')) axisName = 'x'
      else if (key.endsWith('[1]') || key === 'y' || key.endsWith('_y')) axisName = 'y'
      else if (key.endsWith('[2]') || key === 'z' || key.endsWith('_z')) axisName = 'z'

      if (axisName) {
        // Use the base field name (without axis suffix) as the group
        const baseName = key.replace(/\[\d+\]$/, '').replace(/_[xyz]$/, '')
        const mapKey = `${baseName}_${axisName}`
        let arr = inst.axisSamples.get(mapKey)
        if (!arr) {
          arr = []
          inst.axisSamples.set(mapKey, arr)
        }
        if (arr.length < 10000) {
          arr.push({ timeSec: sample.timeSec, value: val })
        }
      }

      // Track clipping counters
      if (key.includes('clip') && typeof val === 'number') {
        const prev = inst.clipCounts[key] ?? 0
        if (val > prev) inst.clipCounts[key] = val
      }

      // Track temperature
      if (key.includes('temperature') && typeof val === 'number') {
        if (inst.temperatureSamples.length < MAX_CHART_POINTS) {
          inst.temperatureSamples.push({ timeSec: sample.timeSec, value: val })
        }
      }
    }
  },

  finalize(state: SensorsState, context: AnalysisContext): ModuleResult<SensorsState, SensorsResult> {
    const findings: DiagnosticFinding[] = []
    const chartSeries: ChartSeriesGroup[] = []

    const processInstanceMap = (
      instanceMap: Map<number, SensorInstanceState>,
      sensorType: string,
    ): SensorInstanceResult[] => {
      const results: SensorInstanceResult[] = []

      for (const [instanceId, inst] of instanceMap) {
        // Compute mean values
        const meanValues: Record<string, number> = {}
        if (inst.chartSamples.length > 0) {
          const sums: Record<string, number> = {}
          for (const s of inst.chartSamples) {
            for (const [k, v] of Object.entries(s.values)) {
              if (typeof v === 'number') {
                sums[k] = (sums[k] ?? 0) + v
              }
            }
          }
          for (const [k, v] of Object.entries(sums)) {
            meanValues[k] = v / inst.chartSamples.length
          }
        }

        // Gap detection
        const gapCount = detectGaps(inst.sampleTimes, GAP_THRESHOLD_SEC)

        // Vibration analysis on each axis
        const vibrationResults: VibrationResult[] = []
        for (const [axisKey, samples] of inst.axisSamples) {
          const vib = analyzeVibration(samples)
          if (vib) {
            vib.axis = axisKey
            vibrationResults.push(vib)
          }
        }

        results.push({
          instanceId,
          topicName: inst.topicName,
          sampleCount: inst.chartSamples.length,
          clipCounts: { ...inst.clipCounts },
          meanValues,
          vibration: vibrationResults,
          gapCount,
        })

        // ── Findings ──────────────────────────────────────────────────────
        // Clipping
        for (const [key, count] of Object.entries(inst.clipCounts)) {
          if (count > 0) {
            findings.push({
              id: `sensors-${sensorType}-${instanceId}-clip-${key}`,
              moduleId: 'sensors',
              section: 'sensors-power',
              severity: 'warning',
              confidence: 'measured',
              title: `检测到传感器削波：${sensorType}[${instanceId}] ${key}`,
              summary: `${sensorType} 实例 ${instanceId} 的 ${key} 检测到 ${count} 次削波。`,
              recommendation: '请检查传感器安装并降低振动。',
              evidence: [{
                topic: inst.topicName,
                multiId: instanceId,
                fields: [key],
                startSec: null,
                endSec: null,
                observed: `${count} 次削波`,
                threshold: '0',
              }],
            })
          }
        }

        // High vibration
        for (const vib of vibrationResults) {
          if (vib.peakAmplitude > 5.0) {
            findings.push({
              id: `sensors-${sensorType}-${instanceId}-vibration-${vib.axis}`,
              moduleId: 'sensors',
              section: 'sensors-power',
              severity: 'warning',
              confidence: 'derived',
              title: `${sensorType}[${instanceId}] ${vib.axis} 轴振动过高`,
              summary: `${vib.axis} 轴在 ${vib.peakFrequencyHz.toFixed(1)} Hz 处的峰值幅度为 ${vib.peakAmplitude.toFixed(2)}。`,
              recommendation: '请检查机架是否存在部件松动或不平衡。',
              evidence: [{
                topic: inst.topicName,
                multiId: instanceId,
                fields: [vib.axis],
                startSec: null,
                endSec: null,
                observed: `峰值=${vib.peakAmplitude.toFixed(2)}，频率=${vib.peakFrequencyHz.toFixed(1)}Hz`,
                threshold: '5.0',
              }],
            })
          }
        }

        // Sample gaps
        if (gapCount > 5) {
          findings.push({
            id: `sensors-${sensorType}-${instanceId}-gaps`,
            moduleId: 'sensors',
            section: 'sensors-power',
            severity: 'notice',
            confidence: 'measured',
            title: `${sensorType}[${instanceId}] 存在采样缺口`,
            summary: `${sensorType} 实例 ${instanceId} 检测到 ${gapCount} 个采样缺口。`,
            recommendation: null,
            evidence: [{
              topic: inst.topicName,
              multiId: instanceId,
              fields: [],
              startSec: null,
              endSec: null,
              observed: `${gapCount} 个缺口`,
              threshold: '5',
            }],
          })
        }

        // ── Chart series: vibration spectrum ──────────────────────────────
        for (const vib of vibrationResults) {
          if (vib.frequencies.length > 0) {
            chartSeries.push({
              id: `sensors-${sensorType}-${instanceId}-vib-${vib.axis}`,
              title: `振动频谱：${sensorType}[${instanceId}] ${vib.axis} 轴`,
              description: `${sensorType} 实例 ${instanceId} 的 ${vib.axis} 轴振动幅度频谱`,
              unit: 'm/s²',
              series: [{
                label: `${vib.axis} 轴幅度`,
                times: vib.frequencies,
                values: vib.amplitudes,
              }],
              hasGaps: false,
            })
          }
        }

        // ── Chart series: sensor values over time ─────────────────────────
        if (inst.chartSamples.length > 0) {
          const times = inst.chartSamples.map(s => s.timeSec)
          // Pick up to 3 numeric fields for charting
          const numericFields = Object.keys(inst.chartSamples[0]!.values).filter(k =>
            typeof inst.chartSamples[0]!.values[k] === 'number'
          ).slice(0, 3)

          for (const field of numericFields) {
            const values = inst.chartSamples.map(s => (s.values[field] as number) ?? 0)
            const ds = downsample(times, values, MAX_CHART_POINTS)
            chartSeries.push({
              id: `sensors-${sensorType}-${instanceId}-ts-${field}`,
              title: `${sensorType}[${instanceId}] ${field}`,
              description: `${sensorType} 实例 ${instanceId} 的 ${field} 随时间的变化`,
              unit: '',
              series: [{ label: field, times: ds.times, values: ds.values }],
              hasGaps: gapCount > 0,
            })
          }
        }
      }

      return results
    }

    // Process all sensor types
    const accelResults = processInstanceMap(state.accelInstances, 'accel')
    const gyroResults = processInstanceMap(state.gyroInstances, 'gyro')
    const magResults = processInstanceMap(state.magInstances, 'mag')
    const baroResults = processInstanceMap(state.baroInstances, 'baro')

    // ── Cross-instance inconsistency check ────────────────────────────────
    const checkInconsistency = (results: SensorInstanceResult[], sensorType: string) => {
      if (results.length < 2) return
      // Compare mean values across instances
      const allFields = new Set<string>()
      for (const r of results) {
        for (const k of Object.keys(r.meanValues)) allFields.add(k)
      }
      for (const field of allFields) {
        const means = results.map(r => r.meanValues[field] ?? 0).filter(v => isFinite(v))
        if (means.length < 2) continue
        const maxDiff = Math.max(...means) - Math.min(...means)
        if (maxDiff > 1.0) {
          findings.push({
            id: `sensors-${sensorType}-inconsistency-${field}`,
            moduleId: 'sensors',
            section: 'sensors-power',
            severity: 'warning',
            confidence: 'heuristic',
            title: `传感器实例不一致：${sensorType} ${field}`,
            summary: `${sensorType} 各实例的 ${field} 最大差值为 ${maxDiff.toFixed(3)}。`,
            recommendation: '请检查传感器校准和安装。',
            evidence: results.map((r, i) => ({
              topic: r.topicName,
              multiId: r.instanceId,
              fields: [field],
              startSec: null,
              endSec: null,
              observed: `平均值=${(r.meanValues[field] ?? 0).toFixed(3)}`,
              threshold: `max_diff=${maxDiff.toFixed(3)}`,
            })),
          })
        }
      }
    }

    checkInconsistency(accelResults, 'accel')
    checkInconsistency(gyroResults, 'gyro')
    checkInconsistency(magResults, 'mag')

    return {
      chartSeries,
      metrics: {
        combinedSamples: state.sensorCombined.length,
        accelInstanceCount: state.accelInstances.size,
        gyroInstanceCount: state.gyroInstances.size,
        magInstanceCount: state.magInstances.size,
        baroInstanceCount: state.baroInstances.size,
      },
      findings,
      consumedTopics: [],
      missingRequirements: [],
      warnings: [],
      result: {
        accelInstances: accelResults,
        gyroInstances: gyroResults,
        magInstances: magResults,
        baroInstances: baroResults,
        combinedSampleCount: state.sensorCombined.length,
      },
    }
  },
}
