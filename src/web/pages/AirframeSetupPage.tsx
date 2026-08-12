import { useEffect, useMemo, useState } from 'react'
import { NavLink } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import {
  ARDUCOPTER_FRAME_CLASSES,
  ARDUCOPTER_FRAME_OPTIONS,
  PX4_AIRFRAMES,
} from '../../shared/airframes'
import { vehicleCapabilities } from '../../shared/vehicleProfiles'
import { sendClientMessage } from '../hooks/useWebSocket'
import { useConnectionStore } from '../stores/connectionStore'
import { useParameterStore } from '../stores/parameterStore'
import { useTelemetryStore } from '../stores/telemetryStore'
import { useVehicleSetupStore } from '../stores/vehicleSetupStore'
import { buildFrameConfigView } from '../utils/vehicleConfig'
import { setupRequestId, SetupNotice } from '../components/setup/SetupControls'
import { Button } from '../components/ui/Button'
import ConfirmDialog from '../components/ui/ConfirmDialog'
import Field from '../components/ui/Field'
import Icon from '../components/ui/Icon'

interface AirframeCommitment {
  epoch: number
  authorityId: string
  selectionKey: string
}

export default function AirframeSetupPage() {
  const { t } = useTranslation()
  const params = useParameterStore((state) => state.params)
  const loading = useParameterStore((state) => state.loading)
  const identity = useTelemetryStore((state) => state.vehicleIdentity)
  const armed = useTelemetryStore((state) => state.status?.armed)
  const vehicleReady = useConnectionStore((state) => state.vehicleReady)
  const canControl = useConnectionStore((state) => state.canControl)
  const safetyEpoch = useConnectionStore((state) => state.safetyEpoch)
  const safetyAuthorityId = useConnectionStore((state) => state.safetyAuthorityId)
  const status = useVehicleSetupStore((state) => state.airframeStatus)
  const frameView = params.size ? buildFrameConfigView(identity, params) : null
  const caps = vehicleCapabilities(identity)
  const [search, setSearch] = useState('')
  const [selectedPx4, setSelectedPx4] = useState<number | null>(null)
  const currentClass = Math.round(params.get('FRAME_CLASS')?.value ?? 1)
  const currentType = Math.round(params.get('FRAME_TYPE')?.value ?? 1)
  const [frameClass, setFrameClass] = useState(currentClass)
  const [frameType, setFrameType] = useState(currentType)
  const [commitment, setCommitment] = useState<AirframeCommitment | null>(null)
  const [contextError, setContextError] = useState<string | null>(null)
  const busy = status?.phase === 'validating' || status?.phase === 'writing' || status?.phase === 'rebooting'

  useEffect(() => {
    setFrameClass(currentClass)
    setFrameType(currentType)
  }, [currentClass, currentType])

  const filteredPx4 = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase()
    return PX4_AIRFRAMES.filter((entry) => (
      !needle
      || `${entry.name} ${entry.group} ${entry.autostartId}`.toLocaleLowerCase().includes(needle)
    ))
  }, [search])
  const groupedPx4 = useMemo(() => filteredPx4.reduce((groups, entry) => {
    const items = groups.get(entry.group) ?? []
    items.push(entry)
    groups.set(entry.group, items)
    return groups
  }, new Map<string, typeof filteredPx4>()), [filteredPx4])
  const classTypes = ARDUCOPTER_FRAME_OPTIONS.filter((option) => option.frameClass === frameClass)
  const selectionKey = identity?.family === 'px4'
    ? `px4:${selectedPx4 ?? '-'}`
    : identity?.family === 'ardupilot'
      ? `ardupilot:${frameClass}:${frameType}`
      : 'unsupported'
  const writable = vehicleReady
    && canControl
    && armed === false
    && caps.airframeSelection
    && !loading
    && !busy
    && safetyAuthorityId !== null

  const openConfirmation = () => {
    const connection = useConnectionStore.getState()
    if (!writable || connection.safetyAuthorityId === null) return
    setContextError(null)
    setCommitment({
      epoch: connection.safetyEpoch,
      authorityId: connection.safetyAuthorityId,
      selectionKey,
    })
  }

  const apply = () => {
    const confirmed = commitment
    const connection = useConnectionStore.getState()
    const liveArmed = useTelemetryStore.getState().status?.armed
    const liveSelectionKey = identity?.family === 'px4'
      ? `px4:${selectedPx4 ?? '-'}`
      : identity?.family === 'ardupilot'
        ? `ardupilot:${frameClass}:${frameType}`
        : 'unsupported'
    if (
      !confirmed
      || !connection.vehicleReady
      || !connection.canControl
      || liveArmed !== false
      || connection.safetyAuthorityId !== confirmed.authorityId
      || connection.safetyEpoch !== confirmed.epoch
      || liveSelectionKey !== confirmed.selectionKey
    ) {
      setCommitment(null)
      setContextError(t('vehicleSetup.safetyContextChanged'))
      return
    }
    const data = identity?.family === 'px4'
      ? selectedPx4 === null ? null : { family: 'px4' as const, autostartId: selectedPx4 }
      : identity?.family === 'ardupilot'
        ? { family: 'ardupilot' as const, frameClass, frameType }
        : null
    if (!data) return
    sendClientMessage({
      type: 'airframe_apply',
      requestId: setupRequestId('airframe'),
      data,
      safetyConfirmation: 'apply_airframe',
      expectedSafetyEpoch: confirmed.epoch,
      expectedSafetyAuthorityId: confirmed.authorityId,
    })
    setCommitment(null)
  }

  return (
    <div className="mc-setup-page mc-fade-in">
      <section className="mc-card mc-setup-identity">
        <span className="mc-setup-identity__icon"><Icon name="flight" size={30} /></span>
        <div>
          <span className="mc-eyebrow">{t('settings.currentFrame')}</span>
          <h3>{frameView?.name ?? t('settings.waitingParams')}</h3>
          <p>{frameView?.frameSource ?? t('settings.autoIdentify')}</p>
        </div>
        {frameView && <code className="mc-setup-identity__protocol">{frameView.protocolLabel}</code>}
      </section>

      {!caps.airframeSelection && <SetupNotice state="warning">{t('vehicleSetup.readOnlyProfile')}</SetupNotice>}
      {armed !== false && vehicleReady && (
        <SetupNotice state="warning">
          {armed ? t('vehicleSetup.disarmRequired') : t('vehicleSetup.armingUnknown')}
        </SetupNotice>
      )}
      {contextError && <SetupNotice state="warning">{contextError}</SetupNotice>}
      {status && (
        <SetupNotice state={status.phase === 'done' ? 'detected' : status.phase === 'failed' || status.phase === 'reboot_required' ? 'warning' : 'waiting'}>
          {t(`vehicleSetup.airframePhase.${status.phase}`, {
            completed: status.completed,
            total: status.total,
            reason: status.reason ?? '',
          })}
        </SetupNotice>
      )}

      {identity?.family === 'px4' && (
        <section className="mc-card mc-setup-panel">
          <header>
            <div>
              <h3>{t('vehicleSetup.chooseAirframe')}</h3>
              <p>{t('vehicleSetup.px4AirframeHint')}</p>
            </div>
          </header>
          <div className="mc-airframe-picker">
            <Field label={t('vehicleSetup.searchAirframes')} controlId="airframe-search">
              <input
                id="airframe-search"
                className="mc-input"
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={t('vehicleSetup.searchAirframes')}
              />
            </Field>
            <div className="mc-airframe-groups">
              {[...groupedPx4].map(([group, entries]) => (
                <section key={group} className="mc-airframe-group">
                  <header><strong>{group}</strong><small>{entries.length}</small></header>
                  <div className="mc-airframe-grid">
                    {entries.map((entry) => (
                      <button
                        type="button"
                        key={entry.autostartId}
                        className="mc-airframe-card"
                        data-selected={selectedPx4 === entry.autostartId}
                        aria-pressed={selectedPx4 === entry.autostartId}
                        onClick={() => setSelectedPx4(entry.autostartId)}
                      >
                        <span className="mc-airframe-card__glyph"><Icon name="flight" size={18} /></span>
                        <strong>{entry.name}</strong>
                        <code>#{entry.autostartId}</code>
                        <small>{entry.outputs.slice(0, 3).join(' · ') || t('vehicleSetup.fcDefaults')}</small>
                      </button>
                    ))}
                  </div>
                </section>
              ))}
              {filteredPx4.length === 0 && <p className="mc-setup-empty">{t('vehicleSetup.noAirframeMatches')}</p>}
            </div>
          </div>
        </section>
      )}

      {identity?.family === 'ardupilot' && identity.vehicleClass === 'copter' && (
        <section className="mc-card mc-setup-panel">
          <header>
            <div>
              <h3>{t('vehicleSetup.chooseAirframe')}</h3>
              <p>{t('vehicleSetup.arduAirframeHint')}</p>
            </div>
          </header>
          <div className="mc-setup-form-grid">
            <Field label={t('vehicleSetup.frameClass')} controlId="airframe-class">
              <select
                id="airframe-class"
                className="mc-select"
                value={frameClass}
                onChange={(event) => {
                  const next = Number(event.target.value)
                  setFrameClass(next)
                  setFrameType(ARDUCOPTER_FRAME_OPTIONS.find((option) => option.frameClass === next)?.frameType ?? 0)
                }}
              >
                {Object.entries(ARDUCOPTER_FRAME_CLASSES).map(([value, name]) => (
                  <option key={value} value={value}>{name}</option>
                ))}
              </select>
            </Field>
            <Field label={t('vehicleSetup.frameType')} controlId="airframe-type">
              <select
                id="airframe-type"
                className="mc-select"
                value={frameType}
                onChange={(event) => setFrameType(Number(event.target.value))}
              >
                {classTypes.map((option) => (
                  <option key={option.frameType} value={option.frameType}>{option.frameTypeName}</option>
                ))}
              </select>
            </Field>
          </div>
        </section>
      )}

      <footer className="mc-setup-savebar">
        <div>
          <strong>{t('vehicleSetup.airframeApplyTitle')}</strong>
          <small>{t('vehicleSetup.airframeApplyHint')}</small>
        </div>
        <div>
          <NavLink className="mc-button" data-tone="quiet" data-size="compact" to="/diagnostics">
            {t('vehicleSetup.openParameters')}
          </NavLink>
          <Button
            tone="primary"
            disabled={!writable || (identity?.family === 'px4' && selectedPx4 === null)}
            onClick={openConfirmation}
          >
            {busy ? t('vehicleSetup.writing') : t('vehicleSetup.applyAirframe')}
          </Button>
        </div>
      </footer>

      <ConfirmDialog
        open={commitment !== null}
        title={t('vehicleSetup.airframeConfirmTitle')}
        consequence={identity?.family === 'px4'
          ? t('vehicleSetup.px4ResetWarning')
          : t('vehicleSetup.arduRebootWarning')}
        commitmentLabel={t('vehicleSetup.airframeCommitment')}
        confirmLabel={t('vehicleSetup.applyAirframe')}
        cancelLabel={t('common.cancel')}
        closeLabel={t('common.close')}
        tone={identity?.family === 'px4' ? 'danger' : 'warning'}
        confirmationKey={commitment
          ? `${commitment.authorityId}:${commitment.epoch}:${commitment.selectionKey}:${safetyAuthorityId ?? '-'}:${safetyEpoch}`
          : ''}
        onCancel={() => setCommitment(null)}
        onConfirm={apply}
      />
    </div>
  )
}
