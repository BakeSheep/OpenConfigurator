import { lazy, Suspense, useEffect, useState } from 'react'
import { NavLink } from 'react-router-dom'
import Icon from '../components/ui/Icon'
import { PageHeader } from '../components/ui/PageFrame'
import { useConnectionStore } from '../stores/connectionStore'
import { useSensorStore } from '../stores/sensorStore'
import { useTelemetryStore } from '../stores/telemetryStore'

const radToDegrees = (radians: number) => radians * 180 / Math.PI
const AttitudeIndicator = lazy(() => import('../components/telemetry/AttitudeIndicator'))

function readDashboardSnapshot() {
  const telemetry = useTelemetryStore.getState()
  const sensors = useSensorStore.getState()
  return {
    attitude: telemetry.attitude,
    gps: telemetry.gps,
    battery: telemetry.battery,
    relativeAlt: telemetry.relativeAlt,
    heading: telemetry.heading,
    mode: telemetry.status?.mode,
    armed: telemetry.status?.armed ?? false,
    isStale: telemetry.isStale,
    sensorHealth: sensors.sensorHealth,
    imu: sensors.imu,
    magData: sensors.magData,
    baro: sensors.baro,
    opticalFlow: sensors.opticalFlow,
    distanceSensor: sensors.distanceSensor,
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
  return <div className="mc-dashboard-health-row"><span className="mc-status-dot" style={{ background: ok ? 'var(--success)' : 'var(--text-disabled)' }} /><span>{label}</span><strong className="mc-mono">{value}</strong></div>
}

export default function DashboardPage() {
  const [snapshot, setSnapshot] = useState(readDashboardSnapshot)
  useEffect(() => {
    const timer = window.setInterval(() => setSnapshot(readDashboardSnapshot()), 200)
    return () => window.clearInterval(timer)
  }, [])
  const vehicleReady = useConnectionStore((state) => state.vehicleReady)
  const {
    attitude, gps, battery, relativeAlt, heading, mode, armed, isStale,
    sensorHealth, imu, magData, baro, opticalFlow, distanceSensor,
  } = snapshot
  const roll = radToDegrees(attitude?.roll ?? 0)
  const pitch = radToDegrees(attitude?.pitch ?? 0)
  const yaw = radToDegrees(attitude?.yaw ?? 0)

  return (
    <div className="mc-workspace mc-workspace--full mc-fade-in">
      <PageHeader
        title="飞行总览"
        description={vehicleReady ? `${armed ? '已解锁' : '已上锁'} · ${mode ?? '模式未知'} · 高度 ${relativeAlt.toFixed(1)} m · 航向 ${heading.toFixed(0)}°` : '连接飞控后显示实时姿态、定位和传感器健康。'}
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
            <HealthRow label="电池" value={battery ? `${battery.voltage?.toFixed(1) ?? '—'} V · ${battery.remaining ?? '—'}%` : '—'} ok={Boolean(vehicleReady && battery)} />
          </div>
        </aside>
      </section>
    </div>
  )
}
