import { useEffect, useState, type ReactNode } from 'react'
import AttitudeIndicator from '../components/telemetry/AttitudeIndicator'
import RealtimeChart from '../components/telemetry/RealtimeChart'
import ChannelBars from '../components/telemetry/ChannelBars'
import EkfFusionPanel from '../components/ekf/EkfFusionPanel'
import Icon, { type IconName } from '../components/ui/Icon'
import { PageHeader } from '../components/ui/PageFrame'
import { useConnectionStore } from '../stores/connectionStore'
import { useSensorStore } from '../stores/sensorStore'
import { useTelemetryStore } from '../stores/telemetryStore'

const radToDegrees = (radians: number) => radians * 180 / Math.PI

function readDashboardSnapshot() {
  const telemetry = useTelemetryStore.getState()
  const sensors = useSensorStore.getState()
  return {
    attitude: telemetry.attitude,
    gps: telemetry.gps,
    battery: telemetry.battery,
    rcChannels: telemetry.rcChannels,
    motorOutputs: telemetry.motorOutputs,
    relativeAlt: telemetry.relativeAlt,
    groundSpeed: telemetry.groundSpeed,
    heading: telemetry.heading,
    isStale: telemetry.isStale,
    sensorHealth: sensors.sensorHealth,
    opticalFlow: sensors.opticalFlow,
    distanceSensor: sensors.distanceSensor,
  }
}

function PanelTitle({ title, detail, action }: { title: string; detail?: string; action?: ReactNode }) {
  return (
    <header className="flex items-center justify-between gap-4 border-b px-5 py-4" style={{ borderColor: 'var(--border)' }}>
      <div>
        <h2 className="text-[14px] font-bold" style={{ color: 'var(--text-primary)' }}>{title}</h2>
        {detail && <p className="mt-1 text-[11px]" style={{ color: 'var(--text-secondary)' }}>{detail}</p>}
      </div>
      {action}
    </header>
  )
}

function SensorTile({ icon, label, status, value }: { icon: IconName; label: string; status: string; value: string }) {
  const healthy = status === 'ok'
  const warning = status === 'warning'
  const color = healthy ? 'var(--success)' : warning ? 'var(--warning)' : 'var(--text-disabled)'

  return (
    <div className="rounded-xl border p-4 text-center" style={{ borderColor: 'var(--border)', background: 'var(--bg-secondary)' }}>
      <span className="mx-auto grid h-9 w-9 place-items-center rounded-full" style={{ background: healthy ? 'var(--success-dim)' : 'var(--bg-tertiary)', color }}>
        <Icon name={icon} size={19} />
      </span>
      <p className="mt-2 text-[12px] font-bold" style={{ color: 'var(--text-primary)' }}>{label}</p>
      <p className="mt-1 text-[10px]" style={{ color }}>{value}</p>
    </div>
  )
}

function Horizon({ roll, pitch, yaw, frozen }: { roll: number; pitch: number; yaw: number; frozen: boolean }) {
  const transform = 'rotate(' + roll.toFixed(1) + 'deg) translateY(' + (-pitch * 1.15).toFixed(1) + '%)'

  return (
    <section className="mc-dashboard-horizon">
      <div className="mc-dashboard-horizon__scene" style={{ transform }}>
        <div className="mc-dashboard-horizon__sky" />
        <div className="mc-dashboard-horizon__ground" />
        <div className="mc-dashboard-horizon__line" />
        {[-60, -40, -20, 20, 40, 60].map((mark) => (
          <span key={mark} className="mc-dashboard-horizon__mark" style={{ top: 50 - mark * 0.52 + '%', left: mark < 0 ? '20%' : '66%' }}>
            {Math.abs(mark)}
          </span>
        ))}
      </div>
      <div className="mc-dashboard-horizon__reticle">
        <span />
        <i />
        <span />
      </div>
      <div className="mc-dashboard-horizon__heading">
        <span>W</span><span>330</span><strong>{yaw.toFixed(0)}°</strong><span>30</span><span>NE</span>
      </div>
      <div className="mc-dashboard-horizon__angle mc-dashboard-horizon__angle--left">R {roll.toFixed(1)}°</div>
      <div className="mc-dashboard-horizon__angle mc-dashboard-horizon__angle--right">P {pitch.toFixed(1)}°</div>
      {frozen && <div className="mc-dashboard-horizon__frozen">飞控未连接</div>}
    </section>
  )
}

function SignalStrip({ title, labels, values, motor = false, connected }: {
  title: string
  labels: string[]
  values: Array<number | null>
  motor?: boolean
  connected: boolean
}) {
  return (
    <section className="mc-card overflow-hidden">
      <div className="flex items-center justify-between border-b px-5 py-3" style={{ borderColor: 'var(--border)' }}>
        <h2 className="mc-section-title">{title}</h2>
        <span className="rounded-full px-2 py-1 text-[10px] font-semibold" style={{ background: connected ? 'var(--accent-dim)' : 'var(--bg-tertiary)', color: connected ? 'var(--accent)' : 'var(--text-disabled)' }}>
          {connected ? '实时数据' : '未连接飞控'}
        </span>
      </div>
      <ChannelBars labels={labels} values={values} connected={connected} accent={motor ? 'success' : 'accent'} />
    </section>
  )
}

