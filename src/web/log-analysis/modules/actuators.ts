import type { AnalysisModule, AnalysisContext, ResolvedSample, ModuleResult } from '../engine/AnalysisModule.js'
import type { ChartSeriesGroup, ChartFamily, ChartView, ChartSeries, DiagnosticFinding } from '../types.js'
import { readArmedState, ARMED_SOURCE_RANK, type ArmedSource } from '../px4/flightState.js'
import {
  resolveMotorLayout,
  classifyInvalidGap,
  motorLabel,
  type ChannelEvidence,
  type MotorLayout,
} from '../px4/actuatorLayout.js'

// ─── Constants ──────────────────────────────────────────────────────────────

const MAX_CHART_POINTS = 2000
const SATURATION_THRESHOLD_SEC = 2.0
/** Motor output defaults to all configured motors when count ≤ 6 */
const MAX_DEFAULT_VISIBLE_MOTORS = 6
/** Gap runs starting within this window of the final disarm are the disarm itself */
const FINAL_DISARM_EPSILON_SEC = 0.5
const GAP_THRESHOLD_DESCRIPTION = '解锁期间持续 ≥0.2 秒或占比 ≥5%'

// ─── State types ────────────────────────────────────────────────────────────

/** Per-channel evidence: nothing becomes a "motor" just because a slot exists. */
interface MotorChannelState {
  channelIndex: number
  finiteSamples: number
  invalidSamplesAfterActivation: number
  firstFiniteSec: number | null
  lastFiniteSec: number | null
  /** Times/values including NaN entries (only after first finite) for chart gaps */
  times: number[]
  values: number[]
  /** Closed invalid runs (NaN stretches after the channel produced data) */
  invalidRuns: Array<{ startSec: number; endSec: number; samples: number }>
  openInvalidRun: { startSec: number; samples: number } | null
}

interface ActuatorState {
  /** Per-channel motor data from actuator_motors */
  motorChannels: Map<number, MotorChannelState>
  /** Per-channel output data from actuator_outputs */
  outputChannels: Map<number, MotorChannelState>
  /** Per-channel servo data from actuator_servos */
  servoChannels: Map<number, MotorChannelState>
  /** Armed intervals built from vehicle_status / actuator_armed */
  armedRanges: Array<{ start: number; end: number }>
  currentArmedStart: number | null
  isArmed: boolean
  hasArmedInfo: boolean
  armedSourceRank: number
}

// ─── Result type ────────────────────────────────────────────────────────────

interface ActuatorResult {
  motorCount: number
  outputCount: number
  layout: MotorLayout | null
  motorStats: Array<{
    channelIndex: number
    min: number
    max: number
    mean: number
    invalidSamples: number
    sampleCount: number
  }>
  pwmLimits: { min: number | null; max: number | null; disarmed: number | null }
  saturationDuration: Array<{ channelIndex: number; durationSec: number }>
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
  // Always keep the last sample so the chart spans the full log
  if (t[t.length - 1] !== times[times.length - 1]) {
    t.push(times[times.length - 1]!)
    v.push(values[values.length - 1]!)
  }
  return { times: t, values: v }
}

/** Duration of [start, end] overlapping any armed range */
function armedOverlapSec(
  start: number,
  end: number,
  ranges: Array<{ start: number; end: number }>,
): number {
  let overlap = 0
  for (const r of ranges) {
    const s = Math.max(start, r.start)
    const e = Math.min(end, r.end)
    if (e > s) overlap += e - s
  }
  return overlap
}

