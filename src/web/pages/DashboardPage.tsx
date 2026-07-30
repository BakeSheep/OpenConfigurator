import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import { NavLink } from 'react-router-dom'
import Icon from '../components/ui/Icon'
import { PageHeader } from '../components/ui/PageFrame'
import { buildGroups, readStatusVariableSnapshot, STATUS_SNAPSHOT_INTERVAL_MS } from '../components/telemetry/StatusVariableBrowser'
import { useConnectionStore } from '../stores/connectionStore'
import { useSensorStore } from '../stores/sensorStore'
import { useTelemetryStore } from '../stores/telemetryStore'
import type { RcChannelsData } from '../../shared/types'

const radToDegrees = (radians: number) => radians * 180 / Math.PI
const AttitudeIndicator = lazy(() => import('../components/telemetry/AttitudeIndicator'))

// Selected variable ids ("GROUP.name") for the custom data board.
const CUSTOM_VARS_KEY = 'oc-dashboard-custom-vars'

function loadCustomVars(): string[] {
  try {
    const raw = localStorage.getItem(CUSTOM_VARS_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) return parsed.filter((id) => typeof id === 'string')
    }
  } catch { /* ignore */ }
  return []
}

function saveCustomVars(ids: string[]) {
  try { localStorage.setItem(CUSTOM_VARS_KEY, JSON.stringify(ids)) } catch { /* ignore */ }
}


function readDashboardSnapshot() {
  const telemetry = useTelemetryStore.getState()
  const sensors = useSensorStore.getState()
  return {
    attitude: telemetry.attitude,
    gps: telemetry.gps,
    battery: telemetry.battery,
    isStale: telemetry.isStale,
    sensorHealth: sensors.sensorHealth,
    imu: sensors.imu,
    magData: sensors.magData,
    baro: sensors.baro,
    opticalFlow: sensors.opticalFlow,
    distanceSensor: sensors.distanceSensor,
    rcChannels: telemetry.rcChannels,
    motorOutputs: telemetry.motorOutputs,
  }
}

function Horizon({ roll, pitch, yaw, frozen }: { roll: number; pitch: number; yaw: number; frozen: boolean }) {
  const transform = `rotate(${roll.toFixed(1)}deg) translateY(${(-pitch * 1.15).toFixed(1)}%)`
  return (
    <section className="mc-dashboard-horizon">
      <div className="mc-dashboard-horizon__scene" style={{ transform }}>
        <div className="mc-dashboard-horizon__sky" /><div className="mc-dashboard-horizon__ground" /><div className="mc-dashboard-horizon__line" />
        {[-60, -40, -20, 20, 40, 60].map((mark) => <span key={mark} className="mc-dashboard-horizon__mark" style={{ top: 50 - mark * 0.52 + '%', left: mark < 0 ? '20%' : '66%' }}>{Math.abs(mark)}</span>)}
      </div>
      <div className="mc-dashboard-horizon__reticle"><span /><i /><span /></div>
      <div className="mc-dashboard-horizon__heading"><span>W</span><span>330</span><strong>{yaw.toFixed(0)}°</strong><span>30</span><span>NE</span></div>
      <div className="mc-dashboard-horizon__angle mc-dashboard-horizon__angle--left">R {roll.toFixed(1)}°</div>
      <div className="mc-dashboard-horizon__angle mc-dashboard-horizon__angle--right">P {pitch.toFixed(1)}°</div>
      {frozen && <div className="mc-dashboard-horizon__frozen">等待飞控姿态</div>}
    </section>
  )
}

function HealthRow({ label, value, ok }: { label: string; value: string; ok: boolean }) {
  return (
    <div className="mc-dashboard-health-card">
      <div><span className="mc-status-dot" style={{ background: ok ? 'var(--success)' : 'var(--text-disabled)' }} /><span>{label}</span></div>
      <strong className="mc-mono">{value}</strong>
    </div>
  )
}

// Vertical fill bars for RC channel inputs / motor PWM outputs. Values are
// raw microseconds; the fill maps the usual 1000-2000 us servo range.
function VerticalBarsCard({ title, subtitle, live, bars }: {
  title: string
  subtitle: string
  live: boolean
  bars: Array<{ label: string; value: number | null }>
}) {
  return (
    <aside className="mc-card mc-dashboard-sensors overflow-hidden">
      <header><div><h2>{title}</h2><p>{subtitle}</p></div><span data-ready={live}>{live ? 'LIVE' : 'OFFLINE'}</span></header>
      <div className="mc-dashboard-bars">
        {bars.map((bar) => {
          const fresh = live && bar.value !== null
          const ratio = fresh ? Math.max(0, Math.min(1, (bar.value! - 1000) / 1000)) : 0
          return (
            <div key={bar.label} className="mc-dashboard-bars__bar" title={fresh ? `${bar.label}: ${Math.round(bar.value!)} µs` : `${bar.label}: —`}>
              <span className="mc-dashboard-bars__value">{fresh ? Math.round(bar.value!) : '—'}</span>
              <div className="mc-dashboard-bars__track">
                <div className="mc-dashboard-bars__fill" data-stale={!fresh || undefined} style={{ height: `${(ratio * 100).toFixed(1)}%` }} />
              </div>
              <span className="mc-dashboard-bars__label">{bar.label}</span>
            </div>
          )
        })}
      </div>
    </aside>
  )
}

