// Configured-motor discovery and invalid-gap semantics for actuator_motors.
//
// actuator_motors always logs a fixed control[12] array; unused slots carry
// IEEE NaN permanently (https://docs.px4.io/main/en/msg_docs/ActuatorMotors).
// A NaN in an unused slot is NOT a fault. Motor count must come from
// configuration evidence, falling back to finite-sample inference.

// ─── Channel evidence ────────────────────────────────────────────────────────

export interface ChannelEvidence {
  /** Zero-based control[] slot index */
  channelIndex: number
  /** Finite samples observed anywhere in the log */
  finiteSamples: number
  /** Finite samples observed inside an armed interval */
  finiteArmedSamples: number
}

// ─── Motor layout resolution ─────────────────────────────────────────────────

export type MotorLayoutSource =
  | 'ca-rotor-count'
  | 'output-function'
  | 'armed-finite'
  | 'finite'
  | 'none'

export interface MotorLayout {
  motorCount: number
  /** Zero-based channel indices considered configured motors */
  configuredChannels: number[]
  source: MotorLayoutSource
  /** True when the count was inferred from data rather than configuration */
  inferred: boolean
}

/** PX4 output-function values Motor1…Motor12 (e.g. PWM_MAIN_FUNC1 = 101) */
const MOTOR_FUNC_MIN = 101
const MOTOR_FUNC_MAX = 112

const MAX_MOTOR_CHANNELS = 12

/**
 * Resolve which control[] slots are configured motors.
 * Precedence:
 *  1. CA_ROTOR_COUNT parameter in range 1–12;
 *  2. output-function parameters (*_FUNC<n> = 101…112) naming Motor 1–12;
 *  3. channels with finite samples during an armed interval (inferred);
 *  4. channels with finite samples anywhere (inferred).
 */
export function resolveMotorLayout(
  parameters: ReadonlyArray<{ name: string; value: number | string }>,
  channels: ReadonlyArray<ChannelEvidence>,
): MotorLayout {
  // 1. CA_ROTOR_COUNT
  const rotorCount = parameters.find((p) => p.name === 'CA_ROTOR_COUNT')
  if (rotorCount && typeof rotorCount.value === 'number') {
    const n = Math.floor(rotorCount.value)
    if (n >= 1 && n <= MAX_MOTOR_CHANNELS) {
      return {
        motorCount: n,
        configuredChannels: Array.from({ length: n }, (_, i) => i),
        source: 'ca-rotor-count',
        inferred: false,
      }
    }
  }

  // 2. Output functions identifying Motor 1–12
  const motorChannels = new Set<number>()
  for (const p of parameters) {
    if (!/_FUNC\d+$/.test(p.name)) continue
    if (typeof p.value === 'number' && p.value >= MOTOR_FUNC_MIN && p.value <= MOTOR_FUNC_MAX) {
      motorChannels.add(p.value - MOTOR_FUNC_MIN)
    }
  }
  if (motorChannels.size > 0) {
    const configured = [...motorChannels].sort((a, b) => a - b)
    return {
      motorCount: configured.length,
      configuredChannels: configured,
      source: 'output-function',
      inferred: false,
    }
  }

  // 3. Finite during an armed interval
  const armedFinite = channels
    .filter((c) => c.finiteArmedSamples > 0)
    .map((c) => c.channelIndex)
    .sort((a, b) => a - b)
  if (armedFinite.length > 0) {
    return {
      motorCount: armedFinite.length,
      configuredChannels: armedFinite,
      source: 'armed-finite',
      inferred: true,
    }
  }

  // 4. Finite anywhere
  const finite = channels
    .filter((c) => c.finiteSamples > 0)
    .map((c) => c.channelIndex)
    .sort((a, b) => a - b)
  if (finite.length > 0) {
    return {
      motorCount: finite.length,
      configuredChannels: finite,
      source: 'finite',
      inferred: true,
    }
  }

  return { motorCount: 0, configuredChannels: [], source: 'none', inferred: true }
}

// ─── Invalid-gap classification ──────────────────────────────────────────────

/** Below both of these, a gap is chart-only (line break), never a finding. */
export const GAP_MIN_DURATION_SEC = 0.2
export const GAP_MIN_RATIO = 0.05
/** Gaps at least this long while armed count as sustained. */
export const GAP_SUSTAINED_DURATION_SEC = 2.0

export type GapSeverity = 'none' | 'notice' | 'warning' | 'critical'

export interface InvalidGapContext {
  /** Channel is a configured motor */
  configured: boolean
  /** Channel produced finite data before the gap started */
  hadFiniteBefore: boolean
  /** Duration of the gap that overlaps armed intervals */
  armedDurationSec: number
  /** Invalid samples in this gap relative to the channel's total samples */
  invalidRatio: number
  /** Gap coincides with the final disarm transition */
  isFinalDisarmTransition: boolean
  /** Independent failure/ESC evidence supports an actual motor loss */
  corroborated: boolean
}

/**
 * Classify an invalid (NaN) gap on a motor channel.
 * A single NaN is never critical; `critical` requires corroborating
 * failure/ESC evidence for a sustained armed gap.
 */
export function classifyInvalidGap(gap: InvalidGapContext): GapSeverity {
  if (!gap.configured) return 'none'
  if (!gap.hadFiniteBefore) return 'none'
  if (gap.isFinalDisarmTransition) return 'none'
  if (gap.armedDurationSec <= 0) return 'none'
  if (gap.armedDurationSec < GAP_MIN_DURATION_SEC && gap.invalidRatio < GAP_MIN_RATIO) {
    return 'none'
  }
  if (gap.armedDurationSec >= GAP_SUSTAINED_DURATION_SEC) {
    return gap.corroborated ? 'critical' : 'warning'
  }
  return 'notice'
}

/** Format a zero-based channel index as the user-facing 1-based motor label. */
export function motorLabel(channelIndex: number): string {
  return `电机 ${channelIndex + 1}`
}
