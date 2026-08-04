import { useEffect, useMemo, useState } from 'react'
import Icon from '../components/ui/Icon'
import { PageTabs } from '../components/ui/PageFrame'
import StatusVariableBrowser from '../components/telemetry/StatusVariableBrowser'
import FlightControllerTerminal from '../components/telemetry/FlightControllerTerminal'
import { DEFAULT_MESSAGE_RATES, MESSAGE_RATE_OPTIONS } from '../../shared/constants'
import type { MessageRateConfig } from '../../shared/types'
import { vehicleCapabilities } from '../../shared/vehicleProfiles'
import { sendClientMessage } from '../hooks/useWebSocket'
import { useConnectionStore } from '../stores/connectionStore'
import {
  isMavlinkMessageLive,
  measuredMavlinkHz,
  useMavlinkMessageStore,
  type MavlinkMessageSample,
} from '../stores/mavlinkMessageStore'
import { useMessageRateStore } from '../stores/messageRateStore'
import { useTelemetryStore } from '../stores/telemetryStore'

const tabs = [
  { id: 'messages', label: '消息' },
  { id: 'status', label: '状态' },
  { id: 'terminal', label: '终端' },
]

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
  { key: 'attitude', label: '姿态' },
  { key: 'position', label: '位置' },
  { key: 'sensors', label: '传感器' },
  { key: 'rc', label: '遥控' },
  { key: 'status', label: '状态' },
  { key: 'hud', label: 'HUD' },
  { key: 'auxiliary', label: '光流/电池/振动' },
]

function formatMeasuredRate(sample: MavlinkMessageSample | undefined, nowMs: number, event = false): string {
  if (!isMavlinkMessageLive(sample, nowMs)) return '0 Hz'
  if (event) return '事件'
  const hz = measuredMavlinkHz(sample, nowMs)
  if (hz === null) return '测量中'
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

function imuUnitSummary(data: unknown): string | null {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return null
  const units = (data as Record<string, unknown>).units
  if (units === 'raw') return '原始设备计数（未经单位换算）'
  if (units === 'normalized') return '归一化单位：加速度 g · 角速度 rad/s · 磁场 mG'
  return null
}

export default function MessagesPage({ embedded = false }: { embedded?: boolean }) {
  const [activeTab, setActiveTab] = useState('messages')
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
      rate: formatMeasuredRate(sample, nowTick, row.event),
      live: connected && isMavlinkMessageLive(sample, nowTick),
    }
  }), [connected, messageSamples, nowTick])

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
      {activeTab !== 'terminal' && <div className="flex items-center justify-end gap-2 mb-3">
        <span className="mc-toolbar-summary">{liveCount} 种活跃消息 · {displayLogs.length} 条状态记录</span>
        <button type="button" className="mc-icon-btn mc-icon-btn--bordered" aria-label={paused ? '继续' : '暂停'} onClick={togglePaused}><Icon name={paused ? 'refresh' : 'pause'} size={15} /></button>
        <button type="button" className="mc-icon-btn mc-icon-btn--bordered" aria-label="清空" onClick={clearDiagnostics}><Icon name="trash" size={15} /></button>
      </div>}
      <PageTabs tabs={tabs} active={activeTab} onChange={setActiveTab} />

      {activeTab === 'messages' && (
        <div className="mc-message-layout">
          <section className="mc-card mc-message-table">
            <div className="mc-message-row mc-message-row--header"><span>ID</span><span>消息名称</span><span>状态</span><span>实测频率</span></div>
            {displayRows.map((row) => {
              const expanded = expandedRows.has(row.id)
              const unitSummary = imuUnitSummary(row.sample?.latestData)
              return (
              <div className="mc-message-item" key={row.id} data-expanded={expanded}>
                <div className="mc-message-row">
                  <button
                    type="button"
                    className="mc-message-row__toggle mc-mono"
                    aria-label={`${expanded ? '收起' : '展开'} ${row.name}`}
                    aria-expanded={expanded}
                    onClick={() => toggleExpanded(row.id)}
                  >{expanded ? '−' : '+'}&nbsp; #{row.id}</button>
                  <strong className="mc-mono">{row.name}</strong>
                  <span>{row.live ? '接收中' : '等待'}</span>
                  <span className="mc-mono" style={{ color: row.live ? 'var(--success)' : 'var(--text-disabled)' }}>{paused ? '暂停' : row.rate}</span>
                </div>
                {expanded && (
                  <div className="mc-message-details">
                    {row.sample ? (
                      <>
                        <header>
                          <span>{unitSummary ?? '后端解码后的最新字段'}</span>
                          <span className="mc-mono">累计 {row.sample.totalCount} 帧 · {new Date(row.sample.lastSeen).toLocaleTimeString()}</span>
                        </header>
                        <div className="mc-message-details__grid">
                          {messageFields(row.sample.latestData).map(([field, value]) => (
                            <div key={field}><code>{field}</code><strong className="mc-mono">{formatFieldValue(value)}</strong></div>
                          ))}
                        </div>
                      </>
                    ) : <p>尚未收到该消息。</p>}
                  </div>
                )}
              </div>
            )})}
          </section>

          <section className="mc-card mc-rate-panel">
            <h3>消息频率控制</h3>
            <div className="mc-rate-panel__rows">
              {rateRows.map((row) => (
                <label key={row.key}>
                  <span>{row.label}</span>
                  <select
                    className="mc-select mc-mono"
                    aria-label={`${row.label}消息频率`}
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
              >恢复默认</button>
            </footer>
          </section>

          <section className="mc-card mc-link-stats">
            <h3>链路统计</h3>
            {[
              ['连接状态', connected ? '已连接' : '未连接'], ['活跃数据流', String(liveCount)], ['状态消息', String(displayLogs.length)], ['CRC 错误', '—'], ['丢包率', '—'], ['传输速率', connected ? '实时' : '0 msg/s'],
            ].map(([label, value]) => <div key={label}><span>{label}</span><strong className="mc-mono">{value}</strong></div>)}
          </section>
        </div>
      )}

      {activeTab === 'status' && <StatusVariableBrowser paused={paused} />}

      {activeTab === 'terminal' && (
        <FlightControllerTerminal />
      )}

    </div>
  )
}
