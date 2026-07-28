import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildViewModel,
  severityOrder,
  getPrimaryFindings,
  sectionWorstSeverity,
  getSectionResult,
} from './uiModel.js'
import { buildChartWorkspaceModel } from './chartModel.js'
import type { ChartFamily } from './types.js'
import type {
  UlogAnalysisDataset,
  DiagnosticFinding,
  FindingSeverity,
  AnalysisSectionId,
  SectionResult,
  CoverageSummary,
  TimelineSummary,
  UlogMetadata,
} from './types.js'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeFinding(overrides: Partial<DiagnosticFinding> = {}): DiagnosticFinding {
  return {
    id: 'f-1',
    moduleId: 'test-module',
    section: 'overview',
    severity: 'notice',
    confidence: 'measured',
    title: 'Test finding',
    summary: 'A test finding',
    recommendation: null,
    evidence: [],
    ...overrides,
  }
}

function makeDataset(overrides: Partial<UlogAnalysisDataset> = {}): UlogAnalysisDataset {
  const metadata: UlogMetadata = {
    version: 1,
    timestamp: null,
    utcTimeSec: null,
    vehicleType: null,
    vehicleUuid: null,
    airframeName: null,
    firmwareVersion: null,
    hardwareVersion: null,
    systemInfo: {},
    information: {},
    multiInformation: [],
    logDuration: 120,
    hadAppendedData: false,
    warnings: [],
  }
  const coverage: CoverageSummary = {
    discoveredTopicInstances: 5,
    analyzedTopicInstances: 3,
    rawOnlyTopicInstances: 2,
    unsupportedTopicInstances: 0,
    discoveredFields: 40,
    plottableFields: 20,
    warnings: [],
  }
  const timeline: TimelineSummary = {
    logStartSec: 0,
    logEndSec: 120,
    armedStartSec: 10,
    armedEndSec: 110,
    takeoffSec: 15,
    landSec: 105,
    modeChanges: [{ timeSec: 20, mode: 'ALTITUDE' }],
    dropoutCount: 0,
    dropoutTotalMs: 0,
    dropoutMaxMs: 0,
    dropoutMeanMs: 0,
  }
  return {
    metadata,
    catalog: [],
    coverage,
    findings: [],
    parameters: [],
    events: [],
    sections: {},
    timeline,
    ...overrides,
  }
}

function makeSectionResult(overrides: {
  section?: SectionResult['section']
  moduleId?: string
  available?: boolean
  missingRequirements?: string[]
  findings?: SectionResult['findings']
  chartFamilies?: SectionResult['chartFamilies']
} = {}): SectionResult {
  return {
    section: overrides.section ?? 'overview',
    available: overrides.available ?? true,
    moduleResults: [{
      moduleId: overrides.moduleId ?? 'test',
      available: overrides.available ?? true,
      missingRequirements: overrides.missingRequirements ?? [],
      warnings: [],
      consumedTopics: [],
      metrics: {},
    }],
    chartFamilies: overrides.chartFamilies ?? [],
    findings: overrides.findings ?? [],
    warnings: [],
  }
}

// ─── severityOrder ───────────────────────────────────────────────────────────

describe('severityOrder', () => {
  it('critical < warning < notice < healthy', () => {
    assert.ok(severityOrder('critical', 'warning') < 0)
    assert.ok(severityOrder('warning', 'notice') < 0)
    assert.ok(severityOrder('notice', 'healthy') < 0)
    assert.ok(severityOrder('critical', 'healthy') < 0)
  })

  it('returns 0 for equal severities', () => {
    assert.equal(severityOrder('critical', 'critical'), 0)
    assert.equal(severityOrder('healthy', 'healthy'), 0)
  })

  it('reverse comparison returns positive', () => {
    assert.ok(severityOrder('healthy', 'critical') > 0)
    assert.ok(severityOrder('warning', 'critical') > 0)
  })
})

// ─── getPrimaryFindings ──────────────────────────────────────────────────────

describe('getPrimaryFindings', () => {
  it('sorts by severity and limits to maxCount', () => {
    const findings: DiagnosticFinding[] = [
      makeFinding({ id: 'f1', severity: 'healthy' }),
      makeFinding({ id: 'f2', severity: 'critical' }),
      makeFinding({ id: 'f3', severity: 'warning' }),
      makeFinding({ id: 'f4', severity: 'notice' }),
      makeFinding({ id: 'f5', severity: 'warning' }),
      makeFinding({ id: 'f6', severity: 'critical' }),
    ]
    const primary = getPrimaryFindings(findings, 3)
    assert.equal(primary.length, 3)
    assert.equal(primary[0].severity, 'critical')
    assert.equal(primary[1].severity, 'critical')
    assert.equal(primary[2].severity, 'warning')
  })

  it('returns all findings if fewer than maxCount', () => {
    const findings = [
      makeFinding({ id: 'f1', severity: 'warning' }),
      makeFinding({ id: 'f2', severity: 'notice' }),
    ]
    const primary = getPrimaryFindings(findings)
    assert.equal(primary.length, 2)
  })

  it('returns empty array for empty input', () => {
    assert.equal(getPrimaryFindings([]).length, 0)
  })
})

