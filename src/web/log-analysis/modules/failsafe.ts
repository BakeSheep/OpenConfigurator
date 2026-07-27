import type { AnalysisModule, AnalysisContext, ResolvedSample, ModuleResult } from '../engine/AnalysisModule.js'
import type { DiagnosticFinding } from '../types.js'

// ── State types ──────────────────────────────────────────────────────────────

interface FailsafeEvent {
  timeSec: number
  type: string
  value: number
}

interface FailsafeState {
  failsafeSamples: Array<{ timeSec: number; values: Record<string, number> }>
  landDetectedSamples: Array<{ timeSec: number; values: Record<string, number> }>
  events: FailsafeEvent[]
  /** Track state transitions */
  prevFailsafeActive: boolean | null
  prevBatteryWarning: number | null
  prevRcLoss: boolean | null
  prevDataLinkLoss: boolean | null
  prevGeofenceViolation: boolean | null
  prevPositionFailure: boolean | null
}

// ── Result types ─────────────────────────────────────────────────────────────

interface FailsafeTransition {
  timeSec: number
  type: string
  from: string
  to: string
}

interface FailsafeResult {
  totalSamples: number
  landDetectedSamples: number
  transitions: FailsafeTransition[]
  batteryWarningCount: number
  rcLossCount: number
  dataLinkLossCount: number
  geofenceViolationCount: number
  positionFailureCount: number
}

// ── Module ───────────────────────────────────────────────────────────────────

