import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  calibratedMultiplier,
  discoverBatteryConfigs,
  type VehicleConfigField,
} from '../../shared/vehicleSetupProfiles'
import { vehicleCapabilities } from '../../shared/vehicleProfiles'
import { ConfigFieldControl, SetupNotice, setupRequestId } from '../components/setup/SetupControls'
import { sendClientMessage } from '../hooks/useWebSocket'
import { useConnectionStore } from '../stores/connectionStore'
import { useParameterStore } from '../stores/parameterStore'
import { useTelemetryStore } from '../stores/telemetryStore'
import { useVehicleSetupStore } from '../stores/vehicleSetupStore'
import { parameterEnumOptions } from '../utils/parameterEnumMetadata'

const SUFFIX_META: Record<string, Omit<VehicleConfigField, 'id' | 'group'>> = {
  SOURCE: { label: 'Power source', kind: 'enum' },
  N_CELLS: { label: 'Cell count', kind: 'number', min: 0, max: 24, step: 1 },
  CAPACITY: { label: 'Capacity', kind: 'number', unit: 'mAh', min: 0, max: 100000, step: 10 },
  V_EMPTY: { label: 'Empty cell voltage', kind: 'number', unit: 'V', min: 2, max: 5, step: 0.01 },
  V_CHARGED: { label: 'Full cell voltage', kind: 'number', unit: 'V', min: 2, max: 5, step: 0.01 },
  V_DIV: { label: 'Voltage divider', kind: 'number', min: 0.01, max: 100, step: 0.001 },
  A_PER_V: { label: 'Current scale', kind: 'number', unit: 'A/V', min: 0.01, max: 1000, step: 0.001 },
  MONITOR: { label: 'Monitor type', kind: 'enum' },
  ARM_VOLT: { label: 'Minimum arming voltage', kind: 'number', unit: 'V', min: 0, max: 100, step: 0.1 },
  VOLT_MULT: { label: 'Voltage multiplier', kind: 'number', min: 0.01, max: 100, step: 0.001 },
  AMP_PERVLT: { label: 'Current multiplier', kind: 'number', unit: 'A/V', min: 0.01, max: 1000, step: 0.001 },
  AMP_OFFSET: { label: 'Current offset', kind: 'number', unit: 'V', min: -100, max: 100, step: 0.001 },
}

function fieldFor(id: string, prefix: string): VehicleConfigField {
  const suffix = id.slice(prefix.length)
  return { id, group: 'Battery', ...(SUFFIX_META[suffix] ?? { label: suffix, kind: 'number' }) }
}

