import type { AnalysisModule, AnalysisContext, ResolvedSample, ModuleResult } from '../engine/AnalysisModule.js'
import type { DiagnosticFinding, ChartFamily, ChartView } from '../types.js'
import { StreamingSeriesCollector } from '../../utils/ulogAnalysis.js'

// ── State types ──────────────────────────────────────────────────────────────

interface SystemHealthState {
  /** Full-log bounded CPU/RAM chart collectors */
  loadCollector: StreamingSeriesCollector
  ramCollector: StreamingSeriesCollector
  cpuSampleCount: number
  lastCpuTimeSec: number | null
  systemPowerSampleCount: number
  magnetometerSampleCount: number
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
      loadCollector: new StreamingSeriesCollector(MAX_CHART_POINTS),
      ramCollector: new StreamingSeriesCollector(MAX_CHART_POINTS),
      cpuSampleCount: 0,
      lastCpuTimeSec: null,
      systemPowerSampleCount: 0,
      magnetometerSampleCount: 0,
      maxCpuLoad: 0,
      highCpuStart: null,
      highCpuTotalSec: 0,
      maxRamUsage: 0,
    }
  },

  consume(state: SystemHealthState, sample: ResolvedSample, bindName: string): void {
    if (bindName === 'cpuLoad') {
      // cpuload.load — a missing/invalid value means unknown, never zero
      const rawLoad = sample.values['load']
      if (typeof rawLoad !== 'number' || !Number.isFinite(rawLoad)) return
      // PX4 logs load as a 0–1 fraction; convert to percentage
      let load = rawLoad
      if (load > 0 && load <= 1.0) load *= 100

      state.cpuSampleCount++
      state.lastCpuTimeSec = sample.timeSec
      state.loadCollector.push(sample.timeSec, load)
      if (load > state.maxCpuLoad) state.maxCpuLoad = load

      // cpuload.ram_usage — 0–1 fraction in PX4; values outside 0–100 after
      // conversion have an unknown scale and are treated as unknown
      const rawRam = sample.values['ram_usage']
      if (typeof rawRam === 'number' && Number.isFinite(rawRam)) {
        let ram = rawRam
        if (ram > 0 && ram <= 1.0) ram *= 100
        if (ram >= 0 && ram <= 100) {
          state.ramCollector.push(sample.timeSec, ram)
          if (ram > state.maxRamUsage) state.maxRamUsage = ram
        }
      }

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
      state.systemPowerSampleCount++
    } else if (bindName === 'magnetometer') {
      state.magnetometerSampleCount++
    }
  },

  finalize(state: SystemHealthState, context: AnalysisContext): ModuleResult<SystemHealthState, SystemHealthResult> {
    const findings: DiagnosticFinding[] = []

    // Close any open high CPU window
    if (state.highCpuStart !== null && state.lastCpuTimeSec !== null) {
      state.highCpuTotalSec += state.lastCpuTimeSec - state.highCpuStart
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
    const resourceViews: ChartView[] = []
    if (!state.loadCollector.isEmpty) {
      const load = state.loadCollector.toSeries()
      resourceViews.push({
        id: 'cpu-load',
        title: 'CPU 负载',
        description: 'CPU 负载百分比随时间的变化',
        unit: '%',
        series: [{ id: 'cpu-load', label: 'CPU 负载', times: load.times, values: load.values }],
        defaultVisibleSeriesIds: ['cpu-load'],
        thresholds: [
          { value: CPU_WARNING_THRESHOLD, label: '警告阈值', severity: 'warning' },
        ],
        xAxis: 'time',
        hasGaps: false,
      })

      // RAM usage view
      if (!state.ramCollector.isEmpty && state.maxRamUsage > 0) {
        const ram = state.ramCollector.toSeries()
        resourceViews.push({
          id: 'ram-usage',
          title: '内存占用',
          description: '内存占用百分比随时间的变化',
          unit: '%',
          series: [{ id: 'ram-usage', label: '内存占用', times: ram.times, values: ram.values }],
          defaultVisibleSeriesIds: ['ram-usage'],
          thresholds: [
            { value: RAM_CRITICAL_THRESHOLD, label: '严重阈值', severity: 'critical' },
          ],
          xAxis: 'time',
          hasGaps: false,
        })
      }
    }

    const chartFamilies: ChartFamily[] = []
    if (resourceViews.length > 0) {
      chartFamilies.push({
        id: 'system-resources',
        moduleId: 'system-health',
        title: '系统资源',
        description: 'CPU 与内存占用',
        views: resourceViews,
        defaultViewId: resourceViews[0]!.id,
        order: 40,
      })
    }

    return {
      chartFamilies,
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
        cpuLoadSamples: state.cpuSampleCount,
        systemPowerSamples: state.systemPowerSampleCount,
        magnetometerSamples: state.magnetometerSampleCount,
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
