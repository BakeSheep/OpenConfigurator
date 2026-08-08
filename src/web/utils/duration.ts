export function roundedDurationParts(value: number): { minutes: number; seconds: number } | null {
  if (!Number.isFinite(value) || value <= 0) return null
  const totalSeconds = Math.round(value)
  return {
    minutes: Math.floor(totalSeconds / 60),
    seconds: totalSeconds % 60,
  }
}
