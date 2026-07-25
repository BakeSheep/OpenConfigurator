import { useState } from 'react'
import { useConnectionStore } from '../../stores/connectionStore'
import { useTelemetryStore, type StatusSeverity } from '../../stores/telemetryStore'
import Icon from '../ui/Icon'

const severityTone: Record<StatusSeverity, string> = {
  emergency: 'var(--danger)',
  alert: 'var(--danger)',
  critical: 'var(--danger)',
  error: 'var(--danger)',
  warning: 'var(--warning)',
  notice: 'var(--accent)',
  info: 'var(--accent)',
  debug: 'var(--text-disabled)',
}

function formatBps(bytesPerSec: number): string {
  if (bytesPerSec >= 1024) return `${(bytesPerSec / 1024).toFixed(1)}KB/s`
  return `${bytesPerSec}B/s`
}

export default function StatusBar() {
  const [expanded, setExpanded] = useState(false)
  const connectionStatus = useConnectionStore((state) => state.status)
  const reconnect = useConnectionStore((state) => state.reconnect)
  const linkStats = useConnectionStore((state) => state.linkStats)
  const statusLogs = useTelemetryStore((state) => state.statusLogs)
  const clearStatusLogs = useTelemetryStore((state) => state.clearStatusLogs)
  const latest = statusLogs[0]

  const statusText = connectionStatus === 'connected' ? '已连接'
    : connectionStatus === 'reconnecting' ? `重连中${reconnect ? ` (${reconnect.attempt}/${reconnect.maxAttempts})` : ''}`
    : connectionStatus === 'connecting' ? '连接中' : '未连接'
  const statusColor = connectionStatus === 'connected' ? 'var(--success)'
    : connectionStatus === 'reconnecting' || connectionStatus === 'connecting' ? 'var(--warning)'
    : 'var(--text-disabled)'
  const linkText = linkStats && connectionStatus === 'connected'
    ? `↓${formatBps(linkStats.rxBps)} ↑${formatBps(linkStats.txBps)}${linkStats.crcErrorsPerSec > 0 ? ` · CRC ${linkStats.crcErrorsPerSec}/s` : ''}`
    : null

  return (
    <footer className="mc-statusbar">
      <button type="button" className="mc-statusbar__summary" onClick={() => setExpanded((current) => !current)}>
        <span className="flex items-center gap-1.5">
          <span className="mc-status-dot" style={{ background: latest ? severityTone[latest.severity] : statusColor }} />
          <span>状态 {statusText}</span>
        </span>
        <span className="mc-statusbar__version">SkyLab · PX4 Web GCS</span>
        <span className="flex items-center gap-1.5">
          {linkText && (
            <span
              className="mc-mono text-[11px]"
              style={{ color: linkStats && linkStats.crcErrorsPerSec > 0 ? 'var(--warning)' : 'var(--text-disabled)' }}
              title="链路吞吐（↓收 ↑发）/ CRC 错误率"
            >
              {linkText}
            </span>
          )}
          <span className="mc-statusbar__message">{latest?.text ?? '消息速率 —'}</span>
          <Icon name="chevronDown" size={13} style={{ transform: expanded ? 'rotate(180deg)' : undefined, transition: 'transform 160ms ease' }} />
        </span>
      </button>
      {expanded && (
        <section className="mc-statusbar__drawer mc-slide-up">
          <div className="flex items-center justify-between border-b px-4 py-2" style={{ borderColor: 'var(--border)' }}>
            <span className="mc-section-title">飞控消息</span>
            <button type="button" className="text-[12px]" style={{ color: 'var(--accent)' }} onClick={clearStatusLogs}>清空</button>
          </div>
          <div className="max-h-52 overflow-y-auto">
            {statusLogs.length === 0 ? (
              <div className="px-4 py-8 text-center text-[12px]" style={{ color: 'var(--text-disabled)' }}>暂无飞控消息</div>
            ) : statusLogs.map((log) => (
              <div key={log.id} className="flex items-center gap-3 border-b px-4 py-2 text-[12px]" style={{ borderColor: 'var(--border)' }}>
                <span className="mc-status-dot" style={{ background: severityTone[log.severity] }} />
                <span className="flex-1 truncate" style={{ color: 'var(--text-primary)' }}>{log.text}</span>
                <span className="mc-mono text-[10px]" style={{ color: 'var(--text-disabled)' }}>{new Date(log.time).toLocaleTimeString()}</span>
              </div>
            ))}
          </div>
        </section>
      )}
    </footer>
  )
}
