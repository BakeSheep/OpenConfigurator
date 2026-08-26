import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  calibratedMultiplier,
  discoverBatteryConfigs,
  type VehicleConfigField,
} from '../../shared/vehicleSetupProfiles'
import { vehicleCapabilities } from '../../shared/vehicleProfiles'
import { ConfigFieldControl, setupRequestId, SetupNotice } from '../components/setup/SetupControls'
import { Button } from '../components/ui/Button'
import Dialog from '../components/ui/Dialog'
import Field from '../components/ui/Field'
import { PageTabs } from '../components/ui/PageFrame'
import { sendRuntimeCommand } from '../hooks/useLocalRuntime'
import { useConnectionStore } from '../stores/connectionStore'
import { useParameterStore } from '../stores/parameterStore'
import { useTelemetryStore } from '../stores/telemetryStore'
import { useVehicleSetupStore } from '../stores/vehicleSetupStore'
import { parameterEnumOptions } from '../utils/parameterEnumMetadata'
import { formatParameterValue } from '../utils/parameterDisplay'

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
  const armed = useTelemetryStore((state) => state.status?.armed)
  const params = useParameterStore((state) => state.params)
  const loading = useParameterStore((state) => state.loading)
  const vehicleReady = useConnectionStore((state) => state.vehicleReady)
  const canControl = useConnectionStore((state) => state.canControl)
  const caps = vehicleCapabilities(identity)
  const instances = useMemo(() => discoverBatteryConfigs(identity, params), [identity, params])
  const [selectedIndex, setSelectedIndex] = useState(1)
  const selected = instances.find((instance) => instance.index === selectedIndex) ?? instances[0]
  const [calibrationId, setCalibrationId] = useState<string | null>(null)
  const [measured, setMeasured] = useState('')
  const [pendingCalibration, setPendingCalibration] = useState<string | null>(null)
  const [calibrationError, setCalibrationError] = useState<string | null>(null)
  const results = useVehicleSetupStore((state) => state.configResults)
  const calibrationResult = pendingCalibration ? results.get(pendingCalibration) : undefined

  useEffect(() => {
    if (!calibrationResult) return
    setPendingCalibration(null)
    if (calibrationResult.accepted) {
      setCalibrationId(null)
      setMeasured('')
      setCalibrationError(null)
    } else {
      setCalibrationError(calibrationResult.reason ?? t('vehicleSetup.writeFailed'))
    }
  }, [calibrationResult, t])

  if (!caps.powerConfig) {
    return <SetupNotice state="warning">{t('vehicleSetup.readOnlyProfile')}</SetupNotice>
  }

  const telemetryId = Math.max(0, (selected?.index ?? 1) - 1)
  const telemetry = batteries.get(telemetryId)
  const stale = isBatteryStale(telemetryId)
  const currentParam = calibrationId ? params.get(calibrationId) : undefined
  const isVoltageCalibration = Boolean(calibrationId && /(?:V_DIV|VOLT_MULT)$/.test(calibrationId))
  const telemetryValue = isVoltageCalibration ? telemetry?.voltage : telemetry?.current
  const nextMultiplier = currentParam
    ? calibratedMultiplier(Number(measured), telemetryValue ?? 0, currentParam.value)
    : null
  const canWrite = vehicleReady && canControl && armed === false

  const submitCalibration = () => {
    const connection = useConnectionStore.getState()
    const liveArmed = useTelemetryStore.getState().status?.armed
    if (
      !calibrationId
      || nextMultiplier === null
      || !connection.vehicleReady
      || !connection.canControl
      || liveArmed !== false
    ) {
      setCalibrationError(t('vehicleSetup.writeContextChanged'))
      return
    }
    const requestId = setupRequestId(`power-cal-${calibrationId}`)
    if (sendRuntimeCommand({
      type: 'vehicle_config_set',
      requestId,
      feature: 'power',
      data: { id: calibrationId, value: nextMultiplier },
    })) {
      setPendingCalibration(requestId)
      setCalibrationError(null)
    } else {
      setCalibrationError(t('vehicleSetup.connectionUnavailable'))
    }
  }

  return (
    <div className="mc-setup-page mc-fade-in">
      {!vehicleReady && <SetupNotice state="waiting">{t('receiver.waitingHint')}</SetupNotice>}
      {armed !== false && vehicleReady && (
        <SetupNotice state="warning">
          {armed ? t('vehicleSetup.disarmRequired') : t('vehicleSetup.armingUnknown')}
        </SetupNotice>
      )}
      {loading && <SetupNotice state="waiting">{t('settings.waitingParams')}</SetupNotice>}
      {instances.length === 0 && !loading && (
        <SetupNotice state="warning">{t('vehicleSetup.noBatteryConfig')}</SetupNotice>
      )}

      {selected && (
        <>
          {instances.length > 1 && (
            <PageTabs
              tabs={instances.map((instance) => ({ id: String(instance.index), label: instance.label }))}
              active={String(selected.index)}
              onChange={(id) => setSelectedIndex(Number(id))}
              ariaLabel={t('vehicleSetup.batteryInstances')}
              idBase="battery-instances"
            />
          )}
          <section className="mc-card mc-setup-panel mc-power-panel">
            <header>
              <div>
                <h3>{selected.label}</h3>
                <p>{t('vehicleSetup.immediateWriteHint')}</p>
              </div>
              <div className="mc-power-live mc-power-live--inline" data-stale={stale}>
                <span>{t('vehicleSetup.liveTelemetry')}</span>
                <strong>{telemetry?.voltage?.toFixed(2) ?? '—'} V</strong>
                <small>{telemetry?.current?.toFixed(2) ?? '—'} A · {telemetry?.remaining ?? '—'}%</small>
              </div>
            </header>
            <div className="mc-setup-fields">
              {selected.parameterIds.map((id) => {
                const field = fieldFor(id, selected.prefix)
                const calibratable = /(?:V_DIV|VOLT_MULT|A_PER_V|AMP_PERVLT)$/.test(id)
                return (
                  <div className="mc-power-field" key={id}>
                    <ConfigFieldControl
                      feature="power"
                      field={field}
                      label={t(`vehicleSetup.powerField.${id.slice(selected.prefix.length)}`, { defaultValue: field.label })}
                      options={parameterEnumOptions(id, identity)}
                    />
                    {calibratable && (
                      <Button
                        tone="quiet"
                        disabled={!canWrite || stale || !telemetryValue}
                        onClick={() => {
                          setCalibrationId(id)
                          setMeasured('')
                          setCalibrationError(null)
                        }}
                      >
                        {t('vehicleSetup.calibrate')}
                      </Button>
                    )}
                  </div>
                )
              })}
            </div>
          </section>
        </>
      )}

      <Dialog
        open={calibrationId !== null}
        title={t('vehicleSetup.meterCalibrationTitle')}
        description={t('vehicleSetup.meterCalibrationHint')}
        closeLabel={t('common.close')}
        closeDisabled={pendingCalibration !== null}
        onClose={() => setCalibrationId(null)}
        footer={(
          <>
            <Button tone="quiet" disabled={pendingCalibration !== null} onClick={() => setCalibrationId(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              tone="primary"
              loading={pendingCalibration !== null}
              disabled={nextMultiplier === null}
              onClick={submitCalibration}
            >
              {pendingCalibration ? t('vehicleSetup.writing') : t('vehicleSetup.applyCalibration')}
            </Button>
          </>
        )}
      >
        <dl className="mc-calibration-math">
          <div><dt>{t('vehicleSetup.fcTelemetry')}</dt><dd>{telemetryValue?.toFixed(3) ?? '—'} {isVoltageCalibration ? 'V' : 'A'}</dd></div>
          <div><dt>{t('vehicleSetup.currentMultiplier')}</dt><dd>{currentParam ? formatParameterValue(currentParam.value) : '—'}</dd></div>
          <div><dt>{t('vehicleSetup.newMultiplier')}</dt><dd>{nextMultiplier?.toFixed(6) ?? '—'}</dd></div>
        </dl>
        <Field
          label={t('vehicleSetup.measuredValue')}
          controlId="power-calibration-value"
          error={calibrationError ?? undefined}
        >
          <input
            id="power-calibration-value"
            data-autofocus
            className="mc-input mc-mono"
            type="number"
            min="0"
            step="0.001"
            value={measured}
            onChange={(event) => setMeasured(event.target.value)}
          />
        </Field>
      </Dialog>
    </div>
  )
}