export const failsafeModule: AnalysisModule<FailsafeState, FailsafeResult> = {
  id: 'failsafe',
  section: 'events-raw',

  requirements: [
    {
      aliases: ['failsafe', 'vehicle_status'],
      required: false,
      bindAs: 'failsafe',
    },
    {
      aliases: ['vehicle_land_detected'],
      required: false,
      bindAs: 'landDetected',
    },
  ],

  create(_context: AnalysisContext): FailsafeState {
    return {
      failsafeSamples: [],
      landDetectedSamples: [],
      events: [],
      prevFailsafeActive: null,
      prevBatteryWarning: null,
      prevRcLoss: null,
      prevDataLinkLoss: null,
      prevGeofenceViolation: null,
      prevPositionFailure: null,
    }
  },

  consume(state: FailsafeState, sample: ResolvedSample, bindName: string): void {
    if (bindName === 'failsafe') {
      const numericValues: Record<string, number> = {}
      for (const [k, v] of Object.entries(sample.values)) {
        if (typeof v === 'number') numericValues[k] = v
      }
      state.failsafeSamples.push({ timeSec: sample.timeSec, values: numericValues })

      // Detect state transitions
      for (const [key, val] of Object.entries(sample.values)) {
        if (typeof val !== 'number') continue

        if (key === 'failsafe' || key === 'failsafe_active') {
          const isActive = val > 0.5
          if (state.prevFailsafeActive !== null && isActive !== state.prevFailsafeActive) {
            state.events.push({
              timeSec: sample.timeSec,
              type: 'failsafe',
              value: val,
            })
          }
          state.prevFailsafeActive = isActive
        }

        if (key === 'battery_warning' || key === 'battery_warn_level') {
          if (state.prevBatteryWarning !== null && val !== state.prevBatteryWarning) {
            state.events.push({
              timeSec: sample.timeSec,
              type: 'battery_warning',
              value: val,
            })
          }
          state.prevBatteryWarning = val
        }

        if (key === 'rc_loss' || key === 'rc_lost') {
          const isLost = val > 0.5
          if (state.prevRcLoss !== null && isLost !== state.prevRcLoss) {
            state.events.push({
              timeSec: sample.timeSec,
              type: 'rc_loss',
              value: val,
            })
          }
          state.prevRcLoss = isLost
        }

        if (key === 'data_link_loss' || key === 'data_link_lost') {
          const isLost = val > 0.5
          if (state.prevDataLinkLoss !== null && isLost !== state.prevDataLinkLoss) {
            state.events.push({
              timeSec: sample.timeSec,
              type: 'data_link_loss',
              value: val,
            })
          }
          state.prevDataLinkLoss = isLost
        }

        if (key === 'geofence_violated' || key === 'geofence_action') {
          const isViolated = val > 0.5
          if (state.prevGeofenceViolation !== null && isViolated !== state.prevGeofenceViolation) {
            state.events.push({
              timeSec: sample.timeSec,
              type: 'geofence_violation',
              value: val,
            })
          }
          state.prevGeofenceViolation = isViolated
        }

        if (key === 'position_failure' || key === 'local_position_invalid' || key === 'global_position_invalid') {
          const isFailure = val > 0.5
          if (state.prevPositionFailure !== null && isFailure !== state.prevPositionFailure) {
            state.events.push({
              timeSec: sample.timeSec,
              type: 'position_failure',
              value: val,
            })
          }
          state.prevPositionFailure = isFailure
        }
      }
    } else if (bindName === 'landDetected') {
      const numericValues: Record<string, number> = {}
      for (const [k, v] of Object.entries(sample.values)) {
        if (typeof v === 'number') numericValues[k] = v
      }
      state.landDetectedSamples.push({ timeSec: sample.timeSec, values: numericValues })
    }
  },

  finalize(state: FailsafeState, context: AnalysisContext): ModuleResult<FailsafeState, FailsafeResult> {
    const findings: DiagnosticFinding[] = []

    // Count events by type
    const eventsByType = new Map<string, FailsafeEvent[]>()
    for (const evt of state.events) {
      let arr = eventsByType.get(evt.type)
      if (!arr) {
        arr = []
        eventsByType.set(evt.type, arr)
      }
      arr.push(evt)
    }

    const rcLossEvents = eventsByType.get('rc_loss') ?? []
    const dataLinkLossEvents = eventsByType.get('data_link_loss') ?? []
    const geofenceEvents = eventsByType.get('geofence_violation') ?? []
    const positionFailureEvents = eventsByType.get('position_failure') ?? []
    const batteryWarningEvents = eventsByType.get('battery_warning') ?? []

    // ── Findings ────────────────────────────────────────────────────────────
    if (rcLossEvents.length > 0) {
      const first = rcLossEvents[0]!
      const last = rcLossEvents[rcLossEvents.length - 1]!
      findings.push({
        id: 'failsafe-rc-loss',
        moduleId: 'failsafe',
        section: 'events-raw',
        severity: 'critical',
        confidence: 'measured',
        title: '检测到遥控链路丢失',
        summary: `在 ${first.timeSec.toFixed(1)} 秒至 ${last.timeSec.toFixed(1)} 秒之间检测到 ${rcLossEvents.length} 次遥控链路丢失状态变化。`,
        recommendation: '请检查遥控接收机天线位置和有效距离。',
        evidence: [{
          topic: 'failsafe',
          multiId: 0,
          fields: ['rc_loss'],
          startSec: first.timeSec,
          endSec: last.timeSec,
          observed: `${rcLossEvents.length} 次状态变化`,
          threshold: '0',
        }],
      })
    }

    if (dataLinkLossEvents.length > 0) {
      const first = dataLinkLossEvents[0]!
      const last = dataLinkLossEvents[dataLinkLossEvents.length - 1]!
      findings.push({
        id: 'failsafe-datalink-loss',
        moduleId: 'failsafe',
        section: 'events-raw',
        severity: 'warning',
        confidence: 'measured',
        title: '检测到数传链路丢失',
        summary: `在 ${first.timeSec.toFixed(1)} 秒至 ${last.timeSec.toFixed(1)} 秒之间检测到 ${dataLinkLossEvents.length} 次数传链路丢失状态变化。`,
        recommendation: '请检查数传电台的有效距离和无线干扰。',
        evidence: [{
          topic: 'failsafe',
          multiId: 0,
          fields: ['data_link_loss'],
          startSec: first.timeSec,
          endSec: last.timeSec,
          observed: `${dataLinkLossEvents.length} 次状态变化`,
          threshold: '0',
        }],
      })
    }

    if (geofenceEvents.length > 0) {
      const first = geofenceEvents[0]!
      findings.push({
        id: 'failsafe-geofence',
        moduleId: 'failsafe',
        section: 'events-raw',
        severity: 'warning',
        confidence: 'measured',
        title: '检测到地理围栏违规',
        summary: `从 ${first.timeSec.toFixed(1)} 秒开始检测到 ${geofenceEvents.length} 次地理围栏违规。`,
        recommendation: '请检查地理围栏配置和飞行边界。',
        evidence: [{
          topic: 'failsafe',
          multiId: 0,
          fields: ['geofence_violated'],
          startSec: first.timeSec,
          endSec: geofenceEvents[geofenceEvents.length - 1]!.timeSec,
          observed: `${geofenceEvents.length} 次违规`,
          threshold: '0',
        }],
      })
    }

    if (positionFailureEvents.length > 0) {
      const first = positionFailureEvents[0]!
      findings.push({
        id: 'failsafe-position-failure',
        moduleId: 'failsafe',
        section: 'events-raw',
        severity: 'critical',
        confidence: 'measured',
        title: '检测到位置估计故障',
        summary: `从 ${first.timeSec.toFixed(1)} 秒开始检测到 ${positionFailureEvents.length} 次位置估计故障。`,
        recommendation: '请检查 GPS 和估计器状态。',
        evidence: [{
          topic: 'failsafe',
          multiId: 0,
          fields: ['position_failure'],
          startSec: first.timeSec,
          endSec: positionFailureEvents[positionFailureEvents.length - 1]!.timeSec,
          observed: `${positionFailureEvents.length} 次故障`,
          threshold: '0',
        }],
      })
    }

    if (batteryWarningEvents.length > 0) {
      const maxWarning = Math.max(...batteryWarningEvents.map(e => e.value))
      const first = batteryWarningEvents[0]!
      findings.push({
        id: 'failsafe-battery-warning',
        moduleId: 'failsafe',
        section: 'events-raw',
        severity: maxWarning >= 2 ? 'critical' : 'warning',
        confidence: 'measured',
        title: '电池警告等级发生变化',
        summary: `检测到 ${batteryWarningEvents.length} 次电池警告等级变化，最高等级为 ${maxWarning}。`,
        recommendation: '请检查电池健康状况和容量设置。',
        evidence: [{
          topic: 'failsafe',
          multiId: 0,
          fields: ['battery_warning'],
          startSec: first.timeSec,
          endSec: batteryWarningEvents[batteryWarningEvents.length - 1]!.timeSec,
          observed: `最高等级=${maxWarning}`,
          threshold: null,
        }],
      })
    }

    // Build transitions list
    const transitions: FailsafeTransition[] = state.events.map(evt => ({
      timeSec: evt.timeSec,
      type: evt.type,
      from: '',
      to: String(evt.value),
    }))

    return {
      chartFamilies: [],
      metrics: {
        totalSamples: state.failsafeSamples.length,
        landDetectedSamples: state.landDetectedSamples.length,
        eventCount: state.events.length,
      },
      findings,
      consumedTopics: [],
      missingRequirements: [],
      warnings: [],
      result: {
        totalSamples: state.failsafeSamples.length,
        landDetectedSamples: state.landDetectedSamples.length,
        transitions,
        batteryWarningCount: batteryWarningEvents.length,
        rcLossCount: rcLossEvents.length,
        dataLinkLossCount: dataLinkLossEvents.length,
        geofenceViolationCount: geofenceEvents.length,
        positionFailureCount: positionFailureEvents.length,
      },
    }
  },
}
