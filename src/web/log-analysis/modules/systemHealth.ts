import type { AnalysisModule, AnalysisContext, ResolvedSample, ModuleResult } from '../engine/AnalysisModule.js'
import type { DiagnosticFinding, ChartSeriesGroup } from '../types.js'

// ── State types ──────────────────────────────────────────────────────────────

interface SystemHealthState {
  cpuLoadSamples: Array<{ timeSec: number; load: number; ramUsage: number }>
  systemPowerSamples: Array<{ timeSec: number; values: Record<string, number> }>
  magnetometerSamples: Array<{ timeSec: number; values: Record<string, number> }>
  /** Track max CPU load for quick check */
  maxCpuLoad: number
  /** Track sustained high CPU periods */
  highCpuStart: number | null
  highCpuTotalSec: number
  /** Track max RAM usage */
  maxRamUsage: number
}

// ── Result types ─────────────────────────────────────────────────────────────

interface SystemHealthResult {
  cpuLoadSamples: number
  systemPowerSamples: number
  magnetometerSamples: number
  maxCpuLoad: number
  maxRamUsage: number
  sustainedHighCpuSec: number
  dropoutCount: number
  dropoutTotalMs: number
  dropoutMaxMs: number
}

// ── Constants ────────────────────────────────────────────────────────────────

const MAX_CHART_POINTS = 2000
const CPU_WARNING_THRESHOLD = 80
const CPU_CRITICAL_THRESHOLD = 80
const RAM_CRITICAL_THRESHOLD = 90

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

// ── Module ───────────────────────────────────────────────────────────────────

