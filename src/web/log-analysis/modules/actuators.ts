import type { AnalysisModule, AnalysisContext, ResolvedSample, ModuleResult } from '../engine/AnalysisModule.js'
import type { ChartSeriesGroup, DiagnosticFinding } from '../types.js'

// ─── Constants ──────────────────────────────────────────────────────────────

const MAX_CHART_POINTS = 2000
const SATURATION_THRESHOLD_SEC = 2.0

// ─── State types ────────────────────────────────────────────────────────────

interface MotorChannelData {
  values: number[]
  times: number[]
  nanGapCount: number
}

interface ActuatorState {
  /** Per-channel motor data from actuator_motors */
  motorChannels: Map<number, MotorChannelData>
  /** Per-channel output data from actuator_outputs */
  outputChannels: Map<number, MotorChannelData>
  /** Per-channel servo data from actuator_servos */
  servoChannels: Map<number, MotorChannelData>
  /** Which source was used: 'motors' | 'outputs' | 'servos' | null */
  primarySource: 'motors' | 'outputs' | 'servos' | null
}

// ─── Result type ────────────────────────────────────────────────────────────

interface ActuatorResult {
  motorCount: number
  outputCount: number
  motorStats: Array<{
    channel: number
    min: number
    max: number
    mean: number
    nanGapCount: number
    sampleCount: number
  }>
  pwmLimits: { min: number | null; max: number | null; disarmed: number | null }
  saturationDuration: Array<{ channel: number; durationSec: number }>
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function downsample(times: number[], values: number[], maxPoints: number): { times: number[]; values: number[] } {
  if (times.length <= maxPoints) return { times: [...times], values: [...values] }
  const step = Math.ceil(times.length / maxPoints)
  const t: number[] = []
  const v: number[] = []
  for (let i = 0; i < times.length; i += step) {
    t.push(times[i]!)
    v.push(values[i]!)
  }
  return { times: t, values: v }
}

/** Detect sustained saturation: consecutive samples at or near a limit for > threshold seconds */
function detectSaturation(
  times: number[],
  values: number[],
  limit: number,
  tolerance: number,
  minDuration: number,
): number {
  let totalSaturationSec = 0
  let windowStart: number | null = null

  for (let i = 0; i < values.length; i++) {
    const atLimit = Math.abs(values[i]! - limit) <= tolerance
    if (atLimit) {
      if (windowStart === null) windowStart = times[i]!
    } else {
      if (windowStart !== null) {
        const dur = times[i - 1]! - windowStart
        if (dur >= minDuration) totalSaturationSec += dur
        windowStart = null
      }
    }
  }
  if (windowStart !== null && times.length > 0) {
    const dur = times[times.length - 1]! - windowStart
    if (dur >= minDuration) totalSaturationSec += dur
  }
  return totalSaturationSec
}

// ─── Module ─────────────────────────────────────────────────────────────────

export const actuatorsModule: AnalysisModule<ActuatorState, ActuatorResult> = {
  id: 'actuators',
  section: 'control',

  requirements: [
    {
      aliases: ['actuator_motors'],
      required: false,
      bindAs: 'motors',
    },
    {
      aliases: ['actuator_outputs'],
      required: false,
      bindAs: 'outputs',
    },
    {
      aliases: ['actuator_servos'],
      required: false,
      bindAs: 'servos',
    },
    {
      aliases: ['vehicle_control_mode'],
      required: false,
      bindAs: 'controlMode',
    },
  ],

  create(_context: AnalysisContext): ActuatorState {
    return {
      motorChannels: new Map(),
      outputChannels: new Map(),
      servoChannels: new Map(),
      primarySource: null,
    }
  },

  consume(state: ActuatorState, sample: ResolvedSample, bindName: string): void {
    switch (bindName) {
      case 'motors': {
        state.primarySource = 'motors'
        for (const [key, val] of Object.entries(sample.values)) {
          const match = /^control\[(\d+)\]$/.exec(key)
          if (!match) continue
          const ch = parseInt(match[1]!)
          let chData = state.motorChannels.get(ch)
          if (!chData) {
            chData = { values: [], times: [], nanGapCount: 0 }
            state.motorChannels.set(ch, chData)
          }
          if (typeof val === 'number' && Number.isFinite(val)) {
            chData.times.push(sample.timeSec)
            chData.values.push(val)
          } else {
            chData.nanGapCount++
          }
        }
        break
      }
      case 'outputs': {
        if (state.primarySource === null) state.primarySource = 'outputs'
        for (const [key, val] of Object.entries(sample.values)) {
          const match = /^output\[(\d+)\]$/.exec(key)
          if (!match) continue
          const ch = parseInt(match[1]!)
          let chData = state.outputChannels.get(ch)
          if (!chData) {
            chData = { values: [], times: [], nanGapCount: 0 }
            state.outputChannels.set(ch, chData)
          }
          if (typeof val === 'number' && Number.isFinite(val)) {
            chData.times.push(sample.timeSec)
            chData.values.push(val)
          } else {
            chData.nanGapCount++
          }
        }
        break
      }
      case 'servos': {
        for (const [key, val] of Object.entries(sample.values)) {
          const match = /^control\[(\d+)\]$/.exec(key)
          if (!match) continue
          const ch = parseInt(match[1]!)
          let chData = state.servoChannels.get(ch)
          if (!chData) {
            chData = { values: [], times: [], nanGapCount: 0 }
            state.servoChannels.set(ch, chData)
          }
          if (typeof val === 'number' && Number.isFinite(val)) {
            chData.times.push(sample.timeSec)
            chData.values.push(val)
          } else {
            chData.nanGapCount++
          }
        }
        break
      }
      // controlMode: just consume, no special processing needed
    }
  },

  finalize(state: ActuatorState, context: AnalysisContext): ModuleResult<ActuatorState, ActuatorResult> {
    const findings: DiagnosticFinding[] = []
    const chartSeries: ChartSeriesGroup[] = []
    const metrics: Record<string, unknown> = {}
    const missingReqs: string[] = []

    // Determine primary data source
    const useMotors = state.motorChannels.size > 0
    const useOutputs = state.outputChannels.size > 0
    const useServos = state.servoChannels.size > 0

    if (!useMotors && !useOutputs && !useServos) {
      missingReqs.push('motors', 'outputs')
    }

    // ─── PWM limits from parameters ───────────────────────────────────

    let pwmMin: number | null = null
    let pwmMax: number | null = null
    let pwmDisarmed: number | null = null

    for (const p of context.parameters) {
      if (p.name === 'PWM_MIN' && typeof p.value === 'number') pwmMin = p.value
      if (p.name === 'PWM_MAX' && typeof p.value === 'number') pwmMax = p.value
      if (p.name === 'PWM_DISARMED' && typeof p.value === 'number') pwmDisarmed = p.value
    }

    metrics.pwmLimits = { min: pwmMin, max: pwmMax, disarmed: pwmDisarmed }

    // ─── Motor statistics ─────────────────────────────────────────────

    const motorStats: ActuatorResult['motorStats'] = []
    const saturationDurations: Array<{ channel: number; durationSec: number }> = []

    if (useMotors) {
      const sortedChannels = [...state.motorChannels.entries()].sort((a, b) => a[0] - b[0])
      metrics.motorCount = sortedChannels.length

      for (const [ch, data] of sortedChannels) {
        const finiteVals = data.values.filter(v => Number.isFinite(v))
        const min = finiteVals.length > 0 ? Math.min(...finiteVals) : NaN
        const max = finiteVals.length > 0 ? Math.max(...finiteVals) : NaN
        const mean = finiteVals.length > 0 ? finiteVals.reduce((s, v) => s + v, 0) / finiteVals.length : NaN

        motorStats.push({
          channel: ch,
          min,
          max,
          mean,
          nanGapCount: data.nanGapCount,
          sampleCount: data.values.length,
        })

        // NaN gap finding
        if (data.nanGapCount > 0) {
          findings.push({
            id: `actuators-nan-gap-motor-${ch}`,
            moduleId: 'actuators',
            section: 'control',
            severity: 'critical',
            confidence: 'measured',
            title: `电机 ${ch} 输出存在无效数据缺口`,
            summary: `电机 ${ch} 输出中检测到 ${data.nanGapCount} 个 NaN 缺口`,
            recommendation: '请检查执行器配置和混控器',
            evidence: [{
              topic: 'actuator_motors',
              multiId: 0,
              fields: [`control[${ch}]`],
              startSec: null,
              endSec: null,
              observed: `${data.nanGapCount} 个 NaN 缺口`,
              threshold: null,
            }],
          })
        }

        // Saturation detection
        if (pwmMin !== null && pwmMax !== null) {
          // For normalized motor output (0–1), map PWM limits to normalized
          // Actuator motors typically use -1..1 or 0..1 range
          const satTolerance = 0.02 // 2% tolerance for normalized output
          const satDur = detectSaturation(data.times, data.values, 1.0, satTolerance, SATURATION_THRESHOLD_SEC)
          const satDurMin = detectSaturation(data.times, data.values, -1.0, satTolerance, SATURATION_THRESHOLD_SEC)
          const totalSat = satDur + satDurMin

          if (totalSat > 0) {
            saturationDurations.push({ channel: ch, durationSec: totalSat })
          }
        } else {
          // Heuristic saturation: value at exactly 1.0 or -1.0
          const satTolerance = 0.001
          const satDur = detectSaturation(data.times, data.values, 1.0, satTolerance, SATURATION_THRESHOLD_SEC)
          const satDurMin = detectSaturation(data.times, data.values, -1.0, satTolerance, SATURATION_THRESHOLD_SEC)
          const totalSat = satDur + satDurMin
          if (totalSat > 0) {
            saturationDurations.push({ channel: ch, durationSec: totalSat })
          }
        }
      }
    } else if (useOutputs) {
      metrics.outputCount = state.outputChannels.size
      const sortedChannels = [...state.outputChannels.entries()].sort((a, b) => a[0] - b[0])

      for (const [ch, data] of sortedChannels) {
        const finiteVals = data.values.filter(v => Number.isFinite(v))
        const min = finiteVals.length > 0 ? Math.min(...finiteVals) : NaN
        const max = finiteVals.length > 0 ? Math.max(...finiteVals) : NaN
        const mean = finiteVals.length > 0 ? finiteVals.reduce((s, v) => s + v, 0) / finiteVals.length : NaN

        motorStats.push({
          channel: ch,
          min,
          max,
          mean,
          nanGapCount: data.nanGapCount,
          sampleCount: data.values.length,
        })
      }
    }

    metrics.motorStats = motorStats
    metrics.saturationDuration = saturationDurations

    // Saturation findings
    for (const sat of saturationDurations) {
      const confidence = (pwmMin !== null && pwmMax !== null) ? 'measured' : 'heuristic'
      findings.push({
        id: `actuators-saturation-motor-${sat.channel}`,
        moduleId: 'actuators',
        section: 'control',
        severity: 'warning',
        confidence,
        title: `电机 ${sat.channel} 持续饱和`,
        summary: `电机 ${sat.channel} 在输出极限停留了 ${sat.durationSec.toFixed(1)} 秒`,
        recommendation: '请检查混控限制和控制分配',
        evidence: [{
          topic: 'actuator_motors',
          multiId: 0,
          fields: [`control[${sat.channel}]`],
          startSec: null,
          endSec: null,
          observed: `在极限停留 ${sat.durationSec.toFixed(1)} 秒`,
          threshold: `${SATURATION_THRESHOLD_SEC} 秒`,
        }],
      })
    }

    // ─── Chart series ─────────────────────────────────────────────────

    if (useMotors) {
      const sortedChannels = [...state.motorChannels.entries()].sort((a, b) => a[0] - b[0])
      const series: ChartSeriesGroup['series'] = []
      const colors = ['#e74c3c', '#2ecc71', '#3498db', '#f39c12', '#9b59b6', '#1abc9c', '#e67e22', '#34495e']

      for (let i = 0; i < sortedChannels.length; i++) {
        const [ch, data] = sortedChannels[i]!
        const ds = downsample(data.times, data.values, MAX_CHART_POINTS)
        series.push({
          label: `电机 ${ch}`,
          times: ds.times,
          values: ds.values,
          color: colors[i % colors.length],
        })
      }

      if (series.length > 0) {
        chartSeries.push({
          id: 'motor-commands',
          title: '电机指令',
          description: '各电机控制输出随时间的变化',
          unit: 'normalized',
          series,
          thresholds: [
            { value: 1.0, label: '最大值', severity: 'warning' },
            { value: -1.0, label: '最小值', severity: 'warning' },
          ],
          hasGaps: motorStats.some(s => s.nanGapCount > 0),
        })
      }

      // Saturation bar chart data
      if (saturationDurations.length > 0) {
        chartSeries.push({
          id: 'motor-saturation',
          title: '电机饱和时长',
          description: '各电机停留在输出极限的时长',
          unit: 's',
          series: [{
            label: '饱和时长',
            times: saturationDurations.map(s => s.channel),
            values: saturationDurations.map(s => s.durationSec),
          }],
          hasGaps: false,
        })
      }
    } else if (useOutputs) {
      const sortedChannels = [...state.outputChannels.entries()].sort((a, b) => a[0] - b[0])
      const series: ChartSeriesGroup['series'] = []
      const colors = ['#e74c3c', '#2ecc71', '#3498db', '#f39c12', '#9b59b6', '#1abc9c']

      for (let i = 0; i < sortedChannels.length; i++) {
        const [ch, data] = sortedChannels[i]!
        const ds = downsample(data.times, data.values, MAX_CHART_POINTS)
        series.push({
          label: `输出 ${ch}`,
          times: ds.times,
          values: ds.values,
          color: colors[i % colors.length],
        })
      }

      if (series.length > 0) {
        chartSeries.push({
          id: 'output-commands',
          title: '输出指令',
          description: '各通道输出值随时间的变化',
          unit: 'PWM',
          series,
          hasGaps: motorStats.some(s => s.nanGapCount > 0),
        })
      }
    }

    // ─── Consumed topics ──────────────────────────────────────────────

    const consumedTopics: Array<{ name: string; multiId: number; msgId: number }> = []
    for (const [, topic] of context.resolvedTopics) {
      consumedTopics.push({ name: topic.name, multiId: topic.multiId, msgId: topic.msgId })
    }

    return {
      chartSeries,
      metrics,
      findings,
      consumedTopics,
      missingRequirements: missingReqs,
      warnings: [],
      result: {
        motorCount: useMotors ? state.motorChannels.size : 0,
        outputCount: useOutputs ? state.outputChannels.size : 0,
        motorStats,
        pwmLimits: { min: pwmMin, max: pwmMax, disarmed: pwmDisarmed },
        saturationDuration: saturationDurations,
      },
    }
  },
}
