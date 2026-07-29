import { useEffect, useState } from 'react'
import { CartesianGrid, Line, LineChart, ResponsiveContainer, XAxis, YAxis } from 'recharts'
import { vehicleCapabilities } from '../../shared/vehicleProfiles'
import Icon from '../components/ui/Icon'
import { PageTabs } from '../components/ui/PageFrame'
import { sendClientMessage } from '../hooks/useWebSocket'
import { useConnectionStore } from '../stores/connectionStore'
import { useSensorStore } from '../stores/sensorStore'
import { useTelemetryStore } from '../stores/telemetryStore'

const tabs = [{ id: 'imu', label: 'IMU' }, { id: 'mag', label: '罗盘' }, { id: 'baro', label: '气压计' }, { id: 'gps', label: 'GPS' }, { id: 'optflow', label: '光流' }, { id: 'rangefinder', label: '测距仪' }]
type CalibrationType = 'accel' | 'gyro' | 'mag' | 'baro'
type CalibrationStatus = 'sending' | 'running' | 'completed' | 'failed'
type CalibrationState = {
  type: CalibrationType
  requestId: string
  status: CalibrationStatus
  startedAt: number
  progress: number
  completedSteps: string[]
  message: string
}

const STANDARD_GRAVITY = 9.80665
const RADIANS_TO_DEGREES = 180 / Math.PI
const calibrationLabels: Record<CalibrationType, string> = {
  accel: '加速度计',
  gyro: '陀螺仪',
  mag: '罗盘',
  baro: '气压计',
}

const calibrationGuides: Record<CalibrationType, {
  preparation: string
  steps: Array<{ id: string; label: string; instruction: string }>
}> = {
  accel: {
    preparation: '拆除螺旋桨，将飞行器放在稳定、无振动的平面上。按飞控提示依次摆放六个方向，每次保持静止。',
    steps: [
      { id: 'down', label: '水平正放', instruction: '底部朝下，保持静止' },
      { id: 'left', label: '左侧朝下', instruction: '左侧贴近水平面，保持静止' },
      { id: 'right', label: '右侧朝下', instruction: '右侧贴近水平面，保持静止' },
      { id: 'front', label: '机头朝下', instruction: '机头垂直向下，保持静止' },
      { id: 'back', label: '机头朝上', instruction: '机头垂直向上，保持静止' },
      { id: 'up', label: '倒置', instruction: '顶部朝下，保持静止' },
    ],
  },
  gyro: {
    preparation: '拆除螺旋桨，把飞行器水平放稳。校准结束前不要移动或触碰飞行器。',
    steps: [{ id: 'still', label: '保持静止', instruction: '等待飞控采集陀螺仪零偏' }],
  },
  mag: {
    preparation: '远离磁铁、扬声器和大块金属。按飞控提示绕三个轴缓慢、连续旋转飞行器。',
    steps: [
      { id: 'roll', label: '横滚轴', instruction: '绕机身前后轴缓慢旋转' },
      { id: 'pitch', label: '俯仰轴', instruction: '绕机身左右轴缓慢旋转' },
      { id: 'yaw', label: '偏航轴', instruction: '绕机身垂直轴缓慢旋转' },
    ],
  },
  baro: {
    preparation: '保持飞行器静止，避免气流吹向气压计。',
    steps: [{ id: 'baro', label: '稳定采样', instruction: '等待飞控完成气压基准采样' }],
  },
}

const calibrationFailurePattern = /calibration\s+(?:failed|cancelled|canceled|error)|calibration.*denied|\[cal\].*(?:failed|cancelled|canceled)/i
const calibrationSuccessPattern = /calibration\s+(?:done|complete|completed|successful)|\[cal\].*(?:done|complete)/i

