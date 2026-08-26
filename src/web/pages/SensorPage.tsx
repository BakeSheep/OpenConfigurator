import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import i18next, { type TFunction } from 'i18next'
import { useSearchParams } from 'react-router-dom'
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
import { TabPanel } from '../components/ui/Tabs'
import AccelOrientationVisual from '../components/sensors/AccelOrientationVisual'
import GpsConfigurationPanel from '../components/sensors/GpsConfigurationPanel'
import GpsTrackPlot from '../components/sensors/GpsTrackPlot'
import { sendRuntimeCommand } from '../hooks/useLocalRuntime'
import { useQueryTab } from '../hooks/useQueryTab'
import { useCalibrationStore } from '../stores/calibrationStore'
import { useConnectionStore } from '../stores/connectionStore'
import { useParameterStore } from '../stores/parameterStore'
import { useSensorStore } from '../stores/sensorStore'
import { useTelemetryStore } from '../stores/telemetryStore'
import { gpsFixLabel } from '../utils/gpsTelemetry'

const buildTabs = (t: TFunction) => [
  { id: 'imu', label: 'IMU' },
  { id: 'mag', label: t('common.compass') },
  { id: 'baro', label: t('common.barometer') },
  { id: 'gps', label: 'GPS' },
  { id: 'optflow', label: t('sensor.label.opticalFlow') },
  { id: 'rangefinder', label: t('sensor.label.rangefinder') },
]

const SENSOR_TAB_IDS = ['imu', 'mag', 'baro', 'gps', 'optflow', 'rangefinder'] as const

const STANDARD_GRAVITY = 9.80665
const RADIANS_TO_DEGREES = 180 / Math.PI
const CALIBRATION_START_TIMEOUT_MS = 8_000

const getCalibrationLabels = (t: TFunction): Record<CalibrationKind, string> => ({
  accel: t('common.accelerometer'),
  accel_simple: t('sensor.calibrationKind.accelSimple'),
  gyro: t('common.gyroscope'),
  mag: t('common.compass'),
  baro: t('common.barometer'),
  level: t('sensor.calibrationKind.level'),
})

const getCalibrationPreparation = (t: TFunction): Record<CalibrationKind, string> => ({
  accel: t('sensor.preparation.accel'),
  accel_simple: t('sensor.preparation.accelSimple'),
  gyro: t('sensor.preparation.gyro'),
  mag: t('sensor.preparation.mag'),
  baro: t('sensor.preparation.baro'),
  level: t('sensor.preparation.level'),
})

type CalibrationCatalogItem = {
  kind: CalibrationKind
  title: string
  icon: IconName
}

const getCalibrationCatalog = (t: TFunction): CalibrationCatalogItem[] => [
  { kind: 'accel', title: t('sensor.catalog.accel'), icon: 'sensor' },
  { kind: 'gyro', title: t('sensor.catalog.gyro'), icon: 'waveform' },
  { kind: 'mag', title: t('common.compass'), icon: 'refresh' },
  { kind: 'level', title: t('sensor.catalog.level'), icon: 'altitude' },
  { kind: 'baro', title: t('common.barometer'), icon: 'altitude' },
]

// Wizard render order and human labels for the six calibration orientations.
const SIDE_ORDER: CalibrationSide[] = ['down', 'left', 'right', 'front', 'back', 'up']
const getSideLabels = (t: TFunction): Record<CalibrationSide, { label: string; instruction: string }> => ({
  down: { label: t('sensor.side.down.label'), instruction: t('sensor.side.down.instruction') },
  up: { label: t('sensor.side.up.label'), instruction: t('sensor.side.up.instruction') },
  left: { label: t('sensor.side.left.label'), instruction: t('sensor.side.left.instruction') },
  right: { label: t('sensor.side.right.label'), instruction: t('sensor.side.right.instruction') },
  front: { label: t('sensor.side.front.label'), instruction: t('sensor.side.front.instruction') },
  back: { label: t('sensor.side.back.label'), instruction: t('sensor.side.back.instruction') },
})

export const calibrationSideInstruction = (
  kind: CalibrationKind,
  side: CalibrationSide,
  t: TFunction = i18next.t,
): string =>
  kind === 'mag'
    ? t('sensor.sideInstruction.mag', { label: getSideLabels(t)[side].label })
    : getSideLabels(t)[side].instruction

