// Simple flight timeline: horizontal bar showing log duration with markers
// for armed, takeoff, land, and mode changes. Clickable for future chart sync.
import type { TimelineSummary, DiagnosticFinding } from '../../log-analysis/types.js'

interface Props {
  timeline: TimelineSummary
  findings?: DiagnosticFinding[]
  onTimeSelect?: (timeSec: number) => void
}

function pct(timeSec: number, startSec: number, endSec: number): number {
  if (endSec <= startSec) return 0
  return Math.max(0, Math.min(100, ((timeSec - startSec) / (endSec - startSec)) * 100))
}

export default function LogTimeline({ timeline, findings = [], onTimeSelect }: Props) {
  const { logStartSec, logEndSec, armedStartSec, armedEndSec, takeoffSec, landSec, modeChanges } = timeline
  const duration = logEndSec - logStartSec

  if (duration <= 0) {
    return (
      <div className="timeline-container">
        <span style={{ color: 'var(--text-disabled)', fontSize: 12 }}>无时间轴数据</span>
      </div>
    )
  }

  const armedPctStart = armedStartSec != null ? pct(armedStartSec, logStartSec, logEndSec) : null
  const armedPctEnd = armedEndSec != null ? pct(armedEndSec, logStartSec, logEndSec) : null

  return (
    <div className="timeline-container" aria-label="飞行时间轴">
      <div className="timeline-bar">
        {/* Armed segment */}
        {armedPctStart != null && armedPctEnd != null && (
          <div
            className="timeline-bar__armed"
            style={{
              left: `${armedPctStart}%`,
              width: `${armedPctEnd - armedPctStart}%`,
            }}
            title={`解锁：${armedStartSec!.toFixed(1)} 秒 – ${armedEndSec!.toFixed(1)} 秒`}
          />
        )}

        {/* Takeoff marker */}
        {takeoffSec != null && (
          <div
            className="timeline-bar__marker timeline-bar__takeoff"
            style={{ left: `${pct(takeoffSec, logStartSec, logEndSec)}%` }}
            title={`起飞：${takeoffSec.toFixed(1)} 秒`}
            onClick={() => onTimeSelect?.(takeoffSec)}
            role="button"
            tabIndex={0}
          />
        )}

        {/* Land marker */}
        {landSec != null && (
          <div
            className="timeline-bar__marker timeline-bar__land"
            style={{ left: `${pct(landSec, logStartSec, logEndSec)}%` }}
            title={`降落：${landSec.toFixed(1)} 秒`}
            onClick={() => onTimeSelect?.(landSec)}
            role="button"
            tabIndex={0}
          />
        )}

        {/* Mode change markers */}
        {modeChanges.map((mc, i) => (
          <div
            key={i}
            className="timeline-bar__marker timeline-bar__mode"
            style={{ left: `${pct(mc.timeSec, logStartSec, logEndSec)}%` }}
            title={`${mc.mode}：${mc.timeSec.toFixed(1)} 秒`}
            onClick={() => onTimeSelect?.(mc.timeSec)}
            role="button"
            tabIndex={0}
          />
        ))}

        {/* Finding markers (critical/warning only) */}
        {findings
          .filter((f) => f.severity === 'critical' || f.severity === 'warning')
          .flatMap((f) =>
            f.evidence
              .filter((ev) => ev.startSec != null)
              .map((ev, i) => ({
                key: `${f.id}-${i}`,
                timeSec: ev.startSec!,
                severity: f.severity,
                title: f.title,
              })),
          )
          .map((marker) => (
            <div
              key={marker.key}
              className={`timeline-bar__marker timeline-bar__finding timeline-bar__finding--${marker.severity}`}
              style={{ left: `${pct(marker.timeSec, logStartSec, logEndSec)}%` }}
              title={`${marker.title}：${marker.timeSec.toFixed(1)} 秒`}
              onClick={() => onTimeSelect?.(marker.timeSec)}
              role="button"
              tabIndex={0}
            />
          ))}
      </div>

      {/* Time labels */}
      <div className="timeline-labels">
        <span className="mc-mono">{logStartSec.toFixed(0)} 秒</span>
        <span className="mc-mono">{(duration / 2).toFixed(0)} 秒</span>
        <span className="mc-mono">{logEndSec.toFixed(0)} 秒</span>
      </div>
    </div>
  )
}
