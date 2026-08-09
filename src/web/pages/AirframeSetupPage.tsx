import { useEffect, useMemo, useState } from 'react'
import { NavLink } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ARDUCOPTER_FRAME_CLASSES, ARDUCOPTER_FRAME_OPTIONS, PX4_AIRFRAMES } from '../../shared/airframes'
import { vehicleCapabilities } from '../../shared/vehicleProfiles'
import { sendClientMessage } from '../hooks/useWebSocket'
import { useConnectionStore } from '../stores/connectionStore'
import { useParameterStore } from '../stores/parameterStore'
import { useTelemetryStore } from '../stores/telemetryStore'
import { useVehicleSetupStore } from '../stores/vehicleSetupStore'
import { buildFrameConfigView } from '../utils/vehicleConfig'
import { ConfirmDialog, SetupNotice, setupRequestId } from '../components/setup/SetupControls'
import Icon from '../components/ui/Icon'

export default function AirframeSetupPage() {
  const { t } = useTranslation()
  const params = useParameterStore((state) => state.params)
  const loading = useParameterStore((state) => state.loading)
  const identity = useTelemetryStore((state) => state.vehicleIdentity)
  const armed = useTelemetryStore((state) => state.status?.armed)
  const vehicleReady = useConnectionStore((state) => state.vehicleReady)
  const canControl = useConnectionStore((state) => state.canControl)
  const status = useVehicleSetupStore((state) => state.airframeStatus)
  const frameView = params.size ? buildFrameConfigView(identity, params) : null
  const caps = vehicleCapabilities(identity)
  const [search, setSearch] = useState('')
  const [selectedPx4, setSelectedPx4] = useState<number | null>(null)
  const currentClass = Math.round(params.get('FRAME_CLASS')?.value ?? 1)
  const currentType = Math.round(params.get('FRAME_TYPE')?.value ?? 1)
  const [frameClass, setFrameClass] = useState(currentClass)
  const [frameType, setFrameType] = useState(currentType)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const busy = status?.phase === 'validating' || status?.phase === 'writing' || status?.phase === 'rebooting'

  useEffect(() => {
    setFrameClass(currentClass)
    setFrameType(currentType)
  }, [currentClass, currentType])

  const filteredPx4 = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase()
    return PX4_AIRFRAMES.filter((entry) => !needle || `${entry.name} ${entry.group} ${entry.autostartId}`.toLocaleLowerCase().includes(needle))
  }, [search])
  const groupedPx4 = useMemo(() => filteredPx4.reduce((groups, entry) => {
    const items = groups.get(entry.group) ?? []
    items.push(entry)
    groups.set(entry.group, items)
    return groups
  }, new Map<string, typeof filteredPx4>()), [filteredPx4])
  const classTypes = ARDUCOPTER_FRAME_OPTIONS.filter((option) => option.frameClass === frameClass)
  const writable = vehicleReady && canControl && armed === false && caps.airframeSelection && !loading && !busy

  const apply = () => {
    const requestId = setupRequestId('airframe')
    const data = identity?.family === 'px4'
      ? selectedPx4 ? { family: 'px4' as const, autostartId: selectedPx4 } : null
      : identity?.family === 'ardupilot'
        ? { family: 'ardupilot' as const, frameClass, frameType }
        : null
    if (!data) return
    sendClientMessage({ type: 'airframe_apply', requestId, data, safetyConfirmation: 'apply_airframe' })
    setConfirmOpen(false)
  }

  const reboot = () => sendClientMessage({
    type: 'reboot_vehicle',
    requestId: setupRequestId('airframe-reboot'),
    safetyConfirmation: 'reboot_flight_controller',
  })

  return (
    <div className="mc-setup-page mc-fade-in">
      <section className="mc-card mc-setup-identity">
        <span className="mc-setup-identity__icon"><Icon name="flight" size={34} /></span>
        <div>
          <span className="mc-eyebrow">{t('settings.currentFrame')}</span>
          <h2>{frameView?.name ?? t('settings.waitingParams')}</h2>
          <p>{frameView?.frameSource ?? t('settings.autoIdentify')}</p>
        </div>
        {frameView && <code className="mc-setup-identity__protocol">{frameView.protocolLabel}</code>}
      </section>

      {!caps.airframeSelection && <SetupNotice state="warning">{t('vehicleSetup.readOnlyProfile')}</SetupNotice>}
      {armed !== false && vehicleReady && <SetupNotice state="warning">{armed ? t('vehicleSetup.disarmRequired') : t('vehicleSetup.armingUnknown')}</SetupNotice>}
      {status && (
        <SetupNotice state={status.phase === 'failed' ? 'warning' : status.phase === 'reboot_required' ? 'warning' : 'detected'}>
          {t(`vehicleSetup.airframePhase.${status.phase}`, { completed: status.completed, total: status.total, reason: status.reason ?? '' })}
          {status.phase === 'reboot_required' && <button type="button" className="mc-btn mc-btn-primary" onClick={reboot}>{t('vehicleSetup.rebootNow')}</button>}
        </SetupNotice>
      )}

      {identity?.family === 'px4' && (
        <>
          <div className="mc-setup-toolbar">
            <div>
              <h2>{t('vehicleSetup.chooseAirframe')}</h2>
              <p>{t('vehicleSetup.px4AirframeHint')}</p>
            </div>
            <input className="mc-input" value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t('vehicleSetup.searchAirframes')} />
          </div>
          <div className="mc-airframe-groups">
            {[...groupedPx4].map(([group, entries]) => (
              <section key={group} className="mc-airframe-group">
                <header><span className="mc-eyebrow">{group}</span><small>{entries.length}</small></header>
                <div className="mc-airframe-grid">
                  {entries.map((entry) => (
                    <button
                      type="button"
                      key={entry.autostartId}
                      className="mc-card mc-card--hover mc-airframe-card"
                      data-selected={selectedPx4 === entry.autostartId}
                      aria-pressed={selectedPx4 === entry.autostartId}
                      onClick={() => setSelectedPx4(entry.autostartId)}
                    >
                      <span className="mc-airframe-card__glyph"><Icon name="flight" size={22} /></span>
                      <strong>{entry.name}</strong>
                      <code>#{entry.autostartId}</code>
                      <small>{entry.outputs.slice(0, 3).join(' · ') || t('vehicleSetup.fcDefaults')}</small>
                    </button>
                  ))}
                </div>
              </section>
            ))}
          </div>
        </>
      )}

      {identity?.family === 'ardupilot' && identity.vehicleClass === 'copter' && (
        <section className="mc-card mc-setup-panel">
          <header><div><h2>{t('vehicleSetup.chooseAirframe')}</h2><p>{t('vehicleSetup.arduAirframeHint')}</p></div></header>
          <div className="mc-setup-form-grid">
            <label><span>{t('vehicleSetup.frameClass')}</span><select className="mc-select" value={frameClass} onChange={(event) => {
              const next = Number(event.target.value)
              setFrameClass(next)
              setFrameType(ARDUCOPTER_FRAME_OPTIONS.find((option) => option.frameClass === next)?.frameType ?? 0)
            }}>{Object.entries(ARDUCOPTER_FRAME_CLASSES).map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select></label>
            <label><span>{t('vehicleSetup.frameType')}</span><select className="mc-select" value={frameType} onChange={(event) => setFrameType(Number(event.target.value))}>{classTypes.map((option) => <option key={option.frameType} value={option.frameType}>{option.frameTypeName}</option>)}</select></label>
          </div>
        </section>
      )}

      <footer className="mc-setup-savebar">
        <div><strong>{t('vehicleSetup.airframeApplyTitle')}</strong><small>{t('vehicleSetup.airframeApplyHint')}</small></div>
        <div>
          <NavLink className="mc-btn mc-btn-ghost" to="/diagnostics">{t('vehicleSetup.openParameters')}</NavLink>
          <button type="button" className="mc-btn mc-btn-primary" disabled={!writable || (identity?.family === 'px4' && selectedPx4 === null)} onClick={() => setConfirmOpen(true)}>{busy ? t('vehicleSetup.writing') : t('vehicleSetup.applyAirframe')}</button>
        </div>
      </footer>

      {confirmOpen && <ConfirmDialog
        title={t('vehicleSetup.airframeConfirmTitle')}
        description={identity?.family === 'px4' ? t('vehicleSetup.px4ResetWarning') : t('vehicleSetup.arduRebootWarning')}
        confirmLabel={t('vehicleSetup.applyAirframe')}
        danger={identity?.family === 'px4'}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={apply}
      />}
    </div>
  )
}