const getSideStateLabels = (t: TFunction): Record<string, string> => ({
  pending: t('sensor.sideState.pending'),
  active: t('sensor.sideState.active'),
  done: t('sensor.sideState.done'),
  hidden: t('sensor.sideState.hidden'),
})

// ArduPilot ACCELCAL_VEHICLE_POS (1..6) -> the orientation the user must hold.
const POSITION_SIDE: Record<AccelCalibrationPosition, CalibrationSide> = {
  1: 'down', 2: 'left', 3: 'right', 4: 'front', 5: 'back', 6: 'up',
}

/** The latest FC-requested or actively sampled side, kept visible between phases. */
export const resolveAccelGuideSide = (snapshot: CalibrationSnapshot): CalibrationSide | null => {
  if (snapshot.requestedPosition) return POSITION_SIDE[snapshot.requestedPosition]
  return SIDE_ORDER.find((side) => snapshot.sides?.[side] === 'active') ?? null
}

const phaseLabel = (snapshot: CalibrationSnapshot, t: TFunction): string => {
  switch (snapshot.phase) {
    case 'starting': return t('sensor.phase.starting')
    case 'running': return t('sensor.phase.running')
    case 'waiting_position': return t('sensor.phase.waitingPosition')
    case 'awaiting_accept': return t('sensor.phase.awaitingAccept')
    case 'accepted': return snapshot.verification === 'ack_only' ? t('sensor.phase.acceptedAckOnly') : t('sensor.phase.accepted')
    case 'done': return t('sensor.phase.done')
    case 'failed': return t('sensor.phase.failed')
    case 'cancelled': return t('sensor.phase.cancelled')
  }
}

export const displayImuValue = (
  kind: 'accel' | 'gyro',
  value: number,
  units: 'raw' | 'normalized' | undefined,
) => units === 'raw'
  ? value
  : kind === 'accel' ? value * STANDARD_GRAVITY : value * RADIANS_TO_DEGREES

export const imuDisplayUnit = (
  kind: 'accel' | 'gyro',
  units: 'raw' | 'normalized' | undefined,
) => units === 'raw' ? 'raw' : kind === 'accel' ? 'm/s²' : '°/s'

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
  const { t } = useTranslation()
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
      {data.length === 0 && <span>{t('sensor.liveChart.waiting')}</span>}
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

