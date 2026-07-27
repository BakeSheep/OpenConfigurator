import type { AnalysisModule, AnalysisContext, ResolvedSample, ModuleResult } from '../engine/AnalysisModule.js'
import type { DiagnosticFinding, ChartSeriesGroup, ChartFamily, ChartView, ChartSeries } from '../types.js'
import {
  resolveVectors,
  resolveScalars,
  decodeClippingBits,
  AXIS_LABELS,
  VECTOR_KIND_LABELS,
  SCALAR_KIND_LABELS,
  type ResolvedVector,
  type ResolvedScalar,
  type SensorVectorKind,
  type SensorScalarKind,
} from '../px4/sensorProfiles.js'
import { StreamingSeriesCollector } from '../../utils/ulogAnalysis.js'

// ── Constants ────────────────────────────────────────────────────────────────

const MAX_CHART_POINTS = 2000
const MAX_VIBRATION_POINTS = 500
/** Minimum contiguous samples needed for vibration analysis */
const MIN_VIBRATION_SAMPLES = 32
/** Gap threshold in seconds — samples farther apart than this are split */
const GAP_THRESHOLD_SEC = 0.05
/** Bounded raw buffer for spectral analysis (not chart retention) */
const MAX_VIBRATION_INPUT_SAMPLES = 10000

// ── State types ──────────────────────────────────────────────────────────────

interface VectorCollectorState {
  spec: ResolvedVector
  axes: [StreamingSeriesCollector, StreamingSeriesCollector, StreamingSeriesCollector]
}

interface ScalarCollectorState {
  spec: ResolvedScalar
  collector: StreamingSeriesCollector
}

interface SensorInstanceState {
  instanceId: number
  topicName: string
  resolved: boolean
  vectors: Map<SensorVectorKind, VectorCollectorState>
  scalars: Map<SensorScalarKind, ScalarCollectorState>
  /** Per-axis raw samples for vibration analysis (bounded spectral input) */
  axisSamples: Map<string, Array<{ timeSec: number; value: number }>>
  /** Clipping counter values (dedicated topics: clip_counter fields) */
  clipCounts: Record<string, number>
  /** Streaming mean accumulation per semantic axis for consistency checks */
  meanAccum: Record<string, { sum: number; count: number }>
  sampleCount: number
  gapCount: number
  prevTimeSec: number | null
}

interface CombinedState {
  sampleCount: number
  resolved: boolean
  vectors: Map<SensorVectorKind, VectorCollectorState>
  /** Samples where the SensorCombined clipping bitfields flag each axis */
  accelClipSamples: [number, number, number]
  gyroClipSamples: [number, number, number]
  /** Raw accel samples for vibration when no dedicated topic exists */
  axisSamples: Map<string, Array<{ timeSec: number; value: number }>>
}

