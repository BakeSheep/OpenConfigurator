import { useState } from 'react'
import { useConnectionStore } from '../../stores/connectionStore'
import { useSensorStore } from '../../stores/sensorStore'
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

function formatKBps(bytesPerSec: number): string {
  return `${(bytesPerSec / 1024).toFixed(1)}KB/s`
}

function getLinkQuality(stats: { rxBps: number; crcErrorsPerSec: number } | null): { percent: number; color: string } {
  if (!stats) return { percent: 0, color: 'var(--text-disabled)' }
  // Quality based on throughput and CRC errors
  const throughputScore = Math.min(stats.rxBps / 5000, 1) // max at 5KB/s
  const errorPenalty = Math.min(stats.crcErrorsPerSec * 0.1, 0.5)
  const quality = Math.max(0, Math.min(100, Math.round((throughputScore - errorPenalty) * 100)))
  let color = 'var(--success)' // green >= 70
  if (quality < 40) color = 'var(--danger)'
  else if (quality < 70) color = 'var(--warning)'
  return { percent: quality, color }
}

export default function StatusBar() {
  const [expanded, setExpanded] = useState(false)
  const [tempOpen, setTempOpen] = useState(false)
  const connectionStatus = useConnectionStore((state) => state.status)
  const transportOpen = useConnectionStore((state) => state.transportOpen)
  const vehicleReady = useConnectionStore((state) => state.vehicleReady)
  const reconnect = useConnectionStore((state) => state.reconnect)
  const linkStats = useConnectionStore((state) => state.linkStats)
  const statusLogs = useTelemetryStore((state) => state.statusLogs)
  const clearStatusLogs = useTelemetryStore((state) => state.clearStatusLogs)
  const imus = useSensorStore((state) => state.imus)
  const baro = useSensorStore((state) => state.baro)
  const opticalFlow = useSensorStore((state) => state.opticalFlow)
  const sensorStale = useSensorStore((state) => state.isStale)
  const latest = statusLogs[0]

  // All temperature-capable MAVLink sources; a source reads null when the
  // sensor never reported a temperature or its data went stale.
  const imuFresh = !sensorStale('imu')
  const tempSources = [
    ...Object.entries(imus).map(([instance, imu]) => ({
      label: `IMU${instance}`,
      value: imuFresh && imu?.temperature != null && Number.isFinite(imu.temperature) ? imu.temperature : null,
    })),
    { label: '气压计', value: baro && !sensorStale('baro') && Number.isFinite(baro.temperature) ? baro.temperature : null },
    { label: '光流', value: opticalFlow && !sensorStale('opticalFlow') && opticalFlow.temperature_c != null && Number.isFinite(opticalFlow.temperature_c) ? opticalFlow.temperature_c : null },
  ]
  const validTemps = tempSources.filter((source) => source.value !== null)
  const avgTemp = validTemps.length > 0
    ? validTemps.reduce((sum, source) => sum + (source.value as number), 0) / validTemps.length
    : null

  const statusText = vehicleReady ? '飞控已就绪'
    : transportOpen ? '端口已打开 · 等待飞控'
    : connectionStatus === 'reconnecting' ? `重连中${reconnect ? ` (${reconnect.attempt}/${reconnect.maxAttempts})` : ''}`
    : connectionStatus === 'connecting' ? '连接中' : '未连接'
  const statusColor = vehicleReady ? 'var(--success)'
    : transportOpen ? 'var(--warning)'
    : connectionStatus === 'reconnecting' || connectionStatus === 'connecting' ? 'var(--warning)'
    : 'var(--text-disabled)'
  const linkText = linkStats && transportOpen
    ? `↓${formatKBps(linkStats.rxBps)} ↑${formatKBps(linkStats.txBps)}${linkStats.crcErrorsPerSec > 0 ? ` · CRC ${linkStats.crcErrorsPerSec.toFixed(1)}/s` : ''}`
    : null
  const linkQuality = transportOpen ? getLinkQuality(linkStats) : { percent: 0, color: 'var(--text-disabled)' }

  return (
    <footer className="mc-statusbar">
      <button type="button" className="mc-statusbar__summary" onClick={() => { setTempOpen(false); setExpanded((current) => !current) }}>
        <span className="flex items-center gap-1.5">
          <span className="mc-status-dot" style={{ background: latest ? severityTone[latest.severity] : statusColor }} />
          <span>状态 {statusText}</span>
          {avgTemp !== null && (
            <span
              role="button"
              tabIndex={0}
              className="mc-statusbar__temp mc-mono"
              data-open={tempOpen || undefined}
              title="有效传感器温度均值 · 点击查看各温度源"
              onClick={(event) => { event.stopPropagation(); setExpanded(false); setTempOpen((current) => !current) }}
              onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); setExpanded(false); setTempOpen((current) => !current) } }}
            >
              均温 {avgTemp.toFixed(1)}°C
            </span>
          )}
        </span>
        <span className="mc-statusbar__version">OpenConfigurator</span>
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
          {transportOpen && (
            <span
              className="mc-mono text-[11px] font-bold"
              style={{ color: linkQuality.color }}
              title="连接质量"
            >
              {linkQuality.percent}%
            </span>
          )}
          <span className="mc-statusbar__message">{latest?.text ?? '消息速率 —'}</span>
          <Icon name="chevronDown" size={13} style={{ transform: expanded ? 'rotate(180deg)' : undefined, transition: 'transform 160ms ease' }} />
        </span>
      </button>
      {tempOpen && (
        <section className="mc-statusbar__drawer mc-slide-up">
          <div className="flex items-center justify-between border-b px-4 py-2" style={{ borderColor: 'var(--border)' }}>
            <span className="mc-section-title">传感器温度</span>
            <span className="mc-mono text-[11px] font-bold" style={{ color: 'var(--accent)' }}>
              {avgTemp !== null ? `均值 ${avgTemp.toFixed(1)} °C · ${validTemps.length} 个有效源` : '暂无有效温度源'}
            </span>
          </div>
          <div className="max-h-52 overflow-y-auto">
            {tempSources.length === 0 ? (
              <div className="px-4 py-8 text-center text-[12px]" style={{ color: 'var(--text-disabled)' }}>暂无温度数据</div>
            ) : tempSources.map((source) => (
              <div key={source.label} className="flex items-center gap-3 border-b px-4 py-2 text-[12px]" style={{ borderColor: 'var(--border)' }}>
                <span className="mc-status-dot" style={{ background: source.value !== null ? 'var(--success)' : 'var(--text-disabled)' }} />
                <span className="flex-1" style={{ color: 'var(--text-primary)' }}>{source.label}</span>
                <span className="mc-mono" style={{ color: source.value !== null ? 'var(--text-primary)' : 'var(--text-disabled)' }}>
                  {source.value !== null ? `${source.value.toFixed(1)} °C` : '—'}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}
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