export const systemHealthModule: AnalysisModule<SystemHealthState, SystemHealthResult> = {
  id: 'system-health',
  section: 'events-raw',

  requirements: [
    {
      aliases: ['cpuload'],
      required: false,
      bindAs: 'cpuLoad',
    },
    {
      aliases: ['system_power'],
      required: false,
      bindAs: 'systemPower',
    },
    {
      aliases: ['vehicle_magnetometer'],
      required: false,
      bindAs: 'magnetometer',
    },
  ],

  create(_context: AnalysisContext): SystemHealthState {
    return {
      cpuLoadSamples: [],
      systemPowerSamples: [],
      magnetometerSamples: [],
      maxCpuLoad: 0,
      highCpuStart: null,
      highCpuTotalSec: 0,
      maxRamUsage: 0,
    }
  },

  consume(state: SystemHealthState, sample: ResolvedSample, bindName: string): void {
    if (bindName === 'cpuLoad') {
      // Extract CPU load (could be 'load' or 'cpu_load' field, typically 0-100 or 0-1 as fraction)
      let load = typeof sample.values['load'] === 'number' ? sample.values['load'] as number : 0
      // If load is 0-1 fraction, convert to percentage
      if (load > 0 && load <= 1.0) load *= 100

      // Extract RAM usage (could be 'ram_usage' field, typically bytes or percentage)
      let ramUsage = typeof sample.values['ram_usage'] === 'number' ? sample.values['ram_usage'] as number : 0
      // If ram_usage is in bytes, we need total RAM to compute percentage — for now keep raw
      // If it's already percentage (0-100), keep it
      const ramPercent = ramUsage > 100 ? 0 : ramUsage // crude heuristic: if > 100, it's bytes not %

      if (state.cpuLoadSamples.length < MAX_CHART_POINTS) {
        state.cpuLoadSamples.push({ timeSec: sample.timeSec, load, ramUsage: ramPercent })
      }

      if (load > state.maxCpuLoad) state.maxCpuLoad = load
      if (ramPercent > state.maxRamUsage) state.maxRamUsage = ramPercent

      // Track sustained high CPU
      if (load > CPU_CRITICAL_THRESHOLD) {
        if (state.highCpuStart === null) {
          state.highCpuStart = sample.timeSec
        }
      } else {
        if (state.highCpuStart !== null) {
          state.highCpuTotalSec += sample.timeSec - state.highCpuStart
          state.highCpuStart = null
        }
      }
    } else if (bindName === 'systemPower') {
      const numericValues: Record<string, number> = {}
      for (const [k, v] of Object.entries(sample.values)) {
        if (typeof v === 'number') numericValues[k] = v
      }
      if (state.systemPowerSamples.length < MAX_CHART_POINTS) {
        state.systemPowerSamples.push({ timeSec: sample.timeSec, values: numericValues })
      }
    } else if (bindName === 'magnetometer') {
      const numericValues: Record<string, number> = {}
      for (const [k, v] of Object.entries(sample.values)) {
        if (typeof v === 'number') numericValues[k] = v
      }
      if (state.magnetometerSamples.length < MAX_CHART_POINTS) {
        state.magnetometerSamples.push({ timeSec: sample.timeSec, values: numericValues })
      }
    }
  },

  finalize(state: SystemHealthState, context: AnalysisContext): ModuleResult<SystemHealthState, SystemHealthResult> {
    const findings: DiagnosticFinding[] = []
    const chartSeries: ChartSeriesGroup[] = []

    // Close any open high CPU window
    if (state.highCpuStart !== null && state.cpuLoadSamples.length > 0) {
      const last = state.cpuLoadSamples[state.cpuLoadSamples.length - 1]
      if (last) {
        state.highCpuTotalSec += last.timeSec - state.highCpuStart
      }
    }

    // ── Findings ────────────────────────────────────────────────────────────
    // Sustained high CPU
    if (state.highCpuTotalSec >= 5.0) {
      findings.push({
        id: 'system-health-high-cpu',
        moduleId: 'system-health',
        section: 'events-raw',
        severity: 'warning',
        confidence: 'measured',
        title: 'CPU 持续高负载',
        summary: `CPU 负载超过 ${CPU_CRITICAL_THRESHOLD}% 的累计时长为 ${state.highCpuTotalSec.toFixed(1)} 秒（最高 ${state.maxCpuLoad.toFixed(1)}%）。`,
        recommendation: '请降低计算负载，或检查是否存在异常进程。',
        evidence: [{
          topic: 'cpuload',
          multiId: 0,
          fields: ['load'],
          startSec: null,
          endSec: null,
          observed: `最高=${state.maxCpuLoad.toFixed(1)}%，持续=${state.highCpuTotalSec.toFixed(1)}秒`,
          threshold: `${CPU_CRITICAL_THRESHOLD}%`,
        }],
      })
    }

    // High RAM
    if (state.maxRamUsage > RAM_CRITICAL_THRESHOLD) {
      findings.push({
        id: 'system-health-high-ram',
        moduleId: 'system-health',
        section: 'events-raw',
        severity: 'critical',
        confidence: 'measured',
        title: '内存占用过高',
        summary: `内存占用峰值达到 ${state.maxRamUsage.toFixed(1)}%，超过 ${RAM_CRITICAL_THRESHOLD}% 的阈值。`,
        recommendation: '请检查内存泄漏，或降低日志记录频率。',
        evidence: [{
          topic: 'cpuload',
          multiId: 0,
          fields: ['ram_usage'],
          startSec: null,
          endSec: null,
          observed: `最高=${state.maxRamUsage.toFixed(1)}%`,
          threshold: `${RAM_CRITICAL_THRESHOLD}%`,
        }],
      })
    }

    // Dropout statistics from context timeline
    const dropoutCount = context.allSubscriptions.length > 0
      ? 0  // We'll get this from the document timeline via metadata
      : 0

    // ── Chart series: CPU load ──────────────────────────────────────────────
    if (state.cpuLoadSamples.length > 0) {
      const times = state.cpuLoadSamples.map(s => s.timeSec)
      const loads = state.cpuLoadSamples.map(s => s.load)
      const ds = downsample(times, loads, MAX_CHART_POINTS)
      chartSeries.push({
        id: 'system-health-cpu-load',
          title: 'CPU 负载',
          description: 'CPU 负载百分比随时间的变化',
        unit: '%',
        series: [{ label: 'CPU 负载', times: ds.times, values: ds.values }],
        thresholds: [
          { value: CPU_WARNING_THRESHOLD, label: '警告阈值', severity: 'warning' },
        ],
        hasGaps: false,
      })

      // RAM usage chart
      const ramValues = state.cpuLoadSamples.map(s => s.ramUsage)
      if (ramValues.some(v => v > 0)) {
        const dsRam = downsample(times, ramValues, MAX_CHART_POINTS)
        chartSeries.push({
          id: 'system-health-ram-usage',
          title: '内存占用',
          description: '内存占用百分比随时间的变化',
          unit: '%',
          series: [{ label: '内存占用', times: dsRam.times, values: dsRam.values }],
          thresholds: [
            { value: RAM_CRITICAL_THRESHOLD, label: '严重阈值', severity: 'critical' },
          ],
          hasGaps: false,
        })
      }
    }

    return {
      chartSeries,
      metrics: {
        maxCpuLoad: state.maxCpuLoad,
        maxRamUsage: state.maxRamUsage,
        sustainedHighCpuSec: state.highCpuTotalSec,
      },
      findings,
      consumedTopics: [],
      missingRequirements: [],
      warnings: [],
      result: {
        cpuLoadSamples: state.cpuLoadSamples.length,
        systemPowerSamples: state.systemPowerSamples.length,
        magnetometerSamples: state.magnetometerSamples.length,
        maxCpuLoad: state.maxCpuLoad,
        maxRamUsage: state.maxRamUsage,
        sustainedHighCpuSec: state.highCpuTotalSec,
        dropoutCount: 0,
        dropoutTotalMs: 0,
        dropoutMaxMs: 0,
      },
    }
  },
}