// Custom data board: user picks any variables from the MAVLink status tree
// (same registry as the status variable browser) for realtime display.
function CustomDataCard() {
  // Sample a snapshot on a fixed interval instead of subscribing to the whole
  // telemetry/sensor stores, which would rebuild the variable tree for every
  // high-rate message and re-render the dashboard on each packet.
  const [snapshot, setSnapshot] = useState(readStatusVariableSnapshot)
  useEffect(() => {
    const timer = window.setInterval(
      () => setSnapshot(readStatusVariableSnapshot()),
      STATUS_SNAPSHOT_INTERVAL_MS,
    )
    return () => window.clearInterval(timer)
  }, [])
  const [selected, setSelected] = useState(loadCustomVars)
  const [editing, setEditing] = useState(false)
  const [query, setQuery] = useState('')

  const groups = useMemo(
    () => buildGroups(snapshot.telemetry, snapshot.sensors, snapshot.linkStats),
    [snapshot],
  )
  const entryById = new Map(groups.flatMap((group) => group.entries.map((entry) => [`${group.name}.${entry.name}`, entry] as [string, typeof entry])))

  const toggleVar = (id: string) => {
    setSelected((current) => {
      const next = current.includes(id) ? current.filter((item) => item !== id) : [...current, id]
      saveCustomVars(next)
      return next
    })
  }

  const needle = query.trim().toLowerCase()
  const pickerGroups = needle
    ? groups
        .map((group) => ({
          ...group,
          entries: group.name.toLowerCase().includes(needle)
            ? group.entries
            : group.entries.filter((entry) => entry.name.toLowerCase().includes(needle)),
        }))
        .filter((group) => group.entries.length > 0)
    : groups

  return (
    <aside className="mc-card mc-dashboard-sensors overflow-hidden">
      <header>
        <div><h2>自定义看板</h2><p>{editing ? '勾选要显示的 MAVLink 状态变量' : `${selected.length} 项实时数据`}</p></div>
        <button type="button" className="mc-dashboard-custom__edit" data-active={editing} onClick={() => setEditing((v) => !v)}>
          {editing ? '完成' : '编辑'}
        </button>
      </header>
      {editing ? (
        <div className="mc-dashboard-custom__picker">
          <input
            type="text"
            className="mc-input"
            value={query}
            placeholder="搜索变量名…"
            onChange={(event) => setQuery(event.target.value)}
          />
          <div className="mc-dashboard-custom__picker-list">
            {pickerGroups.map((group) => (
              <div key={group.name}>
                <p>{group.name}</p>
                {group.entries.map((entry) => {
                  const id = `${group.name}.${entry.name}`
                  return (
                    <label key={id}>
                      <input type="checkbox" checked={selected.includes(id)} onChange={() => toggleVar(id)} style={{ accentColor: 'var(--accent)' }} />
                      <span>{entry.name}</span>
                      <i className="mc-mono">{entry.value ?? '--'}</i>
                    </label>
                  )
                })}
              </div>
            ))}
          </div>
        </div>
      ) : selected.length === 0 ? (
        <div className="mc-dashboard-custom__empty">点击右上角“编辑”，从 MAVLink 状态变量中选取要实时显示的数据。</div>
      ) : (
        <div className="mc-dashboard-health-list mc-dashboard-custom__list">
          {selected.map((id) => {
            const entry = entryById.get(id)
            return (
              <div key={id} className="mc-dashboard-health-card">
                <div><span className="mc-status-dot" style={{ background: entry?.value != null ? 'var(--success)' : 'var(--text-disabled)' }} /><span>{id}</span></div>
                <strong className="mc-mono">{entry ? `${entry.value ?? '--'}${entry.value != null && entry.unit ? ` ${entry.unit}` : ''}` : '--'}</strong>
              </div>
            )
          })}
        </div>
      )}
    </aside>
  )
}

