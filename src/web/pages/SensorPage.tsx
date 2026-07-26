import { useEffect, useState } from 'react'
import { CartesianGrid, Line, LineChart, ResponsiveContainer, XAxis, YAxis } from 'recharts'
import Icon from '../components/ui/Icon'
import { PageTabs } from '../components/ui/PageFrame'
import { sendClientMessage } from '../hooks/useWebSocket'
import { useConnectionStore } from '../stores/connectionStore'
import { useSensorStore } from '../stores/sensorStore'
import { useTelemetryStore } from '../stores/telemetryStore'

const tabs = [{ id: 'imu', label: 'IMU' }, { id: 'mag', label: '罗盘' }, { id: 'baro', label: '气压计' }, { id: 'gps', label: 'GPS' }, { id: 'optflow', label: '光流' }, { id: 'rangefinder', label: '测距仪' }]
type CalibrationType = 'accel' | 'gyro' | 'mag' | 'baro'
type CalibrationState = { type: CalibrationType; requestId: string; status: 'sending' | 'accepted' | 'failed' }

const STANDARD_GRAVITY = 9.80665
const RADIANS_TO_DEGREES = 180 / Math.PI
const calibrationLabels: Record<CalibrationType, string> = {
  accel: '加速度计',
  gyro: '陀螺仪',
  mag: '罗盘',
  baro: '气压计',
}

const displayImuValue = (kind: 'accel' | 'gyro', value: number) =>
  kind === 'accel' ? value * STANDARD_GRAVITY : value * RADIANS_TO_DEGREES

function SensorChart({ kind, instance }: { kind: 'accel' | 'gyro'; instance: number }) {
  const [data, setData] = useState<Array<{ t: number; x: number; y: number; z: number }>>([])
  useEffect(() => {
    setData([])
    const id = setInterval(() => {
      const imu = useSensorStore.getState().imus[instance]
      if (!imu) return
      setData((current) => [...current.slice(-89), {
        t: Date.now(),
        x: displayImuValue(kind, kind === 'accel' ? imu.xacc : imu.xgyro),
        y: displayImuValue(kind, kind === 'accel' ? imu.yacc : imu.ygyro),
        z: displayImuValue(kind, kind === 'accel' ? imu.zacc : imu.zgyro),
      }])
    }, 200)
    return () => clearInterval(id)
  }, [instance, kind])
  return (
    <ResponsiveContainer width="100%" height={165}>
      <LineChart data={data} margin={{ top: 10, right: 6, bottom: 0, left: -20 }}>
        <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
        <XAxis dataKey="t" hide />
        <YAxis stroke="var(--chart-axis)" tick={{ fontSize: 9 }} />
        <Line type="monotone" dataKey="x" stroke="#ef5d7a" dot={false} strokeWidth={1.4} isAnimationActive={false} />
        <Line type="monotone" dataKey="y" stroke="#35bf78" dot={false} strokeWidth={1.4} isAnimationActive={false} />
        <Line type="monotone" dataKey="z" stroke="#4c92ef" dot={false} strokeWidth={1.4} isAnimationActive={false} />
      </LineChart>
    </ResponsiveContainer>
  )
}

function AxisValue({ axis, value, color }: { axis: string; value: number | null; color: string }) {
  return <div className="mc-sensor-axis" style={{ '--axis-color': color } as React.CSSProperties}><span>{axis}</span><strong className="mc-mono">{value == null ? '—' : value.toFixed(2)}</strong></div>
}

function SensorStatusCard({ title, values }: { title: string; values: Array<[string, string]> }) {
  return <section className="mc-card mc-sensor-status-card"><h2>{title}</h2><div>{values.map(([label, value]) => <dl key={label}><dt>{label}</dt><dd className="mc-mono">{value}</dd></dl>)}</div></section>
}

