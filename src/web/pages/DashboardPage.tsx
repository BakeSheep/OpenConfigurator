import { useTelemetryStore } from '../stores/telemetryStore'
import { useSensorStore } from '../stores/sensorStore'
import AttitudeIndicator from '../components/telemetry/AttitudeIndicator'
import RealtimeChart from '../components/telemetry/RealtimeChart'
import EkfFusionPanel from '../components/ekf/EkfFusionPanel'

function StatCard({ label, value, unit, accent }: { label: string; value: string | number; unit?: string; accent?: boolean }) {
  return (
    <div className="mc-card px-4 py-3">
      <p className="text-[11px] uppercase tracking-wider mb-1.5" style={{ color: 'var(--text-disabled)' }}>{label}</p>
      <p className="mc-mono font-semibold tabular-nums" style={{ color: accent ? 'var(--accent)' : 'var(--text-primary)', fontSize: 20, lineHeight: 1 }}>
        {value}<span className="text-[11px] ml-1 font-normal" style={{ color: 'var(--text-secondary)' }}>{unit}</span>
      </p>
    </div>
  )
}

function SensorCard({ title, online, children }: { title: string; online: boolean; children: React.ReactNode }) {
  return (
    <div className="mc-card p-4">
      <div className="flex items-center gap-2 mb-3">
        <span
          className="rounded-full"
          style={{
            width: 7,
            height: 7,
            background: online ? 'var(--success)' : 'var(--text-disabled)',
            boxShadow: online ? '0 0 6px rgba(34,197,94,.5)' : 'none',
          }}
        />
        <h4 className="mc-section-title">{title}</h4>
      </div>
      <div className="space-y-2">{children}</div>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between items-center">
      <span className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>{label}</span>
      <span className="text-[12px] mc-mono" style={{ color: 'var(--text-primary)' }}>{value}</span>
    </div>
  )
}

export default function DashboardPage() {
  const { attitude, gps, battery, status, relativeAlt, groundSpeed, heading, ekfStatus } = useTelemetryStore()
  const { imu, baro, opticalFlow, distanceSensor, magData, sensorHealth } = useSensorStore()
  const rad2deg = (r: number) => (r * 180 / Math.PI).toFixed(1)

  return (
    <div className="p-5 space-y-5">
      {/* Page heading */}
      <div>
        <h2 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>仪表盘</h2>
        <p className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>飞控实时状态总览</p>
      </div>

      {/* Top stats row */}
      <div className="grid grid-cols-3 md:grid-cols-6 gap-3">
        <StatCard label="高度" value={relativeAlt.toFixed(1)} unit="m" accent />
        <StatCard label="地速" value={groundSpeed.toFixed(1)} unit="m/s" />
        <StatCard label="航向" value={heading.toFixed(0)} unit="°" />
        <StatCard label="电压" value={battery?.voltage.toFixed(1) || '--'} unit="V" />
        <StatCard label="模式" value={status?.mode || '--'} />
        <StatCard label="状态" value={status?.armed ? 'ARMED' : 'SAFE'} accent={status?.armed} />
      </div>

      {/* 3D + EKF */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 space-y-4">
          <AttitudeIndicator />
          <RealtimeChart />
        </div>
        <EkfFusionPanel />
      </div>

      {/* Attitude + GPS + EKF status */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <SensorCard title="姿态" online={!!attitude}>
          <Row label="Roll" value={`${rad2deg(attitude?.roll || 0)}°`} />
          <Row label="Pitch" value={`${rad2deg(attitude?.pitch || 0)}°`} />
          <Row label="Yaw" value={`${rad2deg(attitude?.yaw || 0)}°`} />
        </SensorCard>
        <SensorCard title="GPS" online={sensorHealth.gps === 'ok'}>
          <Row label="Fix" value={`${gps?.fix_type || 0}D`} />
          <Row label="卫星" value={`${gps?.satellites_visible ?? '--'}`} />
          <Row label="HDOP" value={`${((gps?.eph || 0) / 100).toFixed(2)}`} />
        </SensorCard>
        <SensorCard title="EKF" online={!!ekfStatus}>
          <Row label="速度创新" value={`${(ekfStatus?.innovation_vel || 0).toFixed(3)}`} />
          <Row label="位置创新" value={`${(ekfStatus?.innovation_pos || 0).toFixed(3)}`} />
          <Row label="高度创新" value={`${(ekfStatus?.innovation_hgt || 0).toFixed(3)}`} />
        </SensorCard>
      </div>

      {/* Sensor monitors */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        <SensorCard title="IMU" online={sensorHealth.imu === 'ok'}>
          <Row label="Accel" value={`${(imu?.xacc||0).toFixed(2)} ${(imu?.yacc||0).toFixed(2)} ${(imu?.zacc||0).toFixed(2)}`} />
          <Row label="Gyro" value={`${(imu?.xgyro||0).toFixed(2)} ${(imu?.ygyro||0).toFixed(2)} ${(imu?.zgyro||0).toFixed(2)}`} />
          <Row label="温度" value={`${(imu?.temperature||0).toFixed(1)} °C`} />
        </SensorCard>
        <SensorCard title="磁力计" online={sensorHealth.mag === 'ok'}>
          <Row label="X / Y / Z" value={`${magData?.x||0} / ${magData?.y||0} / ${magData?.z||0}`} />
          <Row label="总量" value={`${Math.sqrt((magData?.x||0)**2+(magData?.y||0)**2+(magData?.z||0)**2).toFixed(0)} mgauss`} />
        </SensorCard>
        <SensorCard title="气压计" online={sensorHealth.baro === 'ok'}>
          <Row label="气压" value={`${(baro?.press_abs||0).toFixed(1)} hPa`} />
          <Row label="高度" value={`${(baro?.altitude||0).toFixed(1)} m`} />
          <Row label="温度" value={`${(baro?.temperature||0).toFixed(1)} °C`} />
        </SensorCard>
        <SensorCard title="光流" online={sensorHealth.opticalFlow === 'ok'}>
          <Row label="Flow" value={`${opticalFlow?.flow_x ?? '--'} / ${opticalFlow?.flow_y ?? '--'}`} />
          <Row label="质量" value={`${opticalFlow?.quality ?? '--'} / 255`} />
        </SensorCard>
        <SensorCard title="测距" online={sensorHealth.rangefinder === 'ok'}>
          <Row label="距离" value={`${distanceSensor?.current_distance ?? '--'} cm`} />
          <Row label="信号" value={`${distanceSensor?.signal_quality ?? '--'}%`} />
        </SensorCard>
        <SensorCard title="电池" online={sensorHealth.battery === 'ok'}>
          <Row label="电压" value={`${battery?.voltage.toFixed(2)||'--'} V`} />
          <Row label="电流" value={`${battery?.current.toFixed(2)||'--'} A`} />
          <Row label="剩余" value={`${battery?.remaining ?? '--'}%`} />
        </SensorCard>
      </div>
    </div>
  )
}
