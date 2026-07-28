import type { AnalysisModule, AnalysisContext, ResolvedSample, ModuleResult } from '../engine/AnalysisModule.js'
import type { DiagnosticFinding, ChartFamily, ChartView, ChartSeries, FindingSeverity } from '../types.js'
import { StreamingSeriesCollector } from '../../utils/ulogAnalysis.js'

// ── State types ──────────────────────────────────────────────────────────────

interface EstimatorInstanceState {
  instanceId: number
  topicName: string
  sampleCount: number
  lastTimeSec: number | null
  /** Full-log bounded collectors for innovation-ratio chart fields */
  ratioCollectors: Map<string, StreamingSeriesCollector>
  /** Full-log bounded collectors for covariance chart fields */
  covCollectors: Map<string, StreamingSeriesCollector>
  /** Track max innovation test ratios */
  maxTestRatios: Record<string, number>
  /** Reset counters */
  resetCounts: Record<string, number>
  /** Filter fault flags observed */
  faultFlags: number[]
  /** Dead reckoning detection */
  deadReckoningStart: number | null
  deadReckoningTotalSec: number
  /** Bias tracking */
  biasSum: Record<string, number>
  biasCount: number
  /** Covariance tracking */
  maxCovariance: Record<string, number>
}

interface EstimatorState {
  instances: Map<number, EstimatorInstanceState>
  innovationSampleCounts: Map<number, number>
  visualInnovationSampleCount: number
  preflowSampleCount: number
}

// ── Result types ─────────────────────────────────────────────────────────────

interface EstimatorInstanceResult {
  instanceId: number
  topicName: string
  sampleCount: number
  maxTestRatios: Record<string, number>
  resetCounts: Record<string, number>
  faultCount: number
  deadReckoningSec: number
  maxBias: Record<string, number>
  maxCovariance: Record<string, number>
}