function applyCalibrationLogs(current: CalibrationState, logs: ReturnType<typeof useTelemetryStore.getState>['statusLogs']): CalibrationState {
  let next = current
  for (const entry of [...logs].reverse()) {
    if (entry.time < current.startedAt || !/(?:calibration|\[cal\])/i.test(entry.text)) continue
    const completedSteps = new Set(next.completedSteps)
    const orientation = entry.text.match(/orientation detected:\s*(back|front|left|right|up|down)/i)?.[1]?.toLowerCase()
    if (current.type === 'accel' && orientation) completedSteps.add(orientation)

    const progressMatch = entry.text.match(/(?:calibration\s+)?progress[^0-9]*(\d{1,3})\s*%?/i)
    const parsedProgress = progressMatch ? Math.min(100, Number(progressMatch[1])) : next.progress
    const status = calibrationFailurePattern.test(entry.text)
      ? 'failed'
      : calibrationSuccessPattern.test(entry.text)
        ? 'completed'
        : next.status === 'sending' ? 'running' : next.status
    next = {
      ...next,
      status,
      progress: status === 'completed' ? 100 : parsedProgress,
      completedSteps: status === 'completed'
        ? calibrationGuides[current.type].steps.map((step) => step.id)
        : [...completedSteps],
      message: entry.text,
    }
  }
  return next
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
  const hasCalibrationControl = useConnectionStore((state) => state.vehicleReady && state.canControl)
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
  const statusLogs = useTelemetryStore((state) => state.statusLogs)
  const armed = useTelemetryStore((state) => state.status?.armed ?? false)
  const lastCommandAck = useTelemetryStore((state) => state.lastCommandAck)
  const vehicleIdentity = useTelemetryStore((state) => state.vehicleIdentity)
  const caps = vehicleCapabilities(vehicleIdentity)
  // Calibration is capability-gated: unknown or untested vehicle profiles
  // must never receive MAV_CMD_PREFLIGHT_CALIBRATION.
  const canCalibrate = hasCalibrationControl && !armed && caps.calibrate
  const selectedImuInstance = imuIndex === 'imu2' ? 1 : 0
  const imu = imus[selectedImuInstance] ?? null

  useEffect(() => {
    if (!calibration || lastCommandAck?.requestId !== calibration.requestId) return
    setCalibration((current) => current ? {
      ...current,
      status: lastCommandAck.result === 0 || lastCommandAck.result === 5 ? 'running' : 'failed',
      progress: lastCommandAck.progress ?? current.progress,
      message: lastCommandAck.result === 0 || lastCommandAck.result === 5
        ? '飞控已接受校准指令，正在等待校准进度。'
        : `飞控拒绝校准指令（result=${lastCommandAck.result}）。`,
    } : null)
  }, [calibration?.requestId, lastCommandAck])

  useEffect(() => {
    setCalibration((current) => current ? applyCalibrationLogs(current, statusLogs) : null)
  }, [statusLogs])

  const startCalibration = (type: CalibrationType) => {
    if (!canCalibrate) return
    const params = [0, 0, 0, 0, 0, 0, 0]
    if (type === 'gyro') params[0] = 1
    if (type === 'mag') params[1] = 1
    if (type === 'baro') params[2] = 1
    if (type === 'accel') params[4] = 1
    const requestId = `cal-${type}-${Date.now().toString(36)}`
    const startedAt = Date.now()
    const sent = send({ type: 'command', requestId, cmd: 'MAV_CMD_PREFLIGHT_CALIBRATION', params })
    setCalibration({
      type,
      requestId,
      status: sent ? 'sending' : 'failed',
      startedAt,
      progress: 0,
      completedSteps: [],
      message: sent ? '校准指令已发送，正在等待飞控确认。' : 'WebSocket 未连接，校准指令未发送。',
    })
  }

  const calibrationWizard = calibration && (() => {
    const guide = calibrationGuides[calibration.type]
    const completed = new Set(calibration.completedSteps)
    if (calibration.type !== 'accel' && calibration.status !== 'failed') {
      const completedByProgress = Math.floor((calibration.progress * guide.steps.length) / 100)
      guide.steps.slice(0, completedByProgress).forEach((step) => completed.add(step.id))
    }
    const activeStep = guide.steps.findIndex((step) => !completed.has(step.id))
    const inferredProgress = guide.steps.length > 1
      ? Math.round((completed.size / guide.steps.length) * 100)
      : calibration.progress
    const progress = Math.max(calibration.progress, inferredProgress)
    return (
      <div className="mc-calibration-wizard" data-state={calibration.status} role="status" aria-live="polite">
        <header>
          <div>
            <strong>{calibrationLabels[calibration.type]}校准向导</strong>
            <span>{calibration.status === 'sending' ? '等待确认' : calibration.status === 'running' ? '校准进行中' : calibration.status === 'completed' ? '校准完成' : '校准失败'}</span>
          </div>
          <b className="mc-mono">{progress}%</b>
        </header>
        <p>{guide.preparation}</p>
        <div className="mc-calibration-progress" aria-label={`校准进度 ${progress}%`}><span style={{ width: `${progress}%` }} /></div>
        <ol>
          {guide.steps.map((step, index) => {
            const stepState = completed.has(step.id) || calibration.status === 'completed'
              ? 'completed'
              : calibration.status === 'failed' ? 'failed' : index === activeStep ? 'active' : 'pending'
            return <li key={step.id} data-state={stepState}><Icon name={stepState === 'completed' ? 'check' : stepState === 'failed' ? 'warning' : stepState === 'active' ? 'refresh' : 'pause'} size={15} /><div><strong>{step.label}</strong><span>{step.instruction}</span></div></li>
          })}
        </ol>
        <footer>
          <span>{calibration.message}</span>
          {(calibration.status === 'completed' || calibration.status === 'failed') && <button type="button" className="mc-btn mc-btn-ghost" onClick={() => setCalibration(null)}>关闭</button>}
        </footer>
      </div>
    )
  })()

  return (
    <div className={embedded ? 'mc-fade-in mc-data-workspace' : 'mc-workspace mc-fade-in mc-data-workspace'}>
      <PageTabs tabs={tabs} active={activeTab} onChange={(tab) => { setActiveTab(tab); setCalibration(null) }} />

      {!canCalibrate && (
        <div className="mc-capability-note" data-state="waiting">
          <Icon name="warning" size={15} />
          <span>{armed
            ? '飞行器已解锁，必须先安全上锁才能校准。'
            : hasCalibrationControl && !caps.calibrate
              ? '当前飞控类型尚未适配校准流程（仅支持 PX4 与 ArduCopter），校准按钮已禁用。'
              : '连接飞控并取得控制权后才可执行校准；实时监控仍保持只读。'}</span>
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
            {calibrationWizard}
          </section>
        </>
      )}

      {activeTab === 'mag' && (
        <>
          <SensorStatusCard title="罗盘" values={[["磁场 X", mag?.x.toFixed(2) ?? '—'], ["磁场 Y", mag?.y.toFixed(2) ?? '—'], ["磁场 Z", mag?.z.toFixed(2) ?? '—'], ["校准状态", mag ? '数据正常' : '等待数据']]} />
          <section className="mc-card mc-calibration-bar"><h2>罗盘校准</h2><div><button type="button" className="mc-btn mc-btn-primary" onClick={() => startCalibration('mag')} disabled={!canCalibrate || calibration !== null}>开始罗盘校准</button></div>{calibrationWizard}</section>
        </>
      )}
      {activeTab === 'baro' && (
        <>
          <SensorStatusCard title="气压计" values={[["绝对气压", baro ? `${baro.press_abs.toFixed(2)} hPa` : '—'], ["差压", baro ? `${baro.press_diff.toFixed(2)} hPa` : '—'], ["温度", baro?.temperature == null ? '—' : `${baro.temperature.toFixed(1)} °C`], ["气压高度", baro?.altitude == null ? '—' : `${baro.altitude.toFixed(1)} m`]]} />
          <section className="mc-card mc-calibration-bar"><h2>气压计校准</h2><div><button type="button" className="mc-btn mc-btn-primary" onClick={() => startCalibration('baro')} disabled={!canCalibrate || calibration !== null}>开始气压计校准</button></div>{calibrationWizard}</section>
        </>
      )}
      {activeTab === 'gps' && <SensorStatusCard title="GPS" values={[["定位类型", gps ? String(gps.fix_type) : '—'], ["卫星数量", gps ? String(gps.satellites_visible) : '—'], ["水平精度", gps ? String(gps.eph) : '—'], ["状态", gps && gps.fix_type >= 3 ? '定位正常' : '未定位']]} />}
      {activeTab === 'optflow' && <SensorStatusCard title="光流" values={[["Flow X", opticalFlow?.flow_x.toFixed(3) ?? '—'], ["Flow Y", opticalFlow?.flow_y.toFixed(3) ?? '—'], ["质量", opticalFlow ? `${opticalFlow.quality} / 255` : '—'], ["离地距离", opticalFlow?.ground_distance == null ? '—' : `${opticalFlow.ground_distance.toFixed(2)} m`]]} />}
      {activeTab === 'rangefinder' && <SensorStatusCard title="测距仪" values={[["当前距离", distance ? `${distance.current_distance} cm` : '—'], ["最小量程", distance ? `${distance.min_distance} cm` : '—'], ["最大量程", distance ? `${distance.max_distance} cm` : '—'], ["信号质量", distance ? String(distance.signal_quality) : '—']]} />}
    </div>
  )
}
