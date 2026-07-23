import { useMemo, useState } from 'react'
import Icon from '../components/ui/Icon'
import { PageHeader, PageTabs } from '../components/ui/PageFrame'
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

export default function MessagesPage() {
  const [activeTab, setActiveTab] = useState('messages')
  const [paused, setPaused] = useState(false)
  const connected = useConnectionStore((state) => state.status === 'connected')
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

  const liveCount = rows.filter((row) => row.live).length

  return (
    <div className="mc-workspace mc-fade-in mc-data-workspace">
      <PageHeader
        title="消息控制台"
        description="实时 MAVLink 消息监控"
        actions={
          <>
            <span className="mc-toolbar-summary">{liveCount} 种活跃消息 · {statusLogs.length} 条状态记录</span>
            <button type="button" className="mc-icon-btn mc-icon-btn--bordered" aria-label={paused ? '继续' : '暂停'} onClick={() => setPaused((value) => !value)}><Icon name={paused ? 'refresh' : 'pause'} size={15} /></button>
            <button type="button" className="mc-icon-btn mc-icon-btn--bordered" aria-label="清空" onClick={clearStatusLogs}><Icon name="trash" size={15} /></button>
          </>
        }
      />
      <PageTabs tabs={tabs} active={activeTab} onChange={setActiveTab} />

      {activeTab === 'messages' && (
        <div className="mc-message-layout">
          <section className="mc-card mc-message-table">
            <div className="mc-message-row mc-message-row--header"><span>ID</span><span>消息名称</span><span>状态</span><span>频率</span></div>
            {rows.map((row) => (
              <div className="mc-message-row" key={row.id}>
                <span className="mc-mono">+&nbsp; #{row.id}</span>
                <strong className="mc-mono">{row.name}</strong>
                <span>{row.live ? '接收中' : '等待'}</span>
                <span className="mc-mono" style={{ color: row.live ? 'var(--success)' : 'var(--text-disabled)' }}>{paused ? '暂停' : row.live ? row.rate : '0 Hz'}</span>
              </div>
            ))}
          </section>

          <aside className="mc-card mc-rate-panel">
            <h3>消息频率控制</h3>
            {['姿态', '位置', '传感器', '遥控', '状态', 'HUD', '光流/电池/振动'].map((label, index) => (
              <label key={label}><span>{label}</span><select className="mc-select" defaultValue={index === 6 ? '100' : index < 3 ? '4' : '1'} disabled><option>1</option><option>2</option><option>4</option><option>10</option><option>100</option></select><small>Hz</small></label>
            ))}
            <button type="button" className="mc-btn mc-btn-ghost" disabled>恢复默认</button>
          </aside>

          <section className="mc-card mc-link-stats">
            <h3>链路统计</h3>
            {[
              ['连接状态', connected ? '已连接' : '未连接'], ['活跃数据流', String(liveCount)], ['状态消息', String(statusLogs.length)], ['CRC 错误', '—'], ['丢包率', '—'], ['传输速率', connected ? '实时' : '0 msg/s'],
            ].map(([label, value]) => <div key={label}><span>{label}</span><strong className="mc-mono">{value}</strong></div>)}
          </section>
        </div>
      )}

      {activeTab === 'status' && (
        <section className="mc-card mc-console-panel">
          {statusLogs.length === 0 ? <p className="mc-console-empty">暂无飞控状态消息</p> : statusLogs.map((log) => (
            <div key={log.id}><time className="mc-mono">{new Date(log.time).toLocaleTimeString()}</time><span data-severity={log.severity}>{log.severity.toUpperCase()}</span><p>{log.text}</p></div>
          ))}
        </section>
      )}

      {activeTab === 'terminal' && <section className="mc-card mc-terminal"><p>SkyLab MAVLink Console</p><p className="is-muted">只读终端 · 等待飞控状态文本...</p></section>}
    </div>
  )
}
