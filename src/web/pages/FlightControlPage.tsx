import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { availableModes, vehicleCapabilities } from '../../shared/vehicleProfiles'
import Icon from '../components/ui/Icon'
import { PageHeader } from '../components/ui/PageFrame'
import { sendClientMessage } from '../hooks/useWebSocket'
import { useConnectionStore } from '../stores/connectionStore'
import { useSensorStore } from '../stores/sensorStore'
import { useTelemetryStore } from '../stores/telemetryStore'
import {
  latestTargetSessionBoundary,
  PREARM_FAILURE_TTL_MS,
  resolveRecentPrearmFailure,
} from '../utils/prearmStatus'

export default function FlightControlPage() {
  const { t } = useTranslation()
  const send = sendClientMessage
  const vehicle = useTelemetryStore((state) => state.status)
  const vehicleIdentity = useTelemetryStore((state) => state.vehicleIdentity)
  const battery = useTelemetryStore((state) => state.battery)
  const gps = useTelemetryStore((state) => state.gps)
  const ekfStatus = useTelemetryStore((state) => state.ekfStatus)
  const preflightCheck = useTelemetryStore((state) => state.preflightCheck)
  const sensorsHealthy = useTelemetryStore((state) => state.sensorsHealthy)
  const unhealthySensors = useTelemetryStore((state) => state.unhealthySensors)
  const statusLogs = useTelemetryStore((state) => state.statusLogs)
  const isTelemetryStale = useTelemetryStore((state) => state.isStale)
  const sensorHealth = useSensorStore((state) => state.sensorHealth)
  const opticalFlow = useSensorStore((state) => state.opticalFlow)
  const distanceSensor = useSensorStore((state) => state.distanceSensor)
  const isSensorStale = useSensorStore((state) => state.isStale)
  const vehicleReady = useConnectionStore((state) => state.vehicleReady)
  const canControl = useConnectionStore((state) => state.canControl)
  const connected = vehicleReady && canControl
  const [takeoffAltitude, setTakeoffAltitude] = useState(2.5)
  const [armConfirmation, setArmConfirmation] = useState(false)
  const [, refreshPrearmExpiry] = useState(0)
  const confirmationTimer = useRef<number | null>(null)
  const armed = vehicle?.armed ?? false

  useEffect(() => () => {
    if (confirmationTimer.current !== null) window.clearTimeout(confirmationTimer.current)
  }, [])

  const arm = () => {
    if (!armConfirmation) {
      setArmConfirmation(true)
      confirmationTimer.current = window.setTimeout(() => setArmConfirmation(false), 3000)
      return
    }
    send({
      type: 'command',
      cmd: 'MAV_CMD_COMPONENT_ARM_DISARM',
      params: [1, 0, 0, 0, 0, 0, 0],
      safetyConfirmation: 'arm',
    })
    // Clear the pending 3 s reset timer so it cannot fire after a successful
    // confirmation and needlessly toggle state later.
    if (confirmationTimer.current !== null) {
      window.clearTimeout(confirmationTimer.current)
      confirmationTimer.current = null
    }
    setArmConfirmation(false)
  }

  const disarm = () => send({
    type: 'command',
    cmd: 'MAV_CMD_COMPONENT_ARM_DISARM',
    params: [0, 0, 0, 0, 0, 0, 0],
    safetyConfirmation: 'disarm',
  })
  const command = (cmd: string, params: number[]) => send({ type: 'command', cmd, params })
  const modeOptions = availableModes(vehicleIdentity)
  const caps = vehicleCapabilities(vehicleIdentity)
  const setMode = (modeId: number) =>
    send({ type: 'set_flight_mode', data: { modeId } })

  const hasGpsPosition = (gps?.fix_type ?? 0) >= 3
  // Status logs intentionally survive reconnects. Bound PreArm feedback to the
  // latest selected target, then let the newest status resolve older failures.
  const prearmSessionBoundary = latestTargetSessionBoundary(statusLogs)
  const recentPrearmFailure = resolveRecentPrearmFailure(statusLogs, {
    now: Date.now(),
    sessionBoundary: prearmSessionBoundary,
  })
  useEffect(() => {
    if (!recentPrearmFailure) return
    const remainingMs = recentPrearmFailure.time + PREARM_FAILURE_TTL_MS - Date.now()
    if (remainingMs <= 0) return
    const expiryTimer = window.setTimeout(
      () => refreshPrearmExpiry((value) => value + 1),
      remainingMs + 1,
    )
    return () => window.clearTimeout(expiryTimer)
  }, [prearmSessionBoundary?.id, prearmSessionBoundary?.time, recentPrearmFailure?.id, recentPrearmFailure?.time])
  const hasValidOpticalFlow = sensorHealth.opticalFlow === 'ok'
    && !isSensorStale('opticalFlow')
    && (opticalFlow?.quality ?? 0) > 0
  const rangefinderHasDeclaredRange = distanceSensor !== null
    && distanceSensor.max_distance > distanceSensor.min_distance
  const hasValidRangefinder = sensorHealth.rangefinder === 'ok'
    && !isSensorStale('distanceSensor')
    && distanceSensor !== null
    && (rangefinderHasDeclaredRange
      ? distanceSensor.current_distance >= distanceSensor.min_distance
        && distanceSensor.current_distance <= distanceSensor.max_distance
      : distanceSensor.current_distance > 0)
    && distanceSensor.signal_quality !== 1
  const hasFlowPosition = hasValidOpticalFlow && hasValidRangefinder
  const sysStatusFresh = !isTelemetryStale('sysStatus')
  const systemHealthLabel = unhealthySensors.length > 0
    ? t('flight.systemHealthAbnormal', { sensors: unhealthySensors.join(t('common.listSeparator')) })
    : t('flight.systemHealth')
  const checks = [
    { label: t('flight.checkPositionSource'), ok: hasGpsPosition || hasFlowPosition },
    // Battery gate keys off a valid voltage source, not a stale/absent percent.
    { label: t('flight.checkBattery'), ok: battery?.voltage != null && (battery?.remaining ?? 0) > 20 },
    { label: t('flight.checkImu'), ok: sensorHealth.imu === 'ok' && !isSensorStale('imu') },
    { label: t('flight.checkBaro'), ok: sensorHealth.baro === 'ok' && !isSensorStale('baro') },
    { label: t('flight.checkEkf'), ok: ekfStatus !== null && !isTelemetryStale('ekfStatus') && ekfStatus.health_flags !== 0 },
    { label: systemHealthLabel, ok: sysStatusFresh && sensorsHealthy === true },
    ...(preflightCheck === null
      ? []
      : [{ label: t('flight.checkPreflight'), ok: sysStatusFresh && preflightCheck === true }]),
    ...(recentPrearmFailure
      ? [{ label: t('flight.checkPrearm', { text: recentPrearmFailure.text }), ok: false }]
      : []),
  ]
  const allChecksPassed = checks.every((check) => check.ok)
  const latestArmMessage = statusLogs.find((entry) =>
    /arm|arming|解锁|preflight|pre-arm/i.test(entry.text)
  )

  return (
    <div className="mc-workspace mc-workspace--standard mc-fade-in">
      <PageHeader title={t('flight.title')} description={t('flight.description')} />

      {!connected && (
        <div className="mc-capability-note" data-state="waiting">
          <Icon name="warning" size={15} />
          <span>{!vehicleReady ? t('flight.waitingHeartbeat') : t('flight.readOnlyControl')}</span>
        </div>
      )}

      {connected && !caps.arm && (
        <div className="mc-capability-note" data-state="waiting">
          <Icon name="warning" size={15} />
          <span>{t('flight.writeNotSupported', { type: vehicleIdentity ? `${vehicleIdentity.family}/${vehicleIdentity.vehicleClass}` : t('flight.unrecognized') })}</span>
        </div>
      )}

      <section className="mc-card overflow-hidden mt-4">
        <div className="flex flex-col gap-5 p-5 md:flex-row md:items-center">
          <span className="grid h-12 w-12 place-items-center rounded-xl" style={{ background: armed ? 'var(--success-dim)' : 'var(--bg-tertiary)', color: armed ? 'var(--success)' : 'var(--text-disabled)' }}>
            <Icon name="flight" size={23} />
          </span>
          <div className="flex-1">
            <p className="text-[18px] font-bold" style={{ color: armed ? 'var(--success)' : 'var(--text-primary)' }}>{armed ? t('flight.armed') : t('flight.disarmed')}</p>
            <p className="mt-1 text-[12px]" style={{ color: 'var(--text-secondary)' }}>{connected ? t('flight.currentMode', { mode: vehicle?.mode ?? '-' }) : t('flight.fcNotConnected')}</p>
          </div>
          {!armed && (
            <button type="button" disabled={!connected || !allChecksPassed || !caps.arm} className="mc-btn min-h-11 px-6 text-[14px]" style={{ background: armConfirmation ? 'var(--warning)' : 'var(--success)', color: '#fff', animation: armConfirmation ? 'mc-pulse 1s ease-in-out infinite' : undefined }} onClick={arm}>
              {armConfirmation ? t('flight.confirmArm') : caps.arm ? t('flight.armVehicle') : t('flight.armNotSupported')}
            </button>
          )}
          <button type="button" className="mc-btn mc-btn-danger min-h-11 px-6 text-[14px]" disabled={!connected || !armed || !caps.arm} onClick={disarm} title={t('flight.disarmTitle')}>{t('flight.disarmNow')}</button>
        </div>
      </section>

      <section className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-2">
        <div className="mc-card overflow-hidden">
          <div className="border-b px-5 py-4" style={{ borderColor: 'var(--border)' }}>
            <h2 className="text-[14px] font-bold" style={{ color: 'var(--text-primary)' }}>{t('flight.commands')}</h2>
            <p className="mt-1 text-[11px]" style={{ color: 'var(--text-secondary)' }}>{t('flight.commandsHint')}</p>
          </div>
          <div className="space-y-5 p-5">
            <div>
              <div className="flex items-center justify-between">
                <span className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>{t('flight.takeoffAltitude')}</span>
                <span className="mc-mono font-bold" style={{ color: 'var(--accent)' }}>{takeoffAltitude.toFixed(1)}m</span>
              </div>
              <input className="mt-4" type="range" min="1" max="10" step="0.5" value={takeoffAltitude} onChange={(event) => setTakeoffAltitude(Number(event.target.value))} />
            </div>
            <div className="grid grid-cols-3 gap-3">
              <button
                type="button"
                className="mc-btn mc-btn-primary min-h-10"
                disabled={!connected || !armed || !allChecksPassed || !caps.guidedTakeoff}
                onClick={() => send({
                  type: 'command',
                  cmd: 'MAV_CMD_NAV_TAKEOFF',
                  params: [0, 0, 0, 0, 0, 0, takeoffAltitude],
                  safetyConfirmation: 'takeoff',
                })}
              >
                {t('flight.takeoff')}
              </button>
              <button type="button" className="mc-btn min-h-10" disabled={!connected || !armed || !caps.setMode} style={{ background: 'var(--warning-dim)', color: 'var(--warning)' }} onClick={() => command('MAV_CMD_NAV_LAND', [0, 0, 0, 0, 0, 0, 0])}>{t('flight.land')}</button>
              <button type="button" className="mc-btn min-h-10" disabled={!connected || !armed || !caps.setMode} style={{ background: 'var(--info-dim)', color: 'var(--info)' }} onClick={() => command('MAV_CMD_NAV_RETURN_TO_LAUNCH', [0, 0, 0, 0, 0, 0, 0])}>{t('flight.rtl')}</button>
            </div>
          </div>
        </div>

        <div className="mc-card overflow-hidden">
          <div className="border-b px-5 py-4" style={{ borderColor: 'var(--border)' }}>
            <h2 className="text-[14px] font-bold" style={{ color: 'var(--text-primary)' }}>{t('flight.modeTitle')}</h2>
            <p className="mt-1 text-[11px]" style={{ color: 'var(--text-secondary)' }}>{t('flight.modeHint')}</p>
          </div>
          <div className="grid grid-cols-2 gap-2 p-5 sm:grid-cols-3">
            {modeOptions.length === 0 && (
              <p className="col-span-full text-[12px]" style={{ color: 'var(--text-secondary)' }}>
                {connected ? t('flight.modeNotSupported') : t('flight.connectToShowModes')}
              </p>
            )}
            {modeOptions.map((mode) => (
              <button
                key={mode.id}
                type="button"
                disabled={!connected}
                className="mc-btn min-h-10"
                style={vehicle?.modeId === mode.id ? { background: 'var(--accent)', color: '#fff' } : { background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
                onClick={() => setMode(mode.id)}
              >
                {mode.name}
              </button>
            ))}
          </div>
        </div>
      </section>

      <section className="mt-4 grid grid-cols-1 gap-4">
        <div className="mc-card overflow-hidden">
          <div className="border-b px-5 py-4" style={{ borderColor: 'var(--border)' }}>
            <h2 className="text-[14px] font-bold" style={{ color: 'var(--text-primary)' }}>{t('flight.preflightCheck')}</h2>
          </div>
          <div className="grid grid-cols-1 gap-x-6 gap-y-3 p-5 sm:grid-cols-2">
            {checks.map((check) => (
              <div key={check.label} className="flex items-center gap-3">
                <span className="grid h-6 w-6 place-items-center rounded-lg" style={{ background: check.ok ? 'var(--success-dim)' : 'var(--danger-dim)', color: check.ok ? 'var(--success)' : 'var(--danger)' }}>
                  <Icon name={check.ok ? 'check' : 'warning'} size={14} />
                </span>
                <span className="text-[13px]" style={{ color: check.ok ? 'var(--text-primary)' : 'var(--text-secondary)' }}>{check.label}</span>
              </div>
            ))}
            <div className="col-span-full mt-2 rounded-xl px-4 py-3 text-[12px] font-semibold" style={{ background: allChecksPassed ? 'var(--success-dim)' : 'var(--warning-dim)', color: allChecksPassed ? 'var(--success)' : 'var(--warning)' }}>
              {allChecksPassed ? t('flight.allChecksPassed') : t('flight.checksNotPassed')}
            </div>
            {latestArmMessage && (
              <div className="col-span-full rounded-xl px-4 py-3 text-[11px]" style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}>
                {t('flight.latestFcFeedback', { text: latestArmMessage.text })}
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  )
}
