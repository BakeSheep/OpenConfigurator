import type { AnalysisModule, AnalysisContext, ResolvedSample, ModuleResult } from '../engine/AnalysisModule.js'
import type { ChartSeriesGroup, DiagnosticFinding, DiagnosticEvidence } from '../types.js'

// ─── State ──────────────────────────────────────────────────────────────────

interface EscInstanceState {
  rpms: Array<{ time: number; value: number }>
  currents: Array<{ time: number; value: number }>
  voltages: Array<{ time: number; value: number }>
  temperatures: Array<{ time: number; value: number }>
  errorFlags: number
  sampleCount: number
  maxRpm: number
  sumRpm: number
  maxTemp: number
}

interface PropulsionState {
  escInstances: Map<number, EscInstanceState>
}

// ─── Result ─────────────────────────────────────────────────────────────────

interface EscMetrics {
  instanceId: number
  sampleCount: number
  maxRpm: number
  meanRpm: number
  maxCurrent: number
  maxVoltage: number
  maxTemp: number
  errorFlags: number
}

interface PropulsionResult {
  escInstances: EscMetrics[]
  motorImbalance: number | null
}

// ─── Constants ──────────────────────────────────────────────────────────────

const MAX_CHART_POINTS = 5000
const MOTOR_IMBALANCE_THRESHOLD = 0.15 // 15% RPM spread
const ESC_OVERTEMP_THRESHOLD = 80 // °C heuristic

// ─── Helpers ────────────────────────────────────────────────────────────────

function downsample<T>(arr: T[], maxPoints: number): T[] {
  if (arr.length <= maxPoints) return arr
  const step = Math.ceil(arr.length / maxPoints)
  return arr.filter((_, i) => i % step === 0)
}

function makeEvidence(
  topicName: string,
  multiId: number,
  fields: string[],
  observed: string,
  threshold: string | null = null,
): DiagnosticEvidence {
  return { topic: topicName, multiId, fields, startSec: null, endSec: null, observed, threshold }
}

// ─── Module ─────────────────────────────────────────────────────────────────