// ─── sectionWorstSeverity ────────────────────────────────────────────────────

describe('sectionWorstSeverity', () => {
  it('returns null for empty findings', () => {
    assert.equal(sectionWorstSeverity([]), null)
  })

  it('returns worst severity from findings', () => {
    const findings = [
      makeFinding({ severity: 'healthy' }),
      makeFinding({ severity: 'notice' }),
      makeFinding({ severity: 'warning' }),
    ]
    assert.equal(sectionWorstSeverity(findings), 'warning')
  })

  it('returns critical when any critical finding exists', () => {
    const findings = [
      makeFinding({ severity: 'notice' }),
      makeFinding({ severity: 'critical' }),
      makeFinding({ severity: 'warning' }),
    ]
    assert.equal(sectionWorstSeverity(findings), 'critical')
  })
})

// ─── buildViewModel ──────────────────────────────────────────────────────────

describe('buildViewModel', () => {
  it('returns empty state for null dataset', () => {
    const vm = buildViewModel(null)
    assert.equal(vm.isEmpty, true)
    assert.equal(vm.emptyReason, '尚未加载日志文件')
    assert.equal(vm.sections.length, 0)
    assert.equal(vm.selectedSection, 'overview')
  })

  it('returns available sections from dataset', () => {
    const ds = makeDataset({
      sections: {
        overview: makeSectionResult({ section: 'overview' }),
        control: makeSectionResult({ section: 'control', moduleId: 'ctrl' }),
      },
    })
    const vm = buildViewModel(ds)
    assert.deepEqual(vm.sections, ['overview', 'control'])
    assert.equal(vm.isEmpty, false)
    assert.equal(vm.emptyReason, null)
  })

  it('counts findings per section', () => {
    const ds = makeDataset({
      sections: {
        overview: makeSectionResult({
          section: 'overview',
          findings: [
            makeFinding({ id: 'f1', section: 'overview' }),
            makeFinding({ id: 'f2', section: 'overview', severity: 'warning' }),
          ],
        }),
        control: makeSectionResult({
          section: 'control',
          moduleId: 'ctrl',
          findings: [makeFinding({ id: 'f3', section: 'control' })],
        }),
      },
    })
    const vm = buildViewModel(ds)
    assert.equal(vm.sectionCounts.overview, 2)
    assert.equal(vm.sectionCounts.control, 1)
    assert.equal(vm.sectionCounts.estimator, 0)
  })

  it('falls back selected section when not available', () => {
    const ds = makeDataset({
      sections: {
        control: makeSectionResult({ section: 'control', moduleId: 'ctrl' }),
      },
    })
    const vm = buildViewModel(ds, 'overview')
    // 'overview' is not available, should fall back to first available
    assert.equal(vm.selectedSection, 'control')
  })

  it('keeps selected section when it is available', () => {
    const ds = makeDataset({
      sections: {
        overview: makeSectionResult({ section: 'overview' }),
        control: makeSectionResult({ section: 'control', moduleId: 'ctrl' }),
      },
    })
    const vm = buildViewModel(ds, 'control')
    assert.equal(vm.selectedSection, 'control')
  })

  it('generates overview metrics', () => {
    const ds = makeDataset({
      metadata: {
        version: 1,
        timestamp: null,
        utcTimeSec: 1700000000,
        vehicleType: 'Quadrotor',
        vehicleUuid: null,
        airframeName: null,
        firmwareVersion: '1.14.0',
        hardwareVersion: 'HW v3',
        systemInfo: {},
        information: {},
        multiInformation: [],
        logDuration: 300,
        hadAppendedData: false,
        warnings: [],
      },
      sections: {
        overview: makeSectionResult({ section: 'overview' }),
      },
    })
    const vm = buildViewModel(ds)
    assert.ok(vm.overviewMetrics.length > 0)
    assert.ok(vm.overviewMetrics.length <= 8)
    const labels = vm.overviewMetrics.map((m) => m.label)
    assert.ok(labels.includes('日志时长'))
    assert.ok(labels.includes('固件'))
  })

  it('reports empty reason when all sections unavailable', () => {
    const ds = makeDataset({
      sections: {
        overview: makeSectionResult({ section: 'overview', available: false, missingRequirements: ['sensor_combined'] }),
      },
    })
    const vm = buildViewModel(ds)
    assert.equal(vm.isEmpty, true)
    assert.equal(vm.emptyReason, '所有分析模块均缺少必需的数据主题')
  })

  it('hasAppendedData reflects metadata', () => {
    const ds = makeDataset({
      metadata: {
        version: 1,
        timestamp: null,
        utcTimeSec: null,
        vehicleType: null,
        vehicleUuid: null,
        airframeName: null,
        firmwareVersion: null,
        hardwareVersion: null,
        systemInfo: {},
        information: {},
        multiInformation: [],
        logDuration: 60,
        hadAppendedData: true,
        warnings: [],
      },
      sections: {
        overview: makeSectionResult({ section: 'overview' }),
      },
    })
    const vm = buildViewModel(ds)
    assert.equal(vm.hasAppendedData, true)
  })

  it('groups findings by section', () => {
    const findings: DiagnosticFinding[] = [
      makeFinding({ id: 'f1', section: 'overview' }),
      makeFinding({ id: 'f2', section: 'control', moduleId: 'ctrl' }),
    ]
    const ds = makeDataset({
      findings,
      sections: {
        overview: makeSectionResult({ section: 'overview', findings: [findings[0]] }),
        control: makeSectionResult({ section: 'control', moduleId: 'ctrl', findings: [findings[1]] }),
      },
    })
    const vm = buildViewModel(ds)
    assert.equal(vm.findingsBySection.overview.length, 1)
    assert.equal(vm.findingsBySection.control.length, 1)
    assert.equal(vm.findingsBySection.estimator.length, 0)
  })
})

