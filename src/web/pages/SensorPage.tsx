import { useEffect, useMemo, useState } from 'react'
import { CartesianGrid, Line, LineChart, ResponsiveContainer, XAxis, YAxis } from 'recharts'
import {
  supportsCalibrationKind,
  vehicleCapabilities,
  type CalibrationKind,
} from '../../shared/vehicleProfiles'
import type {
  AccelCalibrationPosition,
  CalibrationSide,
  CalibrationSnapshot,
  OpticalFlowData,
} from '../../shared/types'
import { boardOrientationField } from '../utils/parameterProfiles'
import { magFitnessRating, magOffsetMagnitude, magOffsetWarning } from '../utils/magCalibrationQuality'
import type { MagInterferenceReading } from '../utils/magInterference'
import Icon, { type IconName } from '../components/ui/Icon'
import { PageTabs } from '../components/ui/PageFrame'
import AccelOrientationVisual from '../components/sensors/AccelOrientationVisual'
import GpsConfigurationPanel from '../components/sensors/GpsConfigurationPanel'
import GpsTrackPlot from '../components/sensors/GpsTrackPlot'
import { sendClientMessage } from '../hooks/useWebSocket'
import { useCalibrationStore } from '../stores/calibrationStore'
import { useConnectionStore } from '../stores/connectionStore'
import { useParameterStore } from '../stores/parameterStore'
import { useSensorStore } from '../stores/sensorStore'
import { useTelemetryStore } from '../stores/telemetryStore'
import { gpsFixLabel } from '../utils/gpsTelemetry'

const tabs = [{ id: 'imu', label: 'IMU' }, { id: 'mag', label: '罗盘' }, { id: 'baro', label: '气压计' }, { id: 'gps', label: 'GPS' }, { id: 'optflow', label: '光流' }, { id: 'rangefinder', label: '测距仪' }]

const STANDARD_GRAVITY = 9.80665
const RADIANS_TO_DEGREES = 180 / Math.PI
const CALIBRATION_START_TIMEOUT_MS = 8_000

const calibrationLabels: Record<CalibrationKind, string> = {
  accel: '加速度计',
  accel_simple: '简易加速度计',
  gyro: '陀螺仪',
  mag: '罗盘',
  baro: '气压计',
  level: '水平',
}

const calibrationPreparation: Record<CalibrationKind, string> = {
  accel: '拆除螺旋桨，将飞行器放在稳定平面上。按飞控提示依次摆放六个方向，每次保持静止。',
  accel_simple: '拆除螺旋桨，将飞行器水平放稳。简易校准只采样当前姿态，无需翻面。',
  gyro: '拆除螺旋桨，把飞行器水平放稳。校准结束前不要移动或触碰飞行器。',
  mag: '远离磁铁、扬声器和大块金属。按飞控提示绕三个轴缓慢、连续旋转飞行器。',
  baro: '保持飞行器静止，避免气流吹向气压计。',
  level: '拆除螺旋桨，把飞行器放在真正水平的表面上，校准期间不要触碰。',
}

const calibrationCatalog: Array<{
  kind: CalibrationKind
  title: string
  icon: IconName
}> = [
  { kind: 'accel', title: '六面加速度计', icon: 'sensor' },
  { kind: 'gyro', title: '陀螺仪零偏', icon: 'waveform' },
  { kind: 'mag', title: '罗盘', icon: 'refresh' },
  { kind: 'level', title: '水平基准', icon: 'altitude' },
  { kind: 'baro', title: '气压计', icon: 'altitude' },
]

// Wizard render order and human labels for the six calibration orientations.
const SIDE_ORDER: CalibrationSide[] = ['down', 'left', 'right', 'front', 'back', 'up']
const SIDE_LABELS: Record<CalibrationSide, { label: string; instruction: string }> = {
  down: { label: '水平正放', instruction: '底部朝下，保持静止' },
  up: { label: '倒置', instruction: '顶部朝下，保持静止' },
  left: { label: '左侧朝下', instruction: '左侧贴近水平面，保持静止' },
  right: { label: '右侧朝下', instruction: '右侧贴近水平面，保持静止' },
  front: { label: '机头朝下', instruction: '机头垂直向下，保持静止' },
  back: { label: '机头朝上', instruction: '机头垂直向上，保持静止' },
}

export const calibrationSideInstruction = (kind: CalibrationKind, side: CalibrationSide): string =>
  kind === 'mag'
    ? `保持${SIDE_LABELS[side].label}，按箭头方向绕竖直轴缓慢、连续旋转`
    : SIDE_LABELS[side].instruction

const SIDE_STATE_LABELS = {
  pending: '未开始',
  active: '正在进行',
  done: '已完成',
  hidden: '不需要',
} as const

// ArduPilot ACCELCAL_VEHICLE_POS (1..6) -> the orientation the user must hold.
const POSITION_SIDE: Record<AccelCalibrationPosition, CalibrationSide> = {
  1: 'down', 2: 'left', 3: 'right', 4: 'front', 5: 'back', 6: 'up',
}

/** The latest FC-requested or actively sampled side, kept visible between phases. */
export const resolveAccelGuideSide = (snapshot: CalibrationSnapshot): CalibrationSide | null => {
  if (snapshot.requestedPosition) return POSITION_SIDE[snapshot.requestedPosition]
  return SIDE_ORDER.find((side) => snapshot.sides?.[side] === 'active') ?? null
}

const phaseLabel = (snapshot: CalibrationSnapshot): string => {
  switch (snapshot.phase) {
    case 'starting': return '等待飞控确认'
    case 'running': return '校准进行中'
    case 'waiting_position': return '请摆放到指定方向'
    case 'awaiting_accept': return '等待确认校准结果'
    case 'accepted': return snapshot.verification === 'ack_only' ? '飞控已接受（未独立验证）' : '已接受'
    case 'done': return '校准完成'
    case 'failed': return '校准失败'
    case 'cancelled': return '校准已取消'
  }
}