export default function PowerSetupPage() {
  const { t } = useTranslation()
  const identity = useTelemetryStore((state) => state.vehicleIdentity)
  const batteries = useTelemetryStore((state) => state.batteries)
  const isBatteryStale = useTelemetryStore((state) => state.isBatteryStale)
  const status = useTelemetryStore((state) => state.status)
  const params = useParameterStore((state) => state.params)
  const loading = useParameterStore((state) => state.loading)
  const vehicleReady = useConnectionStore((state) => state.vehicleReady)
  const caps = vehicleCapabilities(identity)
  const instances = useMemo(() => discoverBatteryConfigs(identity, params), [identity, params])
  const [selectedIndex, setSelectedIndex] = useState(1)
  const selected = instances.find((instance) => instance.index === selectedIndex) ?? instances[0]
  const [calibrationId, setCalibrationId] = useState<string | null>(null)
  const [measured, setMeasured] = useState('')
  const [pendingCalibration, setPendingCalibration] = useState<string | null>(null)
  const results = useVehicleSetupStore((state) => state.configResults)
  const calibrationResult = pendingCalibration ? results.get(pendingCalibration) : undefined
  useEffect(() => {
    if (calibrationResult?.accepted) { setCalibrationId(null); setPendingCalibration(null); setMeasured('') }
  }, [calibrationResult])

  if (!caps.powerConfig) return <SetupNotice state="warning">{t('vehicleSetup.readOnlyProfile')}</SetupNotice>
  const telemetryId = Math.max(0, (selected?.index ?? 1) - 1)
  const telemetry = batteries.get(telemetryId)
  const stale = isBatteryStale(telemetryId)
  const currentParam = calibrationId ? params.get(calibrationId) : undefined
  const isVoltageCalibration = Boolean(calibrationId && /(?:V_DIV|VOLT_MULT)$/.test(calibrationId))
  const telemetryValue = isVoltageCalibration ? telemetry?.voltage : telemetry?.current
  const nextMultiplier = currentParam
    ? calibratedMultiplier(Number(measured), telemetryValue ?? 0, currentParam.value)
    : null

  const submitCalibration = () => {
    if (!calibrationId || nextMultiplier === null) return
    const requestId = setupRequestId(`power-cal-${calibrationId}`)
    if (sendClientMessage({ type: 'vehicle_config_set', requestId, feature: 'power', data: { id: calibrationId, value: nextMultiplier } })) {
      setPendingCalibration(requestId)
    }
  }

  return (
    <div className="mc-setup-page mc-fade-in">
      <section className="mc-card mc-power-hero">
        <div><span className="mc-eyebrow">{t('vehicleSetup.powerOverview')}</span><h2>{selected?.label ?? t('vehicleSetup.noBatteryConfig')}</h2><p>{t('vehicleSetup.powerHint')}</p></div>
        <div className="mc-power-live" data-stale={stale}>
          <span>{t('vehicleSetup.liveTelemetry')}</span>
          <strong>{telemetry?.voltage?.toFixed(2) ?? '—'} V</strong>
          <small>{telemetry?.current?.toFixed(2) ?? '—'} A · {telemetry?.remaining ?? '—'}%</small>
        </div>
      </section>

      {!vehicleReady && <SetupNotice state="waiting">{t('receiver.waitingHint')}</SetupNotice>}
      {status?.armed !== false && vehicleReady && <SetupNotice state="warning">{status?.armed ? t('vehicleSetup.disarmRequired') : t('vehicleSetup.armingUnknown')}</SetupNotice>}
      {loading && <SetupNotice state="waiting">{t('settings.waitingParams')}</SetupNotice>}
      {instances.length === 0 && !loading && <SetupNotice state="warning">{t('vehicleSetup.noBatteryConfig')}</SetupNotice>}

      {instances.length > 0 && (
        <>
          <div className="mc-setup-tabs" role="tablist" aria-label={t('vehicleSetup.batteryInstances')}>
            {instances.map((instance) => <button type="button" role="tab" aria-selected={instance.index === selected?.index} data-active={instance.index === selected?.index} key={instance.prefix} onClick={() => setSelectedIndex(instance.index)}>{instance.label}<code>{instance.prefix}</code></button>)}
          </div>
          <section className="mc-card mc-setup-panel">
            <header><div><h2>{selected.label}</h2><p>{t('vehicleSetup.immediateWriteHint')}</p></div></header>
            <div className="mc-setup-fields">
              {selected.parameterIds.map((id) => {
                const field = fieldFor(id, selected.prefix)
                const calibratable = /(?:V_DIV|VOLT_MULT|A_PER_V|AMP_PERVLT)$/.test(id)
                return <div className="mc-power-field" key={id}>
                  <ConfigFieldControl feature="power" field={field} label={t(`vehicleSetup.powerField.${id.slice(selected.prefix.length)}`, { defaultValue: field.label })} options={parameterEnumOptions(id, identity)} />
                  {calibratable && <button type="button" className="mc-btn mc-btn-ghost" disabled={stale || !telemetryValue} onClick={() => { setCalibrationId(id); setMeasured('') }}>{t('vehicleSetup.calibrate')}</button>}
                </div>
              })}
            </div>
          </section>
        </>
      )}

      {calibrationId && (
        <div className="mc-modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="power-calibration-title">
          <section className="mc-card mc-modal mc-setup-confirm">
            <h2 id="power-calibration-title">{t('vehicleSetup.meterCalibrationTitle')}</h2>
            <p>{t('vehicleSetup.meterCalibrationHint')}</p>
            <dl className="mc-calibration-math">
              <div><dt>{t('vehicleSetup.fcTelemetry')}</dt><dd>{telemetryValue?.toFixed(3) ?? '—'} {isVoltageCalibration ? 'V' : 'A'}</dd></div>
              <div><dt>{t('vehicleSetup.currentMultiplier')}</dt><dd>{currentParam?.value ?? '—'}</dd></div>
              <div><dt>{t('vehicleSetup.newMultiplier')}</dt><dd>{nextMultiplier?.toFixed(6) ?? '—'}</dd></div>
            </dl>
            <label className="mc-setup-dialog-field"><span>{t('vehicleSetup.measuredValue')}</span><input autoFocus className="mc-input mc-mono" type="number" min="0" step="0.001" value={measured} onChange={(event) => setMeasured(event.target.value)} /></label>
            {calibrationResult && !calibrationResult.accepted && <small className="mc-setup-field__error" role="alert">{calibrationResult.reason}</small>}
            <footer><button type="button" className="mc-btn mc-btn-ghost" onClick={() => setCalibrationId(null)}>{t('common.cancel')}</button><button type="button" className="mc-btn mc-btn-primary" disabled={nextMultiplier === null || Boolean(pendingCalibration)} onClick={submitCalibration}>{pendingCalibration ? t('vehicleSetup.writing') : t('vehicleSetup.applyCalibration')}</button></footer>
          </section>
        </div>
      )}
    </div>
  )
}