// ─── getSectionResult ────────────────────────────────────────────────────────

describe('getSectionResult', () => {
  it('returns section result when present', () => {
    const section = makeSectionResult({ section: 'overview' })
    const ds = makeDataset({ sections: { overview: section } })
    assert.equal(getSectionResult(ds, 'overview'), section)
  })

  it('returns null when section not present', () => {
    const ds = makeDataset({ sections: {} })
    assert.equal(getSectionResult(ds, 'control'), null)
  })
})

// ─── Render contract: one chart workspace per active section ─────────────

describe('section workspace render contract', () => {
  function familyWithViews(id: string, moduleId: string, viewIds: string[], order: number): ChartFamily {
    return {
      id,
      moduleId,
      title: id,
      description: '',
      views: viewIds.map((vid) => ({
        id: vid,
        title: vid,
        description: '',
        unit: 'rad',
        series: [{ id: `${vid}-a`, label: 'A', times: [0, 1], values: [0, 1] }],
        defaultVisibleSeriesIds: [`${vid}-a`],
        xAxis: 'time' as const,
        hasGaps: false,
      })),
      defaultViewId: viewIds[0]!,
      order,
    }
  }

  it('mounts exactly one view for a section with multiple families and views', () => {
    // control section: control-tracking (6 views) + actuators (1 view)
    const families: ChartFamily[] = [
      familyWithViews('control-tracking', 'control-tracking',
        ['att-roll', 'att-pitch', 'att-yaw', 'rate-roll', 'rate-pitch', 'rate-yaw'], 10),
      familyWithViews('actuators', 'actuators', ['motor-outputs'], 20),
    ]
    const totalViews = families.reduce((n, f) => n + f.views.length, 0)
    assert.equal(totalViews, 7, 'fixture has 7 candidate views')

    const model = buildChartWorkspaceModel(families)
    // Despite 7 views across 2 families, exactly ONE view is active/mounted.
    assert.ok(model.activeView && !Array.isArray(model.activeView))
    assert.equal(model.activeFamilyId, 'control-tracking')
    assert.equal(model.activeViewId, 'att-roll')
  })

  it('a text selector changes the mounted view without creating another card', () => {
    const families: ChartFamily[] = [
      familyWithViews('imu', 'sensors', ['imu-acceleration', 'imu-angular-rate'], 10),
      familyWithViews('environment-sensors', 'sensors', ['mag-0', 'baro-pressure'], 12),
    ]
    // Selecting the second family switches to its default view only.
    const switched = buildChartWorkspaceModel(families, 'environment-sensors')
    assert.equal(switched.activeFamilyId, 'environment-sensors')
    assert.equal(switched.activeViewId, 'mag-0')
    assert.ok(switched.activeView && !Array.isArray(switched.activeView))
  })
})