export const propulsionModule: AnalysisModule<PropulsionState, PropulsionResult> = {
  id: 'propulsion',
  section: 'sensors-power',
  requirements: [
    {
      aliases: ['esc_status'],
      required: false,
      bindAs: 'escStatus',
      multiInstance: true,
    },
    {
      aliases: ['esc_0'],
      required: false,
      bindAs: 'esc',
    },
  ],

  create(_context: AnalysisContext): PropulsionState {
    return { escInstances: new Map() }
  },

  consume(state: PropulsionState, sample: ResolvedSample, bindName: string): void {
    if (bindName !== 'escStatus' && bindName !== 'esc') return

    const instanceId = sample.topic.multiId
    let esc = state.escInstances.get(instanceId)
    if (!esc) {
      esc = {
        rpms: [],
        currents: [],
        voltages: [],
        temperatures: [],
        errorFlags: 0,
        sampleCount: 0,
        maxRpm: 0,
        sumRpm: 0,
        maxTemp: 0,
      }
      state.escInstances.set(instanceId, esc)
    }

    const rpm = sample.values['esc_rpm']
    if (typeof rpm === 'number' && Number.isFinite(rpm)) {
      esc.rpms.push({ time: sample.timeSec, value: rpm })
      esc.sampleCount++
      esc.sumRpm += rpm
      if (rpm > esc.maxRpm) esc.maxRpm = rpm
    }

    const cur = sample.values['esc_current']
    if (typeof cur === 'number' && Number.isFinite(cur)) {
      esc.currents.push({ time: sample.timeSec, value: cur })
    }

    const volt = sample.values['esc_voltage']
    if (typeof volt === 'number' && Number.isFinite(volt)) {
      esc.voltages.push({ time: sample.timeSec, value: volt })
    }

    const temp = sample.values['esc_temperature']
    if (typeof temp === 'number' && Number.isFinite(temp)) {
      esc.temperatures.push({ time: sample.timeSec, value: temp })
      if (temp > esc.maxTemp) esc.maxTemp = temp
    }

    const err = sample.values['esc_errorflags']
    if (typeof err === 'number' && err > 0) {
      esc.errorFlags |= err
    }
  },

  finalize(state: PropulsionState, _context: AnalysisContext): ModuleResult<PropulsionState, PropulsionResult> {
    const findings: DiagnosticFinding[] = []
    const chartSeries: ChartSeriesGroup[] = []
    const escMetrics: EscMetrics[] = []

    for (const [instanceId, esc] of state.escInstances) {
      if (esc.sampleCount === 0) continue

      const meanRpm = esc.rpms.length > 0 ? esc.sumRpm / esc.rpms.length : 0
      const maxCurrent = esc.currents.length > 0 ? Math.max(...esc.currents.map(c => c.value)) : 0
      const maxVoltage = esc.voltages.length > 0 ? Math.max(...esc.voltages.map(v => v.value)) : 0

      escMetrics.push({
        instanceId,
        sampleCount: esc.sampleCount,
        maxRpm: esc.maxRpm,
        meanRpm,
        maxCurrent,
        maxVoltage,
        maxTemp: esc.maxTemp,
        errorFlags: esc.errorFlags,
      })

      // ESC error flags
      if (esc.errorFlags > 0) {
        findings.push({
          id: `propulsion:esc${instanceId}:errors`,
          moduleId: 'propulsion',
          section: 'sensors-power',
          severity: 'warning',
          confidence: 'measured',
          title: `电调 ${instanceId} 报告错误标志`,
          summary: `电调 ${instanceId} 报告错误标志：0x${esc.errorFlags.toString(16)}`,
          recommendation: '请检查电调配置和接线。',
          evidence: [makeEvidence('esc_status', instanceId, ['esc_errorflags'], `0x${esc.errorFlags.toString(16)}`, null)],
        })
      }

      // ESC over-temperature
      if (esc.maxTemp > ESC_OVERTEMP_THRESHOLD) {
        findings.push({
          id: `propulsion:esc${instanceId}:overtemp`,
          moduleId: 'propulsion',
          section: 'sensors-power',
          severity: 'warning',
          confidence: 'heuristic',
          title: `电调 ${instanceId} 温度过高`,
          summary: `电调 ${instanceId} 最高温度达到 ${esc.maxTemp.toFixed(1)}°C（阈值：${ESC_OVERTEMP_THRESHOLD}°C）`,
          recommendation: '请检查电机/电调负载和散热。',
          evidence: [makeEvidence('esc_status', instanceId, ['esc_temperature'], `${esc.maxTemp.toFixed(1)}°C`, `>${ESC_OVERTEMP_THRESHOLD}°C`)],
        })
      }
    }

    // Motor imbalance: compare mean RPMs across all ESC instances
    let motorImbalance: number | null = null
    if (escMetrics.length >= 2) {
      const meanRpms = escMetrics.map(m => m.meanRpm).filter(r => r > 0)
      if (meanRpms.length >= 2) {
        const overallMean = meanRpms.reduce((a, b) => a + b, 0) / meanRpms.length
        const maxDeviation = Math.max(...meanRpms.map(r => Math.abs(r - overallMean)))
        motorImbalance = overallMean > 0 ? maxDeviation / overallMean : null

        if (motorImbalance !== null && motorImbalance > MOTOR_IMBALANCE_THRESHOLD) {
          findings.push({
            id: 'propulsion:motor-imbalance',
            moduleId: 'propulsion',
            section: 'sensors-power',
            severity: 'warning',
            confidence: 'derived',
            title: '检测到电机转速不均衡',
            summary: `${escMetrics.length} 个电机的平均转速差为 ${(motorImbalance * 100).toFixed(1)}%（阈值：${(MOTOR_IMBALANCE_THRESHOLD * 100).toFixed(0)}%）`,
            recommendation: '请检查电机、螺旋桨状态和电调校准。',
            evidence: [makeEvidence('esc_status', 0, ['esc_rpm'], `${(motorImbalance * 100).toFixed(1)}% spread`, `>${(MOTOR_IMBALANCE_THRESHOLD * 100).toFixed(0)}%`)],
          })
        }
      }
    }

    // ── Chart series ──

    // RPM chart: one series per ESC instance
    const rpmSeries = []
    for (const [instanceId, esc] of state.escInstances) {
      if (esc.rpms.length === 0) continue
      const downsampled = downsample(esc.rpms, MAX_CHART_POINTS)
      rpmSeries.push({
        label: `电调 ${instanceId}`,
        times: downsampled.map(s => s.time),
        values: downsampled.map(s => s.value),
      })
    }
    if (rpmSeries.length > 0) {
      chartSeries.push({
        id: 'esc_rpm',
        title: '电调转速',
        description: '各电机转速随时间的变化',
        unit: 'RPM',
        series: rpmSeries,
        hasGaps: false,
      })
    }

    // Motor imbalance bar chart data
    if (escMetrics.length >= 2) {
      const imbalanceSeries = escMetrics.map(m => ({
        label: `电调 ${m.instanceId}`,
        times: [m.instanceId],
        values: [m.meanRpm],
      }))
      chartSeries.push({
        id: 'motor_imbalance',
        title: '电机平衡',
        description: '各电机平均转速的不均衡对比',
        unit: 'RPM',
        series: imbalanceSeries,
        hasGaps: false,
      })
    }

    return {
      chartSeries,
      metrics: { escInstances: escMetrics, motorImbalance },
      findings,
      consumedTopics: [],
      missingRequirements: [],
      warnings: [],
      result: { escInstances: escMetrics, motorImbalance },
    }
  },
}