interface EstimatorResult {
  instances: EstimatorInstanceResult[]
  totalInstances: number
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const MAX_CHART_POINTS = 2000
/** Chart at most this many distinct ratio fields per instance */
const MAX_RATIO_FIELDS = 6
/** Chart at most this many distinct covariance fields per instance */
const MAX_COV_FIELDS = 4

function getCollector(
  map: Map<string, StreamingSeriesCollector>,
  key: string,
  maxFields: number,
): StreamingSeriesCollector | null {
  let collector = map.get(key)
  if (!collector) {
    if (map.size >= maxFields) return null
    collector = new StreamingSeriesCollector(MAX_CHART_POINTS)
    map.set(key, collector)
  }
  return collector
}

// ── Module ───────────────────────────────────────────────────────────────────

export const estimatorModule: AnalysisModule<EstimatorState, EstimatorResult> = {
  id: 'estimator',
  section: 'estimator',

  requirements: [
    {
      aliases: ['estimator_status', 'ekf2_innovations'],
      required: false,
      bindAs: 'estimatorStatus',
      multiInstance: true,
    },
    {
      aliases: ['estimator_innovation', 'ekf2_innovations'],
      required: false,
      bindAs: 'innovations',
      multiInstance: true,
    },
    {
      aliases: ['estimator_visual_innovation'],
      required: false,
      bindAs: 'visualInnovation',
    },
    {
      aliases: ['sensor_preflow'],
      required: false,
      bindAs: 'preflow',
    },
  ],

  create(_context: AnalysisContext): EstimatorState {
    return {
      instances: new Map(),
      innovationSampleCounts: new Map(),
      visualInnovationSampleCount: 0,
      preflowSampleCount: 0,
    }
  },

  consume(state: EstimatorState, sample: ResolvedSample, bindName: string): void {
    const instanceId = sample.topic.multiId

    if (bindName === 'estimatorStatus') {
      let inst = state.instances.get(instanceId)
      if (!inst) {
        inst = {
          instanceId,
          topicName: sample.topic.name,
          sampleCount: 0,
          lastTimeSec: null,
          ratioCollectors: new Map(),
          covCollectors: new Map(),
          maxTestRatios: {},
          resetCounts: {},
          faultFlags: [],
          deadReckoningStart: null,
          deadReckoningTotalSec: 0,
          biasSum: {},
          biasCount: 0,
          maxCovariance: {},
        }
        state.instances.set(instanceId, inst)
      }

      inst.sampleCount++
      inst.lastTimeSec = sample.timeSec

      // Track innovation test ratios (fields ending in _test_ratio or containing test ratio patterns)
      for (const [key, val] of Object.entries(sample.values)) {
        if (typeof val !== 'number') continue
        if (key.includes('test_ratio') || key.includes('innovation_ratio')) {
          const prev = inst.maxTestRatios[key] ?? 0
          if (val > prev) inst.maxTestRatios[key] = val
          // Full-log bounded chart series (never first-N retention)
          getCollector(inst.ratioCollectors, key, MAX_RATIO_FIELDS)
            ?.push(sample.timeSec, Number.isFinite(val) ? val : NaN)
        }
        // Track bias fields
        if (key.includes('bias') && (key.includes('accel') || key.includes('gyro') || key.includes('mag'))) {
          inst.biasSum[key] = (inst.biasSum[key] ?? 0) + Math.abs(val)
          inst.biasCount++
        }
        // Track covariance fields
        if (key.includes('covariance') || key.includes('cov_')) {
          const prev = inst.maxCovariance[key] ?? 0
          if (Math.abs(val) > prev) inst.maxCovariance[key] = Math.abs(val)
          getCollector(inst.covCollectors, key, MAX_COV_FIELDS)
            ?.push(sample.timeSec, Number.isFinite(val) ? Math.abs(val) : NaN)
        }
        // Track reset counters
        if (key.includes('reset') && key.includes('count')) {
          const prev = inst.resetCounts[key] ?? 0
          if (val > prev) inst.resetCounts[key] = val
        }
        // Track fault flags
        if (key === 'filter_fault_flags' || key === 'fault_flags') {
          if (val > 0) inst.faultFlags.push(val)
        }
        // Dead reckoning detection
        if (key === 'dead_reckoning' || key === 'is_dead_reckoning') {
          if (val > 0.5) {
            if (inst.deadReckoningStart === null) {
              inst.deadReckoningStart = sample.timeSec
            }
          } else {
            if (inst.deadReckoningStart !== null) {
              inst.deadReckoningTotalSec += sample.timeSec - inst.deadReckoningStart
              inst.deadReckoningStart = null
            }
          }
        }
      }
    } else if (bindName === 'innovations') {
      state.innovationSampleCounts.set(
        instanceId,
        (state.innovationSampleCounts.get(instanceId) ?? 0) + 1,
      )
    } else if (bindName === 'visualInnovation') {
      state.visualInnovationSampleCount++
    } else if (bindName === 'preflow') {
      state.preflowSampleCount++
    }
  },

  finalize(state: EstimatorState, context: AnalysisContext): ModuleResult<EstimatorState, EstimatorResult> {
    const findings: DiagnosticFinding[] = []
    const innovationViews: ChartView[] = []
    const stateViews: ChartView[] = []
    const instanceResults: EstimatorInstanceResult[] = []

    for (const [instanceId, inst] of state.instances) {
      // Close any open dead reckoning window
      if (inst.deadReckoningStart !== null && inst.lastTimeSec !== null) {
        inst.deadReckoningTotalSec += inst.lastTimeSec - inst.deadReckoningStart
      }

      // Compute max bias
      const maxBias: Record<string, number> = {}
      for (const [key, sum] of Object.entries(inst.biasSum)) {
        maxBias[key] = inst.biasCount > 0 ? sum / inst.biasCount : 0
      }

      instanceResults.push({
        instanceId,
        topicName: inst.topicName,
        sampleCount: inst.sampleCount,
        maxTestRatios: { ...inst.maxTestRatios },
        resetCounts: { ...inst.resetCounts },
        faultCount: inst.faultFlags.length,
        deadReckoningSec: inst.deadReckoningTotalSec,
        maxBias,
        maxCovariance: { ...inst.maxCovariance },
      })

      // ── Findings ────────────────────────────────────────────────────────
      // High innovation test ratios
      for (const [key, val] of Object.entries(inst.maxTestRatios)) {
        if (val > 1.0) {
          findings.push({
            id: `estimator-${instanceId}-high-ratio-${key}`,
            moduleId: 'estimator',
            section: 'estimator',
            severity: 'warning',
            confidence: 'measured',
            title: `新息检验比过高：${key}`,
            summary: `实例 ${instanceId}（${inst.topicName}）的 ${key} 最大检验比为 ${val.toFixed(3)}，超过 1.0 阈值。`,
            recommendation: '请检查传感器校准和安装对齐参数。',
            evidence: [{
              topic: inst.topicName,
              multiId: instanceId,
              fields: [key],
              startSec: null,
              endSec: null,
              observed: `最大值=${val.toFixed(3)}`,
              threshold: '1.0',
            }],
          })
        }
      }

      // Filter faults
      if (inst.faultFlags.length > 0) {
        findings.push({
          id: `estimator-${instanceId}-filter-fault`,
          moduleId: 'estimator',
          section: 'estimator',
          severity: 'critical',
          confidence: 'measured',
          title: `估计器实例 ${instanceId} 检测到滤波器故障`,
          summary: `估计器实例 ${instanceId} 检测到 ${inst.faultFlags.length} 次滤波器故障标志事件。`,
          recommendation: '请检查传感器状态和估计器配置，并考虑重新校准。',
          evidence: [{
            topic: inst.topicName,
            multiId: instanceId,
            fields: ['filter_fault_flags'],
            startSec: null,
            endSec: null,
            observed: `${inst.faultFlags.length} 次故障事件`,
            threshold: '0',
          }],
        })
      }

      // Dead reckoning
      if (inst.deadReckoningTotalSec > 1.0) {
        findings.push({
          id: `estimator-${instanceId}-dead-reckoning`,
          moduleId: 'estimator',
          section: 'estimator',
          severity: 'warning',
          confidence: 'measured',
          title: `估计器实例 ${instanceId} 进入航位推算`,
          summary: `实例 ${instanceId} 处于航位推算模式的累计时长为 ${inst.deadReckoningTotalSec.toFixed(1)} 秒。`,
          recommendation: '请检查 GPS 覆盖和位置源配置。',
          evidence: [{
            topic: inst.topicName,
            multiId: instanceId,
            fields: ['dead_reckoning'],
            startSec: null,
            endSec: null,
            observed: `${inst.deadReckoningTotalSec.toFixed(1)} 秒`,
            threshold: '1.0s',
          }],
        })
      }

      // High bias
      for (const [key, val] of Object.entries(maxBias)) {
        if (val > 0.5) {
          findings.push({
            id: `estimator-${instanceId}-high-bias-${key}`,
            moduleId: 'estimator',
            section: 'estimator',
            severity: 'warning',
            confidence: 'heuristic',
            title: `传感器偏置过高：${key}`,
            summary: `实例 ${instanceId} 的 ${key} 平均绝对偏置为 ${val.toFixed(4)}。`,
            recommendation: '建议重新校准传感器。',
            evidence: [{
              topic: inst.topicName,
              multiId: instanceId,
              fields: [key],
              startSec: null,
              endSec: null,
              observed: `平均绝对值=${val.toFixed(4)}`,
              threshold: '0.5',
            }],
          })
        }
      }

      // Reset events
      for (const [key, val] of Object.entries(inst.resetCounts)) {
        if (val > 0) {
          findings.push({
            id: `estimator-${instanceId}-reset-${key}`,
            moduleId: 'estimator',
            section: 'estimator',
            severity: 'notice',
            confidence: 'measured',
            title: `估计器实例 ${instanceId} 发生重置：${key}`,
            summary: `实例 ${instanceId} 的 ${key} 共记录 ${val} 次重置。`,
            recommendation: null,
            evidence: [{
              topic: inst.topicName,
              multiId: instanceId,
              fields: [key],
              startSec: null,
              endSec: null,
              observed: `${val} 次重置`,
              threshold: null,
            }],
          })
        }
      }

      // ── Chart series: innovation test ratios ────────────────────────────
      if (inst.ratioCollectors.size > 0) {
        const ratioSeries: ChartSeries[] = []
        for (const [field, collector] of inst.ratioCollectors) {
          const { times, values } = collector.toSeries()
          if (times.length === 0) continue
          ratioSeries.push({
            id: `est-${instanceId}-ratio-${field}`,
            label: field,
            times,
            values,
          })
        }
        if (ratioSeries.length > 0) innovationViews.push({
          id: `est-${instanceId}-innovation-ratios`,
          title: `新息检验比（实例 ${instanceId}）`,
          description: `估计器实例 ${instanceId} 的新息检验比随时间的变化`,
          unit: 'ratio',
          series: ratioSeries,
          defaultVisibleSeriesIds: ratioSeries.map(s => s.id),
          thresholds: [{ value: 1.0, label: '警告阈值', severity: 'warning' }],
          xAxis: 'time',
          hasGaps: false,
        })
      }

      // ── Chart series: covariance traces ─────────────────────────────────
      if (inst.covCollectors.size > 0) {
        const covSeries: ChartSeries[] = []
        for (const [field, collector] of inst.covCollectors) {
          const { times, values } = collector.toSeries()
          if (times.length === 0) continue
          covSeries.push({
            id: `est-${instanceId}-cov-${field}`,
            label: field,
            times,
            values,
          })
        }
        if (covSeries.length > 0) stateViews.push({
          id: `est-${instanceId}-covariances`,
          title: `协方差（实例 ${instanceId}）`,
          description: `估计器实例 ${instanceId} 的协方差随时间的变化`,
          unit: 'value',
          series: covSeries,
          defaultVisibleSeriesIds: covSeries.map(s => s.id),
          xAxis: 'time',
          hasGaps: false,
        })
      }
    }

    const chartFamilies: ChartFamily[] = []
    if (innovationViews.length > 0) {
      chartFamilies.push({
        id: 'estimator-innovation',
        moduleId: 'estimator',
        title: '新息检验',
        description: '各估计器实例的新息检验比',
        views: innovationViews,
        defaultViewId: innovationViews[0]!.id,
        order: 10,
      })
    }
    if (stateViews.length > 0) {
      chartFamilies.push({
        id: 'estimator-state',
        moduleId: 'estimator',
        title: '状态与协方差',
        description: '各估计器实例的状态协方差',
        views: stateViews,
        defaultViewId: stateViews[0]!.id,
        order: 11,
      })
    }

    return {
      chartFamilies,
      metrics: {
        totalInstances: state.instances.size,
        instanceIds: [...state.instances.keys()],
      },
      findings,
      consumedTopics: [],
      missingRequirements: [],
      warnings: [],
      result: {
        instances: instanceResults,
        totalInstances: state.instances.size,
      },
    }
  },
}
