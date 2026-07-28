import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildSectionMetrics } from './metricPresentation.js'
import { formatChartValue } from './chartFormatting.js'
import type { SectionModuleResult } from './types.js'

function moduleResult(moduleId: string, metrics: Record<string, unknown>): SectionModuleResult {
  return {
    moduleId,
    available: true,
    missingRequirements: [],
    warnings: [],
    consumedTopics: [],
    metrics,
  }
}

describe('buildSectionMetrics', () => {
  it('uses localized presentation descriptors instead of internal keys', () => {
    const metrics = buildSectionMetrics([
      moduleResult('control-tracking', {
        attitudeProvenance: 'quaternion',
        rollRmsError: 1.234,
        internalDebugValue: 99,
      }),
      moduleResult('actuators', { motorCount: 4 }),
    ])

    assert.deepEqual(metrics.map((metric) => metric.label), [
      '姿态数据来源',
      '横滚 RMS 误差',
      '已配置电机',
    ])
    assert.equal(metrics[0]!.value, '四元数')
    assert.equal(metrics[1]!.value, '1.23 °')
    assert.equal(metrics[2]!.id, 'actuators:motorCount')
    assert.ok(metrics.every((metric) => !metric.label.includes('internal')))
  })
})

describe('formatChartValue', () => {
  it('renders null and non-finite values as unavailable', () => {
    assert.equal(formatChartValue(null), '—')
    assert.equal(formatChartValue(NaN), '—')
    assert.equal(formatChartValue(Infinity), '—')
  })

  it('formats finite chart values with an optional unit', () => {
    assert.equal(formatChartValue(1.234, 'V'), '1.23 V')
  })
})