/** Count finite samples whose time falls inside an armed range */
function countFiniteArmedSamples(
  ch: MotorChannelState,
  ranges: Array<{ start: number; end: number }>,
): number {
  if (ranges.length === 0) return 0
  let count = 0
  let ri = 0
  for (let i = 0; i < ch.times.length; i++) {
    if (!Number.isFinite(ch.values[i]!)) continue
    const t = ch.times[i]!
    while (ri < ranges.length && ranges[ri]!.end < t) ri++
    if (ri >= ranges.length) break
    if (t >= ranges[ri]!.start && t <= ranges[ri]!.end) count++
  }
  return count
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

function makeChannelState(channelIndex: number): MotorChannelState {
  return {
    channelIndex,
    finiteSamples: 0,
    invalidSamplesAfterActivation: 0,
    firstFiniteSec: null,
    lastFiniteSec: null,
    times: [],
    values: [],
    invalidRuns: [],
    openInvalidRun: null,
  }
}

/** Record one channel sample, maintaining finite counters and invalid runs. */
function recordChannelSample(
  ch: MotorChannelState,
  timeSec: number,
  value: unknown,
): void {
  const finite = typeof value === 'number' && Number.isFinite(value)
  if (finite) {
    if (ch.openInvalidRun) {
      ch.invalidRuns.push({
        startSec: ch.openInvalidRun.startSec,
        endSec: timeSec,
        samples: ch.openInvalidRun.samples,
      })
      ch.openInvalidRun = null
    }
    if (ch.firstFiniteSec === null) ch.firstFiniteSec = timeSec
    ch.lastFiniteSec = timeSec
    ch.finiteSamples++
    ch.times.push(timeSec)
    ch.values.push(value)
  } else if (ch.firstFiniteSec !== null) {
    // Invalid only counts after the channel has produced data. Slots that
    // never produced data are simply unused — no run, no chart, no finding.
    ch.invalidSamplesAfterActivation++
    if (!ch.openInvalidRun) {
      ch.openInvalidRun = { startSec: timeSec, samples: 1 }
    } else {
      ch.openInvalidRun.samples++
    }
    // NaN entry breaks the chart line at the gap
    ch.times.push(timeSec)
    ch.values.push(NaN)
  }
}

function applyArmedReading(
  state: ActuatorState,
  timeSec: number,
  armed: boolean | null,
  source: ArmedSource,
): void {
  if (armed === null) return
  const rank = ARMED_SOURCE_RANK[source]
  if (rank < state.armedSourceRank) return
  state.armedSourceRank = rank
  state.hasArmedInfo = true

  if (armed && !state.isArmed) {
    state.isArmed = true
    state.currentArmedStart = timeSec
  } else if (!armed && state.isArmed) {
    state.isArmed = false
    if (state.currentArmedStart !== null) {
      state.armedRanges.push({ start: state.currentArmedStart, end: timeSec })
      state.currentArmedStart = null
    }
  }
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
      aliases: ['vehicle_status'],
      required: false,
      bindAs: 'vehicleStatus',
    },
    {
      aliases: ['actuator_armed'],
      required: false,
      bindAs: 'actuatorArmed',
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
      armedRanges: [],
      currentArmedStart: null,
      isArmed: false,
      hasArmedInfo: false,
      armedSourceRank: 0,
    }
  },

  consume(state: ActuatorState, sample: ResolvedSample, bindName: string): void {
    switch (bindName) {
      case 'motors': {
        for (const [key, val] of Object.entries(sample.values)) {
          const match = /^control\[(\d+)\]$/.exec(key)
          if (!match) continue
          const idx = parseInt(match[1]!)
          let ch = state.motorChannels.get(idx)
          if (!ch) {
            ch = makeChannelState(idx)
            state.motorChannels.set(idx, ch)
          }
          recordChannelSample(ch, sample.timeSec, val)
        }
        break
      }
      case 'outputs': {
        for (const [key, val] of Object.entries(sample.values)) {
          const match = /^output\[(\d+)\]$/.exec(key)
          if (!match) continue
          const idx = parseInt(match[1]!)
          let ch = state.outputChannels.get(idx)
          if (!ch) {
            ch = makeChannelState(idx)
            state.outputChannels.set(idx, ch)
          }
          recordChannelSample(ch, sample.timeSec, val)
        }
        break
      }
      case 'servos': {
        for (const [key, val] of Object.entries(sample.values)) {
          const match = /^control\[(\d+)\]$/.exec(key)
          if (!match) continue
          const idx = parseInt(match[1]!)
          let ch = state.servoChannels.get(idx)
          if (!ch) {
            ch = makeChannelState(idx)
            state.servoChannels.set(idx, ch)
          }
          recordChannelSample(ch, sample.timeSec, val)
        }
        break
      }
      case 'vehicleStatus':
        applyArmedReading(state, sample.timeSec, readArmedState(sample.topic.name, sample.values), 'vehicle_status')
        break
      case 'actuatorArmed':
        applyArmedReading(state, sample.timeSec, readArmedState('actuator_armed', sample.values), 'actuator_armed')
        break
      // controlMode: just consume, no special processing needed
    }
  },

  finalize(state: ActuatorState, context: AnalysisContext): ModuleResult<ActuatorState, ActuatorResult> {
    const findings: DiagnosticFinding[] = []
    const chartSeries: ChartSeriesGroup[] = []
    const metrics: Record<string, unknown> = {}
    const missingReqs: string[] = []
    const warnings: string[] = []

    // Close final armed range
    if (state.isArmed && state.currentArmedStart !== null) {
      state.armedRanges.push({ start: state.currentArmedStart, end: context.logEndSec })
      state.currentArmedStart = null
    }
    // Close open invalid runs at log end
    for (const chans of [state.motorChannels, state.outputChannels, state.servoChannels]) {
      for (const [, ch] of chans) {
        if (ch.openInvalidRun) {
          ch.invalidRuns.push({
            startSec: ch.openInvalidRun.startSec,
            endSec: context.logEndSec,
            samples: ch.openInvalidRun.samples,
          })
          ch.openInvalidRun = null
        }
      }
    }

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

    // ─── Configured motor discovery ───────────────────────────────────

    let layout: MotorLayout | null = null
    const motorStats: ActuatorResult['motorStats'] = []
    const saturationDurations: Array<{ channelIndex: number; durationSec: number }> = []
    const configuredMotorChannels: MotorChannelState[] = []

    if (useMotors) {
      const channelEvidence: ChannelEvidence[] = []
      for (const [, ch] of state.motorChannels) {
        channelEvidence.push({
          channelIndex: ch.channelIndex,
          finiteSamples: ch.finiteSamples,
          finiteArmedSamples: countFiniteArmedSamples(ch, state.armedRanges),
        })
      }

      layout = resolveMotorLayout(context.parameters, channelEvidence)
      metrics.motorCount = layout.motorCount
      metrics.motorLayoutSource = layout.source
      if (layout.inferred && layout.motorCount > 0) {
        warnings.push(`电机数量由数据推断（${layout.motorCount} 个），日志中缺少 CA_ROTOR_COUNT 参数`)
      }

      const configuredSet = new Set(layout.configuredChannels)
      const finalDisarmSec = state.armedRanges.length > 0
        ? state.armedRanges[state.armedRanges.length - 1]!.end
        : null

      for (const idx of [...state.motorChannels.keys()].sort((a, b) => a - b)) {
        const ch = state.motorChannels.get(idx)!
        if (!configuredSet.has(idx)) continue // unused slots: no metrics/series/findings
        configuredMotorChannels.push(ch)

        const finiteVals = ch.values.filter((v) => Number.isFinite(v))
        const min = finiteVals.length > 0 ? Math.min(...finiteVals) : NaN
        const max = finiteVals.length > 0 ? Math.max(...finiteVals) : NaN
        const mean = finiteVals.length > 0 ? finiteVals.reduce((s, v) => s + v, 0) / finiteVals.length : NaN

        motorStats.push({
          channelIndex: ch.channelIndex,
          min,
          max,
          mean,
          invalidSamples: ch.invalidSamplesAfterActivation,
          sampleCount: ch.finiteSamples,
        })

        // ── Invalid-gap findings (specification-based, not NaN==corruption) ──
        for (const run of ch.invalidRuns) {
          const overlap = armedOverlapSec(run.startSec, run.endSec, state.armedRanges)
          const isFinalDisarm = finalDisarmSec !== null &&
            run.startSec >= finalDisarmSec - FINAL_DISARM_EPSILON_SEC
          const severity = classifyInvalidGap({
            configured: true,
            hadFiniteBefore: ch.firstFiniteSec !== null && run.startSec > ch.firstFiniteSec,
            armedDurationSec: overlap,
            invalidRatio: run.samples / Math.max(1, ch.times.length),
            isFinalDisarmTransition: isFinalDisarm,
            corroborated: false, // no independent ESC/failure evidence in this module
          })
          if (severity === 'none') continue
          findings.push({
            id: `actuators-nan-gap-motor-${ch.channelIndex}-${run.startSec.toFixed(2)}`,
            moduleId: 'actuators',
            section: 'control',
            severity,
            confidence: 'measured',
            title: `${motorLabel(ch.channelIndex)} 输出在解锁期间出现无效数据缺口`,
            summary: `${motorLabel(ch.channelIndex)} 在 ${run.startSec.toFixed(1)}s–${run.endSec.toFixed(1)}s 期间输出无效（${run.samples} 个采样）`,
            recommendation: severity === 'warning'
              ? '请检查控制分配与该电机的输出链路'
              : null,
            evidence: [{
              topic: 'actuator_motors',
              multiId: 0,
              fields: [`control[${ch.channelIndex}]`],
              startSec: run.startSec,
              endSec: run.endSec,
              observed: `解锁期间无效 ${overlap.toFixed(2)} 秒`,
              threshold: `${GAP_THRESHOLD_DESCRIPTION}`,
            }],
          })
        }

        // ── Saturation detection ──
        const satTolerance = pwmMin !== null && pwmMax !== null ? 0.02 : 0.001
        const satDur = detectSaturation(ch.times, ch.values, 1.0, satTolerance, SATURATION_THRESHOLD_SEC)
        const satDurMin = detectSaturation(ch.times, ch.values, -1.0, satTolerance, SATURATION_THRESHOLD_SEC)
        const totalSat = satDur + satDurMin
        if (totalSat > 0) {
          saturationDurations.push({ channelIndex: ch.channelIndex, durationSec: totalSat })
        }
      }
    } else if (useOutputs) {
      metrics.outputCount = state.outputChannels.size
      const sortedChannels = [...state.outputChannels.entries()].sort((a, b) => a[0] - b[0])

      for (const [idx, ch] of sortedChannels) {
        const finiteVals = ch.values.filter((v) => Number.isFinite(v))
        const min = finiteVals.length > 0 ? Math.min(...finiteVals) : NaN
        const max = finiteVals.length > 0 ? Math.max(...finiteVals) : NaN
        const mean = finiteVals.length > 0 ? finiteVals.reduce((s, v) => s + v, 0) / finiteVals.length : NaN

        motorStats.push({
          channelIndex: idx,
          min,
          max,
          mean,
          invalidSamples: ch.invalidSamplesAfterActivation,
          sampleCount: ch.finiteSamples,
        })
      }
    }

    metrics.motorStats = motorStats
    // Saturation lives in metrics/details — not a fake time-series chart
    metrics.saturationDuration = saturationDurations

    for (const sat of saturationDurations) {
      const confidence = (pwmMin !== null && pwmMax !== null) ? 'measured' : 'heuristic'
      findings.push({
        id: `actuators-saturation-motor-${sat.channelIndex}`,
        moduleId: 'actuators',
        section: 'control',
        severity: 'warning',
        confidence,
        title: `${motorLabel(sat.channelIndex)} 持续饱和`,
        summary: `${motorLabel(sat.channelIndex)} 在输出极限停留了 ${sat.durationSec.toFixed(1)} 秒`,
        recommendation: '请检查混控限制和控制分配',
        evidence: [{
          topic: 'actuator_motors',
          multiId: 0,
          fields: [`control[${sat.channelIndex}]`],
          startSec: null,
          endSec: null,
          observed: `在极限停留 ${sat.durationSec.toFixed(1)} 秒`,
          threshold: `${SATURATION_THRESHOLD_SEC} 秒`,
        }],
      })
    }

    // ─── Chart views ──────────────────────────────────────────────────

    const views: ChartView[] = []

    if (configuredMotorChannels.length > 0) {
      const series: ChartSeries[] = []
      for (const ch of configuredMotorChannels) {
        const ds = downsample(ch.times, ch.values, MAX_CHART_POINTS)
        series.push({
          id: `motor-${ch.channelIndex}`,
          label: motorLabel(ch.channelIndex),
          times: ds.times,
          values: ds.values,
        })
      }
      const defaultVisible = series
        .slice(0, MAX_DEFAULT_VISIBLE_MOTORS)
        .map((s) => s.id)
      views.push({
        id: 'motor-outputs',
        title: '电机输出',
        description: '各已配置电机的归一化控制输出',
        unit: 'normalized',
        series,
        defaultVisibleSeriesIds: defaultVisible,
        thresholds: [
          { value: 1.0, label: '最大值', severity: 'warning' },
          { value: -1.0, label: '最小值', severity: 'warning' },
        ],
        xAxis: 'time',
        hasGaps: motorStats.some((s) => s.invalidSamples > 0),
      })
    }

    if (useOutputs) {
      const sortedChannels = [...state.outputChannels.entries()].sort((a, b) => a[0] - b[0])
      const series: ChartSeries[] = sortedChannels
        .filter(([, ch]) => ch.finiteSamples > 0)
        .map(([idx, ch]) => {
          const ds = downsample(ch.times, ch.values, MAX_CHART_POINTS)
          return {
            id: `output-${idx}`,
            label: `输出 ${idx + 1}`,
            times: ds.times,
            values: ds.values,
          }
        })
      if (series.length > 0) {
        views.push({
          id: 'output-commands',
          title: '输出指令',
          description: '各输出通道的原始输出值',
          unit: 'PWM',
          series,
          defaultVisibleSeriesIds: series.slice(0, MAX_DEFAULT_VISIBLE_MOTORS).map((s) => s.id),
          xAxis: 'time',
          hasGaps: false,
        })
      }
    }

    if (useServos) {
      const sortedChannels = [...state.servoChannels.entries()].sort((a, b) => a[0] - b[0])
      const series: ChartSeries[] = sortedChannels
        .filter(([, ch]) => ch.finiteSamples > 0)
        .map(([idx, ch]) => {
          const ds = downsample(ch.times, ch.values, MAX_CHART_POINTS)
          return {
            id: `servo-${idx}`,
            label: `舵机 ${idx + 1}`,
            times: ds.times,
            values: ds.values,
          }
        })
      if (series.length > 0) {
        views.push({
          id: 'servo-commands',
          title: '舵机指令',
          description: '各舵机的归一化控制输出',
          unit: 'normalized',
          series,
          defaultVisibleSeriesIds: series.slice(0, MAX_DEFAULT_VISIBLE_MOTORS).map((s) => s.id),
          xAxis: 'time',
          hasGaps: false,
        })
      }
    }

    const chartFamilies: ChartFamily[] = []
    if (views.length > 0) {
      chartFamilies.push({
        id: 'actuators',
        moduleId: 'actuators',
        title: '执行器',
        description: '电机、输出与舵机指令',
        views,
        defaultViewId: views[0]!.id,
        order: 20,
      })
    }

    // Legacy flat series (removed once the section-level family merge lands)
    for (const view of views) {
      chartSeries.push({
        id: view.id === 'motor-outputs' ? 'motor-commands' : view.id,
        title: view.title,
        description: view.description,
        unit: view.unit,
        series: view.series.map((s) => ({ label: s.label, times: s.times, values: s.values })),
        thresholds: view.thresholds,
        hasGaps: view.hasGaps,
      })
    }

    // ─── Consumed topics ──────────────────────────────────────────────

    const consumedTopics: Array<{ name: string; multiId: number; msgId: number }> = []
    for (const [, topic] of context.resolvedTopics) {
      consumedTopics.push({ name: topic.name, multiId: topic.multiId, msgId: topic.msgId })
    }

    return {
      chartSeries,
      chartFamilies,
      metrics,
      findings,
      consumedTopics,
      missingRequirements: missingReqs,
      warnings,
      result: {
        motorCount: layout?.motorCount ?? 0,
        outputCount: useOutputs ? state.outputChannels.size : 0,
        layout,
        motorStats,
        pwmLimits: { min: pwmMin, max: pwmMax, disarmed: pwmDisarmed },
        saturationDuration: saturationDurations,
      },
    }
  },
}