const displayImuValue = (kind: 'accel' | 'gyro', value: number) =>
  kind === 'accel' ? value * STANDARD_GRAVITY : value * RADIANS_TO_DEGREES

type LiveChartPoint = { t: number } & Record<string, number | null>
type LiveChartSeries = { key: string; label: string; color: string; axis?: 'left' | 'right' }

const finiteNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

const formatFinite = (value: number | null, digits: number, unit = ''): string =>
  value === null ? '—' : `${value.toFixed(digits)}${unit}`

export interface OpticalFlowDisplayFrame {
  source: 'OPTICAL_FLOW' | 'OPTICAL_FLOW_RAD'
  flowX: number | null
  flowY: number | null
}

/**
 * Normalizes live and legacy optical-flow payloads before rendering. This
 * deliberately accepts partial frames so reconnect/HMR state or a dialect
 * without RAD extension fields cannot crash the whole sensor workspace.
 */
export const normalizeOpticalFlow = (
  data: Partial<OpticalFlowData> | null,
): OpticalFlowDisplayFrame | null => {
  if (!data) return null
  const hasRadTiming = (finiteNumber(data.integration_time_us) ?? 0) > 0
  const source = data.source ?? (hasRadTiming ? 'OPTICAL_FLOW_RAD' : 'OPTICAL_FLOW')
  const isRad = source === 'OPTICAL_FLOW_RAD'
  return {
    source,
    flowX: finiteNumber(isRad ? data.integrated_x_rad : data.flow_x),
    flowY: finiteNumber(isRad ? data.integrated_y_rad : data.flow_y),
  }
}

/** Append one real telemetry frame. A missing frame leaves history untouched. */
export const appendLiveSample = (
  current: LiveChartPoint[],
  values: Record<string, number | null> | null,
  now = Date.now(),
  maxPoints = 90,
): LiveChartPoint[] => values === null
  ? current
  : [...current.slice(-(maxPoints - 1)), { t: now, ...values }]

