import { MessageType } from '@foxglove/ulog'
import type { UlogDocument } from '../parser/UlogDocument.js'
import type { ModuleRegistry } from './moduleRegistry.js'
import type { AnalysisContext, AnalysisModule, ResolvedSample, ResolvedTopic } from './AnalysisModule.js'
import { resolveTopics } from './topicResolver.js'
import type { SectionResult, AnalysisSectionId, CoverageSummary, TopicInstanceKey, DiagnosticFinding } from '../types.js'

export interface AnalysisRunResult {
  sections: Partial<Record<AnalysisSectionId, SectionResult>>
  findings: DiagnosticFinding[]
  coverage: CoverageSummary
}

export interface CancelToken {
  readonly canceled: boolean
}

/** Merge module output without letting one unavailable/failed module hide its peers. */
export function mergeSectionResult(
  existing: SectionResult | undefined,
  next: SectionResult,
): SectionResult {
  if (!existing) return next

  // Concatenate ordered chart families across modules, keeping each module's
  // identity and metrics in moduleResults[] rather than flattening.
  const chartFamilies = [...existing.chartFamilies, ...next.chartFamilies]
    .sort((a, b) => a.order - b.order)

  return {
    section: existing.section,
    available: existing.available || next.available,
    moduleResults: [...existing.moduleResults, ...next.moduleResults],
    chartFamilies,
    findings: [...existing.findings, ...next.findings],
    warnings: [...existing.warnings, ...next.warnings],
  }
}

