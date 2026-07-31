export interface SmoothedThrottle {
  output: number
  next: number
}

/**
 * Applies the optional gamepad throttle slew limit.
 *
 * A null previous value means that input has just become active. In that case
 * the first output must start at the physical stick's current position; using
 * an arbitrary numeric default can create a large transient command.
 */
export function smoothGamepadThrottle(
  target: number,
  previous: number | null,
  maxStep: number,
  enabled: boolean,
): SmoothedThrottle {
  const boundedTarget = Math.max(-1, Math.min(1, target))
  if (!enabled || previous === null || !Number.isFinite(previous)) {
    return { output: boundedTarget, next: boundedTarget }
  }

  const boundedPrevious = Math.max(-1, Math.min(1, previous))
  const step = Math.max(0, Number.isFinite(maxStep) ? maxStep : 0)
  const difference = boundedTarget - boundedPrevious
  const next = boundedPrevious + Math.max(-step, Math.min(step, difference))
  return { output: next, next }
}
