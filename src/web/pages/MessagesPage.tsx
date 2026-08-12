import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import Icon from '../components/ui/Icon'
import { PageTabs } from '../components/ui/PageFrame'
import { TabPanel } from '../components/ui/Tabs'
import Toolbar from '../components/ui/Toolbar'
import StatusVariableBrowser from '../components/telemetry/StatusVariableBrowser'
import FlightControllerTerminal from '../components/telemetry/FlightControllerTerminal'
import { DEFAULT_MESSAGE_RATES, MESSAGE_RATE_OPTIONS } from '../../shared/constants'
import type { MessageRateConfig } from '../../shared/types'
import { vehicleCapabilities } from '../../shared/vehicleProfiles'
import { sendClientMessage } from '../hooks/useWebSocket'
import { useQueryTab } from '../hooks/useQueryTab'
import { useConnectionStore } from '../stores/connectionStore'
import {
  isMavlinkMessageLive,
  measuredMavlinkHz,
  useMavlinkMessageStore,
  type MavlinkMessageSample,
} from '../stores/mavlinkMessageStore'
import { useMessageRateStore } from '../stores/messageRateStore'
import { useTelemetryStore } from '../stores/telemetryStore'

const TAB_KEYS = [
  { id: 'messages', label: 'messages.tabMessages' },
  { id: 'status', label: 'messages.tabStatus' },
  { id: 'terminal', label: 'messages.tabTerminal' },
] as const

const MESSAGE_TAB_IDS = TAB_KEYS.map((tab) => tab.id)

const streamRows = [
  { id: 0, name: 'HEARTBEAT' },
  { id: 1, name: 'SYS_STATUS', group: 'status' },
  { id: 24, name: 'GPS_RAW_INT', group: 'position' },
  { id: 26, name: 'SCALED_IMU', group: 'sensors' },
  { id: 27, name: 'RAW_IMU', group: 'sensors' },
  { id: 29, name: 'SCALED_PRESSURE', group: 'sensors' },
  { id: 30, name: 'ATTITUDE', group: 'attitude' },
  { id: 33, name: 'GLOBAL_POSITION_INT', group: 'position' },
  { id: 36, name: 'SERVO_OUTPUT_RAW', group: 'rc' },
  { id: 65, name: 'RC_CHANNELS', group: 'rc' },
  { id: 74, name: 'VFR_HUD', group: 'hud' },
  { id: 100, name: 'OPTICAL_FLOW', group: 'auxiliary' },
  { id: 105, name: 'HIGHRES_IMU', group: 'sensors' },
  { id: 106, name: 'OPTICAL_FLOW_RAD', group: 'auxiliary' },
  { id: 116, name: 'SCALED_IMU2', group: 'sensors' },
  { id: 129, name: 'SCALED_IMU3', group: 'sensors' },
  { id: 132, name: 'DISTANCE_SENSOR', group: 'auxiliary' },
  { id: 147, name: 'BATTERY_STATUS', group: 'auxiliary' },
  { id: 173, name: 'RANGEFINDER', group: 'auxiliary' },
  { id: 230, name: 'ESTIMATOR_STATUS', group: 'status' },
  { id: 241, name: 'VIBRATION', group: 'auxiliary' },
  { id: 245, name: 'EXTENDED_SYS_STATE', group: 'status' },
  { id: 253, name: 'STATUSTEXT', event: true },
] satisfies Array<{ id: number; name: string; group?: keyof MessageRateConfig; event?: boolean }>

const rateRows: Array<{ key: keyof MessageRateConfig; label: string }> = [
  { key: 'attitude', label: 'messages.rateAttitude' },
  { key: 'position', label: 'messages.ratePosition' },
  { key: 'sensors', label: 'messages.rateSensors' },
  { key: 'rc', label: 'messages.rateRc' },
  { key: 'status', label: 'messages.rateStatus' },
  { key: 'hud', label: 'messages.rateHud' },
  { key: 'auxiliary', label: 'messages.rateAuxiliary' },
]

function formatMeasuredRate(sample: MavlinkMessageSample | undefined, nowMs: number, t: TFunction, event = false): string {
  if (!isMavlinkMessageLive(sample, nowMs)) return '0 Hz'
  if (event) return t('messages.event')
  const hz = measuredMavlinkHz(sample, nowMs)
  if (hz === null) return t('messages.measuring')
  return `${hz >= 10 ? hz.toFixed(0) : hz.toFixed(1)} Hz`
}

