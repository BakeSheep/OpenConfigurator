// Findings display with severity dots, confidence badges, and disclosure
// for evidence details. No decorative icons — severity is conveyed via
// colored dots only.
import { useState } from 'react'
import type { DiagnosticFinding, FindingSeverity, FindingConfidence } from '../../log-analysis/types.js'

interface Props {
  findings: DiagnosticFinding[]
  compact?: boolean
}

const SEVERITY_LABEL: Record<FindingSeverity, string> = {
  critical: '严重',
  warning: '警告',
  notice: '提示',
  healthy: '正常',
}

const SEVERITY_DOT_CLASS: Record<FindingSeverity, string> = {
  critical: 'finding-row__dot--critical',
  warning: 'finding-row__dot--warning',
  notice: 'finding-row__dot--notice',
  healthy: 'finding-row__dot--healthy',
}

const CONFIDENCE_LABEL: Record<FindingConfidence, string> = {
  measured: '实测',
  derived: '推算',
  heuristic: '启发式',
}

function formatTimeRange(startSec: number | null, endSec: number | null): string {
  if (startSec == null && endSec == null) return ''
  const s = startSec != null ? `${startSec.toFixed(1)} 秒` : '?'
  const e = endSec != null ? `${endSec.toFixed(1)} 秒` : '?'
  return `${s} – ${e}`
}

function FindingRow({ finding, compact }: { finding: DiagnosticFinding; compact?: boolean }) {
  const [evidenceOpen, setEvidenceOpen] = useState(false)
  const hasEvidence = finding.evidence.length > 0
  const timeRange = finding.evidence.length > 0
    ? formatTimeRange(finding.evidence[0].startSec, finding.evidence[0].endSec)
    : ''

  return (
    <div className={`finding-row${compact ? ' finding-row--compact' : ''}`}>
      <div className="finding-row__header">
        <span
          className={`finding-row__dot ${SEVERITY_DOT_CLASS[finding.severity]}`}
          title={SEVERITY_LABEL[finding.severity]}
        />
        <span className="finding-row__title">{finding.title}</span>
        <span className="finding-row__confidence mc-mono">
          {CONFIDENCE_LABEL[finding.confidence]}
        </span>
        {timeRange && (
          <span className="finding-row__time mc-mono">{timeRange}</span>
        )}
      </div>
      <p className="finding-row__summary">{finding.summary}</p>
      {finding.recommendation && (
        <p className="finding-row__rec">{finding.recommendation}</p>
      )}
      {hasEvidence && !compact && (
        <button
          type="button"
          className="finding-row__evidence-toggle"
          onClick={() => setEvidenceOpen((v) => !v)}
          aria-expanded={evidenceOpen}
        >
          {evidenceOpen ? '收起证据' : '查看证据'}
        </button>
      )}
      {hasEvidence && evidenceOpen && (
        <div className="finding-row__evidence">
          {finding.evidence.map((ev, i) => (
            <div key={i} className="finding-row__evidence-item">
              <span className="mc-mono">{ev.topic}{ev.multiId > 0 ? `[${ev.multiId}]` : ''}</span>
              {ev.fields.length > 0 && (
                <span className="mc-mono">{ev.fields.join(', ')}</span>
              )}
              <span className="finding-row__observed">{ev.observed}</span>
              {ev.threshold && (
                <span className="finding-row__threshold">阈值：{ev.threshold}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default function FindingsList({ findings, compact = false }: Props) {
  if (findings.length === 0) return null

  return (
    <div className="findings-list">
      {findings.map((f) => (
        <FindingRow key={f.id} finding={f} compact={compact} />
      ))}
    </div>
  )
}
