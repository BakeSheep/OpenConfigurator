import { useState } from 'react'
import { useTelemetryStore, type StatusSeverity } from '../../stores/telemetryStore'

const severityStyle: Record<StatusSeverity, { label: string; color: string; bg: string }> = {
  emergency: { label: 'EMERG', color: '#EF4444', bg: 'rgba(239,68,68,.2)' },
  alert: { label: 'ALERT', color: '#EF4444', bg: 'rgba(239,68,68,.15)' },
  critical: { label: 'CRIT', color: '#EF4444', bg: 'rgba(239,68,68,.15)' },
  error: { label: 'ERROR', color: '#EF4444', bg: 'rgba(239,68,68,.15)' },
  warning: { label: 'WARN', color: '#F59E0B', bg: 'rgba(245,158,11,.15)' },
  notice: { label: 'NOTE', color: '#3B82F6', bg: 'rgba(59,130,246,.15)' },
  info: { label: 'INFO', color: '#8888A0', bg: 'rgba(136,136,160,.12)' },
  debug: { label: 'DBG', color: '#555566', bg: 'rgba(85,85,102,.12)' },
}

function fmtTime(t: number) {
  const d = new Date(t)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
}

export default function StatusBar() {
  const { statusLogs, clearStatusLogs } = useTelemetryStore()
  const [expanded, setExpanded] = useState(false)

  const latest = statusLogs[0]
  const style = latest ? severityStyle[latest.severity] : null

  return (
    <div
      className="relative shrink-0 select-none border-t"
      style={{
        height: 'var(--statusbar-height)',
        background: 'var(--bg-secondary)',
        borderColor: 'var(--border)',
      }}
    >
      <button
        onClick={() => setExpanded((v) => !v)}
        className="h-full w-full flex items-center px-3 gap-3 text-left hover:bg-white/[0.02] transition-colors"
      >
        {style && latest ? (
          <>
            <span
              className="text-[10px] font-bold px-1.5 py-0.5 rounded leading-none tracking-wider shrink-0"
              style={{ background: style.bg, color: style.color }}
            >
              {style.label}
            </span>
            <span className="mc-mono text-[11px] truncate flex-1" style={{ color: 'var(--text-secondary)' }}>
              {latest.text}
            </span>
            <span className="text-[10px] shrink-0" style={{ color: 'var(--text-disabled)' }}>{fmtTime(latest.time)}</span>
          </>
        ) : (
          <>
            <span
              className="w-2 h-2 rounded-full shrink-0"
              style={{ background: 'var(--success)', boxShadow: '0 0 6px rgba(34,197,94,.4)' }}
            />
            <span className="text-[11px]" style={{ color: 'var(--text-disabled)' }}>就绪 — 暂无飞控消息</span>
          </>
        )}
        {statusLogs.length > 0 && (
          <span
            className="text-[10px] px-1.5 rounded-full shrink-0 mc-mono"
            style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
          >
            {statusLogs.length}
          </span>
        )}
        <svg
          width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
          strokeLinecap="round" strokeLinejoin="round"
          className="shrink-0 transition-transform"
          style={{ color: 'var(--text-disabled)', transform: expanded ? 'rotate(180deg)' : 'none' }}
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      {/* Expanded panel */}
      {expanded && (
        <div
          className="absolute bottom-full left-0 right-0 flex flex-col mc-animate-slide overflow-hidden border-t"
          style={{
            maxHeight: 240,
            background: 'var(--bg-secondary)',
            borderColor: 'var(--border)',
            boxShadow: '0 -4px 16px rgba(0,0,0,.4)',
          }}
        >
          <div className="flex items-center justify-between px-3 py-1.5 border-b" style={{ borderColor: 'var(--border)' }}>
            <span className="mc-section-title">飞控消息</span>
            <button
              onClick={(e) => { e.stopPropagation(); clearStatusLogs() }}
              className="text-[11px] hover:underline"
              style={{ color: 'var(--text-secondary)' }}
            >
              清空
            </button>
          </div>
          <div className="overflow-y-auto flex-1">
            {statusLogs.length === 0 ? (
              <div className="px-3 py-6 text-center text-[12px]" style={{ color: 'var(--text-disabled)' }}>暂无消息</div>
            ) : (
              statusLogs.map((log) => {
                const s = severityStyle[log.severity]
                return (
                  <div
                    key={log.id}
                    className="flex items-center gap-2.5 px-3 py-1.5 border-b"
                    style={{ borderColor: 'var(--border)' }}
                  >
                    <span className="text-[10px] mc-mono shrink-0" style={{ color: 'var(--text-disabled)' }}>{fmtTime(log.time)}</span>
                    <span
                      className="text-[9px] font-bold px-1.5 py-0.5 rounded leading-none tracking-wider shrink-0"
                      style={{ background: s.bg, color: s.color }}
                    >
                      {s.label}
                    </span>
                    <span className="mc-mono text-[11px] truncate" style={{ color: 'var(--text-primary)' }}>{log.text}</span>
                  </div>
                )
              })
            )}
          </div>
        </div>
      )}
    </div>
  )
}
