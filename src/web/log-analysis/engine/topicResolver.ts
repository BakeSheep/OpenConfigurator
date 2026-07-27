import type { TopicRequirement, ResolvedTopic } from './AnalysisModule.js'

/**
 * Resolve topic requirements against available subscriptions.
 * For each requirement, try aliases in order. First match wins.
 * Returns resolved topics map (bindAs → ResolvedTopic[]) and missing requirements.
 */
export function resolveTopics(
  requirements: TopicRequirement[],
  subscriptions: Array<{ name: string; multiId: number; msgId: number; fields: string[] }>,
): { resolved: Map<string, ResolvedTopic[]>; missing: string[] } {
  const resolved = new Map<string, ResolvedTopic[]>()
  const missing: string[] = []

  for (const req of requirements) {
    const matches: ResolvedTopic[] = []

    for (const alias of req.aliases) {
      const matchingSubs = subscriptions.filter(s => s.name === alias)
      if (matchingSubs.length > 0) {
        for (const sub of matchingSubs) {
          if (!req.multiInstance && matches.length > 0) break
          const fieldMap = new Map<string, string>()
          for (const field of sub.fields) {
            fieldMap.set(field, field)
          }
          matches.push({
            name: sub.name,
            multiId: sub.multiId,
            msgId: sub.msgId,
            fieldMap,
          })
        }
        break // First matching alias wins
      }
    }

    if (matches.length === 0 && req.required) {
      missing.push(req.bindAs)
    }

    resolved.set(req.bindAs, matches)
  }

  return { resolved, missing }
}