interface SensorsState {
  combined: CombinedState
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

const AXIS_KEYS = ['x', 'y', 'z'] as const

function makeVectorCollector(spec: ResolvedVector): VectorCollectorState {
  return {
    spec,
    axes: [
      new StreamingSeriesCollector(MAX_CHART_POINTS),
      new StreamingSeriesCollector(MAX_CHART_POINTS),
      new StreamingSeriesCollector(MAX_CHART_POINTS),
    ],
  }
}

function makeInstanceState(instanceId: number, topicName: string): SensorInstanceState {
  return {
    instanceId,
    topicName,
    resolved: false,
    vectors: new Map(),
    scalars: new Map(),
    axisSamples: new Map(),
    clipCounts: {},
    meanAccum: {},
    sampleCount: 0,
    gapCount: 0,
    prevTimeSec: null,
  }
}

/** Feed one vector sample: finite values recorded, missing/invalid → NaN gap. */
function feedVector(
  state: VectorCollectorState,
  timeSec: number,
  values: Record<string, number | string | boolean>,
): [number, number, number] | null {
  const out: [number, number, number] = [NaN, NaN, NaN]
  let anyPresent = false
  for (let axis = 0; axis < 3; axis++) {
    const raw = values[state.spec.fields[axis]!]
    if (typeof raw === 'number') {
      anyPresent = true
      // Preserve invalid values as gaps — never substitute zero
      out[axis] = Number.isFinite(raw) ? raw : NaN
    }
  }
  if (!anyPresent) return null
  for (let axis = 0; axis < 3; axis++) {
    state.axes[axis]!.push(timeSec, out[axis]!)
  }
  return out
}

function vectorViewSeries(idPrefix: string, collector: VectorCollectorState): ChartSeries[] {
  return collector.axes.map((axisCollector, axis) => {
    const { times, values } = axisCollector.toSeries()
    return {
      id: `${idPrefix}-${AXIS_KEYS[axis]}`,
      label: AXIS_LABELS[axis]!,
      times,
      values,
    }
  })
}

function vectorHasGaps(collector: VectorCollectorState): boolean {
  return collector.axes.some((axis) => axis.toSeries().hasGaps)
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
      aliases: ['sensor_baro', 'vehicle_air_data'],
      required: false,
      bindAs: 'baro',
      multiInstance: true,
    },
  ],

  create(_context: AnalysisContext): SensorsState {
    return {
      combined: {
        sampleCount: 0,
        resolved: false,
        vectors: new Map(),
        accelClipSamples: [0, 0, 0],
        gyroClipSamples: [0, 0, 0],
        axisSamples: new Map(),
      },
      accelInstances: new Map(),
      gyroInstances: new Map(),
      magInstances: new Map(),
      baroInstances: new Map(),
    }
  },

  consume(state: SensorsState, sample: ResolvedSample, bindName: string): void {
    if (bindName === 'sensorCombined') {
      const combined = state.combined
      combined.sampleCount++

      if (!combined.resolved) {
        combined.resolved = true
        const available = new Set(Object.keys(sample.values))
        for (const vector of resolveVectors('sensor_combined', available)) {
          combined.vectors.set(vector.kind, makeVectorCollector(vector))
        }
      }

      for (const [, collector] of combined.vectors) {
        const axisValues = feedVector(collector, sample.timeSec, sample.values)
        // Buffer accel axes for vibration when no dedicated topic exists
        if (axisValues && collector.spec.kind === 'acceleration') {
          for (let axis = 0; axis < 3; axis++) {
            const v = axisValues[axis]!
            if (!Number.isFinite(v)) continue
            const key = `acceleration_${AXIS_KEYS[axis]}`
            let arr = combined.axisSamples.get(key)
            if (!arr) {
              arr = []
              combined.axisSamples.set(key, arr)
            }
            if (arr.length < MAX_VIBRATION_INPUT_SAMPLES) {
              arr.push({ timeSec: sample.timeSec, value: v })
            }
          }
        }
      }

      // Official clipping bitfields (bit0=X bit1=Y bit2=Z)
      const accelClip = sample.values['accelerometer_clipping']
      if (typeof accelClip === 'number' && accelClip > 0) {
        const bits = decodeClippingBits(accelClip)
        for (let axis = 0; axis < 3; axis++) {
          if (bits[axis]) combined.accelClipSamples[axis]!++
        }
      }
      const gyroClip = sample.values['gyro_clipping']
      if (typeof gyroClip === 'number' && gyroClip > 0) {
        const bits = decodeClippingBits(gyroClip)
        for (let axis = 0; axis < 3; axis++) {
          if (bits[axis]) combined.gyroClipSamples[axis]!++
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

    const instanceId = sample.topic.multiId
    let inst = instanceMap.get(instanceId)
    if (!inst) {
      inst = makeInstanceState(instanceId, sample.topic.name)
      instanceMap.set(instanceId, inst)
    }

    inst.sampleCount++

    // Streaming gap detection
    if (inst.prevTimeSec !== null && sample.timeSec - inst.prevTimeSec > GAP_THRESHOLD_SEC) {
      inst.gapCount++
    }
    inst.prevTimeSec = sample.timeSec

    // Resolve semantic fields once from the actually-present fields
    if (!inst.resolved) {
      inst.resolved = true
      const available = new Set(Object.keys(sample.values))
      for (const vector of resolveVectors(inst.topicName, available)) {
        inst.vectors.set(vector.kind, makeVectorCollector(vector))
      }
      for (const scalar of resolveScalars(inst.topicName, available)) {
        inst.scalars.set(scalar.kind, {
          spec: scalar,
          collector: new StreamingSeriesCollector(MAX_CHART_POINTS),
        })
      }
    }

    // Vector measurements
    for (const [, collector] of inst.vectors) {
      const axisValues = feedVector(collector, sample.timeSec, sample.values)
      if (!axisValues) continue
      for (let axis = 0; axis < 3; axis++) {
        const v = axisValues[axis]!
        if (!Number.isFinite(v)) continue

        // Consistency accumulation per semantic axis
        const meanKey = `${collector.spec.kind}.${AXIS_KEYS[axis]}`
        const acc = inst.meanAccum[meanKey] ?? { sum: 0, count: 0 }
        acc.sum += v
        acc.count++
        inst.meanAccum[meanKey] = acc

        // Vibration input buffer (bounded spectral window)
        const key = `${collector.spec.kind}_${AXIS_KEYS[axis]}`
        let arr = inst.axisSamples.get(key)
        if (!arr) {
          arr = []
          inst.axisSamples.set(key, arr)
        }
        if (arr.length < MAX_VIBRATION_INPUT_SAMPLES) {
          arr.push({ timeSec: sample.timeSec, value: v })
        }
      }
    }

    // Scalar measurements
    for (const [, scalar] of inst.scalars) {
      const raw = sample.values[scalar.spec.field]
      if (typeof raw === 'number') {
        scalar.collector.push(sample.timeSec, Number.isFinite(raw) ? raw : NaN)
      }
    }

    // Clipping counters (dedicated topics: clip_counter / clip_counter[n])
    for (const [key, val] of Object.entries(sample.values)) {
      if (key.includes('clip') && typeof val === 'number') {
        const prev = inst.clipCounts[key] ?? 0
        if (val > prev) inst.clipCounts[key] = val
      }
    }
  },

  finalize(state: SensorsState, _context: AnalysisContext): ModuleResult<SensorsState, SensorsResult> {
    const findings: DiagnosticFinding[] = []
    const chartSeries: ChartSeriesGroup[] = []
    const imuViews: ChartView[] = []
    const vibrationViews: ChartView[] = []
    const environmentViews: ChartView[] = []

    // ── sensor_combined: calibrated primary IMU summary ──────────────────
    const combined = state.combined
    const combinedAccel = combined.vectors.get('acceleration')
    const combinedGyro = combined.vectors.get('angularRate')
    const firstAccelInstance = [...state.accelInstances.values()].find((i) => i.vectors.has('acceleration'))
    const firstGyroInstance = [...state.gyroInstances.values()].find((i) => i.vectors.has('angularRate'))

    const primaryAccel = combinedAccel ?? firstAccelInstance?.vectors.get('acceleration') ?? null
    const primaryGyro = combinedGyro ?? firstGyroInstance?.vectors.get('angularRate') ?? null

    if (primaryAccel && !primaryAccel.axes[0]!.isEmpty) {
      imuViews.push({
        id: 'imu-acceleration',
        title: '加速度',
        description: combinedAccel
          ? 'sensor_combined 校准后加速度（机体系 XYZ）'
          : `sensor_accel #${firstAccelInstance!.instanceId} 加速度（机体系 XYZ）`,
        unit: primaryAccel.spec.unit,
        series: vectorViewSeries('imu-accel', primaryAccel),
        defaultVisibleSeriesIds: ['imu-accel-x', 'imu-accel-y', 'imu-accel-z'],
        xAxis: 'time',
        hasGaps: vectorHasGaps(primaryAccel),
      })
    }
    if (primaryGyro && !primaryGyro.axes[0]!.isEmpty) {
      imuViews.push({
        id: 'imu-angular-rate',
        title: '角速度',
        description: combinedGyro
          ? 'sensor_combined 校准后角速度（机体系 XYZ）'
          : `sensor_gyro #${firstGyroInstance!.instanceId} 角速度（机体系 XYZ）`,
        unit: primaryGyro.spec.unit,
        series: vectorViewSeries('imu-rate', primaryGyro),
        defaultVisibleSeriesIds: ['imu-rate-x', 'imu-rate-y', 'imu-rate-z'],
        xAxis: 'time',
        hasGaps: vectorHasGaps(primaryGyro),
      })
    }

    // Combined clipping findings from the official bitfields
    const combinedClips: Array<{ kind: string; field: string; counts: [number, number, number] }> = [
      { kind: 'accel', field: 'accelerometer_clipping', counts: combined.accelClipSamples },
      { kind: 'gyro', field: 'gyro_clipping', counts: combined.gyroClipSamples },
    ]
    for (const clip of combinedClips) {
      for (let axis = 0; axis < 3; axis++) {
        const count = clip.counts[axis]!
        if (count > 0) {
          findings.push({
            id: `sensors-combined-clip-${clip.kind}-${AXIS_KEYS[axis]}`,
            moduleId: 'sensors',
            section: 'sensors-power',
            severity: 'warning',
            confidence: 'measured',
            title: `检测到传感器削波：sensor_combined ${clip.kind} ${AXIS_LABELS[axis]} 轴`,
            summary: `sensor_combined 的 ${clip.field} 在 ${count} 个采样中标记了 ${AXIS_LABELS[axis]} 轴削波。`,
            recommendation: '请检查传感器安装并降低振动。',
            evidence: [{
              topic: 'sensor_combined',
              multiId: 0,
              fields: [clip.field],
              startSec: null,
              endSec: null,
              observed: `${count} 个削波采样`,
              threshold: '0',
            }],
          })
        }
      }
    }

    // Vibration from combined accel only when no dedicated accel exists
    if (state.accelInstances.size === 0 && combined.axisSamples.size > 0) {
      const series: ChartSeries[] = []
      let peakInfo: VibrationResult | null = null
      for (const [axisKey, samples] of combined.axisSamples) {
        const vib = analyzeVibration(samples)
        if (!vib) continue
        vib.axis = axisKey
        if (!peakInfo || vib.peakAmplitude > peakInfo.peakAmplitude) peakInfo = vib
        series.push({
          id: `vib-combined-${axisKey}`,
          label: axisKey.replace('acceleration_', '').toUpperCase(),
          times: vib.frequencies,
          values: vib.amplitudes,
        })
      }
      if (series.length > 0) {
        vibrationViews.push({
          id: 'vib-combined',
          title: '振动频谱（sensor_combined）',
          description: 'sensor_combined 加速度的幅度频谱',
          unit: 'm/s²',
          series,
          defaultVisibleSeriesIds: series.map((s) => s.id),
          xAxis: 'frequency',
          hasGaps: false,
        })
      }
    }

    // ── Dedicated sensor instances ────────────────────────────────────────
    const processInstanceMap = (
      instanceMap: Map<number, SensorInstanceState>,
      sensorType: string,
    ): SensorInstanceResult[] => {
      const results: SensorInstanceResult[] = []

      for (const [instanceId, inst] of instanceMap) {
        // Mean values per semantic axis
        const meanValues: Record<string, number> = {}
        for (const [key, acc] of Object.entries(inst.meanAccum)) {
          if (acc.count > 0) meanValues[key] = acc.sum / acc.count
        }

        // Vibration analysis on each buffered axis
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
          sampleCount: inst.sampleCount,
          clipCounts: { ...inst.clipCounts },
          meanValues,
          vibration: vibrationResults,
          gapCount: inst.gapCount,
        })

        // ── Findings ──────────────────────────────────────────────────────
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

        if (inst.gapCount > 5) {
          findings.push({
            id: `sensors-${sensorType}-${instanceId}-gaps`,
            moduleId: 'sensors',
            section: 'sensors-power',
            severity: 'notice',
            confidence: 'measured',
            title: `${sensorType}[${instanceId}] 存在采样缺口`,
            summary: `${sensorType} 实例 ${instanceId} 检测到 ${inst.gapCount} 个采样缺口。`,
            recommendation: null,
            evidence: [{
              topic: inst.topicName,
              multiId: instanceId,
              fields: [],
              startSec: null,
              endSec: null,
              observed: `${inst.gapCount} 个缺口`,
              threshold: '5',
            }],
          })
        }

        // ── Vibration spectrum views (per instance, axes as series) ───────
        if (vibrationResults.length > 0 && vibrationResults.some((v) => v.frequencies.length > 0)) {
          const series: ChartSeries[] = vibrationResults
            .filter((v) => v.frequencies.length > 0)
            .map((vib) => ({
              id: `vib-${sensorType}-${instanceId}-${vib.axis}`,
              label: vib.axis.replace(/^(acceleration|angularRate|magneticField)_/, '').toUpperCase(),
              times: vib.frequencies,
              values: vib.amplitudes,
            }))
          vibrationViews.push({
            id: `vib-${sensorType}-${instanceId}`,
            title: `振动频谱（${sensorType} #${instanceId}）`,
            description: `${sensorType} 实例 ${instanceId} 的幅度频谱`,
            unit: sensorType === 'gyro' ? 'rad/s' : 'm/s²',
            series,
            defaultVisibleSeriesIds: series.map((s) => s.id),
            xAxis: 'frequency',
            hasGaps: false,
          })
        }
      }

      return results
    }

    const accelResults = processInstanceMap(state.accelInstances, 'accel')
    const gyroResults = processInstanceMap(state.gyroInstances, 'gyro')
    const magResults = processInstanceMap(state.magInstances, 'mag')
    const baroResults = processInstanceMap(state.baroInstances, 'baro')

    // ── Instance-selectable IMU views for dedicated sensors ──────────────
    for (const [instanceId, inst] of state.accelInstances) {
      const vec = inst.vectors.get('acceleration')
      if (!vec || vec.axes[0]!.isEmpty) continue
      // sensor_combined already provides the primary summary; dedicated
      // instances become selectable views instead of duplicate cards.
      if (!combinedAccel && inst === firstAccelInstance) continue
      imuViews.push({
        id: `accel-${instanceId}`,
        title: `加速度（sensor_accel #${instanceId}）`,
        description: `sensor_accel 实例 ${instanceId} 的加速度`,
        unit: vec.spec.unit,
        series: vectorViewSeries(`accel-${instanceId}`, vec),
        defaultVisibleSeriesIds: AXIS_KEYS.map((k) => `accel-${instanceId}-${k}`),
        xAxis: 'time',
        hasGaps: vectorHasGaps(vec),
      })
    }
    for (const [instanceId, inst] of state.gyroInstances) {
      const vec = inst.vectors.get('angularRate')
      if (!vec || vec.axes[0]!.isEmpty) continue
      if (!combinedGyro && inst === firstGyroInstance) continue
      imuViews.push({
        id: `gyro-${instanceId}`,
        title: `角速度（sensor_gyro #${instanceId}）`,
        description: `sensor_gyro 实例 ${instanceId} 的角速度`,
        unit: vec.spec.unit,
        series: vectorViewSeries(`gyro-${instanceId}`, vec),
        defaultVisibleSeriesIds: AXIS_KEYS.map((k) => `gyro-${instanceId}-${k}`),
        xAxis: 'time',
        hasGaps: vectorHasGaps(vec),
      })
    }

    // ── Environment views: magnetic field, pressure, altitude, temperature ─
    for (const [instanceId, inst] of state.magInstances) {
      const vec = inst.vectors.get('magneticField')
      if (!vec || vec.axes[0]!.isEmpty) continue
      environmentViews.push({
        id: `mag-${instanceId}`,
        title: `磁场（#${instanceId}）`,
        description: `${inst.topicName} 实例 ${instanceId} 的磁场强度`,
        unit: vec.spec.unit,
        series: vectorViewSeries(`mag-${instanceId}`, vec),
        defaultVisibleSeriesIds: AXIS_KEYS.map((k) => `mag-${instanceId}-${k}`),
        xAxis: 'time',
        hasGaps: vectorHasGaps(vec),
      })
    }

    const scalarViewSpecs: Array<{ kind: SensorScalarKind; viewId: string }> = [
      { kind: 'pressure', viewId: 'baro-pressure' },
      { kind: 'altitude', viewId: 'baro-altitude' },
      { kind: 'temperature', viewId: 'sensor-temperature' },
    ]
    for (const { kind, viewId } of scalarViewSpecs) {
      const series: ChartSeries[] = []
      let unit = ''
      const scalarSources: Array<[string, Map<number, SensorInstanceState>]> = [
        ['baro', state.baroInstances],
        ['accel', state.accelInstances],
        ['gyro', state.gyroInstances],
        ['mag', state.magInstances],
      ]
      for (const [type, map] of scalarSources) {
        // Temperature exists on many sensors; pressure/altitude only on baro
        if (kind !== 'temperature' && type !== 'baro') continue
        for (const [instanceId, inst] of map) {
          const scalar = inst.scalars.get(kind)
          if (!scalar || scalar.collector.isEmpty) continue
          const { times, values } = scalar.collector.toSeries()
          unit = scalar.spec.unit
          series.push({
            id: `${viewId}-${type}-${instanceId}`,
            label: `${inst.topicName} #${instanceId}`,
            times,
            values,
          })
        }
      }
      if (series.length > 0) {
        environmentViews.push({
          id: viewId,
          title: SCALAR_KIND_LABELS[kind],
          description: `${SCALAR_KIND_LABELS[kind]}随时间的变化`,
          unit,
          series,
          defaultVisibleSeriesIds: series.slice(0, 6).map((s) => s.id),
          xAxis: 'time',
          hasGaps: false,
        })
      }
    }

    // ── Cross-instance inconsistency check (semantic axes only) ──────────
    const checkInconsistency = (results: SensorInstanceResult[], sensorType: string) => {
      if (results.length < 2) return
      const allFields = new Set<string>()
      for (const r of results) {
        for (const k of Object.keys(r.meanValues)) allFields.add(k)
      }
      for (const field of allFields) {
        const means = results
          .map(r => r.meanValues[field])
          .filter((v): v is number => typeof v === 'number' && isFinite(v))
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
            evidence: results.map((r) => ({
              topic: r.topicName,
              multiId: r.instanceId,
              fields: [field],
              startSec: null,
              endSec: null,
              observed: `平均值=${(r.meanValues[field] ?? NaN).toFixed(3)}`,
              threshold: `max_diff=${maxDiff.toFixed(3)}`,
            })),
          })
        }
      }
    }

    checkInconsistency(accelResults, 'accel')
    checkInconsistency(gyroResults, 'gyro')
    checkInconsistency(magResults, 'mag')

    // ── Chart families ────────────────────────────────────────────────────
    const chartFamilies: ChartFamily[] = []
    if (imuViews.length > 0) {
      chartFamilies.push({
        id: 'imu',
        moduleId: 'sensors',
        title: '惯性传感器',
        description: '加速度与角速度',
        views: imuViews,
        defaultViewId: imuViews[0]!.id,
        order: 10,
      })
    }
    if (vibrationViews.length > 0) {
      chartFamilies.push({
        id: 'vibration',
        moduleId: 'sensors',
        title: '振动频谱',
        description: '按传感器实例的幅度频谱',
        views: vibrationViews,
        defaultViewId: vibrationViews[0]!.id,
        order: 11,
      })
    }
    if (environmentViews.length > 0) {
      chartFamilies.push({
        id: 'environment-sensors',
        moduleId: 'sensors',
        title: '磁场与气压',
        description: '磁场、气压、高度与温度',
        views: environmentViews,
        defaultViewId: environmentViews[0]!.id,
        order: 12,
      })
    }

    // Legacy flat series (removed once the section-level family merge lands)
    for (const family of chartFamilies) {
      for (const view of family.views) {
        chartSeries.push({
          id: `sensors-${view.id}`,
          title: view.title,
          description: view.description,
          unit: view.unit,
          series: view.series.map((s) => ({ label: s.label, times: s.times, values: s.values })),
          hasGaps: view.hasGaps,
        })
      }
    }

    return {
      chartSeries,
      chartFamilies,
      metrics: {
        combinedSamples: combined.sampleCount,
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
        combinedSampleCount: combined.sampleCount,
      },
    }
  },
}
