import type { AnalysisModule, AnalysisContext, ResolvedSample, ModuleResult } from '../engine/AnalysisModule.js'
import type { ChartSeriesGroup, DiagnosticFinding, DiagnosticEvidence } from '../types.js'

// ─── State ──────────────────────────────────────────────────────────────────

interface BatteryInstanceState {
  voltages: Array<{ time: number; value: number }>
  currents: Array<{ time: number; value: number }>
  remaining: number | null
  dischargedMah: number | null
  cellCount: number
  minVoltage: number
  maxVoltage: number
  sumVoltage: number
  sumCurrent: number
  sampleCount: number
  /** Min cell voltage observed across all samples */
  minCellVoltage: number
  /** Max cell voltage observed across all samples */
  maxCellVoltage: number
  /** Per-sample cell voltage arrays for imbalance detection */
  cellVoltageSamples: number[][]
}

interface PowerState {
  batteries: Map<number, BatteryInstanceState>
}

// ─── Result ─────────────────────────────────────────────────────────────────

interface BatteryMetrics {
  instanceId: number
  minVoltage: number
  maxVoltage: number
  meanVoltage: number
  maxCurrent: number
  meanCurrent: number
  remaining: number | null
  dischargedMah: number | null
  sampleCount: number
  cellCount: number
  sagEstimate: number | null
  cellImbalance: number | null
}

interface PowerResult {
  batteries: BatteryMetrics[]
}

// ─── Constants ──────────────────────────────────────────────────────────────

const MAX_CHART_POINTS = 5000
const LOW_VOLTAGE_WARNING_PER_CELL = 3.3
const LOW_VOLTAGE_CRITICAL_PER_CELL = 3.0
const CELL_IMBALANCE_THRESHOLD = 0.3

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