function SensorChart({ kind, instance, imu }: { kind: 'accel' | 'gyro'; instance: number; imu: ReturnType<typeof useSensorStore.getState>['imu'] }) {
  const values = imu ? {
    x: displayImuValue(kind, kind === 'accel' ? imu.xacc : imu.xgyro, imu.units),
    y: displayImuValue(kind, kind === 'accel' ? imu.yacc : imu.ygyro, imu.units),
    z: displayImuValue(kind, kind === 'accel' ? imu.zacc : imu.zgyro, imu.units),
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
  const { t } = useTranslation()
  return (
    <section className={`mc-card mc-sensor-chart-card ${className}`.trim()}>
      <header><strong>{title}</strong><span>{unit}</span></header>
      <div className="mc-chart-legend">
        {series.map((item) => <span key={item.key} style={{ '--series-color': item.color } as React.CSSProperties}>{item.label}{item.axis && <small>{item.axis === 'left' ? t('sensor.axis.left') : t('sensor.axis.right')}</small>}</span>)}
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
  return <section className="mc-card mc-sensor-status-card"><header><h3>{title}</h3></header><div>{values.map(([label, value]) => <dl key={label}><dt>{label}</dt><dd className="mc-mono">{value}</dd></dl>)}</div></section>
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

export const calibrationAvailabilityReason = (
  {
    vehicleReady,
    supported,
    sessionActive,
    enabled,
  }: {
    vehicleReady: boolean
    supported: boolean
    sessionActive: boolean
    enabled: boolean
  },
  t: TFunction = i18next.t,
): string => !vehicleReady
  ? t('sensor.availabilityReason.waitingForFc')
  : !supported
    ? t('sensor.availabilityReason.unsupported')
    : sessionActive
      ? t('sensor.availabilityReason.sessionActive')
      : !enabled
        ? t('sensor.availabilityReason.safetyNotMet')
        : t('sensor.availabilityReason.ready')

export const calibrationResultNotice = (
  snapshot: CalibrationSnapshot,
  t: TFunction = i18next.t,
): { state: 'success' | 'info' | 'warning' | 'error'; title: string; detail: string } | null => {
  const name = getCalibrationLabels(t)[snapshot.kind]
  if (snapshot.phase === 'done') {
    return { state: 'success', title: t('sensor.result.success', { name }), detail: t('sensor.result.successDetail') }
  }
  if (snapshot.phase === 'accepted') {
    return {
      state: 'info',
      title: t('sensor.result.acceptedTitle', { name }),
      detail: snapshot.verification === 'ack_only'
        ? t('sensor.result.acceptedAckOnlyDetail')
        : t('sensor.result.acceptedDetail'),
    }
  }
  if (snapshot.phase === 'failed') {
    return { state: 'error', title: t('sensor.result.failedTitle', { name }), detail: snapshot.failureReason ?? t('sensor.result.failedDetail') }
  }
  if (snapshot.phase === 'cancelled') {
    return { state: 'warning', title: t('sensor.result.cancelledTitle', { name }), detail: snapshot.failureReason ?? t('sensor.result.cancelledDetail') }
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
  t: TFunction = i18next.t,
): { state: 'good' | 'high' | 'unavailable'; text: string } => {
  if (!reading) {
    return source?.unit === 'raw'
      ? { state: 'unavailable', text: t('sensor.magPrecheck.unavailableRaw') }
      : { state: 'unavailable', text: t('sensor.magPrecheck.unavailable') }
  }
  const value = `${reading.fieldGauss.toFixed(2)} G`
  return reading.warning
    ? { state: 'high', text: t('sensor.magPrecheck.high', { value }) }
    : { state: 'good', text: t('sensor.magPrecheck.good', { value }) }
}

function HealthPill({ state, label }: { state: 'ok' | 'warning' | 'error' | 'offline'; label: string }) {
  const { t } = useTranslation()
  const stateLabel = state === 'ok' ? t('sensor.health.ok') : state === 'warning' ? t('sensor.health.warning') : state === 'error' ? t('sensor.health.error') : t('sensor.health.offline')
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
  item: CalibrationCatalogItem
  vehicleReady: boolean
  supported: boolean
  enabled: boolean
  sessionActive: boolean
  magInterference: MagInterferenceReading | null
  magSource: { unit: 'mgauss' | 'raw'; ts: number } | null
  onStart: (kind: CalibrationKind) => void
}) {
  const { t } = useTranslation()
  const unavailable = !supported || !enabled || sessionActive
  const reason = calibrationAvailabilityReason({ vehicleReady, supported, sessionActive, enabled }, t)
  const magPrecheck = magPrecheckStatus(magInterference, magSource, t)
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
        <footer><button type="button" className="mc-btn mc-btn-ghost" disabled={unavailable} onClick={() => onStart(item.kind)}>{t('sensor.calibration.start')} <Icon name="arrowRight" size={14} /></button></footer>
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
  const { t } = useTranslation()
  const calibrationLabels = useMemo(() => getCalibrationLabels(t), [t])
  const calibrationPreparation = useMemo(() => getCalibrationPreparation(t), [t])
  const sideLabels = useMemo(() => getSideLabels(t), [t])
  const sideStateLabels = useMemo(() => getSideStateLabels(t), [t])
  const terminal = snapshot.phase === 'done' || snapshot.phase === 'failed'
    || snapshot.phase === 'cancelled' || snapshot.phase === 'accepted'
  const visibleSides = SIDE_ORDER.filter((side) => snapshot.sides && snapshot.sides[side] !== 'hidden')
  const doneSides = visibleSides.filter((side) => snapshot.sides?.[side] === 'done').length
  const progress = resolveCalibrationProgress(snapshot, visibleSides.length, doneSides)
  const indeterminate = progress === null && !terminal
  const requestedSide = snapshot.requestedPosition ? POSITION_SIDE[snapshot.requestedPosition] : null
  const guideSide = resolveAccelGuideSide(snapshot)
  const resultNotice = calibrationResultNotice(snapshot, t)
  const positionNeedsConfirmation = snapshot.family === 'ardupilot'
    && snapshot.phase === 'waiting_position'
    && snapshot.requestedPosition != null
  const accelGuideText = terminal
    ? snapshot.phase === 'done' || snapshot.phase === 'accepted'
      ? { title: t('sensor.wizard.accelComplete.title'), detail: t('sensor.wizard.accelComplete.detail') }
      : { title: t('sensor.wizard.accelStopped.title'), detail: t('sensor.wizard.accelStopped.detail') }
    : guideSide
      ? positionNeedsConfirmation
        ? { title: t('sensor.wizard.positionTitle', { label: sideLabels[guideSide].label }), detail: t('sensor.wizard.positionDetail', { instruction: sideLabels[guideSide].instruction }) }
        : {
            title: t('sensor.wizard.holdTitle', { label: sideLabels[guideSide].label }),
            detail: snapshot.family === 'px4'
              ? t('sensor.wizard.px4AutoDetail')
              : t('sensor.wizard.samplingDetail'),
          }
      : {
          title: t('sensor.wizard.waitingFc.title'),
          detail: snapshot.family === 'px4'
            ? t('sensor.wizard.waitingFc.px4Detail')
            : t('sensor.wizard.waitingFc.detail'),
        }
  const magGuideText = guideSide
    ? {
        title: t('sensor.wizard.magRotateTitle', { label: sideLabels[guideSide].label }),
        detail: calibrationSideInstruction('mag', guideSide, t),
      }
    : {
        title: t('sensor.wizard.magSelect.title'),
        detail: t('sensor.wizard.magSelect.detail'),
      }

  return (
    <div className="mc-calibration-wizard" data-state={snapshot.phase} role="status" aria-live="polite">
      <header>
        <div>
          <strong>{t('sensor.wizard.title', { name: calibrationLabels[snapshot.kind] })}</strong>
          <span>{phaseLabel(snapshot, t)}</span>
        </div>
        <b className="mc-mono">{progress === null ? (indeterminate ? t('sensor.wizard.processing') : '—') : `${progress}%`}</b>
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
          <span>{t('sensor.wizard.observerMode')}</span>
        </div>
      )}
      {snapshot.protocolDegraded && (
        <div className="mc-capability-note" data-state="waiting">
          <Icon name="warning" size={14} />
          <span>{t('sensor.wizard.protocolDegraded')}</span>
        </div>
      )}
      <div
        className="mc-calibration-progress"
        data-indeterminate={indeterminate || undefined}
        role="progressbar"
        aria-label={indeterminate ? t('sensor.wizard.ariaProcessing') : t('sensor.wizard.ariaProgress', { progress: progress ?? 0 })}
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
              {t('sensor.wizard.confirmPosition')}
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
            const instruction = calibrationSideInstruction(snapshot.kind, side, t)
            return (
              <li
                key={side}
                data-state={state}
                aria-label={t('sensor.wizard.sideAriaLabel', { label: sideLabels[side].label, instruction, state: sideStateLabels[state] })}
                title={instruction}
              >
                <AccelOrientationVisual
                  side={side}
                  label={sideLabels[side].label}
                  instruction={instruction}
                  usePx4MagRotationImage={snapshot.family === 'px4' && snapshot.kind === 'mag'}
                />
                <div className="mc-calibration-side-copy">
                  <span className="mc-calibration-side-state">
                    <i aria-hidden="true" />
                    {sideStateLabels[state]}
                  </span>
                  <strong>{sideLabels[side].label}</strong>
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
                  <strong>{t('sensor.wizard.magInstance', { id: instance.id + 1 })}</strong>
                  <span className="mc-mono">{instance.pct}%</span>
                </header>
                {instance.report ? (
                  <dl>
                    <div><dt>{t('sensor.wizard.fitness')}</dt><dd className="mc-mono">{instance.report.fitness.toFixed(1)}{rating ? ` · ${rating.label}` : ''}</dd></div>
                    <div><dt>{t('sensor.wizard.offset')}</dt><dd className="mc-mono" data-warn={offsetWarn}>{magOffsetMagnitude(instance.report.ofs).toFixed(0)} mGauss</dd></div>
                    <div><dt>{t('common.save')}</dt><dd>{instance.report.autosaved ? t('sensor.wizard.saved') : t('sensor.wizard.pendingConfirm')}</dd></div>
                  </dl>
                ) : <span className="mc-mag-report-progress">{t('sensor.wizard.collecting')}</span>}
                {offsetWarn && <span className="mc-mag-report-warn">{t('sensor.wizard.offsetWarning')}</span>}
              </div>
            )
          })}
        </div>
      )}
      {snapshot.phase === 'awaiting_accept' && isOwner && (
        <div className="mc-calibration-position">
          <Icon name="check" size={16} />
          <div>
            <strong>{t('sensor.wizard.dataReady')}</strong>
            <span>{t('sensor.wizard.acceptDetail')}</span>
          </div>
          <button type="button" className="mc-btn mc-btn-primary" onClick={onAcceptMag}>{t('sensor.wizard.acceptAndSave')}</button>
        </div>
      )}

      {snapshot.rebootRequired && (
        <div className="mc-capability-note" data-state="waiting">
          <Icon name="warning" size={14} />
          <span>{t('sensor.wizard.rebootRequired')}</span>
        </div>
      )}

      <footer>
        {!resultNotice && <span>{phaseLabel(snapshot, t)}</span>}
        {terminal && (
          <div className="mc-calibration-footer-actions">
            <button type="button" className="mc-btn mc-btn-primary" disabled={!restartEnabled} onClick={onRestart}>
              <Icon name="refresh" size={14} />{t('sensor.wizard.recalibrate')}
            </button>
            <button type="button" className="mc-btn mc-btn-ghost" onClick={onClose}>{t('common.close')}</button>
          </div>
        )}
      </footer>
    </div>
  )
}

