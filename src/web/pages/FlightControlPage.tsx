import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { availableModes, vehicleCapabilities } from '../../shared/vehicleProfiles'
import Icon from '../components/ui/Icon'
import { WorkspaceFrame } from '../components/ui/PageFrame'
import { Card, CardBody, CardHeader } from '../components/ui/Card'
import { Notice } from '../components/ui/Feedback'
import ArmSafetyControl from '../components/safety/ArmSafetyControl'
import { sendRuntimeCommand } from '../hooks/useLocalRuntime'
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
  const send = sendRuntimeCommand
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
  const safetyEpoch = useConnectionStore((state) => state.safetyEpoch)
  const safetyAuthorityId = useConnectionStore((state) => state.safetyAuthorityId)
  const connected = vehicleReady && canControl
  const [takeoffAltitude, setTakeoffAltitude] = useState(2.5)
  const [, refreshPrearmExpiry] = useState(0)
  const armed = vehicle?.armed ?? false

  const arm = () => {
    const connection = useConnectionStore.getState()
    const telemetry = useTelemetryStore.getState()
    const liveCaps = vehicleCapabilities(telemetry.vehicleIdentity)
    if (
      !connection.vehicleReady
      || !connection.canControl
      || connection.safetyAuthorityId === null
      || connection.safetyEpoch !== safetyEpoch
      || connection.safetyAuthorityId !== safetyAuthorityId
      || !liveCaps.writeOperations
      || !liveCaps.arm
      || telemetry.status?.armed === true
      || telemetry.preflightCheck === false
      || telemetry.sensorsHealthy === false
    ) return
    send({
      type: 'command',
      cmd: 'MAV_CMD_COMPONENT_ARM_DISARM',
      params: [1, 0, 0, 0, 0, 0, 0],
      safetyConfirmation: 'arm',
      expectedSafetyEpoch: connection.safetyEpoch,
      expectedSafetyAuthorityId: connection.safetyAuthorityId,
    })
  }

  const disarm = () => send({
    type: 'command',
    cmd: 'MAV_CMD_COMPONENT_ARM_DISARM',
    params: [0, 0, 0, 0, 0, 0, 0],
    safetyConfirmation: 'disarm',
  })
  const takeoff = () => {
    const connection = useConnectionStore.getState()
    const telemetry = useTelemetryStore.getState()
    const liveCaps = vehicleCapabilities(telemetry.vehicleIdentity)
    if (
      !connection.vehicleReady
      || !connection.canControl
      || connection.safetyAuthorityId === null
      || connection.safetyEpoch !== safetyEpoch
      || connection.safetyAuthorityId !== safetyAuthorityId
      || telemetry.status?.armed !== true
      || !liveCaps.guidedTakeoff
    ) return
    send({
      type: 'command',
      cmd: 'MAV_CMD_NAV_TAKEOFF',
      params: [0, 0, 0, 0, 0, 0, takeoffAltitude],
      safetyConfirmation: 'takeoff',
      expectedSafetyEpoch: connection.safetyEpoch,
      expectedSafetyAuthorityId: connection.safetyAuthorityId,
    })
  }
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
    <WorkspaceFrame title={t('flight.title')} className="mc-workspace-frame--flight">

      {vehicleReady && !canControl && (
        <Notice tone="warning" title={t('flight.readOnlyTitle')}>
          {t('flight.readOnlyControl')}
        </Notice>
      )}

      {connected && !caps.arm && (
        <Notice tone="warning" title={t('flight.armNotSupported')}>
          {t('flight.writeNotSupported', { type: vehicleIdentity ? `${vehicleIdentity.family}/${vehicleIdentity.vehicleClass}` : t('flight.unrecognized') })}
        </Notice>
      )}

      <section className="mc-card overflow-hidden mt-4">
        <div className="flex flex-col gap-5 p-5 md:flex-row md:items-center">
          <span className="grid h-12 w-12 place-items-center rounded-xl" style={{ background: armed ? 'var(--success-dim)' : 'var(--bg-tertiary)', color: armed ? 'var(--success)' : 'var(--text-disabled)' }}>
            <Icon name="flight" size={23} />
          </span>
          <div className="flex-1">
            <p className="text-[18px] font-bold" style={{ color: armed ? 'var(--success)' : 'var(--text-primary)' }}>{armed ? t('flight.armed') : t('flight.disarmed')}</p>
            <p className="mt-1 text-[12px]" style={{ color: 'var(--text-secondary)' }}>{t('flight.currentMode', { mode: vehicle?.mode ?? '-' })}</p>
          </div>
          <div className="mc-flight-arm-safety">
            <div className="mc-arm-control">
              <ArmSafetyControl
                armed={armed}
                canArm={connected && allChecksPassed && caps.arm}
                canChangeArmState={connected && caps.arm}
                onArm={arm}
                onDisarm={disarm}
                safetyKey={`${safetyAuthorityId ?? '-'}:${safetyEpoch}`}
                describedBy="flight-arm-guidance"
              />
            </div>
            <p id="flight-arm-guidance" role={!allChecksPassed ? 'status' : undefined}>
              {!connected
                ? (!vehicleReady ? t('flight.waitingHeartbeat') : t('flight.readOnlyControl'))
                : armed
                  ? t('flight.disarmNow')
                  : !caps.arm
                  ? t('flight.armNotSupported')
                  : allChecksPassed
                    ? t('topbar.arm.dragToConfirm')
                    : t('flight.checksNotPassed')}
            </p>
          </div>
        </div>
      </section>

      <section className="mt-4 grid grid-cols-1 gap-4">
        <Card>
          <CardHeader headingLevel={2} title={t('flight.preflightCheck')} />
          <CardBody className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
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
          </CardBody>
        </Card>
      </section>

      <section className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader headingLevel={2} title={t('flight.commands')} description={t('flight.commandsHint')} />
          <CardBody className="space-y-5">
            <div>
              <div className="flex items-center justify-between">
                <label htmlFor="flight-takeoff-altitude" className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>{t('flight.takeoffAltitude')}</label>
                <span className="mc-mono font-bold" style={{ color: 'var(--accent)' }}>{takeoffAltitude.toFixed(1)}m</span>
              </div>
              <input id="flight-takeoff-altitude" className="mt-4" type="range" min="1" max="10" step="0.5" value={takeoffAltitude} aria-valuetext={`${takeoffAltitude.toFixed(1)} m`} onChange={(event) => setTakeoffAltitude(Number(event.target.value))} />
            </div>
            <div className="grid grid-cols-3 gap-3">
              <button
                type="button"
                className="mc-btn mc-btn-primary mc-btn--prominent"
                disabled={!connected || !armed || !allChecksPassed || !caps.guidedTakeoff}
                onClick={takeoff}
              >
                {t('flight.takeoff')}
              </button>
              <button type="button" className="mc-btn mc-btn--prominent" disabled={!connected || !armed || !caps.setMode} style={{ background: 'var(--warning-dim)', color: 'var(--warning)' }} onClick={() => command('MAV_CMD_NAV_LAND', [0, 0, 0, 0, 0, 0, 0])}>{t('flight.land')}</button>
              <button type="button" className="mc-btn mc-btn--prominent" disabled={!connected || !armed || !caps.setMode} style={{ background: 'var(--info-dim)', color: 'var(--info)' }} onClick={() => command('MAV_CMD_NAV_RETURN_TO_LAUNCH', [0, 0, 0, 0, 0, 0, 0])}>{t('flight.rtl')}</button>
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader headingLevel={2} title={t('flight.modeTitle')} description={t('flight.modeHint')} />
          <CardBody className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {modeOptions.length === 0 && (
              <p className="col-span-full text-[12px]" style={{ color: 'var(--text-secondary)' }}>
                {vehicleReady ? t('flight.modeNotSupported') : t('flight.connectToShowModes')}
              </p>
            )}
            {modeOptions.map((mode) => (
              <button
                key={mode.id}
                type="button"
                disabled={!connected}
                className="mc-btn mc-btn--prominent"
                style={vehicle?.modeId === mode.id
                  ? { background: 'var(--mc-color-accent-solid)', color: 'var(--mc-color-on-accent)' }
                  : { background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
                onClick={() => setMode(mode.id)}
              >
                {mode.name}
              </button>
            ))}
          </CardBody>
        </Card>
      </section>

    </WorkspaceFrame>
  )
}
