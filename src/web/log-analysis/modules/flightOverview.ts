import type { AnalysisModule, AnalysisContext, ResolvedSample, ModuleResult } from '../engine/AnalysisModule.js'
import type { DiagnosticFinding } from '../types.js'

// ─── PX4 nav_state → mode name mapping ──────────────────────────────────────

const NAV_STATE_NAMES: Record<number, string> = {
  0: '手动',
  1: '定高',
  2: '定点',
  3: '任务',
  4: '悬停',
  5: '返航',
  6: '降落',
  7: '特技',
  8: '外部控制',
  9: '增稳',
  10: '半自稳',
  11: '起飞',
  12: '绕圈',
}

// ─── State types ────────────────────────────────────────────────────────────

interface FlightOverviewState {
  // Armed state tracking
  isArmed: boolean
  armedStartTime: number | null
  armedEndTime: number | null
  totalArmedSec: number

  // Landing state tracking
  isLanded: boolean
  wasEverNotLanded: boolean
  takeoffTime: number | null
  landTime: number | null

  // Flight duration (armed + not landed)
  flightStartTime: number | null
  flightEndTime: number | null
  totalFlightSec: number

  // Mode tracking
  lastMode: number | null
  lastModeTime: number | null
  modeTimeline: Array<{ timeSec: number; mode: string }>

  // Sample tracking
  sampleCount: number
  firstSampleTime: number | null
  lastSampleTime: number | null
}

// ─── Result type ────────────────────────────────────────────────────────────

