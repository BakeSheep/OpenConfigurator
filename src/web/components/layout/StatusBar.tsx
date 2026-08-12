import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useConnectionStore } from '../../stores/connectionStore'
import { useEscStore } from '../../stores/escStore'
import { useSensorStore } from '../../stores/sensorStore'
import { useTelemetryStore, type StatusSeverity } from '../../stores/telemetryStore'
import { Badge } from '../ui/Feedback'
import { Button } from '../ui/Button'
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
  const throughputScore = Math.min(stats.rxBps / 5000, 1)
  const errorPenalty = Math.min(stats.crcErrorsPerSec * 0.1, 0.5)
  const quality = Math.max(0, Math.min(100, Math.round((throughputScore - errorPenalty) * 100)))
  let color = 'var(--success)'
  if (quality < 40) color = 'var(--danger)'
  else if (quality < 70) color = 'var(--warning)'
  return { percent: quality, color }
}

export default function StatusBar() {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const transportOpen = useConnectionStore((state) => state.transportOpen)
  const linkStats = useConnectionStore((state) => state.linkStats)
  const escSession = useEscStore((state) => state.session)
  const statusLogs = useTelemetryStore((state) => state.statusLogs)
  const clearStatusLogs = useTelemetryStore((state) => state.clearStatusLogs)
  const autopilotVersion = useTelemetryStore((state) => state.autopilotVersion)
  const cpuLoad = useTelemetryStore((state) => state.cpuLoad)
  const sysStatusStale = useTelemetryStore((state) => state.isStale('sysStatus'))
  const imus = useSensorStore((state) => state.imus)
  const baro = useSensorStore((state) => state.baro)
  const opticalFlow = useSensorStore((state) => state.opticalFlow)
  const sensorStale = useSensorStore((state) => state.isStale)
  const latest = statusLogs[0]

  const imuFresh = !sensorStale('imu')
  const tempSources = [
    ...Object.entries(imus).map(([instance, imu]) => ({
      label: `IMU${instance}`,
      value: imuFresh && imu?.temperature != null && Number.isFinite(imu.temperature) ? imu.temperature : null,
    })),
    { label: t('statusbar.barometer'), value: baro && !sensorStale('baro') && Number.isFinite(baro.temperature) ? baro.temperature : null },
    { label: t('statusbar.opticalFlow'), value: opticalFlow && !sensorStale('opticalFlow') && opticalFlow.temperature_c != null && Number.isFinite(opticalFlow.temperature_c) ? opticalFlow.temperature_c : null },
  ]
  const validTemps = tempSources.filter((source) => source.value !== null)
  const avgTemp = validTemps.length > 0
    ? validTemps.reduce((sum, source) => sum + (source.value as number), 0) / validTemps.length
    : null

  const escActive = escSession !== null && escSession.state !== 'idle'
  const escBanner = !escActive ? null
    : escSession.mode === 'ardupilot_passthrough' ? t('statusbar.escMavlinkPaused')
    : escSession.mode === 'px4_serial_control' ? t('statusbar.escPx4Session')
    : t('statusbar.escDirectConnection')

  const linkText = linkStats && transportOpen
    ? `↓${formatKBps(linkStats.rxBps)} ↑${formatKBps(linkStats.txBps)}${linkStats.crcErrorsPerSec > 0 ? ` · CRC ${linkStats.crcErrorsPerSec.toFixed(1)}/s` : ''}`
    : '—'
  const linkQuality = transportOpen ? getLinkQuality(linkStats) : { percent: 0, color: 'var(--text-disabled)' }

  const closeDetailsAndRestoreFocus = () => {
    setExpanded(false)
    requestAnimationFrame(() => document.getElementById('mc-statusbar-summary')?.focus())
  }

  useEffect(() => {
    if (!expanded) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeDetailsAndRestoreFocus()
      }
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [expanded])

  return (
    <footer className="mc-statusbar">
      <button
        id="mc-statusbar-summary"
        type="button"
        className="mc-statusbar__summary"
        aria-expanded={expanded}
        aria-controls="mc-statusbar-details"
        onClick={() => setExpanded((current) => !current)}
      >
        <span className="mc-statusbar__link-quality" title={t('statusbar.linkQuality')}>
          <span className="mc-status-dot" style={{ background: linkQuality.color }} aria-hidden="true" />
          <span>{transportOpen ? `${t('statusbar.linkQuality')} ${linkQuality.percent}%` : t('statusbar.disconnected')}</span>
        </span>
        <span className="mc-statusbar__metrics">
          <span className="mc-statusbar__metric" title={t('statusbar.cpuLoad')}>
            <span className="mc-statusbar__metric-label">CPU</span>
            <strong className="mc-mono">{cpuLoad !== null && !sysStatusStale ? `${cpuLoad.toFixed(0)}%` : '—'}</strong>
          </span>
          <span className="mc-statusbar__metric" title={t('statusbar.avgTemp')}>
            <span className="mc-statusbar__metric-label">{t('statusbar.avgTempLabel')}</span>
            <strong className="mc-mono">{avgTemp !== null ? `${avgTemp.toFixed(1)}°C` : '—'}</strong>
          </span>
        </span>
        <span className="mc-statusbar__message" aria-live="polite">
          {latest?.text ?? t('statusbar.messageRateIdle')}
        </span>
        <span className="mc-statusbar__activity">
          {escBanner && <Badge tone="accent">{escBanner}</Badge>}
          <Icon name="chevronDown" size={13} aria-hidden="true" data-expanded={expanded || undefined} />
        </span>
      </button>

      {expanded && (
        <section
          id="mc-statusbar-details"
          className="mc-statusbar__drawer mc-slide-up"
          role="region"
          aria-label={t('statusbar.details')}
        >
          <header className="mc-statusbar__drawer-header">
            <strong>{t('statusbar.details')}</strong>
            <Button tone="quiet" onClick={closeDetailsAndRestoreFocus} aria-label={t('common.close')}>
              {t('common.close')}
            </Button>
          </header>

          <dl className="mc-statusbar__details-grid">
            <div>
              <dt>{t('statusbar.firmwareVersion')}</dt>
              <dd className="mc-mono">{autopilotVersion?.firmwareLabel ?? '—'}</dd>
            </div>
            <div>
              <dt>{t('statusbar.cpuLoad')}</dt>
              <dd className="mc-mono">{cpuLoad !== null && !sysStatusStale ? `${cpuLoad.toFixed(0)}%` : '—'}</dd>
            </div>
            <div>
              <dt>{t('statusbar.linkThroughput')}</dt>
              <dd className="mc-mono">{linkText}</dd>
            </div>
            <div>
              <dt>{t('statusbar.avgTempLabel')}</dt>
              <dd className="mc-mono">{avgTemp !== null ? `${avgTemp.toFixed(1)} °C` : '—'}</dd>
            </div>
          </dl>

          <div className="mc-statusbar__drawer-columns">
            <section aria-labelledby="mc-statusbar-temperature-title">
              <header>
                <strong id="mc-statusbar-temperature-title">{t('statusbar.sensorTemp')}</strong>
                <span>{avgTemp !== null ? t('statusbar.avgTempSummary', { value: avgTemp.toFixed(1), count: validTemps.length }) : t('statusbar.noValidTempSource')}</span>
              </header>
              <div className="mc-statusbar__list">
                {tempSources.map((source) => (
                  <div key={source.label}>
                    <span className="mc-status-dot" style={{ background: source.value !== null ? 'var(--success)' : 'var(--text-disabled)' }} aria-hidden="true" />
                    <span>{source.label}</span>
                    <span className="mc-mono">{source.value !== null ? `${source.value.toFixed(1)} °C` : '—'}</span>
                  </div>
                ))}
              </div>
            </section>

            <section aria-labelledby="mc-statusbar-messages-title">
              <header>
                <strong id="mc-statusbar-messages-title">{t('statusbar.fcMessages')}</strong>
                <Button tone="quiet" disabled={statusLogs.length === 0} onClick={clearStatusLogs}>{t('statusbar.clear')}</Button>
              </header>
              <div className="mc-statusbar__list mc-statusbar__list--messages">
                {statusLogs.length === 0 ? (
                  <p>{t('statusbar.noFcMessages')}</p>
                ) : statusLogs.map((log) => (
                  <div key={log.id}>
                    <span className="mc-status-dot" style={{ background: severityTone[log.severity] }} aria-hidden="true" />
                    <span title={log.text}>{log.text}</span>
                    <time className="mc-mono" dateTime={new Date(log.time).toISOString()}>{new Date(log.time).toLocaleTimeString()}</time>
                  </div>
                ))}
              </div>
            </section>
          </div>
        </section>
      )}
    </footer>
  )
}
