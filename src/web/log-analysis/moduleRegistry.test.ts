import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { resolveTopics } from './engine/topicResolver.js'
import { ModuleRegistry } from './engine/moduleRegistry.js'
import { mergeSectionResult } from './engine/runAnalysis.js'
import type { AnalysisModule, AnalysisContext, ResolvedSample, ModuleResult, TopicRequirement } from './engine/AnalysisModule.js'
import type { SectionResult, TopicInstanceKey } from './types.js'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeSub(
  name: string,
  multiId: number,
  msgId: number,
  fields: string[] = ['timestamp', 'x', 'y', 'z'],
) {
  return { name, multiId, msgId, fields }
}

function makeModule(
  id: string,
  section: string,
  requirements: TopicRequirement[],
): AnalysisModule {
  return {
    id,
    section: section as AnalysisModule['section'],
    requirements,
    create(): Record<string, number> { return { count: 0 } },
    consume(state: Record<string, number>): void { state.count++ },
    finalize(state: Record<string, number>, _ctx: AnalysisContext): ModuleResult {
      return {
        chartSeries: [],
        metrics: { count: state.count },
        findings: [],
        consumedTopics: [],
        missingRequirements: [],
        warnings: [],
        result: state,
      }
    },
  }
}

// ─── topicResolver tests ─────────────────────────────────────────────────────

describe('resolveTopics', () => {
  it('resolves exact topic name', () => {
    const subs = [makeSub('sensor_combined', 0, 100)]
    const reqs: TopicRequirement[] = [
      { aliases: ['sensor_combined'], required: true, bindAs: 'sensor' },
    ]
    const { resolved, missing } = resolveTopics(reqs, subs)
    assert.equal(missing.length, 0)
    const topics = resolved.get('sensor')!
    assert.equal(topics.length, 1)
    assert.equal(topics[0].name, 'sensor_combined')
    assert.equal(topics[0].multiId, 0)
    assert.equal(topics[0].msgId, 100)
  })

  it('resolves aliases in order (first match wins)', () => {
    // Only the second alias exists
    const subs = [makeSub('sensor_gps', 0, 200)]
    const reqs: TopicRequirement[] = [
      { aliases: ['vehicle_gps_position', 'sensor_gps'], required: true, bindAs: 'gps' },
    ]
    const { resolved, missing } = resolveTopics(reqs, subs)
    assert.equal(missing.length, 0)
    const topics = resolved.get('gps')!
    assert.equal(topics.length, 1)
    assert.equal(topics[0].name, 'sensor_gps') // fell through to second alias
  })

  it('prefers first alias when both exist', () => {
    const subs = [
      makeSub('vehicle_gps_position', 0, 200),
      makeSub('sensor_gps', 0, 201),
    ]
    const reqs: TopicRequirement[] = [
      { aliases: ['vehicle_gps_position', 'sensor_gps'], required: true, bindAs: 'gps' },
    ]
    const { resolved } = resolveTopics(reqs, subs)
    const topics = resolved.get('gps')!
    assert.equal(topics[0].name, 'vehicle_gps_position') // first alias wins
  })

  it('optional requirement does not appear in missing when absent', () => {
    const subs: Array<{ name: string; multiId: number; msgId: number; fields: string[] }> = []
    const reqs: TopicRequirement[] = [
      { aliases: ['optional_topic'], required: false, bindAs: 'opt' },
    ]
    const { resolved, missing } = resolveTopics(reqs, subs)
    assert.equal(missing.length, 0)
    assert.deepEqual(resolved.get('opt'), [])
  })

  it('required requirement appears in missing when absent', () => {
    const subs: Array<{ name: string; multiId: number; msgId: number; fields: string[] }> = []
    const reqs: TopicRequirement[] = [
      { aliases: ['needed_topic'], required: true, bindAs: 'needed' },
    ]
    const { missing } = resolveTopics(reqs, subs)
    assert.deepEqual(missing, ['needed'])
  })

  it('handles old/new PX4 topic name aliases', () => {
    // Simulate old name: 'rc_channels', new name: 'input_rc'
    const subs = [makeSub('input_rc', 0, 300, ['timestamp', 'rssi'])]
    const reqs: TopicRequirement[] = [
      {
        aliases: ['input_rc', 'rc_channels'],
        required: true,
        bindAs: 'rcInput',
      },
    ]
    const { resolved, missing } = resolveTopics(reqs, subs)
    assert.equal(missing.length, 0)
    const topics = resolved.get('rcInput')!
    assert.equal(topics[0].name, 'input_rc')
    // Verify field map is populated
    assert.ok(topics[0].fieldMap.has('timestamp'))
    assert.ok(topics[0].fieldMap.has('rssi'))
  })

  it('resolves multiple instances (multiId 0 and 1)', () => {
    const subs = [
      makeSub('sensor_combined', 0, 100),
      makeSub('sensor_combined', 1, 101),
    ]
    const reqs: TopicRequirement[] = [
      { aliases: ['sensor_combined'], required: true, bindAs: 'sensor', multiInstance: true },
    ]
    const { resolved, missing } = resolveTopics(reqs, subs)
    assert.equal(missing.length, 0)
    const topics = resolved.get('sensor')!
    assert.equal(topics.length, 2)
    assert.equal(topics[0].multiId, 0)
    assert.equal(topics[1].multiId, 1)
  })

  it('without multiInstance, only first instance is returned', () => {
    const subs = [
      makeSub('sensor_combined', 0, 100),
      makeSub('sensor_combined', 1, 101),
    ]
    const reqs: TopicRequirement[] = [
      { aliases: ['sensor_combined'], required: true, bindAs: 'sensor', multiInstance: false },
    ]
    const { resolved } = resolveTopics(reqs, subs)
    const topics = resolved.get('sensor')!
    assert.equal(topics.length, 1)
    assert.equal(topics[0].multiId, 0)
  })
})