interface FlightOverviewResult {
  logDurationSec: number
  armedDurationSec: number
  flightDurationSec: number
  utcTimeSec: number | null
  vehicleType: string | null
  firmwareVersion: string | null
  hardwareVersion: string | null
  modeTimeline: Array<{ timeSec: number; mode: string }>
  armingTimeSec: number | null
  takeoffTimeSec: number | null
  landTimeSec: number | null
  logQuality: string
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function modeName(navState: number): string {
  return NAV_STATE_NAMES[navState] ?? `模式 ${navState}`
}

// ─── Module ─────────────────────────────────────────────────────────────────

export const flightOverviewModule: AnalysisModule<FlightOverviewState, FlightOverviewResult> = {
  id: 'flight-overview',
  section: 'overview',

  requirements: [
    {
      aliases: ['vehicle_status'],
      required: false,
      bindAs: 'vehicleStatus',
    },
    {
      aliases: ['vehicle_land_detected'],
      required: false,
      bindAs: 'landDetected',
    },
    {
      aliases: ['commander_state'],
      required: false,
      bindAs: 'commanderState',
    },
  ],

  create(_context: AnalysisContext): FlightOverviewState {
    return {
      isArmed: false,
      armedStartTime: null,
      armedEndTime: null,
      totalArmedSec: 0,
      isLanded: true,
      wasEverNotLanded: false,
      takeoffTime: null,
      landTime: null,
      flightStartTime: null,
      flightEndTime: null,
      totalFlightSec: 0,
      lastMode: null,
      lastModeTime: null,
      modeTimeline: [],
      sampleCount: 0,
      firstSampleTime: null,
      lastSampleTime: null,
    }
  },

  consume(state: FlightOverviewState, sample: ResolvedSample, bindName: string): void {
    state.sampleCount++
    if (state.firstSampleTime === null) state.firstSampleTime = sample.timeSec
    state.lastSampleTime = sample.timeSec

    if (bindName === 'vehicleStatus') {
      // vehicle_status topic: armed + (optionally) nav_state
      const armed = Number(sample.values['armed'] ?? 0) !== 0
      processArmed(state, sample.timeSec, armed)

      // nav_state from vehicle_status (if present)
      const navState = sample.values['nav_state']
      if (typeof navState === 'number') {
        processMode(state, sample.timeSec, navState)
      }
    } else if (bindName === 'landDetected') {
      // vehicle_land_detected topic: landed flag
      const landed = Number(sample.values['landed'] ?? 1) !== 0
      processLanding(state, sample.timeSec, landed)
    } else if (bindName === 'commanderState') {
      // commander_state topic: armed + nav_state
      const armed = Number(sample.values['armed'] ?? 0) !== 0
      processArmed(state, sample.timeSec, armed)

      const navState = sample.values['nav_state']
      if (typeof navState === 'number') {
        processMode(state, sample.timeSec, navState)
      }
    }
  },

  finalize(state: FlightOverviewState, context: AnalysisContext): ModuleResult<FlightOverviewState, FlightOverviewResult> {
    // Close final armed interval
    if (state.isArmed && state.armedStartTime !== null) {
      state.totalArmedSec += context.logEndSec - state.armedStartTime
    }

    // Close final flight interval
    if (state.flightStartTime !== null && state.flightEndTime !== null) {
      // Already accumulated incrementally
    }

    const findings: DiagnosticFinding[] = []

    // Very short log
    if (context.logDuration < 30) {
      findings.push({
        id: 'flight-overview-short-log',
        moduleId: 'flight-overview',
        section: 'overview',
        severity: 'notice',
        confidence: 'measured',
        title: '日志时长过短',
        summary: `日志时长仅为 ${context.logDuration.toFixed(1)} 秒`,
        recommendation: null,
        evidence: [{
          topic: '',
          multiId: 0,
          fields: [],
          startSec: 0,
          endSec: context.logDuration,
          observed: `${context.logDuration.toFixed(1)} 秒`,
          threshold: '30 秒',
        }],
      })
    }

    // No armed period
    if (state.totalArmedSec < 1) {
      findings.push({
        id: 'flight-overview-no-armed-period',
        moduleId: 'flight-overview',
        section: 'overview',
        severity: 'notice',
        confidence: 'measured',
        title: '未检测到解锁时段',
        summary: '该日志记录期间飞行器从未解锁',
        recommendation: '请在飞行器解锁后记录飞行数据',
        evidence: [],
      })
    }

    // Log quality (dropout rate would come from the document level — we approximate)
    const logQuality = '良好' // Default; real dropout info is at document level

    const result: FlightOverviewResult = {
      logDurationSec: context.logDuration,
      armedDurationSec: state.totalArmedSec,
      flightDurationSec: state.totalFlightSec,
      utcTimeSec: null,
      vehicleType: context.metadata.vehicleType,
      firmwareVersion: context.metadata.firmwareVersion,
      hardwareVersion: null,
      modeTimeline: state.modeTimeline,
      armingTimeSec: state.armedStartTime,
      takeoffTimeSec: state.takeoffTime,
      landTimeSec: state.landTime,
      logQuality,
    }

    // Build metrics from result
    const metrics: Record<string, unknown> = {
      logDurationSec: result.logDurationSec,
      armedDurationSec: result.armedDurationSec,
      flightDurationSec: result.flightDurationSec,
      utcTimeSec: result.utcTimeSec,
      vehicleType: result.vehicleType,
      firmwareVersion: result.firmwareVersion,
      hardwareVersion: result.hardwareVersion,
      modeTimeline: result.modeTimeline,
      armingTimeSec: result.armingTimeSec,
      takeoffTimeSec: result.takeoffTimeSec,
      landTimeSec: result.landTimeSec,
      logQuality: result.logQuality,
    }

    // Consumed topics
    const consumedTopics: Array<{ name: string; multiId: number; msgId: number }> = []
    for (const [, topic] of context.resolvedTopics) {
      consumedTopics.push({ name: topic.name, multiId: topic.multiId, msgId: topic.msgId })
    }

    return {
      chartSeries: [],
      metrics,
      findings,
      consumedTopics,
      missingRequirements: [],
      warnings: [],
      result,
    }
  },
}

// ─── Internal state mutators ────────────────────────────────────────────────

function processArmed(state: FlightOverviewState, timeSec: number, armed: boolean): void {
  if (armed && !state.isArmed) {
    // Armed transition
    state.isArmed = true
    state.armedStartTime = timeSec
  } else if (!armed && state.isArmed) {
    // Disarm transition
    state.isArmed = false
    if (state.armedStartTime !== null) {
      state.totalArmedSec += timeSec - state.armedStartTime
      state.armedEndTime = timeSec
      state.armedStartTime = null
    }
  }
}

function processLanding(state: FlightOverviewState, timeSec: number, landed: boolean): void {
  if (landed && !state.isLanded) {
    // Landing detected (was in air, now landed)
    state.isLanded = true
    state.landTime = timeSec
    // Close flight interval
    if (state.flightStartTime !== null) {
      state.totalFlightSec += timeSec - state.flightStartTime
      state.flightStartTime = null
    }
  } else if (!landed && state.isLanded) {
    // Takeoff detected (was landed, now in air)
    state.isLanded = false
    state.wasEverNotLanded = true
    if (state.takeoffTime === null) {
      state.takeoffTime = timeSec
    }
    // Open flight interval (only if armed)
    if (state.isArmed) {
      state.flightStartTime = timeSec
    }
  }

  // Track armed + not-landed as flight
  if (state.isArmed && !landed && state.flightStartTime === null) {
    state.flightStartTime = timeSec
  }
}

function processMode(state: FlightOverviewState, timeSec: number, navState: number): void {
  if (state.lastMode === null) {
    // First mode sample
    state.lastMode = navState
    state.lastModeTime = timeSec
    state.modeTimeline.push({ timeSec, mode: modeName(navState) })
  } else if (navState !== state.lastMode) {
    // Mode transition
    state.modeTimeline.push({ timeSec, mode: modeName(navState) })
    state.lastMode = navState
    state.lastModeTime = timeSec
  }
}