function LiveSensorChart({
  sample,
  values,
  series,
  resetKey,
  height = 165,
}: {
  sample: object | null
  values: Record<string, number | null> | null
  series: LiveChartSeries[]
  resetKey?: string | number
  height?: number
}) {
  const [data, setData] = useState<LiveChartPoint[]>([])
  const axes = Array.from(new Set(series.map((item) => item.axis ?? 'left')))
  useEffect(() => {
    setData([])
  }, [resetKey])
  useEffect(() => {
    if (!sample || !values) return
    setData((current) => appendLiveSample(current, values))
    // `sample` is the store-owned frame identity. Other page renders must not
    // duplicate its values into the chart merely because `values` is rebuilt.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sample])
  return (
    <div className="mc-live-chart" data-empty={data.length === 0 || undefined}>
      {data.length === 0 && <span>等待实时数据</span>}
      <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 10, right: axes.includes('right') ? 0 : 6, bottom: 0, left: axes.includes('right') ? 0 : -20 }}>
        <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
        <XAxis dataKey="t" hide />
        {axes.map((axis) => {
          const axisSeries = series.find((item) => (item.axis ?? 'left') === axis)
          return <YAxis key={axis} yAxisId={axis} orientation={axis} stroke={axisSeries?.color ?? 'var(--chart-axis)'} tick={{ fontSize: 9 }} width={38} />
        })}
        {series.map((item) => (
          <Line key={item.key} name={item.label} yAxisId={item.axis ?? 'left'} type="monotone" dataKey={item.key} stroke={item.color} dot={false} strokeWidth={1.4} isAnimationActive={false} connectNulls={false} />
        ))}
      </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

const xyzSeries: LiveChartSeries[] = [
  { key: 'x', label: 'X', color: 'var(--chart-4)' },
  { key: 'y', label: 'Y', color: 'var(--chart-2)' },
  { key: 'z', label: 'Z', color: 'var(--info)' },
]
const pressureSeries: LiveChartSeries[] = [
  { key: 'absolute', label: '绝对气压', color: 'var(--accent)', axis: 'left' },
  { key: 'differential', label: '差压', color: 'var(--warning)', axis: 'right' },
]
const altitudeTemperatureSeries: LiveChartSeries[] = [
  { key: 'altitude', label: '气压高度', color: 'var(--info)', axis: 'left' },
  { key: 'temperature', label: '温度', color: 'var(--warning)', axis: 'right' },
]
const flowSeries: LiveChartSeries[] = [
  { key: 'x', label: '光流 X', color: 'var(--chart-4)' },
  { key: 'y', label: '光流 Y', color: 'var(--chart-2)' },
]

function SensorChart({ kind, instance, imu }: { kind: 'accel' | 'gyro'; instance: number; imu: ReturnType<typeof useSensorStore.getState>['imu'] }) {
  const values = imu ? {
    x: displayImuValue(kind, kind === 'accel' ? imu.xacc : imu.xgyro),
    y: displayImuValue(kind, kind === 'accel' ? imu.yacc : imu.ygyro),
    z: displayImuValue(kind, kind === 'accel' ? imu.zacc : imu.zgyro),
  } : null
  return <LiveSensorChart sample={imu} values={values} series={xyzSeries} resetKey={`${kind}-${instance}`} />
}

function SensorWaveform({
  title,
  unit,
  sample,
  values,
  series,
  resetKey,
  height,
  className = '',
}: {
  title: string
  unit: string
  sample: object | null
  values: Record<string, number | null> | null
  series: LiveChartSeries[]
  resetKey?: string | number
  height?: number
  className?: string
}) {
  return (
    <section className={`mc-card mc-sensor-chart-card ${className}`.trim()}>
      <header><strong>{title}</strong><span>{unit}</span></header>
      <div className="mc-chart-legend">
        {series.map((item) => <span key={item.key} style={{ '--series-color': item.color } as React.CSSProperties}>{item.label}{item.axis && <small>{item.axis === 'left' ? '左轴' : '右轴'}</small>}</span>)}
      </div>
      <LiveSensorChart sample={sample} values={values} series={series} resetKey={resetKey} height={height} />
    </section>
  )
}

const dopQualityPercent = (value: number | null | undefined): number => value == null
  ? 0
  : Math.max(0, Math.min(100, ((6 - value) / 6) * 100))

function GpsMetric({ label, value, state }: { label: string; value: string; state?: string }) {
  return (
    <div className="mc-gps-metric" data-state={state}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

function DopMeter({ label, value }: { label: string; value: number | null | undefined }) {
  const percent = dopQualityPercent(value)
  return (
    <div className="mc-gps-dop__meter">
      <span><strong>{label}</strong><b className="mc-mono">{value == null ? '—' : value.toFixed(2)}</b></span>
      <div><i style={{ width: `${percent}%` }} /></div>
    </div>
  )
}

function AxisValue({ axis, value, color }: { axis: string; value: number | null; color: string }) {
  return <div className="mc-sensor-axis" style={{ '--axis-color': color } as React.CSSProperties}><span>{axis}</span><strong className="mc-mono">{value == null ? '—' : value.toFixed(2)}</strong></div>
}

function SensorStatusCard({ title, values }: { title: string; values: Array<[string, string]> }) {
  return <section className="mc-card mc-sensor-status-card"><header><span className="mc-eyebrow">LIVE TELEMETRY</span><h2>{title}</h2></header><div>{values.map(([label, value]) => <dl key={label}><dt>{label}</dt><dd className="mc-mono">{value}</dd></dl>)}</div></section>
}

export const isCalibrationSessionActive = (snapshot: CalibrationSnapshot | null): boolean => Boolean(snapshot
  && snapshot.phase !== 'done' && snapshot.phase !== 'failed'
  && snapshot.phase !== 'cancelled' && snapshot.phase !== 'accepted')

export const shouldShowCalibrationWizard = (
  snapshot: CalibrationSnapshot | null,
  dismissedSessionId: string | null,
): boolean => Boolean(snapshot && (isCalibrationSessionActive(snapshot) || snapshot.sessionId !== dismissedSessionId))

export const canRequestCalibrationExit = (
  snapshot: CalibrationSnapshot | null,
  isOwner: boolean,
): boolean => Boolean(snapshot && isOwner && isCalibrationSessionActive(snapshot))

export const calibrationAvailabilityReason = ({
  vehicleReady,
  supported,
  sessionActive,
  enabled,
}: {
  vehicleReady: boolean
  supported: boolean
  sessionActive: boolean
  enabled: boolean
}): string => !vehicleReady
  ? '等待连接飞控'
  : !supported
    ? '当前机型不支持'
    : sessionActive
      ? '已有校准任务进行中'
      : !enabled
        ? '安全条件未满足'
        : '可以开始'

export const calibrationResultNotice = (
  snapshot: CalibrationSnapshot,
): { state: 'success' | 'info' | 'warning' | 'error'; title: string; detail: string } | null => {
  const name = calibrationLabels[snapshot.kind]
  if (snapshot.phase === 'done') {
    return { state: 'success', title: `${name}校准成功`, detail: '飞控已确认校准完成。' }
  }
  if (snapshot.phase === 'accepted') {
    return {
      state: 'info',
      title: `${name}校准命令已接受`,
      detail: snapshot.verification === 'ack_only'
        ? '飞控未提供独立的结果遥测；这不是失败，但当前结果无法进一步核验。'
        : '飞控已接受校准结果。',
    }
  }
  if (snapshot.phase === 'failed') {
    return { state: 'error', title: `${name}校准失败`, detail: snapshot.failureReason ?? '飞控未能完成本次校准。' }
  }
  if (snapshot.phase === 'cancelled') {
    return { state: 'warning', title: `${name}校准已取消`, detail: snapshot.failureReason ?? '本次校准未保存。' }
  }
  return null
}

export const resolveCalibrationProgress = (
  snapshot: CalibrationSnapshot,
  visibleSideCount: number,
  doneSideCount: number,
): number | null => {
  if (snapshot.progress != null) return snapshot.progress
  if (visibleSideCount > 0) return Math.round((doneSideCount / visibleSideCount) * 100)
  if (snapshot.phase === 'done' || snapshot.phase === 'accepted') return 100
  // ArduPilot gyro/level/barometer are one-shot commands: firmware exposes
  // activity/final ACKs but no truthful intermediate percentage.
  return null
}

export const magPrecheckStatus = (
  reading: MagInterferenceReading | null,
  source: { unit: 'mgauss' | 'raw' } | null = null,
): { state: 'good' | 'high' | 'unavailable'; text: string } => {
  if (!reading) {
    return source?.unit === 'raw'
      ? { state: 'unavailable', text: '无法判断 · 仅原始数据' }
      : { state: 'unavailable', text: '等待实时磁场数据' }
  }
  const value = `${reading.fieldGauss.toFixed(2)} G`
  return reading.warning
    ? { state: 'high', text: `干扰偏大 · ${value}` }
    : { state: 'good', text: `干扰较低 · ${value}` }
}

function HealthPill({ state, label }: { state: 'ok' | 'warning' | 'error' | 'offline'; label: string }) {
  const stateLabel = state === 'ok' ? '正常' : state === 'warning' ? '注意' : state === 'error' ? '异常' : '离线'
  return <span className="mc-sensor-health" data-state={state}><i aria-hidden="true" /><span>{label}</span><strong>{stateLabel}</strong></span>
}

function CalibrationTaskCard({
  item,
  vehicleReady,
  supported,
  enabled,
  sessionActive,
  magInterference,
  magSource,
  onStart,
}: {
  item: (typeof calibrationCatalog)[number]
  vehicleReady: boolean
  supported: boolean
  enabled: boolean
  sessionActive: boolean
  magInterference: MagInterferenceReading | null
  magSource: { unit: 'mgauss' | 'raw'; ts: number } | null
  onStart: (kind: CalibrationKind) => void
}) {
  const unavailable = !supported || !enabled || sessionActive
  const reason = calibrationAvailabilityReason({ vehicleReady, supported, sessionActive, enabled })
  const magPrecheck = magPrecheckStatus(magInterference, magSource)
  return (
    <article className="mc-calibration-task" data-disabled={unavailable}>
      <div className="mc-calibration-task__icon"><Icon name={item.icon} size={19} /></div>
      <div className="mc-calibration-task__body">
        <header><h3>{item.title}</h3><span data-ready={!unavailable}>{reason}</span></header>
        {item.kind === 'mag' && (
          <div className="mc-mag-precheck" data-state={magPrecheck.state}>
            <strong>{magPrecheck.text}</strong>
          </div>
        )}
        <footer><button type="button" className="mc-btn mc-btn-ghost" disabled={unavailable} onClick={() => onStart(item.kind)}>开始 <Icon name="arrowRight" size={14} /></button></footer>
      </div>
    </article>
  )
}

/**
 * Calibration wizard rendered entirely from the server snapshot. It carries no
 * protocol logic: sides, progress, verification and failure text come from the
 * idempotent CalibrationSnapshot so page remounts and reconnects are seamless.
 */
function CalibrationWizard({
  snapshot,
  isOwner,
  onCancel,
  onConfirmPosition,
  onAcceptMag,
  onRestart,
  restartEnabled,
  onClose,
}: {
  snapshot: CalibrationSnapshot
  isOwner: boolean
  onCancel: () => void
  onConfirmPosition: (position: AccelCalibrationPosition) => void
  onAcceptMag: () => void
  onRestart: () => void
  restartEnabled: boolean
  onClose: () => void
}) {
  const terminal = snapshot.phase === 'done' || snapshot.phase === 'failed'
    || snapshot.phase === 'cancelled' || snapshot.phase === 'accepted'
  const visibleSides = SIDE_ORDER.filter((side) => snapshot.sides && snapshot.sides[side] !== 'hidden')
  const doneSides = visibleSides.filter((side) => snapshot.sides?.[side] === 'done').length
  const progress = resolveCalibrationProgress(snapshot, visibleSides.length, doneSides)
  const indeterminate = progress === null && !terminal
  const requestedSide = snapshot.requestedPosition ? POSITION_SIDE[snapshot.requestedPosition] : null
  const guideSide = resolveAccelGuideSide(snapshot)
  const resultNotice = calibrationResultNotice(snapshot)
  const positionNeedsConfirmation = snapshot.family === 'ardupilot'
    && snapshot.phase === 'waiting_position'
    && snapshot.requestedPosition != null
  const accelGuideText = terminal
    ? snapshot.phase === 'done' || snapshot.phase === 'accepted'
      ? { title: '六个方向已完成', detail: '飞控已记录本次方向采样；可检查结果或重新校准。' }
      : { title: '方向采样已停止', detail: '请根据上方结果处理后重新开始校准。' }
    : guideSide
      ? positionNeedsConfirmation
        ? { title: `请摆放为：${SIDE_LABELS[guideSide].label}`, detail: `${SIDE_LABELS[guideSide].instruction}，稳定后确认此方向。` }
        : {
            title: `保持：${SIDE_LABELS[guideSide].label}`,
            detail: snapshot.family === 'px4'
              ? '飞控正在自动识别并采样，无需手动确认。'
              : '飞控正在采样，请保持静止。',
          }
      : {
          title: '等待飞控下发方向',
          detail: snapshot.family === 'px4'
            ? 'PX4 会自动识别摆放方向，无需手动确认。'
            : '收到方向请求后，确认按钮会固定显示在这里。',
        }
  const magGuideText = guideSide
    ? {
        title: `旋转：${SIDE_LABELS[guideSide].label}`,
        detail: calibrationSideInstruction('mag', guideSide),
      }
    : {
        title: '选择任一未完成方向',
        detail: '先让该面朝下；飞控识别后，按图中箭头缓慢、连续旋转。',
      }

  return (
    <div className="mc-calibration-wizard" data-state={snapshot.phase} role="status" aria-live="polite">
      <header>
        <div>
          <strong>{calibrationLabels[snapshot.kind]}校准向导</strong>
          <span>{phaseLabel(snapshot)}</span>
        </div>
        <b className="mc-mono">{progress === null ? (indeterminate ? '处理中' : '—') : `${progress}%`}</b>
      </header>
      <p>{calibrationPreparation[snapshot.kind]}</p>
      {resultNotice && (
        <div className="mc-calibration-result" data-state={resultNotice.state} role="alert">
          <span className="mc-calibration-result__icon">
            <Icon name={resultNotice.state === 'success' || resultNotice.state === 'info' ? 'check' : 'warning'} size={18} />
          </span>
          <div><strong>{resultNotice.title}</strong><span>{resultNotice.detail}</span></div>
        </div>
      )}
      {!isOwner && !terminal && (
        <div className="mc-capability-note" data-state="waiting">
          <Icon name="warning" size={14} />
          <span>其他客户端正在执行该校准，你处于观察模式。</span>
        </div>
      )}
      {snapshot.protocolDegraded && (
        <div className="mc-capability-note" data-state="waiting">
          <Icon name="warning" size={14} />
          <span>飞控校准协议版本未知，方向指引不可用，仅显示进度。</span>
        </div>
      )}
      <div
        className="mc-calibration-progress"
        data-indeterminate={indeterminate || undefined}
        role="progressbar"
        aria-label={indeterminate ? '校准处理中，飞控未提供百分比' : `校准进度 ${progress ?? 0}%`}
        aria-valuemin={0}
        aria-valuemax={100}
        {...(progress === null ? {} : { 'aria-valuenow': progress })}
      >
        <span style={progress === null ? undefined : { width: `${progress}%` }} />
      </div>

      {snapshot.kind === 'accel' && visibleSides.length > 0 && (
        <div className="mc-calibration-position" data-side={guideSide ?? undefined} data-waiting={positionNeedsConfirmation || undefined}>
          <Icon name="refresh" size={16} />
          <div>
            <strong>{accelGuideText.title}</strong>
            <span>{accelGuideText.detail}</span>
          </div>
          {isOwner && positionNeedsConfirmation && requestedSide && (
            <button type="button" className="mc-btn mc-btn-primary" onClick={() => onConfirmPosition(snapshot.requestedPosition!)}>
              确认此方向
            </button>
          )}
        </div>
      )}

      {snapshot.kind === 'mag' && visibleSides.length > 0 && (
        <div className="mc-calibration-position" data-side={guideSide ?? undefined}>
          <Icon name="refresh" size={16} />
          <div>
            <strong>{magGuideText.title}</strong>
            <span>{magGuideText.detail}</span>
          </div>
        </div>
      )}

      {visibleSides.length > 0 && (
        <ol className="mc-calibration-sides">
          {visibleSides.map((side) => {
            const state = snapshot.sides?.[side] ?? 'pending'
            const instruction = calibrationSideInstruction(snapshot.kind, side)
            return (
              <li
                key={side}
                data-state={state}
                aria-label={`${SIDE_LABELS[side].label}，${instruction}，${SIDE_STATE_LABELS[state]}`}
                title={instruction}
              >
                <AccelOrientationVisual
                  side={side}
                  label={SIDE_LABELS[side].label}
                  instruction={instruction}
                  usePx4MagRotationImage={snapshot.family === 'px4' && snapshot.kind === 'mag'}
                />
                <div className="mc-calibration-side-copy">
                  <span className="mc-calibration-side-state">
                    <i aria-hidden="true" />
                    {SIDE_STATE_LABELS[state]}
                  </span>
                  <strong>{SIDE_LABELS[side].label}</strong>
                </div>
              </li>
            )
          })}
        </ol>
      )}

      {snapshot.magInstances && snapshot.magInstances.length > 0 && (
        <div className="mc-mag-report">
          {snapshot.magInstances.map((instance) => {
            const rating = instance.report ? magFitnessRating(instance.report.fitness) : null
            const offsetWarn = instance.report ? magOffsetWarning(instance.report.ofs) : false
            return (
              <div key={instance.id} className="mc-mag-report-item" data-rating={rating?.level ?? 'pending'}>
                <header>
                  <strong>罗盘 {instance.id + 1}</strong>
                  <span className="mc-mono">{instance.pct}%</span>
                </header>
                {instance.report ? (
                  <dl>
                    <div><dt>拟合度</dt><dd className="mc-mono">{instance.report.fitness.toFixed(1)}{rating ? ` · ${rating.label}` : ''}</dd></div>
                    <div><dt>校准偏置</dt><dd className="mc-mono" data-warn={offsetWarn}>{magOffsetMagnitude(instance.report.ofs).toFixed(0)} mGauss</dd></div>
                    <div><dt>保存</dt><dd>{instance.report.autosaved ? '已保存' : '待确认'}</dd></div>
                  </dl>
                ) : <span className="mc-mag-report-progress">采集中…</span>}
                {offsetWarn && <span className="mc-mag-report-warn">校准偏置过大，请检查附近磁源和罗盘安装</span>}
              </div>
            )
          })}
        </div>
      )}
      {snapshot.phase === 'awaiting_accept' && isOwner && (
        <div className="mc-calibration-position">
          <Icon name="check" size={16} />
          <div>
            <strong>校准数据已就绪</strong>
            <span>确认接受后写入并需要重启飞控生效。</span>
          </div>
          <button type="button" className="mc-btn mc-btn-primary" onClick={onAcceptMag}>接受并保存</button>
        </div>
      )}

      {snapshot.rebootRequired && (
        <div className="mc-capability-note" data-state="waiting">
          <Icon name="warning" size={14} />
          <span>校准结果需要重启飞控后才能生效。</span>
        </div>
      )}

      <footer>
        {!resultNotice && <span>{phaseLabel(snapshot)}</span>}
        {terminal && (
          <div className="mc-calibration-footer-actions">
            <button type="button" className="mc-btn mc-btn-primary" disabled={!restartEnabled} onClick={onRestart}>
              <Icon name="refresh" size={14} />重新校准
            </button>
            <button type="button" className="mc-btn mc-btn-ghost" onClick={onClose}>关闭</button>
          </div>
        )}
      </footer>
    </div>
  )
}

export default function SensorPage({ embedded = false }: { embedded?: boolean }) {
  const [activeTab, setActiveTab] = useState('imu')
  const [imuIndex, setImuIndex] = useState('imu1')
  // Terminal results may be dismissed locally. A live server session must
  // always remain visible so the page cannot enter a hidden-but-busy state.
  const [dismissedSessionId, setDismissedSessionId] = useState<string | null>(null)
  const [pendingStart, setPendingStart] = useState<{ requestId: string; kind: CalibrationKind } | null>(null)
  const [startFailure, setStartFailure] = useState<{ kind: CalibrationKind; message: string } | null>(null)
  const send = sendClientMessage
  const vehicleReady = useConnectionStore((state) => state.vehicleReady)
  const hasCalibrationControl = useConnectionStore((state) => state.vehicleReady && state.canControl)
  const clientId = useConnectionStore((state) => state.clientId)
  const snapshot = useCalibrationStore((state) => state.snapshot)
  const imus = useSensorStore((state) => state.imus)
  const baro = useSensorStore((state) => state.baro)
  const mag = useSensorStore((state) => state.magData)
  const magInterference = useSensorStore((state) => state.magInterference)
  const magSource = useSensorStore((state) => state.magSource)
  const opticalFlow = useSensorStore((state) => state.opticalFlow)
  const opticalFlowFrame = useMemo(() => normalizeOpticalFlow(opticalFlow), [opticalFlow])
  const distance = useSensorStore((state) => state.distanceSensor)
  const sensorHealth = useSensorStore((state) => state.sensorHealth)
  const gps = useTelemetryStore((state) => state.gps)
  const armed = useTelemetryStore((state) => state.status?.armed ?? false)
  const vehicleIdentity = useTelemetryStore((state) => state.vehicleIdentity)
  const lastOperationError = useTelemetryStore((state) => state.lastOperationError)
  const caps = vehicleCapabilities(vehicleIdentity)
  // Board orientation binds to the profile parameter: PX4 SENS_BOARD_ROT or
  // ArduPilot AHRS_ORIENTATION. A wrong orientation is flight-critical.
  const orientationField = boardOrientationField(vehicleIdentity)
  const orientationParam = useParameterStore(
    (state) => orientationField ? state.params.get(orientationField.id) : undefined,
  )
  const canCalibrate = hasCalibrationControl && !armed && caps.calibrate
  const canCalibrateKind = (type: CalibrationKind) => canCalibrate && supportsCalibrationKind(vehicleIdentity, type)
  const selectedImuInstance = imuIndex === 'imu2' ? 1 : 0
  const imu = imus[selectedImuInstance] ?? null

  // A session is "live" (blocks new starts) while it exists and is not terminal.
  const sessionActive = isCalibrationSessionActive(snapshot)
  const calibrationBusy = sessionActive || pendingStart !== null
  const wizardVisible = shouldShowCalibrationWizard(snapshot, dismissedSessionId)
  const isOwner = useMemo(() => Boolean(clientId && snapshot && snapshot.ownerClientId === clientId), [clientId, snapshot])
  useEffect(() => {
    if (pendingStart && snapshot?.requestId === pendingStart.requestId) {
      setPendingStart(null)
      setStartFailure(null)
    }
  }, [pendingStart, snapshot])

  useEffect(() => {
    if (
      !pendingStart
      || lastOperationError?.operation !== 'start_calibration'
      || lastOperationError.requestId !== pendingStart.requestId
    ) return
    setStartFailure({ kind: pendingStart.kind, message: lastOperationError.message })
    setPendingStart(null)
  }, [lastOperationError, pendingStart])

  useEffect(() => {
    if (!pendingStart) return
    const requestId = pendingStart.requestId
    const kind = pendingStart.kind
    const timeout = window.setTimeout(() => {
      setStartFailure({ kind, message: '等待飞控响应超时，请确认连接后重试。' })
      setPendingStart((current) => current?.requestId === requestId ? null : current)
    }, CALIBRATION_START_TIMEOUT_MS)
    return () => window.clearTimeout(timeout)
  }, [pendingStart])

  const startCalibration = (type: CalibrationKind) => {
    if (!canCalibrateKind(type) || calibrationBusy) return
    const requestId = `cal-${type}-${Date.now().toString(36)}`
    // Hide the previous terminal result immediately so it cannot masquerade
    // as the newly requested calibration while the server creates a session.
    setDismissedSessionId(snapshot?.sessionId ?? null)
    setStartFailure(null)
    setPendingStart({ requestId, kind: type })
    if (!send({ type: 'start_calibration', requestId, data: { kind: type } })) {
      setPendingStart(null)
      setStartFailure({ kind: type, message: 'WebSocket 未连接，校准请求未发送。' })
    }
  }

  const cancelCalibration = () => {
    if (!snapshot || !isOwner) return
    if (!snapshot.cancelSupported) {
      if (!window.confirm('当前 ArduPilot 校准不支持远程取消。退出需要重启飞控，重启期间请保持飞行器上锁并持续供电。确认重启飞控并退出校准？')) return
      send({
        type: 'reboot_vehicle',
        requestId: `cal-reboot-${Date.now().toString(36)}`,
        safetyConfirmation: 'reboot_flight_controller',
      })
      return
    }
    send({
      type: 'calibration_action',
      requestId: `cal-cancel-${Date.now().toString(36)}`,
      data: { sessionId: snapshot.sessionId, action: 'cancel' },
    })
  }

  const confirmPosition = (position: AccelCalibrationPosition) => {
    if (!snapshot || !isOwner) return
    send({
      type: 'calibration_action',
      requestId: `cal-pos-${Date.now().toString(36)}`,
      data: { sessionId: snapshot.sessionId, action: 'confirm_position', position },
    })
  }

  const acceptMag = () => {
    if (!snapshot || !isOwner) return
    send({
      type: 'calibration_action',
      requestId: `cal-accept-${Date.now().toString(36)}`,
      data: { sessionId: snapshot.sessionId, action: 'accept_mag' },
    })
  }

  const setBoardOrientation = (value: number) => {
    if (!orientationField || !orientationParam || !canCalibrate) return
    if (!window.confirm('确认修改飞控安装方向？错误的安装方向会直接导致起飞后失控（飞行关键）。')) return
    send({ type: 'param_set', data: { id: orientationField.id, value, paramType: orientationParam.type } })
  }

  const wizard = wizardVisible && snapshot ? (
    <CalibrationWizard
      snapshot={snapshot}
      isOwner={isOwner}
      onCancel={cancelCalibration}
      onConfirmPosition={confirmPosition}
      onAcceptMag={acceptMag}
      onRestart={() => startCalibration(snapshot.kind)}
      restartEnabled={canCalibrateKind(snapshot.kind) && !calibrationBusy}
      onClose={() => setDismissedSessionId(snapshot.sessionId)}
    />
  ) : null
  return (
    <div className={embedded ? 'mc-fade-in mc-data-workspace mc-sensor-workbench' : 'mc-workspace mc-fade-in mc-data-workspace mc-sensor-workbench'}>
      <div className="mc-sensor-health-strip" aria-label="传感器状态">
        <HealthPill label="IMU" state={sensorHealth.imu ?? 'offline'} />
        <HealthPill label="罗盘" state={sensorHealth.mag ?? 'offline'} />
        <HealthPill label="气压计" state={sensorHealth.baro ?? 'offline'} />
        <HealthPill label="GPS" state={sensorHealth.gps ?? 'offline'} />
        <HealthPill label="光流" state={sensorHealth.opticalFlow ?? 'offline'} />
        <HealthPill label="测距" state={sensorHealth.rangefinder ?? 'offline'} />
      </div>

      <section className="mc-sensor-diagnostics">
        <header className="mc-sensor-section-heading"><div><span className="mc-eyebrow">DIAGNOSTICS</span><h2>实时诊断</h2></div><p>校准前先观察数据是否稳定，并排除安装与环境问题。</p></header>
        <PageTabs tabs={tabs} active={activeTab} onChange={setActiveTab} />

      {activeTab === 'imu' && (
        <>
          <div className="mc-sensor-subbar">
            <button type="button" data-active={imuIndex === 'imu1'} onClick={() => setImuIndex('imu1')}>IMU 1 {imus[0] ? '●' : '○'}</button>
            <button type="button" data-active={imuIndex === 'imu2'} onClick={() => setImuIndex('imu2')}>IMU 2 {imus[1] ? '●' : '○'}</button>
            <span>IMU安装方向</span>
            <select
              className="mc-select"
              aria-label={orientationField?.id ?? 'IMU安装方向'}
              value={orientationParam ? Math.round(orientationParam.value) : ''}
              disabled={!orientationField || !orientationParam || !canCalibrate}
              title={orientationField ? orientationField.hint : '当前飞控类型尚未适配安装方向参数'}
              onChange={(event) => setBoardOrientation(Number(event.target.value))}
            >
              {!orientationParam && <option value="">{orientationField ? '等待参数' : '不适用'}</option>}
              {orientationField?.options.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </div>

          <div className="mc-sensor-chart-grid">
            <section className="mc-card mc-sensor-chart-card">
              <header><strong>加速度计</strong><span>m/s²</span></header>
              <div className="mc-sensor-axis-row"><AxisValue axis="X" value={imu ? displayImuValue('accel', imu.xacc) : null} color="var(--chart-4)" /><AxisValue axis="Y" value={imu ? displayImuValue('accel', imu.yacc) : null} color="var(--chart-2)" /><AxisValue axis="Z" value={imu ? displayImuValue('accel', imu.zacc) : null} color="var(--info)" /></div>
              <SensorChart kind="accel" instance={selectedImuInstance} imu={imu} />
            </section>
            <section className="mc-card mc-sensor-chart-card">
              <header><strong>陀螺仪</strong><span>°/s</span></header>
              <div className="mc-sensor-axis-row"><AxisValue axis="X" value={imu ? displayImuValue('gyro', imu.xgyro) : null} color="var(--warning)" /><AxisValue axis="Y" value={imu ? displayImuValue('gyro', imu.ygyro) : null} color="var(--chart-4)" /><AxisValue axis="Z" value={imu ? displayImuValue('gyro', imu.zgyro) : null} color="var(--accent)" /></div>
              <SensorChart kind="gyro" instance={selectedImuInstance} imu={imu} />
            </section>
          </div>

        </>
      )}

      {activeTab === 'mag' && (
        <>
          <SensorStatusCard title="罗盘" values={[["磁场 X", mag?.x.toFixed(2) ?? '—'], ["磁场 Y", mag?.y.toFixed(2) ?? '—'], ["磁场 Z", mag?.z.toFixed(2) ?? '—'], ["合成场强", magInterference ? `${magInterference.fieldGauss.toFixed(2)} G` : '—']]} />
          <div className="mc-sensor-chart-grid mc-sensor-chart-grid--single">
            <SensorWaveform title="磁场实时波形" unit={magSource?.unit === 'raw' ? 'raw' : 'mGauss'} sample={mag} values={mag ? { x: mag.x, y: mag.y, z: mag.z } : null} series={xyzSeries} />
          </div>
          {magInterference?.warning && (
            <div className="mc-capability-note" data-state="error">
              <Icon name="warning" size={15} />
              <span>当前磁场异常（合成场强 {magInterference.fieldGauss.toFixed(2)} G，正常范围 0.25–0.65 G），可能存在磁干扰。建议远离金属、磁铁与通电设备后再校准。</span>
            </div>
          )}
        </>
      )}
      {activeTab === 'baro' && (
        <>
          <SensorStatusCard title="气压计" values={[["绝对气压", baro ? `${baro.press_abs.toFixed(2)} hPa` : '—'], ["差压", baro ? `${baro.press_diff.toFixed(2)} hPa` : '—'], ["温度", baro?.temperature == null ? '—' : `${baro.temperature.toFixed(1)} °C`], ["气压高度", baro?.altitude == null ? '—' : `${baro.altitude.toFixed(1)} m`]]} />
          <div className="mc-sensor-chart-grid">
            <SensorWaveform title="气压实时波形" unit="hPa" sample={baro} values={baro ? { absolute: baro.press_abs, differential: baro.press_diff } : null} series={pressureSeries} />
            <SensorWaveform title="高度与温度" unit="m / °C" sample={baro} values={baro ? { altitude: baro.altitude, temperature: baro.temperature } : null} series={altitudeTemperatureSeries} />
          </div>
        </>
      )}
      {activeTab === 'gps' && (
        <>
          <div className="mc-gps-workspace">
            <GpsConfigurationPanel family={vehicleIdentity?.family ?? 'unknown'} writable={caps.gpsConfig} compact />

            <div className="mc-gps-diagnostics">
              <div className="mc-gps-metrics">
                <GpsMetric
                  label="定位状态"
                  value={gpsFixLabel(gps?.fix_type)}
                  state={gps && gps.fix_type >= 3 ? 'good' : gps && gps.fix_type >= 2 ? 'waiting' : 'error'}
                />
                <GpsMetric
                  label="卫星数"
                  value={gps?.satellites_visible == null ? '—' : String(gps.satellites_visible)}
                />
                <GpsMetric
                  label="地速"
                  value={gps?.vel == null ? '—' : `${gps.vel.toFixed(1)} m/s`}
                />
                <GpsMetric
                  label="航向"
                  value={gps?.cog == null ? '—' : `${gps.cog.toFixed(1)}°`}
                />
              </div>

              <section className="mc-card mc-gps-dop">
                <header><strong>DOP 精度因子</strong><span>数值越低越好</span></header>
                <div>
                  <DopMeter label="HDOP" value={gps?.eph} />
                  <DopMeter label="VDOP" value={gps?.epv} />
                </div>
              </section>

              <SensorWaveform
                title="卫星数趋势"
                unit="颗"
                sample={gps}
                values={gps ? { satellites: gps.satellites_visible } : null}
                series={[{ key: 'satellites', label: '可见卫星', color: 'var(--accent)' }]}
                height={126}
                className="mc-gps-satellite-chart"
              />
            </div>

            <GpsTrackPlot />

            <section className="mc-card mc-gps-position">
              <header><span className="mc-eyebrow">POSITION</span><strong>位置信息</strong></header>
              <dl>
                <div><dt>纬度</dt><dd className="mc-mono">{gps && gps.fix_type >= 2 ? gps.lat.toFixed(7) : '—'}</dd></div>
                <div><dt>经度</dt><dd className="mc-mono">{gps && gps.fix_type >= 2 ? gps.lon.toFixed(7) : '—'}</dd></div>
                <div><dt>海拔 MSL</dt><dd className="mc-mono">{gps && gps.fix_type >= 2 ? `${gps.alt.toFixed(1)} m` : '—'}</dd></div>
                <div><dt>地速</dt><dd className="mc-mono">{gps?.vel == null ? '—' : `${gps.vel.toFixed(2)} m/s`}</dd></div>
                <div><dt>航向</dt><dd className="mc-mono">{gps?.cog == null ? '—' : `${gps.cog.toFixed(1)}°`}</dd></div>
              </dl>
            </section>
          </div>
        </>
      )}
      {activeTab === 'optflow' && (
        <>
          <SensorStatusCard title="光流" values={[
            ["光流 X", formatFinite(opticalFlowFrame?.flowX ?? null, opticalFlowFrame?.source === 'OPTICAL_FLOW' ? 3 : 5)],
            ["光流 Y", formatFinite(opticalFlowFrame?.flowY ?? null, opticalFlowFrame?.source === 'OPTICAL_FLOW' ? 3 : 5)],
          ]} />
          <div className="mc-sensor-chart-grid mc-sensor-chart-grid--single">
            <SensorWaveform title="光流 X/Y" unit={opticalFlowFrame?.source === 'OPTICAL_FLOW' ? 'pixel' : 'rad'} sample={opticalFlow} values={opticalFlowFrame ? { x: opticalFlowFrame.flowX, y: opticalFlowFrame.flowY } : null} series={flowSeries} />
          </div>
        </>
      )}
      {activeTab === 'rangefinder' && (
        <>
          <SensorStatusCard title="测距仪" values={[["当前距离", distance ? `${distance.current_distance} cm` : '—'], ["最小量程", distance ? (distance.source === 'RANGEFINDER' ? '未提供' : `${distance.min_distance} cm`) : '—'], ["最大量程", distance ? (distance.source === 'RANGEFINDER' ? '未提供' : `${distance.max_distance} cm`) : '—'], ["信号质量", distance ? (distance.signal_quality == null ? '未提供' : String(distance.signal_quality)) : '—']]} />
          <div className="mc-sensor-chart-grid mc-sensor-chart-grid--single">
            <SensorWaveform title="距离实时波形" unit="cm" sample={distance} values={distance ? { distance: distance.current_distance } : null} series={[{ key: 'distance', label: '当前距离', color: 'var(--info)' }]} />
          </div>
        </>
      )}
      </section>

      <section className="mc-calibration-catalog">
        <header className="mc-calibration-header">
          <div><span className="mc-eyebrow">CALIBRATION</span><h2>传感器校准</h2></div>
        </header>

        <div className="mc-calibration-task-grid">
          {calibrationCatalog.map((item) => (
            <CalibrationTaskCard
              key={item.kind}
              item={item}
              vehicleReady={vehicleReady}
              supported={supportsCalibrationKind(vehicleIdentity, item.kind)}
              enabled={canCalibrate}
              sessionActive={calibrationBusy}
              magInterference={magInterference}
              magSource={magSource}
              onStart={startCalibration}
            />
          ))}
        </div>

        {(pendingStart || startFailure) && (
          <div className="mc-capability-note" data-state={startFailure ? 'error' : 'waiting'} role="status">
            <Icon name={startFailure ? 'warning' : 'refresh'} size={15} />
            <span>{startFailure
              ? `无法开始${calibrationLabels[startFailure.kind]}校准：${startFailure.message}`
              : `正在启动${calibrationLabels[pendingStart!.kind]}校准…`}</span>
          </div>
        )}

        {wizard && snapshot && (
          <section className="mc-calibration-session">
            <div className="mc-calibration-session__label">
              <div className="mc-calibration-session__title">
                <span>ACTIVE SESSION</span>
                <strong>{calibrationLabels[snapshot.kind]}</strong>
              </div>
              {sessionActive && (
                <button
                  type="button"
                  className="mc-btn mc-calibration-session__exit"
                  disabled={!canRequestCalibrationExit(snapshot, isOwner)}
                  title={!isOwner
                    ? '仅发起校准的客户端可以退出校准'
                    : !snapshot.cancelSupported
                      ? '当前流程需要重启飞控才能退出，点击后将要求确认'
                      : '终止当前飞控校准会话'}
                  onClick={cancelCalibration}
                >
                  <Icon name="close" size={14} />
                  退出校准
                </button>
              )}
            </div>
            {wizard}
          </section>
        )}
      </section>
    </div>
  )
}