export default function SensorPage({ embedded = false }: { embedded?: boolean }) {
  const [activeTab, setActiveTab] = useState('imu')
  const [imuIndex, setImuIndex] = useState('imu1')
  const [calibration, setCalibration] = useState<CalibrationState | null>(null)
  const send = sendClientMessage
  const canCalibrate = useConnectionStore((state) => state.vehicleReady && state.canControl)
  const [imus, setImus] = useState(() => useSensorStore.getState().imus)
  useEffect(() => {
    const timer = setInterval(() => setImus(useSensorStore.getState().imus), 200)
    return () => clearInterval(timer)
  }, [])
  const baro = useSensorStore((state) => state.baro)
  const mag = useSensorStore((state) => state.magData)
  const opticalFlow = useSensorStore((state) => state.opticalFlow)
  const distance = useSensorStore((state) => state.distanceSensor)
  const gps = useTelemetryStore((state) => state.gps)
  const lastCommandAck = useTelemetryStore((state) => state.lastCommandAck)
  const selectedImuInstance = imuIndex === 'imu2' ? 1 : 0
  const imu = imus[selectedImuInstance] ?? null

  useEffect(() => {
    if (!calibration || lastCommandAck?.requestId !== calibration.requestId) return
    setCalibration((current) => current ? {
      ...current,
      status: lastCommandAck.result === 0 ? 'accepted' : 'failed',
    } : null)
  }, [calibration?.requestId, lastCommandAck])

  const startCalibration = (type: CalibrationType) => {
    if (!canCalibrate) return
    const params = [0, 0, 0, 0, 0, 0, 0]
    if (type === 'gyro') params[0] = 1
    if (type === 'mag') params[1] = 1
    if (type === 'baro') params[2] = 1
    if (type === 'accel') params[4] = 1
    const requestId = `cal-${type}-${Date.now().toString(36)}`
    setCalibration({ type, requestId, status: 'sending' })
    send({ type: 'command', requestId, cmd: 'MAV_CMD_PREFLIGHT_CALIBRATION', params })
  }

  const calibrationNotice = calibration && (
    <p data-state={calibration.status}>
      <Icon name={calibration.status === 'failed' ? 'warning' : calibration.status === 'accepted' ? 'check' : 'refresh'} size={14} />
      {calibration.status === 'sending'
        ? `正在等待飞控确认${calibrationLabels[calibration.type]}校准指令…`
        : calibration.status === 'accepted'
          ? `飞控已接受${calibrationLabels[calibration.type]}校准，请按照飞控消息完成操作。`
          : `${calibrationLabels[calibration.type]}校准指令被拒绝，请查看底部飞控消息。`}
      <button type="button" className="mc-btn mc-btn-ghost" onClick={() => setCalibration(null)}>关闭提示</button>
    </p>
  )

  return (
    <div className={embedded ? 'mc-fade-in mc-data-workspace' : 'mc-workspace mc-fade-in mc-data-workspace'}>
      <PageTabs tabs={tabs} active={activeTab} onChange={(tab) => { setActiveTab(tab); setCalibration(null) }} />

      {!canCalibrate && (
        <div className="mc-capability-note" data-state="waiting">
          <Icon name="warning" size={15} />
          <span>连接飞控并取得控制权后才可执行校准；实时监控仍保持只读。</span>
        </div>
      )}

      {activeTab === 'imu' && (
        <>
          <div className="mc-sensor-subbar">
            <button type="button" data-active={imuIndex === 'imu1'} onClick={() => setImuIndex('imu1')}>IMU 1 {imus[0] ? '●' : '○'}</button>
            <button type="button" data-active={imuIndex === 'imu2'} onClick={() => setImuIndex('imu2')}>IMU 2 {imus[1] ? '●' : '○'}</button>
            <span>IMU安装方向</span>
            <select className="mc-select" aria-label="SENS_BOARD_ROT" defaultValue="none" disabled><option value="none">No rotation</option></select>
          </div>

          <div className="mc-sensor-chart-grid">
            <section className="mc-card mc-sensor-chart-card">
              <header><strong>加速度计</strong><span>m/s²</span></header>
              <div className="mc-sensor-axis-row"><AxisValue axis="X" value={imu ? displayImuValue('accel', imu.xacc) : null} color="#ef5d7a" /><AxisValue axis="Y" value={imu ? displayImuValue('accel', imu.yacc) : null} color="#35bf78" /><AxisValue axis="Z" value={imu ? displayImuValue('accel', imu.zacc) : null} color="#4c92ef" /></div>
              <SensorChart kind="accel" instance={selectedImuInstance} />
            </section>
            <section className="mc-card mc-sensor-chart-card">
              <header><strong>陀螺仪</strong><span>°/s</span></header>
              <div className="mc-sensor-axis-row"><AxisValue axis="X" value={imu ? displayImuValue('gyro', imu.xgyro) : null} color="#f28b35" /><AxisValue axis="Y" value={imu ? displayImuValue('gyro', imu.ygyro) : null} color="#a96fe7" /><AxisValue axis="Z" value={imu ? displayImuValue('gyro', imu.zgyro) : null} color="#22b8c7" /></div>
              <SensorChart kind="gyro" instance={selectedImuInstance} />
            </section>
          </div>

          <section className="mc-card mc-calibration-bar">
            <h2>校准</h2>
            <div><button type="button" className="mc-btn mc-btn-primary" onClick={() => startCalibration('accel')} disabled={!canCalibrate || calibration !== null}>校准加速度计</button><button type="button" className="mc-btn mc-btn-primary" onClick={() => startCalibration('gyro')} disabled={!canCalibrate || calibration !== null}>校准陀螺仪</button></div>
            {calibrationNotice}
          </section>
        </>
      )}

      {activeTab === 'mag' && (
        <>
          <SensorStatusCard title="罗盘" values={[["磁场 X", mag?.x.toFixed(2) ?? '—'], ["磁场 Y", mag?.y.toFixed(2) ?? '—'], ["磁场 Z", mag?.z.toFixed(2) ?? '—'], ["校准状态", mag ? '数据正常' : '等待数据']]} />
          <section className="mc-card mc-calibration-bar"><h2>罗盘校准</h2><div><button type="button" className="mc-btn mc-btn-primary" onClick={() => startCalibration('mag')} disabled={!canCalibrate || calibration !== null}>开始罗盘校准</button></div>{calibrationNotice}</section>
        </>
      )}
      {activeTab === 'baro' && (
        <>
          <SensorStatusCard title="气压计" values={[["绝对气压", baro ? `${baro.press_abs.toFixed(2)} hPa` : '—'], ["差压", baro ? `${baro.press_diff.toFixed(2)} hPa` : '—'], ["温度", baro ? `${baro.temperature.toFixed(1)} °C` : '—'], ["气压高度", baro?.altitude == null ? '—' : `${baro.altitude.toFixed(1)} m`]]} />
          <section className="mc-card mc-calibration-bar"><h2>气压计校准</h2><div><button type="button" className="mc-btn mc-btn-primary" onClick={() => startCalibration('baro')} disabled={!canCalibrate || calibration !== null}>开始气压计校准</button></div>{calibrationNotice}</section>
        </>
      )}
      {activeTab === 'gps' && <SensorStatusCard title="GPS" values={[["定位类型", gps ? String(gps.fix_type) : '—'], ["卫星数量", gps ? String(gps.satellites_visible) : '—'], ["水平精度", gps ? String(gps.eph) : '—'], ["状态", gps && gps.fix_type >= 3 ? '定位正常' : '未定位']]} />}
      {activeTab === 'optflow' && <SensorStatusCard title="光流" values={[["Flow X", opticalFlow?.flow_x.toFixed(3) ?? '—'], ["Flow Y", opticalFlow?.flow_y.toFixed(3) ?? '—'], ["质量", opticalFlow ? `${opticalFlow.quality} / 255` : '—'], ["离地距离", opticalFlow?.ground_distance == null ? '—' : `${opticalFlow.ground_distance.toFixed(2)} m`]]} />}
      {activeTab === 'rangefinder' && <SensorStatusCard title="测距仪" values={[["当前距离", distance ? `${distance.current_distance} cm` : '—'], ["最小量程", distance ? `${distance.min_distance} cm` : '—'], ["最大量程", distance ? `${distance.max_distance} cm` : '—'], ["信号质量", distance ? String(distance.signal_quality) : '—']]} />}
    </div>
  )
}
