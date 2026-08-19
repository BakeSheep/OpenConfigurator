function decimalPlaces(step: number): number {
  const [coefficient, exponentText] = String(step).toLowerCase().split('e')
  const fractionDigits = coefficient.split('.')[1]?.length ?? 0
  const exponent = exponentText === undefined ? 0 : Number(exponentText)
  return Math.max(0, fractionDigits - exponent)
}

// MAVLink REAL32 parameters carry roughly seven significant decimal digits.
// Converting the decoded float directly to a string exposes binary noise such
// as 4.199999809265137 instead of the controller's intended 4.2.
export function sanitizeParameterFloat(value: number): number {
  if (!Number.isFinite(value)) return value
  return Number.parseFloat(value.toPrecision(7))
}

export function roundParameterValue(value: number, step?: number): number {
  const sanitized = sanitizeParameterFloat(value)
  if (!Number.isFinite(sanitized)) return sanitized
  const places = step !== undefined && Number.isFinite(step) && step > 0
    ? decimalPlaces(step)
    : 0
  return Number(sanitized.toFixed(Math.max(places, 4)))
}

export function formatParameterValue(value: number, step?: number): string {
  return String(roundParameterValue(value, step))
}

export function parameterValuesEqual(left: number, right: number, step?: number): boolean {
  const stepTolerance = step !== undefined && Number.isFinite(step) && step > 0 ? step / 10 : 0
  const floatTolerance = Math.max(Math.abs(right) * 1e-7, 1e-7)
  return Math.abs(left - right) <= Math.max(stepTolerance, floatTolerance)
}

export function shouldReleaseParameterDraft(
  draft: string | undefined,
  echoedValue: number,
  requestedValue: number,
  step?: number,
): boolean {
  if (draft === undefined || draft.trim() === '') return false
  const draftValue = Number(draft)
  return Number.isFinite(draftValue)
    && parameterValuesEqual(echoedValue, requestedValue, step)
    && parameterValuesEqual(draftValue, requestedValue, step)
}
