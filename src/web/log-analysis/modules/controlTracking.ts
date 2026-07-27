import type { AnalysisModule, AnalysisContext, ResolvedSample, ModuleResult } from '../engine/AnalysisModule.js'
import type { ChartSeriesGroup, DiagnosticFinding } from '../types.js'
import { readArmedState, ARMED_SOURCE_RANK, type ArmedSource } from '../px4/flightState.js'

// ─── Constants ──────────────────────────────────────────────────────────────

const MAX_CHART_POINTS = 2000
const TIME_ALIGN_TOLERANCE = 0.05 // 50 ms

// ─── State types ────────────────────────────────────────────────────────────

interface BufferedSample {
  timeSec: number
  values: Record<string, number | string | boolean>
  topicName: string
}

interface ControlTrackingState {
  attitudeSamples: BufferedSample[]
  attitudeSetpointSamples: BufferedSample[]
  ratesSetpointSamples: BufferedSample[]
  angularVelocitySamples: BufferedSample[]
  armedRanges: Array<{ start: number; end: number }>
  currentArmedStart: number | null
  isArmed: boolean
  hasExplicitArmedState: boolean
  /** Rank of the armed-state source currently in charge (see ARMED_SOURCE_RANK) */
  armedSourceRank: number
  attitudeHasQuat: boolean
  attitudeHasEuler: boolean
  setpointHasQuat: boolean
  setpointHasEuler: boolean
}

// ─── Result type ────────────────────────────────────────────────────────────

interface ControlTrackingResult {
  rollRmsError: number | null
  pitchRmsError: number | null
  yawRmsError: number | null
  rollRateRmsError: number | null
  pitchRateRmsError: number | null
  yawRateRmsError: number | null
}

// ─── Quaternion → Euler helpers ─────────────────────────────────────────────

function quatToRoll(q0: number, q1: number, q2: number, q3: number): number {
  return Math.atan2(2 * (q0 * q1 + q2 * q3), 1 - 2 * (q1 * q1 + q2 * q2))
}

function quatToPitch(q0: number, q1: number, q2: number, q3: number): number {
  const sinp = 2 * (q0 * q2 - q3 * q1)
  if (Math.abs(sinp) >= 1) return Math.sign(sinp) * Math.PI / 2
  return Math.asin(sinp)
}

function quatToYaw(q0: number, q1: number, q2: number, q3: number): number {
  return Math.atan2(2 * (q0 * q3 + q1 * q2), 1 - 2 * (q2 * q2 + q3 * q3))
}

// ─── Metric helpers ─────────────────────────────────────────────────────────

function computeRms(errors: number[]): number {
  if (errors.length === 0) return 0
  const sumSq = errors.reduce((s, e) => s + e * e, 0)
  return Math.sqrt(sumSq / errors.length)
}

function computeP95(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.ceil(sorted.length * 0.95) - 1
  return sorted[Math.max(0, idx)]!
}

/** Nearest-neighbour alignment: for each item in `a`, find the closest in `b` within tolerance */
function alignByTime(
  a: BufferedSample[],
  b: BufferedSample[],
  tolerance: number,
): Array<[BufferedSample, BufferedSample]> {
  const pairs: Array<[BufferedSample, BufferedSample]> = []
  let bi = 0
  for (const sa of a) {
    // Advance bi to the closest b sample
    while (bi < b.length - 1 && Math.abs(b[bi + 1]!.timeSec - sa.timeSec) <= Math.abs(b[bi]!.timeSec - sa.timeSec)) {
      bi++
    }
    if (bi < b.length && Math.abs(b[bi]!.timeSec - sa.timeSec) <= tolerance) {
      pairs.push([sa, b[bi]!])
    }
  }
  return pairs
}

/** Downsample a series to fit within maxPoints */
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

// ─── Module ─────────────────────────────────────────────────────────────────

/**
 * Apply an explicit armed reading from a state topic. Higher-priority
 * sources (vehicle_status > actuator_armed) own the armed intervals.
 * Null readings (missing/unknown fields) cause no transition.
 */