export default function SensorPage({
  embedded = false,
  view = 'diagnostics',
}: {
  embedded?: boolean
  view?: 'diagnostics' | 'calibration'
}) {
  const { t } = useTranslation()
  const tabs = useMemo(() => buildTabs(t), [t])
  const calibrationLabels = useMemo(() => getCalibrationLabels(t), [t])
  const calibrationCatalog = useMemo(() => getCalibrationCatalog(t), [t])
  const pressureSeries = useMemo<LiveChartSeries[]>(() => [
    { key: 'absolute', label: t('sensor.series.absolutePressure'), color: 'var(--accent)', axis: 'left' },
    { key: 'differential', label: t('sensor.series.differentialPressure'), color: 'var(--warning)', axis: 'right' },
  ], [t])
  const altitudeTemperatureSeries = useMemo<LiveChartSeries[]>(() => [
    { key: 'altitude', label: t('sensor.series.pressureAltitude'), color: 'var(--info)', axis: 'left' },
    { key: 'temperature', label: t('common.temperature'), color: 'var(--warning)', axis: 'right' },
  ], [t])
  const flowSeries = useMemo<LiveChartSeries[]>(() => [
    { key: 'x', label: t('sensor.series.flowX'), color: 'var(--chart-4)' },
    { key: 'y', label: t('sensor.series.flowY'), color: 'var(--chart-2)' },
  ], [t])
  const [activeTab, setActiveTab] = useQueryTab(SENSOR_TAB_IDS, 'imu')
  const [searchParams, setSearchParams] = useSearchParams()
  const [imuIndex, setImuIndex] = useState('imu1')
  // Terminal results may be dismissed locally. A live server session must
  // always remain visible so the page cannot enter a hidden-but-busy state.
  const [dismissedSessionId, setDismissedSessionId] = useState<string | null>(null)
  const [pendingStart, setPendingStart] = useState<{ requestId: string; kind: CalibrationKind } | null>(null)
  const [startFailure, setStartFailure] = useState<{ kind: CalibrationKind; message: string } | null>(null)
  const send = sendRuntimeCommand
  const vehicleReady = useConnectionStore((state) => state.vehicleReady)
  const hasCalibrationControl = useConnectionStore((state) => state.vehicleReady && state.canControl)
  const safetyEpoch = useConnectionStore((state) => state.safetyEpoch)
  const safetyAuthorityId = useConnectionStore((state) => state.safetyAuthorityId)
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
  const isOwner = useMemo(() => Boolean(snapshot && snapshot.ownerClientId === 'local-browser'), [snapshot])
  useEffect(() => {
    if (!searchParams.has('mode')) return
    setSearchParams((current) => {
      const next = new URLSearchParams(current)
      next.delete('mode')
      return next
    }, { replace: true })
  }, [searchParams, setSearchParams])
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
      setStartFailure({ kind, message: t('sensor.startTimeout') })
      setPendingStart((current) => current?.requestId === requestId ? null : current)
    }, CALIBRATION_START_TIMEOUT_MS)
    return () => window.clearTimeout(timeout)
  }, [pendingStart, t])

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
      setStartFailure({ kind: type, message: t('sensor.wsNotConnected') })
    }
  }

  const cancelCalibration = () => {
    if (!snapshot || !isOwner) return
    if (!snapshot.cancelSupported) {
      if (!window.confirm(t('sensor.cancelUnsupportedConfirm'))) return
      const connection = useConnectionStore.getState()
      if (
        !connection.vehicleReady
        || !connection.canControl
        || connection.safetyAuthorityId === null
        || connection.safetyEpoch !== safetyEpoch
        || connection.safetyAuthorityId !== safetyAuthorityId
      ) return
      send({
        type: 'reboot_vehicle',
        requestId: `cal-reboot-${Date.now().toString(36)}`,
        safetyConfirmation: 'reboot_flight_controller',
        expectedSafetyEpoch: connection.safetyEpoch,
        expectedSafetyAuthorityId: connection.safetyAuthorityId,
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
    if (!window.confirm(t('sensor.confirmBoardOrientation'))) return
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
  const healthStrip = (
    <div
      className="mc-sensor-health-strip"
      role="region"
      aria-label={t('sensor.healthStrip.ariaLabel')}
      tabIndex={0}
    >
      <HealthPill label="IMU" state={sensorHealth.imu ?? 'offline'} />
      <HealthPill label={t('common.compass')} state={sensorHealth.mag ?? 'offline'} />
      <HealthPill label={t('common.barometer')} state={sensorHealth.baro ?? 'offline'} />
      <HealthPill label="GPS" state={sensorHealth.gps ?? 'offline'} />
      <HealthPill label={t('sensor.label.opticalFlow')} state={sensorHealth.opticalFlow ?? 'offline'} />
      <HealthPill label={t('sensor.label.ranging')} state={sensorHealth.rangefinder ?? 'offline'} />
    </div>
  )
  return (
    <div className={embedded ? 'mc-fade-in mc-data-workspace mc-sensor-workbench' : 'mc-workspace mc-fade-in mc-data-workspace mc-sensor-workbench'}>
      {view === 'diagnostics' && <section className="mc-sensor-diagnostics">
        <PageTabs
          tabs={tabs}
          active={activeTab}
        onChange={setActiveTab}
        ariaLabel={t('sensor.diagnostics.title')}
        idBase="sensor-diagnostics"
      />
        {healthStrip}
        <TabPanel idBase="sensor-diagnostics" tabId={activeTab}>

      {activeTab === 'imu' && (
        <>
          <div className="mc-sensor-controls">
            <div className="mc-sensor-instance-toggle" role="group" aria-label={t('common.imu')}>
              <button type="button" aria-pressed={imuIndex === 'imu1'} data-active={imuIndex === 'imu1'} onClick={() => setImuIndex('imu1')}>IMU 1 {imus[0] ? '●' : '○'}</button>
              <button type="button" aria-pressed={imuIndex === 'imu2'} data-active={imuIndex === 'imu2'} onClick={() => setImuIndex('imu2')}>IMU 2 {imus[1] ? '●' : '○'}</button>
            </div>
            <label className="mc-sensor-orientation-control">
              <span>{t('sensor.imuOrientation')}</span>
              <select
                className="mc-select"
                aria-label={orientationField?.id ?? t('sensor.imuOrientation')}
                value={orientationParam ? Math.round(orientationParam.value) : ''}
                disabled={!orientationField || !orientationParam || !canCalibrate}
                title={orientationField ? orientationField.hint : t('sensor.orientationNotAdapted')}
                onChange={(event) => setBoardOrientation(Number(event.target.value))}
              >
                {!orientationParam && <option value="">{orientationField ? t('sensor.waitingForParam') : t('sensor.notApplicable')}</option>}
                {orientationField?.options.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
          </div>

          <div className="mc-sensor-chart-grid">
            <section className="mc-card mc-sensor-chart-card">
              <header><strong>{t('common.accelerometer')}</strong><span>{imuDisplayUnit('accel', imu?.units)}</span></header>
              <div className="mc-sensor-axis-row"><AxisValue axis="X" value={imu ? displayImuValue('accel', imu.xacc, imu.units) : null} color="var(--chart-4)" /><AxisValue axis="Y" value={imu ? displayImuValue('accel', imu.yacc, imu.units) : null} color="var(--chart-2)" /><AxisValue axis="Z" value={imu ? displayImuValue('accel', imu.zacc, imu.units) : null} color="var(--info)" /></div>
              <SensorChart kind="accel" instance={selectedImuInstance} imu={imu} />
            </section>
            <section className="mc-card mc-sensor-chart-card">
              <header><strong>{t('common.gyroscope')}</strong><span>{imuDisplayUnit('gyro', imu?.units)}</span></header>
              <div className="mc-sensor-axis-row"><AxisValue axis="X" value={imu ? displayImuValue('gyro', imu.xgyro, imu.units) : null} color="var(--warning)" /><AxisValue axis="Y" value={imu ? displayImuValue('gyro', imu.ygyro, imu.units) : null} color="var(--chart-4)" /><AxisValue axis="Z" value={imu ? displayImuValue('gyro', imu.zgyro, imu.units) : null} color="var(--accent)" /></div>
              <SensorChart kind="gyro" instance={selectedImuInstance} imu={imu} />
            </section>
          </div>

        </>
      )}

      {activeTab === 'mag' && (
        <>
          <SensorStatusCard title={t('common.compass')} values={[[t('sensor.mag.fieldX'), mag?.x.toFixed(2) ?? '—'], [t('sensor.mag.fieldY'), mag?.y.toFixed(2) ?? '—'], [t('sensor.mag.fieldZ'), mag?.z.toFixed(2) ?? '—'], [t('sensor.mag.compositeField'), magInterference ? `${magInterference.fieldGauss.toFixed(2)} G` : '—']]} />
          <div className="mc-sensor-chart-grid mc-sensor-chart-grid--single">
            <SensorWaveform title={t('sensor.mag.waveform')} unit={magSource?.unit === 'raw' ? 'raw' : 'mGauss'} sample={mag} values={mag ? { x: mag.x, y: mag.y, z: mag.z } : null} series={xyzSeries} />
          </div>
          {magInterference?.warning && (
            <div className="mc-capability-note" data-state="error">
              <Icon name="warning" size={15} />
              <span>{t('sensor.mag.anomalyWarning', { value: magInterference.fieldGauss.toFixed(2) })}</span>
            </div>
          )}
        </>
      )}
      {activeTab === 'baro' && (
        <>
          <SensorStatusCard title={t('common.barometer')} values={[[t('sensor.series.absolutePressure'), baro ? `${baro.press_abs.toFixed(2)} hPa` : '—'], [t('sensor.series.differentialPressure'), baro ? `${baro.press_diff.toFixed(2)} hPa` : '—'], [t('common.temperature'), baro?.temperature == null ? '—' : `${baro.temperature.toFixed(1)} °C`], [t('sensor.series.pressureAltitude'), baro?.altitude == null ? '—' : `${baro.altitude.toFixed(1)} m`]]} />
          <div className="mc-sensor-chart-grid">
            <SensorWaveform title={t('sensor.baro.waveform')} unit="hPa" sample={baro} values={baro ? { absolute: baro.press_abs, differential: baro.press_diff } : null} series={pressureSeries} />
            <SensorWaveform title={t('sensor.baro.altitudeTemp')} unit="m / °C" sample={baro} values={baro ? { altitude: baro.altitude, temperature: baro.temperature } : null} series={altitudeTemperatureSeries} />
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
                  label={t('sensor.gps.fixStatus')}
                  value={gpsFixLabel(gps?.fix_type)}
                  state={gps && gps.fix_type >= 3 ? 'good' : gps && gps.fix_type >= 2 ? 'waiting' : 'error'}
                />
                <GpsMetric
                  label={t('sensor.gps.satellites')}
                  value={gps?.satellites_visible == null ? '—' : String(gps.satellites_visible)}
                />
                <GpsMetric
                  label={t('sensor.gps.groundSpeed')}
                  value={gps?.vel == null ? '—' : `${gps.vel.toFixed(1)} m/s`}
                />
                <GpsMetric
                  label={t('common.heading')}
                  value={gps?.cog == null ? '—' : `${gps.cog.toFixed(1)}°`}
                />
              </div>

              <section className="mc-card mc-gps-dop">
                <header><strong>{t('sensor.gps.dop')}</strong><span>{t('sensor.gps.dopHint')}</span></header>
                <div>
                  <DopMeter label="HDOP" value={gps?.eph} />
                  <DopMeter label="VDOP" value={gps?.epv} />
                </div>
              </section>

              <SensorWaveform
                title={t('sensor.gps.satellitesTrend')}
                unit={t('sensor.gps.satellitesUnit')}
                sample={gps}
                values={gps ? { satellites: gps.satellites_visible } : null}
                series={[{ key: 'satellites', label: t('sensor.gps.visibleSatellites'), color: 'var(--accent)' }]}
                height={126}
                className="mc-gps-satellite-chart"
              />
            </div>

            <GpsTrackPlot />

            <section className="mc-card mc-gps-position">
              <header><strong>{t('sensor.gps.position')}</strong></header>
              <dl>
                <div><dt>{t('sensor.gps.latitude')}</dt><dd className="mc-mono">{gps && gps.fix_type >= 2 ? gps.lat.toFixed(7) : '—'}</dd></div>
                <div><dt>{t('sensor.gps.longitude')}</dt><dd className="mc-mono">{gps && gps.fix_type >= 2 ? gps.lon.toFixed(7) : '—'}</dd></div>
                <div><dt>{t('sensor.gps.altitudeMSL')}</dt><dd className="mc-mono">{gps && gps.fix_type >= 2 ? `${gps.alt.toFixed(1)} m` : '—'}</dd></div>
                <div><dt>{t('sensor.gps.groundSpeed')}</dt><dd className="mc-mono">{gps?.vel == null ? '—' : `${gps.vel.toFixed(2)} m/s`}</dd></div>
                <div><dt>{t('common.heading')}</dt><dd className="mc-mono">{gps?.cog == null ? '—' : `${gps.cog.toFixed(1)}°`}</dd></div>
              </dl>
            </section>
          </div>
        </>
      )}
      {activeTab === 'optflow' && (
        <>
          <SensorStatusCard title={t('sensor.label.opticalFlow')} values={[
            [t('sensor.series.flowX'), formatFinite(opticalFlowFrame?.flowX ?? null, opticalFlowFrame?.source === 'OPTICAL_FLOW' ? 3 : 5)],
            [t('sensor.series.flowY'), formatFinite(opticalFlowFrame?.flowY ?? null, opticalFlowFrame?.source === 'OPTICAL_FLOW' ? 3 : 5)],
          ]} />
          <div className="mc-sensor-chart-grid mc-sensor-chart-grid--single">
            <SensorWaveform title={t('sensor.optflow.waveform')} unit={opticalFlowFrame?.source === 'OPTICAL_FLOW' ? 'pixel' : 'rad'} sample={opticalFlow} values={opticalFlowFrame ? { x: opticalFlowFrame.flowX, y: opticalFlowFrame.flowY } : null} series={flowSeries} />
          </div>
        </>
      )}
      {activeTab === 'rangefinder' && (
        <>
          <SensorStatusCard title={t('sensor.label.rangefinder')} values={[[t('sensor.rangefinder.currentDistance'), distance ? `${distance.current_distance} cm` : '—'], [t('sensor.rangefinder.minRange'), distance ? (distance.source === 'RANGEFINDER' ? t('common.notProvided') : `${distance.min_distance} cm`) : '—'], [t('sensor.rangefinder.maxRange'), distance ? (distance.source === 'RANGEFINDER' ? t('common.notProvided') : `${distance.max_distance} cm`) : '—'], [t('sensor.rangefinder.signalQuality'), distance ? (distance.signal_quality == null ? t('common.notProvided') : String(distance.signal_quality)) : '—']]} />
          <div className="mc-sensor-chart-grid mc-sensor-chart-grid--single">
            <SensorWaveform title={t('sensor.rangefinder.waveform')} unit="cm" sample={distance} values={distance ? { distance: distance.current_distance } : null} series={[{ key: 'distance', label: t('sensor.rangefinder.currentDistance'), color: 'var(--info)' }]} />
          </div>
        </>
      )}
        </TabPanel>
      </section>}

      {view === 'calibration' && <section className="mc-calibration-catalog">
        <header className="mc-calibration-catalog__header">
          <h3>{t('sensor.calibration.title')}</h3>
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
              ? t('sensor.startFailed', { name: calibrationLabels[startFailure.kind], message: startFailure.message })
              : t('sensor.starting', { name: calibrationLabels[pendingStart!.kind] })}</span>
          </div>
        )}

        {wizard && snapshot && (
          <section className="mc-calibration-session">
            <div className="mc-calibration-session__label">
              <div className="mc-calibration-session__title">
                <span>{t('sensor.activeSession')}</span>
                <strong>{calibrationLabels[snapshot.kind]}</strong>
              </div>
              {sessionActive && (
                <button
                  type="button"
                  className="mc-btn mc-calibration-session__exit"
                  disabled={!canRequestCalibrationExit(snapshot, isOwner)}
                  title={!isOwner
                    ? t('sensor.exit.titleNotOwner')
                    : !snapshot.cancelSupported
                      ? t('sensor.exit.titleRebootRequired')
                      : t('sensor.exit.titleCancel')}
                  onClick={cancelCalibration}
                >
                  <Icon name="close" size={14} />
                  {t('sensor.exit.button')}
                </button>
              )}
            </div>
            {wizard}
          </section>
        )}
      </section>}
    </div>
  )
}
