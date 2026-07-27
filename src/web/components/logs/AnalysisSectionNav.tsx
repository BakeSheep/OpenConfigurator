// Section tab navigation for the log analysis page. Text-only tabs with
// finding count badges and severity status dots — no icons.
import type { AnalysisSectionId, FindingSeverity } from '../../log-analysis/types.js'
import { sectionWorstSeverity } from '../../log-analysis/uiModel.js'
import type { DiagnosticFinding } from '../../log-analysis/types.js'

interface Props {
  sections: AnalysisSectionId[]
  labels: Record<AnalysisSectionId, string>
  counts: Record<AnalysisSectionId, number>
  findingsBySection: Record<AnalysisSectionId, DiagnosticFinding[]>
  selected: AnalysisSectionId
  onSelect: (section: AnalysisSectionId) => void
}

const SEVERITY_DOT_CLASS: Record<FindingSeverity, string> = {
  critical: 'analysis-nav__dot--critical',
  warning: 'analysis-nav__dot--warning',
  notice: 'analysis-nav__dot--notice',
  healthy: 'analysis-nav__dot--healthy',
}

export default function AnalysisSectionNav({
  sections,
  labels,
  counts,
  findingsBySection,
  selected,
  onSelect,
}: Props) {
  return (
    <nav className="analysis-section-nav" aria-label="分析分区导航">
      <div className="analysis-section-nav__scroll">
        {sections.map((id) => {
          const worst = sectionWorstSeverity(findingsBySection[id] ?? [])
          const count = counts[id] ?? 0
          const isActive = id === selected
          return (
            <button
              key={id}
              type="button"
              className={`analysis-section-nav__tab${isActive ? ' is-active' : ''}`}
              aria-current={isActive ? 'page' : undefined}
              onClick={() => onSelect(id)}
            >
              <span className="analysis-section-nav__label">{labels[id]}</span>
              {count > 0 && (
                <span className="analysis-section-nav__badge">{count}</span>
              )}
              {worst && (
                <span
                  className={`analysis-section-nav__dot ${SEVERITY_DOT_CLASS[worst]}`}
                  aria-label={`最严重: ${worst}`}
                />
              )}
            </button>
          )
        })}
      </div>
    </nav>
  )
}
