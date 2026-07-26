import { useMemo, useState } from 'react'
import Icon from '../components/ui/Icon'
import { PageTabs } from '../components/ui/PageFrame'
import StatusVariableBrowser from '../components/telemetry/StatusVariableBrowser'
import { useConnectionStore } from '../stores/connectionStore'
import { useSensorStore } from '../stores/sensorStore'
import { useTelemetryStore } from '../stores/telemetryStore'

const tabs = [
  { id: 'messages', label: '消息' },
  { id: 'status', label: '状态' },
  { id: 'terminal', label: '终端' },
]

const streamRows = [
  { id: 0, name: 'HEARTBEAT', source: 'status', rate: '1 Hz' },
  { id: 1, name: 'SYS_STATUS', source: 'sysStatus', rate: '1 Hz' },
  { id: 24, name: 'GPS_RAW_INT', source: 'gps', rate: '1 Hz' },
  { id: 26, name: 'SCALED_IMU', source: 'imu', rate: '实时' },
  { id: 29, name: 'SCALED_PRESSURE', source: 'baro', rate: '实时' },
  { id: 30, name: 'ATTITUDE', source: 'attitude', rate: '实时' },
  { id: 36, name: 'SERVO_OUTPUT_RAW', source: 'motorOutputs', rate: '实时' },
  { id: 74, name: 'VFR_HUD', source: 'vfrHud', rate: '实时' },
  { id: 106, name: 'OPTICAL_FLOW_RAD', source: 'opticalFlow', rate: '实时' },
  { id: 132, name: 'DISTANCE_SENSOR', source: 'distanceSensor', rate: '实时' },
  { id: 147, name: 'BATTERY_STATUS', source: 'battery', rate: '实时' },
  { id: 230, name: 'ESTIMATOR_STATUS', source: 'ekfStatus', rate: '1 Hz' },
  { id: 253, name: 'STATUSTEXT', source: 'statusText', rate: '事件' },
]

export default function MessagesPage({ embedded = false }: { embedded?: boolean }) {
  const [activeTab, setActiveTab] = useState('messages')
  const [paused, setPaused] = useState(false)
  const connected = useConnectionStore((state) => state.vehicleReady)
  const lastUpdate = useTelemetryStore((state) => state.lastUpdate)
  const sensorUpdate = useSensorStore((state) => state.lastUpdate)
  const statusLogs = useTelemetryStore((state) => state.statusLogs)
  const clearStatusLogs = useTelemetryStore((state) => state.clearStatusLogs)

  const rows = useMemo(() => streamRows.map((row) => {
    const telemetryTime = lastUpdate[row.source as keyof typeof lastUpdate]
    const sensorTime = sensorUpdate[row.source as keyof typeof sensorUpdate]
    const time = telemetryTime ?? sensorTime ?? (row.source === 'statusText' ? statusLogs[0]?.time : 0) ?? 0
    return { ...row, live: connected && time > 0 && Date.now() - time < 4000 }
  }), [connected, lastUpdate, sensorUpdate, statusLogs])

  const [pausedRows, setPausedRows] = useState<typeof rows | null>(null)
  const [pausedLogs, setPausedLogs] = useState<typeof statusLogs | null>(null)
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

  const clearLogs = () => {
    clearStatusLogs()
    if (paused) setPausedLogs([])
  }

  return (
    <div className={embedded ? 'mc-fade-in mc-data-workspace' : 'mc-workspace mc-fade-in mc-data-workspace'}>
      <div className="flex items-center justify-end gap-2 mb-3">
        <span className="mc-toolbar-summary">{liveCount} 种活跃消息 · {displayLogs.length} 条状态记录</span>
        <button type="button" className="mc-icon-btn mc-icon-btn--bordered" aria-label={paused ? '继续' : '暂停'} onClick={togglePaused}><Icon name={paused ? 'refresh' : 'pause'} size={15} /></button>
        <button type="button" className="mc-icon-btn mc-icon-btn--bordered" aria-label="清空" onClick={clearLogs}><Icon name="trash" size={15} /></button>
      </div>
      <PageTabs tabs={tabs} active={activeTab} onChange={setActiveTab} />

      {activeTab === 'messages' && (
        <div className="mc-message-layout">
          <section className="mc-card mc-message-table">
            <div className="mc-message-row mc-message-row--header"><span>ID</span><span>消息名称</span><span>状态</span><span>频率</span></div>
            {displayRows.map((row) => (
              <div className="mc-message-row" key={row.id}>
                <span className="mc-mono">+&nbsp; #{row.id}</span>
                <strong className="mc-mono">{row.name}</strong>
                <span>{row.live ? '接收中' : '等待'}</span>
                <span className="mc-mono" style={{ color: row.live ? 'var(--success)' : 'var(--text-disabled)' }}>{paused ? '暂停' : row.live ? row.rate : '0 Hz'}</span>
              </div>
            ))}
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
        <section className="mc-card mc-console-panel">
          {displayLogs.length === 0 ? <p className="mc-console-empty">暂无飞控状态消息</p> : displayLogs.map((log) => (
            <div key={log.id}><time className="mc-mono">{new Date(log.time).toLocaleTimeString()}</time><span data-severity={log.severity}>{log.severity.toUpperCase()}</span><p>{log.text}</p></div>
          ))}
        </section>
      )}

    </div>
  )
}