function applyArmedReading(
  state: ControlTrackingState,
  timeSec: number,
  armed: boolean | null,
  source: ArmedSource,
): void {
  if (armed === null) return
  const rank = ARMED_SOURCE_RANK[source]
  if (rank < state.armedSourceRank) return
  state.armedSourceRank = rank

  // First explicit reading takes over from the setpoint-presence heuristic:
  // discard heuristic intervals so disarmed setpoint noise is not scored.
  if (!state.hasExplicitArmedState) {
    state.hasExplicitArmedState = true
    state.armedRanges = []
    state.currentArmedStart = null
    state.isArmed = false
  }

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

export const controlTrackingModule: AnalysisModule<ControlTrackingState, ControlTrackingResult> = {
  id: 'control-tracking',
  section: 'control',

  requirements: [
    {
      aliases: ['vehicle_attitude'],
      required: true,
      bindAs: 'attitude',
      fields: ['q[0]', 'q[1]', 'q[2]', 'q[3]', 'roll', 'pitch', 'yaw'],
    },
    {
      aliases: ['vehicle_attitude_setpoint', 'attitude_setpoint'],
      required: false,
      bindAs: 'attitudeSetpoint',
      fields: ['q_d[0]', 'q_d[1]', 'q_d[2]', 'q_d[3]', 'roll_body', 'pitch_body', 'yaw_body'],
    },
    {
      aliases: ['vehicle_rates_setpoint', 'rates_setpoint'],
      required: false,
      bindAs: 'ratesSetpoint',
      fields: ['roll', 'pitch', 'yaw'],
    },
    {
      aliases: ['vehicle_angular_velocity'],
      required: false,
      bindAs: 'angularVelocity',
      fields: ['xyz[0]', 'xyz[1]', 'xyz[2]'],
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
  ],

  create(_context: AnalysisContext): ControlTrackingState {
    return {
      attitudeSamples: [],
      attitudeSetpointSamples: [],
      ratesSetpointSamples: [],
      angularVelocitySamples: [],
      armedRanges: [],
      currentArmedStart: null,
      isArmed: false,
      hasExplicitArmedState: false,
      armedSourceRank: 0,
      attitudeHasQuat: false,
      attitudeHasEuler: false,
      setpointHasQuat: false,
      setpointHasEuler: false,
    }
  },

  consume(state: ControlTrackingState, sample: ResolvedSample, bindName: string): void {
    const buf: BufferedSample = { timeSec: sample.timeSec, values: { ...sample.values }, topicName: sample.topic.name }

    switch (bindName) {
      case 'attitude':
        state.attitudeSamples.push(buf)
        if ('q[0]' in sample.values) state.attitudeHasQuat = true
        if ('roll' in sample.values) state.attitudeHasEuler = true
        break
      case 'attitudeSetpoint':
        state.attitudeSetpointSamples.push(buf)
        if ('q_d[0]' in sample.values) state.setpointHasQuat = true
        if ('roll_body' in sample.values) state.setpointHasEuler = true
        // Heuristic: presence of setpoint data implies armed — used only
        // when no explicit state topic ever provides an armed reading.
        if (!state.hasExplicitArmedState) {
          if (!state.isArmed) {
            state.isArmed = true
            state.currentArmedStart = sample.timeSec
          }
        }
        break
      case 'ratesSetpoint':
        state.ratesSetpointSamples.push(buf)
        break
      case 'angularVelocity':
        state.angularVelocitySamples.push(buf)
        break
      case 'vehicleStatus':
        applyArmedReading(state, sample.timeSec, readArmedState(sample.topic.name, sample.values), 'vehicle_status')
        break
      case 'actuatorArmed':
        applyArmedReading(state, sample.timeSec, readArmedState('actuator_armed', sample.values), 'actuator_armed')
        break
    }
  },

  finalize(state: ControlTrackingState, context: AnalysisContext): ModuleResult<ControlTrackingState, ControlTrackingResult> {
    const findings: DiagnosticFinding[] = []
    const chartSeries: ChartSeriesGroup[] = []
    const metrics: Record<string, unknown> = {}
    const missingReqs: string[] = []

    // Close final armed range
    if (state.currentArmedStart !== null) {
      state.armedRanges.push({ start: state.currentArmedStart, end: context.logEndSec })
    }

    // Check missing requirements
    const hasAttitudeSetpoint = state.attitudeSetpointSamples.length > 0
    const hasRatesSetpoint = state.ratesSetpointSamples.length > 0

    if (!hasAttitudeSetpoint) {
      missingReqs.push('attitudeSetpoint')
    }

    // ─── Attitude tracking ────────────────────────────────────────────

    let rollRmsError: number | null = null
    let pitchRmsError: number | null = null
    let yawRmsError: number | null = null

    const useQuatAttitude = state.attitudeHasQuat
    const useQuatSetpoint = state.setpointHasQuat

    metrics.attitudeProvenance = useQuatAttitude ? 'quaternion' : state.attitudeHasEuler ? 'euler' : 'none'
    metrics.setpointProvenance = useQuatSetpoint ? 'quaternion' : state.setpointHasEuler ? 'euler' : 'none'

    if (hasAttitudeSetpoint && state.attitudeSamples.length > 0) {
      const pairs = alignByTime(state.attitudeSamples, state.attitudeSetpointSamples, TIME_ALIGN_TOLERANCE)

      const rollErrors: number[] = []
      const pitchErrors: number[] = []
      const yawErrors: number[] = []

      const rollActualT: number[] = []
      const rollActualV: number[] = []
      const rollSpT: number[] = []
      const rollSpV: number[] = []
      const pitchActualT: number[] = []
      const pitchActualV: number[] = []
      const pitchSpT: number[] = []
      const pitchSpV: number[] = []
      const yawActualT: number[] = []
      const yawActualV: number[] = []
      const yawSpT: number[] = []
      const yawSpV: number[] = []

      for (const [att, sp] of pairs) {
        // Check if within armed range
        const inArmed = state.armedRanges.some(r => att.timeSec >= r.start && att.timeSec <= r.end)
        if (!inArmed) continue

        let aRoll: number, aPitch: number, aYaw: number
        let sRoll: number, sPitch: number, sYaw: number

        if (useQuatAttitude) {
          const q0 = Number(att.values['q[0]'] ?? 1)
          const q1 = Number(att.values['q[1]'] ?? 0)
          const q2 = Number(att.values['q[2]'] ?? 0)
          const q3 = Number(att.values['q[3]'] ?? 0)
          aRoll = quatToRoll(q0, q1, q2, q3)
          aPitch = quatToPitch(q0, q1, q2, q3)
          aYaw = quatToYaw(q0, q1, q2, q3)
        } else {
          aRoll = Number(att.values['roll'] ?? 0)
          aPitch = Number(att.values['pitch'] ?? 0)
          aYaw = Number(att.values['yaw'] ?? 0)
        }

        if (useQuatSetpoint) {
          const qd0 = Number(sp.values['q_d[0]'] ?? 1)
          const qd1 = Number(sp.values['q_d[1]'] ?? 0)
          const qd2 = Number(sp.values['q_d[2]'] ?? 0)
          const qd3 = Number(sp.values['q_d[3]'] ?? 0)
          sRoll = quatToRoll(qd0, qd1, qd2, qd3)
          sPitch = quatToPitch(qd0, qd1, qd2, qd3)
          sYaw = quatToYaw(qd0, qd1, qd2, qd3)
        } else {
          sRoll = Number(sp.values['roll_body'] ?? 0)
          sPitch = Number(sp.values['pitch_body'] ?? 0)
          sYaw = Number(sp.values['yaw_body'] ?? 0)
        }

        rollErrors.push(aRoll - sRoll)
        pitchErrors.push(aPitch - sPitch)
        yawErrors.push(aYaw - sYaw)

        rollActualT.push(att.timeSec); rollActualV.push(aRoll)
        rollSpT.push(sp.timeSec); rollSpV.push(sRoll)
        pitchActualT.push(att.timeSec); pitchActualV.push(aPitch)
        pitchSpT.push(sp.timeSec); pitchSpV.push(sPitch)
        yawActualT.push(att.timeSec); yawActualV.push(aYaw)
        yawSpT.push(sp.timeSec); yawSpV.push(sYaw)
      }

      if (rollErrors.length > 0) {
        rollRmsError = computeRms(rollErrors)
        pitchRmsError = computeRms(pitchErrors)
        yawRmsError = computeRms(yawErrors)

        const rollP95 = computeP95(rollErrors.map(Math.abs))
        const pitchP95 = computeP95(pitchErrors.map(Math.abs))
        const yawP95 = computeP95(yawErrors.map(Math.abs))
        const rollMaxOvershoot = Math.max(...rollErrors.map(Math.abs))
        const pitchMaxOvershoot = Math.max(...pitchErrors.map(Math.abs))
        const yawMaxOvershoot = Math.max(...yawErrors.map(Math.abs))

        metrics.rollRmsError = rollRmsError
        metrics.pitchRmsError = pitchRmsError
        metrics.yawRmsError = yawRmsError
        metrics.rollP95Error = rollP95
        metrics.pitchP95Error = pitchP95
        metrics.yawP95Error = yawP95
        metrics.rollMaxOvershoot = rollMaxOvershoot
        metrics.pitchMaxOvershoot = pitchMaxOvershoot
        metrics.yawMaxOvershoot = yawMaxOvershoot

        // Sustained error detection (> 0.1 rad for > 0.5 s)
        const sustainedWindows = detectSustainedErrors(rollErrors, pairs.map(p => p[0].timeSec), 0.1, 0.5)
        if (sustainedWindows.length > 0) {
          findings.push({
            id: 'control-tracking-sustained-attitude-error',
            moduleId: 'control-tracking',
            section: 'control',
            severity: 'warning',
            confidence: 'heuristic',
            title: '姿态跟踪误差持续过大',
            summary: `检测到 ${sustainedWindows.length} 个时段的姿态误差超过 0.1 rad 且持续 0.5 秒以上`,
            recommendation: '请检查 PID 参数和前馈增益',
            evidence: sustainedWindows.map(w => ({
              topic: state.attitudeSamples[0]?.topicName ?? 'vehicle_attitude',
              multiId: 0,
              fields: ['roll', 'pitch', 'yaw'],
              startSec: w.start,
              endSec: w.end,
              observed: `最大误差 ${w.maxError.toFixed(3)} rad，持续 ${(w.end - w.start).toFixed(2)} 秒`,
              threshold: '0.1 rad，持续 0.5 秒',
            })),
          })
        }

        // RMS threshold warning
        const RMS_THRESHOLD = 0.15
        if (rollRmsError > RMS_THRESHOLD || pitchRmsError > RMS_THRESHOLD) {
          findings.push({
            id: 'control-tracking-high-rms-error',
            moduleId: 'control-tracking',
            section: 'control',
            severity: 'warning',
            confidence: 'heuristic',
            title: '姿态跟踪均方根误差过大',
            summary: `横滚均方根误差：${rollRmsError.toFixed(3)} rad，俯仰均方根误差：${pitchRmsError.toFixed(3)} rad`,
            recommendation: '请检查姿态控制器参数',
            evidence: [{
              topic: state.attitudeSamples[0]?.topicName ?? 'vehicle_attitude',
              multiId: 0,
              fields: ['roll', 'pitch', 'yaw'],
              startSec: null,
              endSec: null,
              observed: `横滚 RMS=${rollRmsError.toFixed(3)}，俯仰 RMS=${pitchRmsError.toFixed(3)}`,
              threshold: `${RMS_THRESHOLD} rad`,
            }],
          })
        }

        // Chart series (bounded)
        const rA = downsample(rollActualT, rollActualV, MAX_CHART_POINTS)
        const rS = downsample(rollSpT, rollSpV, MAX_CHART_POINTS)
        const pA = downsample(pitchActualT, pitchActualV, MAX_CHART_POINTS)
        const pS = downsample(pitchSpT, pitchSpV, MAX_CHART_POINTS)
        const yA = downsample(yawActualT, yawActualV, MAX_CHART_POINTS)
        const yS = downsample(yawSpT, yawSpV, MAX_CHART_POINTS)

        chartSeries.push({
          id: 'attitude-tracking',
          title: '姿态跟踪',
          description: '解锁飞行期间横滚、俯仰和偏航的实际值与设定值',
          unit: 'rad',
          series: [
            { label: '横滚实际值', times: rA.times, values: rA.values, color: '#e74c3c' },
            { label: '横滚设定值', times: rS.times, values: rS.values, color: '#c0392b' },
            { label: '俯仰实际值', times: pA.times, values: pA.values, color: '#2ecc71' },
            { label: '俯仰设定值', times: pS.times, values: pS.values, color: '#27ae60' },
            { label: '偏航实际值', times: yA.times, values: yA.values, color: '#3498db' },
            { label: '偏航设定值', times: yS.times, values: yS.values, color: '#2980b9' },
          ],
          hasGaps: false,
        })
      }
    }

    // Default metrics if no data
    metrics.rollRmsError = rollRmsError
    metrics.pitchRmsError = pitchRmsError
    metrics.yawRmsError = yawRmsError

    // ─── Rate tracking ────────────────────────────────────────────────

    let rollRateRmsError: number | null = null
    let pitchRateRmsError: number | null = null
    let yawRateRmsError: number | null = null

    if (hasRatesSetpoint && state.angularVelocitySamples.length > 0) {
      const pairs = alignByTime(state.angularVelocitySamples, state.ratesSetpointSamples, TIME_ALIGN_TOLERANCE)

      const rErrors: number[] = []
      const pErrors: number[] = []
      const yErrors: number[] = []
      const rActT: number[] = [], rActV: number[] = []
      const rSpT: number[] = [], rSpV: number[] = []
      const pActT: number[] = [], pActV: number[] = []
      const pSpT: number[] = [], pSpV: number[] = []
      const yActT: number[] = [], yActV: number[] = []
      const ySpT: number[] = [], ySpV: number[] = []

      for (const [av, rsp] of pairs) {
        const inArmed = state.armedRanges.some(r => av.timeSec >= r.start && av.timeSec <= r.end)
        if (!inArmed) continue

        const actualP = Number(av.values['xyz[0]'] ?? 0)
        const actualQ = Number(av.values['xyz[1]'] ?? 0)
        const actualR = Number(av.values['xyz[2]'] ?? 0)
        const spP = Number(rsp.values['roll'] ?? 0)
        const spQ = Number(rsp.values['pitch'] ?? 0)
        const spR_ = Number(rsp.values['yaw'] ?? 0)

        rErrors.push(actualP - spP)
        pErrors.push(actualQ - spQ)
        yErrors.push(actualR - spR_)

        rActT.push(av.timeSec); rActV.push(actualP)
        rSpT.push(rsp.timeSec); rSpV.push(spP)
        pActT.push(av.timeSec); pActV.push(actualQ)
        pSpT.push(rsp.timeSec); pSpV.push(spQ)
        yActT.push(av.timeSec); yActV.push(actualR)
        ySpT.push(rsp.timeSec); ySpV.push(spR_)
      }

      if (rErrors.length > 0) {
        rollRateRmsError = computeRms(rErrors)
        pitchRateRmsError = computeRms(pErrors)
        yawRateRmsError = computeRms(yErrors)

        metrics.rollRateRmsError = rollRateRmsError
        metrics.pitchRateRmsError = pitchRateRmsError
        metrics.yawRateRmsError = yawRateRmsError
        metrics.rollRateP95Error = computeP95(rErrors.map(Math.abs))
        metrics.pitchRateP95Error = computeP95(pErrors.map(Math.abs))
        metrics.yawRateP95Error = computeP95(yErrors.map(Math.abs))

        const ra = downsample(rActT, rActV, MAX_CHART_POINTS)
        const rs = downsample(rSpT, rSpV, MAX_CHART_POINTS)
        const pa = downsample(pActT, pActV, MAX_CHART_POINTS)
        const ps = downsample(pSpT, pSpV, MAX_CHART_POINTS)
        const ya = downsample(yActT, yActV, MAX_CHART_POINTS)
        const ys = downsample(ySpT, ySpV, MAX_CHART_POINTS)

        chartSeries.push({
          id: 'rate-tracking',
          title: '角速度跟踪',
          description: '解锁飞行期间角速度实际值与设定值',
          unit: 'rad/s',
          series: [
            { label: '横滚角速度实际值', times: ra.times, values: ra.values, color: '#e74c3c' },
            { label: '横滚角速度设定值', times: rs.times, values: rs.values, color: '#c0392b' },
            { label: '俯仰角速度实际值', times: pa.times, values: pa.values, color: '#2ecc71' },
            { label: '俯仰角速度设定值', times: ps.times, values: ps.values, color: '#27ae60' },
            { label: '偏航角速度实际值', times: ya.times, values: ya.values, color: '#3498db' },
            { label: '偏航角速度设定值', times: ys.times, values: ys.values, color: '#2980b9' },
          ],
          hasGaps: false,
        })
      }
    }

    metrics.rollRateRmsError = rollRateRmsError
    metrics.pitchRateRmsError = pitchRateRmsError
    metrics.yawRateRmsError = yawRateRmsError

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
        rollRmsError,
        pitchRmsError,
        yawRmsError,
        rollRateRmsError,
        pitchRateRmsError,
        yawRateRmsError,
      },
    }
  },
}

// ─── Sustained error detection ──────────────────────────────────────────────

interface SustainedWindow {
  start: number
  end: number
  maxError: number
}

function detectSustainedErrors(
  errors: number[],
  times: number[],
  threshold: number,
  minDuration: number,
): SustainedWindow[] {
  const windows: SustainedWindow[] = []
  let windowStart: number | null = null
  let maxErr = 0

  for (let i = 0; i < errors.length; i++) {
    const absErr = Math.abs(errors[i]!)
    if (absErr > threshold) {
      if (windowStart === null) {
        windowStart = times[i]!
        maxErr = absErr
      } else {
        maxErr = Math.max(maxErr, absErr)
      }
    } else {
      if (windowStart !== null) {
        const windowEnd = times[i - 1]!
        if (windowEnd - windowStart >= minDuration) {
          windows.push({ start: windowStart, end: windowEnd, maxError: maxErr })
        }
        windowStart = null
        maxErr = 0
      }
    }
  }
  // Close final window
  if (windowStart !== null && times.length > 0) {
    const windowEnd = times[times.length - 1]!
    if (windowEnd - windowStart >= minDuration) {
      windows.push({ start: windowStart, end: windowEnd, maxError: maxErr })
    }
  }
  return windows
}
