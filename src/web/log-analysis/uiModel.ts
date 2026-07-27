// Pure view-model logic for the log analysis page. No DOM, no React — just
// transforms from UlogAnalysisDataset into a shape the UI components consume.
import type {
  UlogAnalysisDataset,
  DiagnosticFinding,
  FindingSeverity,
  AnalysisSectionId,
  SectionResult,
} from './types.js'

// ─── Section labels (Chinese) ────────────────────────────────────────────────

const SECTION_LABELS: Record<AnalysisSectionId, string> = {
  overview: '概览',
  control: '控制',
  estimator: '估计器',
  'sensors-power': '传感器与动力',
  navigation: '导航',
  'events-raw': '事件与原始数据',
}

// Canonical section order
const SECTION_ORDER: AnalysisSectionId[] = [
  'overview',
  'control',
  'estimator',
  'sensors-power',
  'navigation',
  'events-raw',
]

// ─── Severity helpers ────────────────────────────────────────────────────────

const SEVERITY_RANK: Record<FindingSeverity, number> = {
  critical: 0,
  warning: 1,
  notice: 2,
  healthy: 3,
}

export function severityOrder(a: FindingSeverity, b: FindingSeverity): number {
  return SEVERITY_RANK[a] - SEVERITY_RANK[b]
}

export function getPrimaryFindings(
  findings: DiagnosticFinding[],
  maxCount = 5,
): DiagnosticFinding[] {
  return [...findings]
    .sort((a, b) => severityOrder(a.severity, b.severity))
    .slice(0, maxCount)
}

// ─── View-model ──────────────────────────────────────────────────────────────

export interface AnalysisViewModel {
  sections: AnalysisSectionId[]
  sectionLabels: Record<AnalysisSectionId, string>
  sectionCounts: Record<AnalysisSectionId, number>
  selectedSection: AnalysisSectionId
  findingsBySection: Record<AnalysisSectionId, DiagnosticFinding[]>
  overviewMetrics: Array<{ label: string; value: string }>
  hasAppendedData: boolean
  isEmpty: boolean
  emptyReason: string | null
}

function buildOverviewMetrics(dataset: UlogAnalysisDataset): Array<{ label: string; value: string }> {
  const metrics: Array<{ label: string; value: string }> = []
  const meta = dataset.metadata
  const timeline = dataset.timeline

  // Duration
  const durationSec = meta.logDuration
  if (Number.isFinite(durationSec) && durationSec > 0) {
    const min = Math.floor(durationSec / 60)
    const sec = Math.round(durationSec - min * 60)
    metrics.push({ label: '日志时长', value: min > 0 ? `${min} 分 ${sec} 秒` : `${sec} 秒` })
  }

  // Armed duration
  if (timeline.armedStartSec != null && timeline.armedEndSec != null) {
    const armed = timeline.armedEndSec - timeline.armedStartSec
    if (Number.isFinite(armed) && armed > 0) {
      const min = Math.floor(armed / 60)
      const sec = Math.round(armed - min * 60)
      metrics.push({ label: '解锁时长', value: min > 0 ? `${min} 分 ${sec} 秒` : `${sec} 秒` })
    }
  }

  // UTC time
  if (meta.utcTimeSec != null) {
    metrics.push({
      label: '起飞时间 (UTC)',
      value: new Date(meta.utcTimeSec * 1000).toISOString().replace('T', ' ').slice(0, 19),
    })
  }

  // Firmware
  if (meta.firmwareVersion) {
    metrics.push({ label: '固件', value: meta.firmwareVersion })
  }

  // Hardware
  if (meta.hardwareVersion) {
    metrics.push({ label: '硬件', value: meta.hardwareVersion })
  }

  // Vehicle type
  if (meta.vehicleType) {
    metrics.push({ label: '机型', value: meta.vehicleType })
  }

  // Dropout count
  metrics.push({
    label: '日志丢帧',
    value: String(timeline.dropoutCount),
  })

  // Parameter count
  if (dataset.parameters.length > 0) {
    metrics.push({ label: '参数数量', value: String(dataset.parameters.length) })
  }

  return metrics.slice(0, 8)
}

function determineEmptyReason(dataset: UlogAnalysisDataset | null): string | null {
  if (!dataset) return null
  const sectionKeys = Object.keys(dataset.sections) as AnalysisSectionId[]
  if (sectionKeys.length === 0) return '日志中未发现可分析的模块数据'
  const allUnavailable = sectionKeys.every((key) => {
    const section = dataset.sections[key]
    return section && !section.available
  })
  if (allUnavailable) return '所有分析模块均缺少必需的数据主题'
  return null
}

export function buildViewModel(
  dataset: UlogAnalysisDataset | null,
  selectedSection?: AnalysisSectionId,
): AnalysisViewModel {
  const empty: AnalysisViewModel = {
    sections: [],
    sectionLabels: { ...SECTION_LABELS },
    sectionCounts: Object.fromEntries(
      SECTION_ORDER.map((s) => [s, 0]),
    ) as Record<AnalysisSectionId, number>,
    selectedSection: selectedSection ?? 'overview',
    findingsBySection: Object.fromEntries(
      SECTION_ORDER.map((s) => [s, [] as DiagnosticFinding[]]),
    ) as Record<AnalysisSectionId, DiagnosticFinding[]>,
    overviewMetrics: [],
    hasAppendedData: false,
    isEmpty: true,
    emptyReason: dataset ? determineEmptyReason(dataset) : '尚未加载日志文件',
  }

  if (!dataset) return empty

  // Determine available sections (present AND available)
  const availableSections: AnalysisSectionId[] = []
  for (const id of SECTION_ORDER) {
    const section = dataset.sections[id]
    if (section && section.available) availableSections.push(id)
  }

  // Build finding counts and grouped findings
  const sectionCounts = {} as Record<AnalysisSectionId, number>
  const findingsBySection = {} as Record<AnalysisSectionId, DiagnosticFinding[]>
  for (const id of SECTION_ORDER) {
    const section = dataset.sections[id]
    if (section) {
      findingsBySection[id] = section.findings
      sectionCounts[id] = section.findings.length
    } else {
      findingsBySection[id] = []
      sectionCounts[id] = 0
    }
  }

  // Selected section fallback
  let selected = selectedSection ?? 'overview'
  if (availableSections.length > 0 && !availableSections.includes(selected)) {
    selected = availableSections[0]
  }
  if (availableSections.length === 0) {
    selected = 'overview'
  }

  return {
    sections: availableSections.length > 0 ? availableSections : SECTION_ORDER,
    sectionLabels: { ...SECTION_LABELS },
    sectionCounts,
    selectedSection: selected,
    findingsBySection,
    overviewMetrics: buildOverviewMetrics(dataset),
    hasAppendedData: dataset.metadata.hadAppendedData,
    isEmpty: availableSections.length === 0,
    emptyReason: determineEmptyReason(dataset),
  }
}

// ─── Helpers for section severity (worst finding in section) ─────────────────

export function sectionWorstSeverity(
  findings: DiagnosticFinding[],
): FindingSeverity | null {
  if (findings.length === 0) return null
  let worst: FindingSeverity = 'healthy'
  for (const f of findings) {
    if (severityOrder(f.severity, worst) < 0) {
      worst = f.severity
    }
  }
  return worst
}

// ─── Section result helper ───────────────────────────────────────────────────

export function getSectionResult(
  dataset: UlogAnalysisDataset,
  sectionId: AnalysisSectionId,
): SectionResult | null {
  return dataset.sections[sectionId] ?? null
}