export const powerModule: AnalysisModule<PowerState, PowerResult> = {
  id: 'power',
  section: 'sensors-power',
  requirements: [
    {
      aliases: ['battery_status', 'battery_status_old'],
      required: false,
      bindAs: 'battery',
      multiInstance: true,
    },
    {
      aliases: ['system_power'],
      required: false,
      bindAs: 'systemPower',
    },
  ],

  create(_context: AnalysisContext): PowerState {
    return { batteries: new Map() }
  },

  consume(state: PowerState, sample: ResolvedSample, bindName: string): void {
    if (bindName !== 'battery') return

    const instanceId = sample.topic.multiId
    let batt = state.batteries.get(instanceId)
    if (!batt) {
      batt = {
        voltages: [],
        currents: [],
        remaining: null,
        dischargedMah: null,
        cellCount: 0,
        minVoltage: Infinity,
        maxVoltage: -Infinity,
        sumVoltage: 0,
        sumCurrent: 0,
        sampleCount: 0,
        minCellVoltage: Infinity,
        maxCellVoltage: -Infinity,
        cellVoltageSamples: [],
      }
      state.batteries.set(instanceId, batt)
    }

    const v = sample.values['voltage_v']
    if (typeof v === 'number' && Number.isFinite(v)) {
      batt.voltages.push({ time: sample.timeSec, value: v })
      batt.sampleCount++
      batt.sumVoltage += v
      if (v < batt.minVoltage) batt.minVoltage = v
      if (v > batt.maxVoltage) batt.maxVoltage = v
    }

    const c = sample.values['current_a']
    if (typeof c === 'number' && Number.isFinite(c)) {
      batt.currents.push({ time: sample.timeSec, value: c })
      batt.sumCurrent += c
    }

    const cc = sample.values['cell_count']
    if (typeof cc === 'number' && cc > 0) batt.cellCount = cc

    const rem = sample.values['remaining']
    if (typeof rem === 'number') batt.remaining = rem

    const dis = sample.values['discharged_mah']
    if (typeof dis === 'number') batt.dischargedMah = dis

    // Collect cell voltages
    const cellVoltages: number[] = []
    for (let i = 0; i < 14; i++) {
      const cv = sample.values[`voltage_cell_v[${i}]`]
      if (typeof cv === 'number' && cv > 0) {
        cellVoltages.push(cv)
        if (cv < batt.minCellVoltage) batt.minCellVoltage = cv
        if (cv > batt.maxCellVoltage) batt.maxCellVoltage = cv
      }
    }
    if (cellVoltages.length > 0) {
      batt.cellVoltageSamples.push(cellVoltages)
    }
  },

  finalize(state: PowerState, context: AnalysisContext): ModuleResult<PowerState, PowerResult> {
    const findings: DiagnosticFinding[] = []
    const chartSeries: ChartSeriesGroup[] = []
    const batteryMetrics: BatteryMetrics[] = []

    for (const [instanceId, batt] of state.batteries) {
      if (batt.sampleCount === 0) continue

      const meanVoltage = batt.sumVoltage / batt.sampleCount
      const meanCurrent = batt.currents.length > 0 ? batt.sumCurrent / batt.currents.length : 0
      const maxCurrent = batt.currents.length > 0 ? Math.max(...batt.currents.map(c => c.value)) : 0

      // Sag estimate: difference between max (idle-ish) and min (loaded) voltage
      const sagEstimate = batt.maxVoltage - batt.minVoltage

      // Cell imbalance
      const cellImbalance = batt.maxCellVoltage - batt.minCellVoltage

      batteryMetrics.push({
        instanceId,
        minVoltage: batt.minVoltage,
        maxVoltage: batt.maxVoltage,
        meanVoltage,
        maxCurrent,
        meanCurrent,
        remaining: batt.remaining,
        dischargedMah: batt.dischargedMah,
        sampleCount: batt.sampleCount,
        cellCount: batt.cellCount,
        sagEstimate: sagEstimate > 0.01 ? sagEstimate : null,
        cellImbalance: cellImbalance > 0.01 ? cellImbalance : null,
      })

      // ── Findings ──

      // Low voltage check (per-cell if cell count known)
      const cellCount = batt.cellCount || 1
      const criticalThreshold = LOW_VOLTAGE_CRITICAL_PER_CELL * cellCount
      const warningThreshold = LOW_VOLTAGE_WARNING_PER_CELL * cellCount

      if (batt.minVoltage < criticalThreshold) {
        findings.push({
          id: `power:battery${instanceId}:voltage-critical`,
          moduleId: 'power',
          section: 'sensors-power',
          severity: 'critical',
          confidence: 'measured',
          title: `电池 ${instanceId} 电压严重过低`,
          summary: `最低电压 ${batt.minVoltage.toFixed(2)}V，低于严重阈值 ${criticalThreshold.toFixed(2)}V（${cellCount}S × ${LOW_VOLTAGE_CRITICAL_PER_CELL}V/节）`,
          recommendation: '电池电量已严重不足，请立即降落。',
          evidence: [makeEvidence('battery_status', instanceId, ['voltage_v'], `${batt.minVoltage.toFixed(2)}V min`, `${criticalThreshold.toFixed(2)}V critical`)],
        })
      } else if (batt.minVoltage < warningThreshold) {
        findings.push({
          id: `power:battery${instanceId}:voltage-warning`,
          moduleId: 'power',
          section: 'sensors-power',
          severity: 'warning',
          confidence: 'measured',
          title: `电池 ${instanceId} 电压过低`,
          summary: `最低电压 ${batt.minVoltage.toFixed(2)}V，低于警告阈值 ${warningThreshold.toFixed(2)}V（${cellCount}S × ${LOW_VOLTAGE_WARNING_PER_CELL}V/节）`,
          recommendation: '电池电压偏低，请尽快安排降落。',
          evidence: [makeEvidence('battery_status', instanceId, ['voltage_v'], `${batt.minVoltage.toFixed(2)}V min`, `${warningThreshold.toFixed(2)}V warning`)],
        })
      }

      // High sag heuristic
      if (sagEstimate > 2.0) {
        findings.push({
          id: `power:battery${instanceId}:high-sag`,
          moduleId: 'power',
          section: 'sensors-power',
          severity: 'warning',
          confidence: 'heuristic',
          title: `电池 ${instanceId} 压降过大`,
          summary: `检测到 ${sagEstimate.toFixed(2)}V 的压降（最高电压与最低电压之差）`,
          recommendation: '电池可能已老化，或容量不足以承受当前电流。',
          evidence: [makeEvidence('battery_status', instanceId, ['voltage_v'], `${sagEstimate.toFixed(2)}V sag`, '>2.0V')],
        })
      }

      // Cell imbalance
      if (cellImbalance > CELL_IMBALANCE_THRESHOLD) {
        findings.push({
          id: `power:battery${instanceId}:cell-imbalance`,
          moduleId: 'power',
          section: 'sensors-power',
          severity: 'notice',
          confidence: 'measured',
          title: `电池 ${instanceId} 单体不均衡`,
          summary: `单体电压差为 ${cellImbalance.toFixed(2)}V（最低 ${batt.minCellVoltage.toFixed(2)}V，最高 ${batt.maxCellVoltage.toFixed(2)}V）`,
          recommendation: '下次飞行前请对电池单体进行均衡。',
          evidence: [makeEvidence('battery_status', instanceId, ['voltage_cell_v'], `spread ${cellImbalance.toFixed(2)}V`, `>${CELL_IMBALANCE_THRESHOLD}V`)],
        })
      }

      // ── Chart series ──

      const vDownsampled = downsample(batt.voltages, MAX_CHART_POINTS)
      const cDownsampled = downsample(batt.currents, MAX_CHART_POINTS)

      chartSeries.push({
        id: `battery_${instanceId}_voltage`,
        title: `电池 ${instanceId} 电压`,
        description: `电池 ${instanceId} 电压随时间的变化`,
        unit: 'V',
        series: [{
          label: `电池 ${instanceId}`,
          times: vDownsampled.map(s => s.time),
          values: vDownsampled.map(s => s.value),
        }],
        thresholds: [
          { value: warningThreshold, label: '警告阈值', severity: 'warning' },
          { value: criticalThreshold, label: '严重阈值', severity: 'critical' },
        ],
        hasGaps: false,
      })

      chartSeries.push({
        id: `battery_${instanceId}_current`,
        title: `电池 ${instanceId} 电流`,
        description: `电池 ${instanceId} 放电电流随时间的变化`,
        unit: 'A',
        series: [{
          label: `电池 ${instanceId}`,
          times: cDownsampled.map(s => s.time),
          values: cDownsampled.map(s => s.value),
        }],
        hasGaps: false,
      })
    }

    return {
      chartSeries,
      metrics: { batteries: batteryMetrics },
      findings,
      consumedTopics: [],
      missingRequirements: [],
      warnings: [],
      result: { batteries: batteryMetrics },
    }
  },
}