// ─── ModuleRegistry tests ────────────────────────────────────────────────────

describe('ModuleRegistry', () => {
  it('registers and retrieves a module by id', () => {
    const registry = new ModuleRegistry()
    const mod = makeModule('test-mod', 'overview', [])
    registry.register(mod)
    assert.equal(registry.get('test-mod'), mod)
  })

  it('throws on duplicate registration', () => {
    const registry = new ModuleRegistry()
    const mod = makeModule('dup-mod', 'overview', [])
    registry.register(mod)
    assert.throws(() => registry.register(mod), /already registered/)
  })

  it('returns undefined for unknown module id', () => {
    const registry = new ModuleRegistry()
    assert.equal(registry.get('nonexistent'), undefined)
  })

  it('getAll returns all registered modules', () => {
    const registry = new ModuleRegistry()
    const mod1 = makeModule('mod-a', 'overview', [])
    const mod2 = makeModule('mod-b', 'control', [])
    registry.register(mod1)
    registry.register(mod2)
    assert.equal(registry.getAll().length, 2)
  })

  it('getBySection filters modules by section', () => {
    const registry = new ModuleRegistry()
    registry.register(makeModule('a', 'overview', []))
    registry.register(makeModule('b', 'control', []))
    registry.register(makeModule('c', 'overview', []))
    const overviewMods = registry.getBySection('overview')
    assert.equal(overviewMods.length, 2)
    assert.ok(overviewMods.every(m => m.section === 'overview'))
  })
})

// ─── Integration: module result includes consumed topic instances ────────────