function formatFieldValue(value: unknown): string {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return String(value)
    if (Number.isInteger(value)) return String(value)
    const absolute = Math.abs(value)
    if (absolute >= 100) return value.toFixed(2)
    if (absolute >= 1) return value.toFixed(4)
    return value.toFixed(6)
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(formatFieldValue).join(', ')
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function messageFields(data: unknown): Array<[string, unknown]> {
  if (data !== null && typeof data === 'object' && !Array.isArray(data)) {
    return Object.entries(data as Record<string, unknown>)
  }
  return [['value', data]]
}

function imuUnitSummary(data: unknown, t: TFunction): string | null {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return null
  const units = (data as Record<string, unknown>).units
  if (units === 'raw') return t('messages.imuUnitRaw')
  if (units === 'normalized') return t('messages.imuUnitNormalized')
  return null
}

export default function MessagesPage({ embedded = false }: { embedded?: boolean }) {
  const { t } = useTranslation()
  const tabs = useMemo(() => TAB_KEYS.map((tab) => ({ ...tab, label: t(tab.label) })), [t])
  const [activeTab, setActiveTab] = useQueryTab(MESSAGE_TAB_IDS, 'messages')
  const [paused, setPaused] = useState(false)
  const connected = useConnectionStore((state) => state.vehicleReady)
  const canControl = useConnectionStore((state) => state.canControl)
  const vehicleIdentity = useTelemetryStore((state) => state.vehicleIdentity)
  const rates = useMessageRateStore((state) => state.rates)
  const messageSamples = useMavlinkMessageStore((state) => state.messages)
  const resetMessageSamples = useMavlinkMessageStore((state) => state.reset)
  const statusLogs = useTelemetryStore((state) => state.statusLogs)
  const clearStatusLogs = useTelemetryStore((state) => state.clearStatusLogs)
  const canSetRates = connected
    && canControl
    && vehicleCapabilities(vehicleIdentity).writeOperations

  // The live flag compares against wall-clock time; a 1 s tick keeps it
  // re-evaluated after the link stops and store updates no longer arrive
  // (otherwise frozen rows would show “接收中” forever).
  const [nowTick, setNowTick] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNowTick(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  const rows = useMemo(() => streamRows.map((row) => {
    const sample = messageSamples[row.name]
    return {
      ...row,
      sample,
      rate: formatMeasuredRate(sample, nowTick, t, row.event),
      live: connected && isMavlinkMessageLive(sample, nowTick),
    }
  }), [connected, messageSamples, nowTick, t])

  const [pausedRows, setPausedRows] = useState<typeof rows | null>(null)
  const [pausedLogs, setPausedLogs] = useState<typeof statusLogs | null>(null)
  const [expandedRows, setExpandedRows] = useState<Set<number>>(() => new Set())
  const displayRows = paused ? pausedRows ?? rows : rows
  const displayLogs = paused ? pausedLogs ?? statusLogs : statusLogs
  const liveCount = displayRows.filter((row) => row.live).length

  const togglePaused = () => {
    if (paused) {
      setPaused(false)
      setPausedRows(null)
      setPausedLogs(null)
      return
    }
    setPausedRows(rows)
    setPausedLogs(statusLogs)
    setPaused(true)
  }

  const clearDiagnostics = () => {
    resetMessageSamples()
    clearStatusLogs()
    if (paused) {
      setPaused(false)
      setPausedRows(null)
      setPausedLogs(null)
    }
  }

  const toggleExpanded = (id: number) => setExpandedRows((current) => {
    const next = new Set(current)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })

  const applyRates = (next: MessageRateConfig) => {
    if (!canSetRates) return
    sendClientMessage({
      type: 'message_rates_set',
      requestId: `message-rates-${Date.now().toString(36)}`,
      data: next,
    })
  }

  return (
    <div className={embedded ? 'mc-fade-in mc-data-workspace' : 'mc-workspace mc-fade-in mc-data-workspace'}>
      <PageTabs
        tabs={tabs}
        active={activeTab}
        onChange={setActiveTab}
        ariaLabel={t('diagnostics.section.messages.label')}
        idBase="message-diagnostics"
      />
      {activeTab !== 'terminal' && (
        <Toolbar
          summary={t('messages.activeSummary', { live: liveCount, logs: displayLogs.length })}
          actions={(
            <>
              <button type="button" className="mc-icon-btn mc-icon-btn--bordered" aria-label={paused ? t('messages.resume') : t('messages.pause')} onClick={togglePaused}><Icon name={paused ? 'refresh' : 'pause'} size={15} /></button>
              <button type="button" className="mc-icon-btn mc-icon-btn--bordered" aria-label={t('messages.clear')} onClick={clearDiagnostics}><Icon name="trash" size={15} /></button>
            </>
          )}
        />
      )}
      <TabPanel idBase="message-diagnostics" tabId={activeTab}>

      {activeTab === 'messages' && (
        <div className="mc-message-layout">
          <section className="mc-card mc-message-table">
            <div className="mc-message-row mc-message-row--header"><span>ID</span><span>{t('messages.colMessageName')}</span><span>{t('messages.colStatus')}</span><span>{t('messages.colMeasuredRate')}</span></div>
            {displayRows.map((row) => {
              const expanded = expandedRows.has(row.id)
              const unitSummary = imuUnitSummary(row.sample?.latestData, t)
              return (
              <div className="mc-message-item" key={row.id} data-expanded={expanded}>
                <div className="mc-message-row">
                  <button
                    type="button"
                    className="mc-message-row__toggle mc-mono"
                    aria-label={expanded ? t('messages.collapseAria', { name: row.name }) : t('messages.expandAria', { name: row.name })}
                    aria-expanded={expanded}
                    onClick={() => toggleExpanded(row.id)}
                  >{expanded ? '−' : '+'}&nbsp; #{row.id}</button>
                  <strong className="mc-mono">{row.name}</strong>
                  <span>{row.live ? t('messages.receiving') : t('messages.waiting')}</span>
                  <span className="mc-mono" style={{ color: row.live ? 'var(--success)' : 'var(--text-secondary)' }}>{paused ? t('messages.paused') : row.rate}</span>
                </div>
                {expanded && (
                  <div className="mc-message-details">
                    {row.sample ? (
                      <>
                        <header>
                          <span>{unitSummary ?? t('messages.latestFields')}</span>
                          <span className="mc-mono">{t('messages.frames', { count: row.sample.totalCount })} · {new Date(row.sample.lastSeen).toLocaleTimeString()}</span>
                        </header>
                        <div className="mc-message-details__grid">
                          {messageFields(row.sample.latestData).map(([field, value]) => (
                            <div key={field}><code>{field}</code><strong className="mc-mono">{formatFieldValue(value)}</strong></div>
                          ))}
                        </div>
                      </>
                    ) : <p>{t('messages.notReceived')}</p>}
                  </div>
                )}
              </div>
            )})}
          </section>

          <section className="mc-card mc-rate-panel">
            <h3>{t('messages.rateControl')}</h3>
            <div className="mc-rate-panel__rows">
              {rateRows.map((row) => (
                <label key={row.key}>
                  <span>{t(row.label)}</span>
                  <select
                    className="mc-select mc-mono"
                    aria-label={t('messages.rateAria', { label: t(row.label) })}
                    value={rates[row.key]}
                    disabled={!canSetRates}
                    onChange={(event) => applyRates({ ...rates, [row.key]: Number(event.target.value) })}
                  >
                    {MESSAGE_RATE_OPTIONS.map((rate) => <option key={rate} value={rate}>{rate}</option>)}
                  </select>
                  <small>Hz</small>
                </label>
              ))}
            </div>
            <footer>
              <button
                type="button"
                className="mc-btn mc-btn-ghost"
                disabled={!canSetRates}
                onClick={() => applyRates({ ...DEFAULT_MESSAGE_RATES })}
              >{t('messages.resetDefault')}</button>
            </footer>
          </section>

          <section className="mc-card mc-link-stats">
            <h3>{t('messages.linkStats')}</h3>
            {[
              [t('messages.statConnection'), connected ? t('messages.connected') : t('messages.disconnected')], [t('messages.statActiveStreams'), String(liveCount)], [t('messages.statStatusMsgs'), String(displayLogs.length)], [t('messages.statCrcErrors'), '-'], [t('messages.statLossRate'), '-'], [t('messages.statTransferRate'), connected ? t('messages.realtime') : '0 msg/s'],
            ].map(([label, value]) => <div key={label}><span>{label}</span><strong className="mc-mono">{value}</strong></div>)}
          </section>
        </div>
      )}

      {activeTab === 'status' && <StatusVariableBrowser paused={paused} />}

      {activeTab === 'terminal' && (
        <FlightControllerTerminal />
      )}

      </TabPanel>

    </div>
  )
}
