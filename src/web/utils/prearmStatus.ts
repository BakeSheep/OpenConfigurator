export const PREARM_FAILURE_TTL_MS = 30_000

export interface TimedStatusText {
  id?: number
  text: string
  time: number
}

export interface StatusSessionBoundary {
  id?: number
  time: number
}

const PREARM_PATTERN = /\bpre[\s-]?arm\b/i
const TARGET_SELECTED_PATTERN = /^(?:已选定飞控目标|Flight controller target selected) system \d+ \/ component \d+$/

function isPrearmSuccess(text: string): boolean {
  const match = PREARM_PATTERN.exec(text)
  if (!match) return false
  const detail = text.slice(match.index + match[0].length)
    .replace(/^\s*:\s*/, '')
    .trim()
  return /^(?:(?:all\s+)?checks?\s+(?:passed|ok)|good|healthy|ok|ready)\b/i.test(detail)
}

function isAfterBoundary(entry: TimedStatusText, boundary: StatusSessionBoundary | null): boolean {
  if (!boundary) return true
  if (entry.time !== boundary.time) return entry.time > boundary.time
  if (entry.id !== undefined && boundary.id !== undefined) return entry.id > boundary.id
  return true
}

/**
 * Finds the newest target-selection marker emitted by useLocalRuntime. Status
 * logs are retained across reconnects, so this boundary prevents a prior
 * vehicle's PreArm result from affecting the current target.
 */
export function latestTargetSessionBoundary(
  entries: readonly TimedStatusText[],
): StatusSessionBoundary | null {
  let latest: TimedStatusText | null = null
  for (const entry of entries) {
    if (!TARGET_SELECTED_PATTERN.test(entry.text)) continue
    if (
      latest === null
      || entry.time > latest.time
      || (entry.time === latest.time && (entry.id ?? -1) > (latest.id ?? -1))
    ) {
      latest = entry
    }
  }
  return latest ? { id: latest.id, time: latest.time } : null
}

/**
 * Returns a blocking failure only when the latest PreArm message in the
 * current target session is a recent failure. A newer success resolves any
 * older failure.
 */
export function resolveRecentPrearmFailure<T extends TimedStatusText>(
  entries: readonly T[],
  options: {
    now: number
    sessionBoundary?: StatusSessionBoundary | null
    ttlMs?: number
  },
): T | null {
  const ttlMs = options.ttlMs ?? PREARM_FAILURE_TTL_MS
  const sessionBoundary = options.sessionBoundary ?? null
  let latest: T | null = null

  for (const entry of entries) {
    if (!PREARM_PATTERN.test(entry.text) || !isAfterBoundary(entry, sessionBoundary)) continue
    if (
      latest === null
      || entry.time > latest.time
      || (entry.time === latest.time && (entry.id ?? -1) > (latest.id ?? -1))
    ) {
      latest = entry
    }
  }

  if (!latest || isPrearmSuccess(latest.text)) return null
  const age = Math.max(0, options.now - latest.time)
  return age < Math.max(0, ttlMs) ? latest : null
}