describe('Module consumed topics accounting', () => {
  it('module result includes consumed topic instances', () => {
    // Build a module that tracks consumed topics in finalize
    const mod: AnalysisModule = {
      id: 'consumer',
      section: 'sensors-power',
      requirements: [
        { aliases: ['battery_status'], required: true, bindAs: 'battery' },
      ],
      create(): { count: number } { return { count: 0 } },
      consume(state: { count: number }): void { state.count++ },
      finalize(state: { count: number }, ctx: AnalysisContext): ModuleResult {
        const consumedTopics: TopicInstanceKey[] = []
        for (const [, topic] of ctx.resolvedTopics) {
          consumedTopics.push({ name: topic.name, multiId: topic.multiId, msgId: topic.msgId })
        }
        return {
          chartSeries: [],
          metrics: { count: state.count },
          findings: [],
          consumedTopics,
          missingRequirements: [],
          warnings: [],
          result: state,
        }
      },
    }

    const subs = [makeSub('battery_status', 0, 50, ['timestamp', 'voltage_v'])]
    const reqs = mod.requirements
    const { resolved, missing } = resolveTopics(reqs, subs)

    // Build context
    const ctx: AnalysisContext = {
      resolvedTopics: new Map(),
      logStartSec: 0,
      logEndSec: 10,
      logDuration: 10,
      allSubscriptions: subs.map(s => ({ name: s.name, multiId: s.multiId, msgId: s.msgId })),
      parameters: [],
      metadata: { vehicleType: null, firmwareVersion: null, airframeName: null },
    }
    for (const [bindName, topics] of resolved) {
      if (topics.length > 0) {
        ctx.resolvedTopics.set(bindName, topics[0])
      }
    }

    const state = mod.create(ctx)
    const result = mod.finalize(state, ctx)

    assert.equal(result.consumedTopics.length, 1)
    assert.equal(result.consumedTopics[0].name, 'battery_status')
    assert.equal(result.consumedTopics[0].multiId, 0)
    assert.equal(result.consumedTopics[0].msgId, 50)
    assert.equal(missing.length, 0)
  })

  it('consumed vs raw-only coverage accounting', () => {
    // Simulate 5 discovered topic instances, 3 consumed by modules
    const discoveredTopicInstances = 5
    const unsupportedTopicInstances = 0
    const consumedKeys = new Set<string>()
    consumedKeys.add('battery_status:0')
    consumedKeys.add('sensor_combined:0')
    consumedKeys.add('sensor_combined:1')

    const analyzedTopicInstances = consumedKeys.size
    const rawOnlyTopicInstances =
      discoveredTopicInstances - analyzedTopicInstances - unsupportedTopicInstances

    assert.equal(analyzedTopicInstances, 3)
    assert.equal(rawOnlyTopicInstances, 2)
    // Invariant: discovered = analyzed + rawOnly + unsupported
    assert.equal(
      discoveredTopicInstances,
      analyzedTopicInstances + rawOnlyTopicInstances + unsupportedTopicInstances,
    )
  })
})

describe('Section result aggregation', () => {
  function sectionResult(overrides: Partial<SectionResult>): SectionResult {
    return {
      moduleId: 'module',
      section: 'control',
      available: true,
      missingRequirements: [],
      warnings: [],
      consumedTopics: [],
      metrics: {},
      chartSeries: [],
      findings: [],
      ...overrides,
    }
  }

  it('keeps a section available when any module can provide results', () => {
    const unavailable = sectionResult({
      moduleId: 'tracking',
      available: false,
      missingRequirements: ['attitude'],
    })
    const actuators = sectionResult({
      moduleId: 'actuators',
      available: true,
      metrics: { motorCount: 4 },
    })

    const merged = mergeSectionResult(unavailable, actuators)
    assert.equal(merged.available, true)
    assert.equal(merged.metrics.motorCount, 4)
    assert.deepEqual(merged.missingRequirements, ['attitude'])
  })

  it('preserves existing output when a later module fails', () => {
    const successful = sectionResult({
      metrics: { sampleCount: 42 },
      warnings: ['已有警告'],
    })
    const failed = sectionResult({
      moduleId: 'failed-module',
      available: false,
      warnings: ['模块处理失败'],
    })

    const merged = mergeSectionResult(successful, failed)
    assert.equal(merged.available, true)
    assert.equal(merged.metrics.sampleCount, 42)
    assert.deepEqual(merged.warnings, ['已有警告', '模块处理失败'])
  })
})
