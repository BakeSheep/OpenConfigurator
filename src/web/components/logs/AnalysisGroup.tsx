// Reusable analysis group card. Each group shows a title, optional description,
// a compact metrics row, a primary chart area (children), findings, and an
// optional disclosure panel for details.
import { useState } from 'react'
import type { DiagnosticFinding } from '../../log-analysis/types.js'
import FindingsList from './FindingsList.js'

interface Props {
  title: string
  description?: string
  metrics?: Array<{ label: string; value: string | number }>
  findings?: DiagnosticFinding[]
  children?: React.ReactNode
  details?: React.ReactNode
}

export default function AnalysisGroup({
  title,
  description,
  metrics,
  findings,
  children,
  details,
}: Props) {
  const [detailsOpen, setDetailsOpen] = useState(false)

  return (
    <section className="mc-card analysis-group">
      <header className="analysis-group__header">
        <h3 className="mc-section-title">{title}</h3>
      </header>

      {description && (
        <p className="analysis-group__desc">{description}</p>
      )}

      {metrics && metrics.length > 0 && (
        <div className="analysis-group__metrics">
          {metrics.map((m) => (
            <div key={m.label} className="analysis-group__metric">
              <span>{m.label}</span>
              <strong className="mc-mono">{String(m.value)}</strong>
            </div>
          ))}
        </div>
      )}

      {children && (
        <div className="analysis-group__chart">
          {children}
        </div>
      )}

      {findings && findings.length > 0 && (
        <FindingsList findings={findings} />
      )}

      {details && (
        <div className="analysis-group__details">
          <button
            type="button"
            className="analysis-group__details-toggle"
            onClick={() => setDetailsOpen((v) => !v)}
            aria-expanded={detailsOpen}
          >
            {detailsOpen ? '收起详情' : '查看详情'}
          </button>
          {detailsOpen && (
            <div className="analysis-group__details-content">
              {details}
            </div>
          )}
        </div>
      )}
    </section>
  )
}
