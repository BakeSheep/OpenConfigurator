// Advisory quality helpers for ArduPilot MAG_CAL_REPORT.
//
// IMPORTANT: these are operator-facing hints only. The authoritative pass/fail
// signal is the firmware `cal_status` in the report; nothing here may override
// it. The fitness buckets and offset warning threshold are heuristics that
// mirror the guidance used by Mission Planner / ArduPilot's compass setup wiki
// (lower fitness = better; large offsets suggest interference or a bad mount).
// They are labelled heuristic on purpose and were not copied from a specific
// source line, so treat them as tunable advisory values.

export type MagFitnessLevel = 'good' | 'acceptable' | 'marginal' | 'poor' | 'unknown'

/** Fitness (mGauss RMS residual) bucket boundaries, ascending = worse. */
export const MAG_FITNESS_THRESHOLDS = {
  good: 8,
  acceptable: 16,
  marginal: 25,
} as const

/** Offset magnitude above which a large-offset advisory is shown (mGauss). */
export const MAG_OFFSET_WARN_MGAUSS = 600

const FITNESS_LABELS: Record<MagFitnessLevel, string> = {
  good: '优秀',
  acceptable: '良好',
  marginal: '勉强可用',
  poor: '较差',
  unknown: '未知',
}

export interface MagFitnessRating {
  level: MagFitnessLevel
  label: string
}

/** Classify a fitness value into an advisory rating (never a pass/fail gate). */
export function magFitnessRating(fitness: number): MagFitnessRating {
  if (!Number.isFinite(fitness)) return { level: 'unknown', label: FITNESS_LABELS.unknown }
  const level: MagFitnessLevel = fitness < MAG_FITNESS_THRESHOLDS.good
    ? 'good'
    : fitness < MAG_FITNESS_THRESHOLDS.acceptable
      ? 'acceptable'
      : fitness < MAG_FITNESS_THRESHOLDS.marginal
        ? 'marginal'
        : 'poor'
  return { level, label: FITNESS_LABELS[level] }
}

/** Euclidean magnitude of the offset vector (mGauss). */
export function magOffsetMagnitude(ofs: readonly [number, number, number]): number {
  const [x, y, z] = ofs
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return Number.NaN
  return Math.sqrt(x * x + y * y + z * z)
}

/** Advisory: true when the offset magnitude exceeds the warning threshold. */
export function magOffsetWarning(ofs: readonly [number, number, number]): boolean {
  const magnitude = magOffsetMagnitude(ofs)
  return Number.isFinite(magnitude) && magnitude > MAG_OFFSET_WARN_MGAUSS
}