function MetricCard({ label, value, unit, icon, accent = false }: { label: string; value: string; unit: string; icon: IconName; accent?: boolean }) {
  return (
    <div className="mc-card flex min-h-[102px] items-center gap-4 p-4">
      <span className="grid h-10 w-10 place-items-center rounded-xl" style={{ background: accent ? 'var(--accent-dim)' : 'var(--bg-tertiary)', color: accent ? 'var(--accent)' : 'var(--text-secondary)' }}>
        <Icon name={icon} size={19} />
      </span>
      <div>
        <p className="text-[11px] font-semibold" style={{ color: 'var(--text-secondary)' }}>{label}</p>
        <p className="mt-1 mc-mono text-[20px] font-bold tracking-tight" style={{ color: accent ? 'var(--accent)' : 'var(--text-primary)' }}>
          {value}<span className="ml-1 text-[11px] font-medium" style={{ color: 'var(--text-secondary)' }}>{unit}</span>
        </p>
      </div>
    </div>
  )
}

export default function DashboardPage() {
  const [snapshot, setSnapshot] = useState(readDashboardSnapshot)
  useEffect(() => {
    const timer = setInterval(() => setSnapshot(readDashboardSnapshot()), 200)
    return () => clearInterval(timer)
  }, [])
  const {
    attitude, gps, battery, rcChannels, motorOutputs,
    relativeAlt, groundSpeed, heading, isStale,
    sensorHealth, opticalFlow, distanceSensor,
  } = snapshot
  const connected = useConnectionStore((state) => state.status === 'connected')

  const roll = radToDegrees(attitude?.roll ?? 0)
  const pitch = radToDegrees(attitude?.pitch ?? 0)
  const yaw = radToDegrees(attitude?.yaw ?? 0)
  const rcValues = Array.from({ length: 12 }, (_, index) => rcChannels?.[('ch' + (index + 1)) as keyof NonNullable<typeof rcChannels>] ?? null) as Array<number | null>
  const outputs = motorOutputs?.outputs ?? []
  const motorValues = Array.from({ length: 12 }, (_, index) => outputs[index] ?? null)

  return (
    <div className="mc-workspace mc-fade-in">
      <PageHeader title="仪表盘" description="飞控状态实时概览" />

      <section className="mc-dashboard-primary-grid">
        <div className="mc-card mc-dashboard-visual overflow-hidden">
          <AttitudeIndicator />
          <div className="mc-dashboard-attitude-values">
            {[
              ['ROLL', roll.toFixed(1)],
              ['PITCH', pitch.toFixed(1)],
              ['YAW', yaw.toFixed(1)],
            ].map(([label, value]) => (
              <div key={label} className="rounded-lg bg-[var(--bg-tertiary)] px-3 py-2.5 text-center">
                <p className="text-[10px] font-semibold" style={{ color: 'var(--text-secondary)' }}>{label}</p>
                <p className="mt-1 mc-mono text-[14px] font-bold" style={{ color: 'var(--text-primary)' }}>{value}°</p>
              </div>
            ))}
          </div>
        </div>

        <div className="mc-card mc-dashboard-visual overflow-hidden">
          <Horizon roll={roll} pitch={pitch} yaw={yaw} frozen={!connected || isStale('attitude')} />
        </div>

        <div className="mc-card mc-dashboard-sensors overflow-hidden">
          <PanelTitle title="传感器" />
          <div className="grid flex-1 grid-cols-2 gap-3 p-3">
            <SensorTile icon="sensor" label="IMU" status={sensorHealth.imu} value={sensorHealth.imu === 'ok' ? '在线' : '等待数据'} />
            <SensorTile icon="sensor" label="罗盘" status={sensorHealth.mag} value={sensorHealth.mag === 'ok' ? '在线' : '等待数据'} />
            <SensorTile icon="altitude" label="气压计" status={sensorHealth.baro} value={sensorHealth.baro === 'ok' ? '在线' : '等待数据'} />
            <SensorTile icon="satellite" label="GPS" status={sensorHealth.gps} value={gps?.fix_type && gps.fix_type >= 3 ? '定位正常' : '未定位'} />
            <SensorTile icon="waveform" label="光流" status={sensorHealth.opticalFlow} value={opticalFlow ? String(opticalFlow.quality) + ' / 255' : '未检测'} />
            <SensorTile icon="sensor" label="测距" status={sensorHealth.rangefinder} value={distanceSensor ? String(distanceSensor.current_distance) + ' cm' : '未检测'} />
          </div>
        </div>
      </section>

      <section className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-2">
        <SignalStrip title="遥控器输入" labels={Array.from({ length: 12 }, (_, index) => 'CH' + (index + 1))} values={rcValues} connected={connected} />
        <SignalStrip title="电机输出" labels={Array.from({ length: 12 }, (_, index) => 'M' + (index + 1))} values={motorValues} motor connected={connected} />
      </section>

      <section className="mt-4 grid grid-cols-2 gap-4 xl:grid-cols-4">
        <MetricCard label="相对高度" value={relativeAlt.toFixed(1)} unit="m" icon="altitude" accent />
        <MetricCard label="地速" value={groundSpeed.toFixed(1)} unit="m/s" icon="flight" />
        <MetricCard label="电池电压" value={battery?.voltage.toFixed(1) ?? '—'} unit="V" icon="battery" />
        <MetricCard label="GPS 卫星" value={String(gps?.satellites_visible ?? 0)} unit="SAT" icon="satellite" />
      </section>

      <section className="mt-4 grid grid-cols-1 gap-4 2xl:grid-cols-[1.45fr_1fr]">
        <RealtimeChart />
        <EkfFusionPanel />
      </section>
    </div>
  )
}