export default function DashboardPage() {
  const [snapshot, setSnapshot] = useState(readDashboardSnapshot)
  useEffect(() => {
    const timer = window.setInterval(() => setSnapshot(readDashboardSnapshot()), 200)
    return () => window.clearInterval(timer)
  }, [])
  const vehicleReady = useConnectionStore((state) => state.vehicleReady)
  const {
    attitude, gps, battery, isStale,
    sensorHealth, imu, magData, baro, opticalFlow, distanceSensor,
    rcChannels, motorOutputs,
  } = snapshot
  const roll = radToDegrees(attitude?.roll ?? 0)
  const pitch = radToDegrees(attitude?.pitch ?? 0)
  const yaw = radToDegrees(attitude?.yaw ?? 0)

  // RC bars: ch1-8 are always present in RC_CHANNELS, 9+ only when reported.
  const rcLive = vehicleReady && rcChannels !== null && !isStale('rcChannels')
  const rcBars = Array.from({ length: 18 }, (_, index) => {
    const value = rcChannels?.[`ch${index + 1}` as keyof RcChannelsData] ?? null
    if (index >= 8 && value == null) return null
    return { label: String(index + 1), value }
  }).filter((bar) => bar !== null)

  // Motor bars: null slots mean the output channel is not present.
  const motorLive = vehicleReady && motorOutputs !== null && !isStale('motorOutputs')
  const motorBars = (motorOutputs?.outputs ?? Array.from({ length: 8 }, () => null))
    .map((value, index) => ({ label: `M${index + 1}`, value }))
    .filter((bar, index) => bar.value !== null || index < 8)

  // Battery summary: voltage / current / power (V×I) / remaining, skipping
  // fields the current BATTERY_STATUS instance does not report.
  const batteryValue = battery
    ? [
        battery.voltage != null ? `${battery.voltage.toFixed(1)} V` : null,
        battery.current != null ? `${battery.current.toFixed(1)} A` : null,
        battery.voltage != null && battery.current != null ? `${(battery.voltage * battery.current).toFixed(0)} W` : null,
        battery.remaining != null ? `${battery.remaining}%` : null,
      ].filter((part) => part !== null).join(' · ') || '—'
    : '—'

  return (
    <div className="mc-workspace mc-workspace--full mc-fade-in">
      <PageHeader
        title="飞行总览"
        actions={<NavLink to="/flight" className="mc-btn mc-btn-primary"><Icon name="flight" size={15} />进入飞行操作</NavLink>}
      />
      <section className="mc-dashboard-primary-grid">
        <div className="mc-card mc-dashboard-visual overflow-hidden">
          <Suspense fallback={<div className="mc-attitude-view mc-route-loading">正在加载三维姿态…</div>}><AttitudeIndicator /></Suspense>
          <div className="mc-dashboard-attitude-values">
            {[['ROLL', roll], ['PITCH', pitch], ['YAW', yaw]].map(([label, value]) => <div key={label as string} className="px-3 py-2 text-center"><p className="text-[10px] font-semibold" style={{ color: 'var(--text-secondary)' }}>{label}</p><p className="mt-0.5 mc-mono text-[13px] font-bold">{Number(value).toFixed(1)}°</p></div>)}
          </div>
        </div>
        <div className="mc-card mc-dashboard-visual overflow-hidden">
          <Horizon roll={roll} pitch={pitch} yaw={yaw} frozen={!vehicleReady || isStale('attitude')} />
        </div>
        <aside className="mc-card mc-dashboard-sensors overflow-hidden">
          <header><div><h2>系统健康</h2><p>{vehicleReady ? '实时数据' : '等待飞控'}</p></div><span data-ready={vehicleReady}>{vehicleReady ? 'READY' : 'OFFLINE'}</span></header>
          <div className="mc-dashboard-health-list">
            <HealthRow label="IMU" value={imu ? `${imu.xacc.toFixed(1)} / ${imu.yacc.toFixed(1)} / ${imu.zacc.toFixed(1)}` : '—'} ok={sensorHealth.imu === 'ok'} />
            <HealthRow label="罗盘" value={magData ? `${magData.x.toFixed(0)} / ${magData.y.toFixed(0)} / ${magData.z.toFixed(0)}` : '—'} ok={sensorHealth.mag === 'ok'} />
            <HealthRow label="气压计" value={baro ? `${baro.press_abs.toFixed(1)} hPa` : '—'} ok={sensorHealth.baro === 'ok'} />
            <HealthRow label="GPS" value={gps ? `${gps.satellites_visible} SAT · Fix ${gps.fix_type}` : '—'} ok={sensorHealth.gps === 'ok'} />
            <HealthRow label="光流" value={opticalFlow ? `Q ${opticalFlow.quality}/255` : '—'} ok={sensorHealth.opticalFlow === 'ok'} />
            <HealthRow label="测距" value={distanceSensor ? `${distanceSensor.current_distance} cm` : '—'} ok={sensorHealth.rangefinder === 'ok'} />
            <HealthRow label="电池" value={batteryValue} ok={Boolean(vehicleReady && battery)} />
          </div>
        </aside>
        <VerticalBarsCard title="遥控输入" subtitle="RC_CHANNELS · µs" live={rcLive} bars={rcBars} />
        <VerticalBarsCard title="电机输出" subtitle="SERVO_OUTPUT_RAW · µs" live={motorLive} bars={motorBars} />
        <CustomDataCard />
      </section>
    </div>
  )
}