export async function runAnalysis(
  doc: UlogDocument,
  registry: ModuleRegistry,
  onProgress?: (phase: string, fraction: number) => void,
  cancelToken?: CancelToken,
): Promise<AnalysisRunResult> {
  const modules = registry.getAll()
  const subscriptions = doc.rawUlog.subscriptions

  // Build subscription array with field info from catalog
  const subArray: Array<{ name: string; multiId: number; msgId: number; fields: string[] }> = []
  for (const [msgId, sub] of subscriptions) {
    subArray.push({
      name: sub.name,
      multiId: sub.multiId,
      msgId,
      fields: [], // populated below from catalog
    })
  }

  // Populate fields from catalog
  for (const entry of doc.catalog) {
    const sub = subArray.find(s => s.msgId === entry.msgId)
    if (sub) {
      sub.fields = entry.fields.map(f => f.path)
    }
  }

  // Resolve topics for all modules
  const moduleResolutions = new Map<string, {
    resolved: Map<string, ResolvedTopic[]>
    missing: string[]
  }>()

  for (const mod of modules) {
    const resolution = resolveTopics(mod.requirements, subArray)
    moduleResolutions.set(mod.id, resolution)
  }

  // Build msgId → module+bindName mapping
  const msgIdToModules = new Map<number, Array<{ module: AnalysisModule; bindName: string }>>()
  for (const mod of modules) {
    const resolution = moduleResolutions.get(mod.id)!
    for (const [bindName, topics] of resolution.resolved) {
      for (const topic of topics) {
        const entries = msgIdToModules.get(topic.msgId) ?? []
        entries.push({ module: mod, bindName })
        msgIdToModules.set(topic.msgId, entries)
      }
    }
  }

  // Shared context fields
  const baseContext: Omit<AnalysisContext, 'resolvedTopics'> = {
    logStartSec: doc.timeline.logStartSec,
    logEndSec: doc.timeline.logEndSec,
    logDuration: doc.metadata.logDuration,
    allSubscriptions: subArray.map(s => ({ name: s.name, multiId: s.multiId, msgId: s.msgId })),
    parameters: doc.parameters.map(p => ({ name: p.name, value: p.value })),
    metadata: {
      vehicleType: doc.metadata.vehicleType,
      firmwareVersion: doc.metadata.firmwareVersion,
      airframeName: doc.metadata.airframeName,
    },
  }

  // Helper to build per-module context
  function buildModuleContext(mod: AnalysisModule): AnalysisContext {
    const resolution = moduleResolutions.get(mod.id)!
    const resolvedTopics = new Map<string, ResolvedTopic>()
    for (const [bindName, topics] of resolution.resolved) {
      if (topics.length > 0) {
        resolvedTopics.set(bindName, topics[0])
      }
    }
    return { ...baseContext, resolvedTopics }
  }

  // Create module states
  const states = new Map<string, unknown>()
  for (const mod of modules) {
    states.set(mod.id, mod.create(buildModuleContext(mod)))
  }

  // Stream through messages once
  onProgress?.('analyzing', 0.3)

  const ulog = doc.rawUlog
  const wantedMsgIds = new Set(msgIdToModules.keys())

  if (wantedMsgIds.size > 0) {
    const timeBase = doc.timeline.logStartSec
    let sampleCount = 0

    for await (const message of ulog.readMessages({ msgIds: wantedMsgIds })) {
      // Cancellation checkpoint every 5000 samples
      if (sampleCount % 5000 === 0 && cancelToken?.canceled) {
        throw new Error('canceled')
      }
      if (message.type !== MessageType.Data) continue

      const modEntries = msgIdToModules.get(message.msgId)
      if (!modEntries) continue

      const timeSec = Number(message.value.timestamp) / 1e6 - timeBase

      for (const { module: mod, bindName } of modEntries) {
        const resolution = moduleResolutions.get(mod.id)!
        const topics = resolution.resolved.get(bindName)
        if (!topics || topics.length === 0) continue

        const topic = topics.find(t => t.msgId === message.msgId)
        if (!topic) continue

        const sample: ResolvedSample = {
          topic,
          timeSec,
          values: {},
        }

        // Extract field values
        for (const [fieldPath] of topic.fieldMap) {
          let val = message.value[fieldPath]
          // Handle array field paths like "xyz[0]" — the library may store
          // these as nested arrays (message.value.xyz[0]) rather than flat keys.
          if (val === undefined) {
            const bracketMatch = /^(.+)\[(\d+)\]$/.exec(fieldPath)
            if (bracketMatch) {
              const arr = message.value[bracketMatch[1]!]
              if (Array.isArray(arr)) {
                val = arr[parseInt(bracketMatch[2]!, 10)]
              }
            }
          }
          if (val !== undefined) {
            if (typeof val === 'number' || typeof val === 'string' || typeof val === 'boolean') {
              sample.values[fieldPath] = val
            } else if (typeof val === 'bigint') {
              sample.values[fieldPath] = Number(val)
            }
          }
        }

        mod.consume(states.get(mod.id)!, sample, bindName)
        sampleCount++
      }

      // Progress reporting (every 10000 samples)
      if (sampleCount % 10000 === 0) {
        onProgress?.('analyzing', 0.3 + 0.5 * Math.min(sampleCount / 1000000, 1))
      }
    }
  }

  onProgress?.('analyzing', 0.9)

  // Finalize all modules
  const sections: Partial<Record<AnalysisSectionId, SectionResult>> = {}
  const allFindings: DiagnosticFinding[] = []

  for (const mod of modules) {
    const resolution = moduleResolutions.get(mod.id)!
    const modContext = buildModuleContext(mod)

    try {
      const result = mod.finalize(states.get(mod.id)!, modContext)

      const consumedTopics: TopicInstanceKey[] = []
      for (const [, topics] of resolution.resolved) {
        for (const t of topics) {
          consumedTopics.push({ name: t.name, multiId: t.multiId, msgId: t.msgId })
        }
      }

      const hasMissingRequired = mod.requirements.some(
        r => r.required && resolution.missing.includes(r.bindAs),
      )

      const sectionResult: SectionResult = {
        section: mod.section,
        available: !hasMissingRequired,
        moduleResults: [{
          moduleId: mod.id,
          available: !hasMissingRequired,
          missingRequirements: resolution.missing,
          warnings: result.warnings,
          consumedTopics,
          metrics: result.metrics,
        }],
        chartFamilies: [...result.chartFamilies].sort((a, b) => a.order - b.order),
        findings: result.findings,
        warnings: result.warnings,
      }

      // If multiple modules target same section, merge
      sections[mod.section] = mergeSectionResult(sections[mod.section], sectionResult)

      allFindings.push(...result.findings)
    } catch (err) {
      // Module failed — report as warning but don't crash the whole analysis
      const sectionResult: SectionResult = {
        section: mod.section,
        available: false,
        moduleResults: [{
          moduleId: mod.id,
          available: false,
          missingRequirements: resolution.missing,
          warnings: [`分析模块 "${mod.id}" 处理失败，已跳过`],
          consumedTopics: [],
          metrics: {},
        }],
        chartFamilies: [],
        findings: [],
        warnings: [`分析模块 "${mod.id}" 处理失败，已跳过`],
      }
      sections[mod.section] = mergeSectionResult(sections[mod.section], sectionResult)
    }
  }

  // Update coverage
  const coverage: CoverageSummary = { ...doc.coverage }
  const consumedSet = new Set<string>()
  for (const [, section] of Object.entries(sections)) {
    if (section) {
      for (const modResult of section.moduleResults) {
        for (const t of modResult.consumedTopics) {
          consumedSet.add(`${t.name}:${t.multiId}`)
        }
      }
    }
  }
  coverage.analyzedTopicInstances = consumedSet.size
  coverage.rawOnlyTopicInstances =
    coverage.discoveredTopicInstances - consumedSet.size - coverage.unsupportedTopicInstances

  return {
    sections,
    findings: allFindings,
    coverage,
  }
}
