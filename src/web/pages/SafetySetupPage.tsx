import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { setupFields, type VehicleConfigField } from '../../shared/vehicleSetupProfiles'
import { vehicleCapabilities } from '../../shared/vehicleProfiles'
import { ConfigFieldControl, SetupNotice } from '../components/setup/SetupControls'
import { useConnectionStore } from '../stores/connectionStore'
import { useParameterStore } from '../stores/parameterStore'
import { useTelemetryStore } from '../stores/telemetryStore'
import { parameterEnumOptions } from '../utils/parameterEnumMetadata'

function batteryFailsafeField(id: string): VehicleConfigField {
  const action = id.endsWith('_ACT')
  const mah = id.endsWith('_MAH')
  return {
    id,
    label: id,
    group: 'Battery failsafe',
    kind: action ? 'enum' : 'number',
    min: action ? undefined : 0,
    unit: mah ? 'mAh' : action ? undefined : 'V',
    step: mah ? 10 : action ? undefined : 0.1,
  }
}

export default function SafetySetupPage() {
  const { t } = useTranslation()
  const identity = useTelemetryStore((state) => state.vehicleIdentity)
  const status = useTelemetryStore((state) => state.status)
  const params = useParameterStore((state) => state.params)
  const loading = useParameterStore((state) => state.loading)
  const vehicleReady = useConnectionStore((state) => state.vehicleReady)
  const caps = vehicleCapabilities(identity)
  const fields = useMemo(() => {
    const visible = setupFields(identity, 'safety').filter((field) => params.has(field.id))
    if (identity?.family === 'ardupilot') {
      for (const id of [...params.keys()]
        .filter((candidate) => /^BATT(?:[2-9]|[A-J])?_FS_(?:LOW|CRT)_(?:VOLT|MAH|ACT)$/.test(candidate))
        .sort()) {
        visible.push(batteryFailsafeField(id))
      }
    }
    return visible
  }, [identity, params])
  const groups = useMemo(() => fields.reduce((result, field) => {
    const items = result.get(field.group) ?? []
    items.push(field)
    result.set(field.group, items)
    return result
  }, new Map<string, VehicleConfigField[]>()), [fields])

  if (!caps.safetyConfig) {
    return <SetupNotice state="warning">{t('vehicleSetup.readOnlyProfile')}</SetupNotice>
  }

  return (
    <div className="mc-setup-page mc-fade-in">
      <section className="mc-card mc-safety-hero" data-state={status?.failsafe ?? 'unknown'}>
        <div>
          <span className="mc-eyebrow">{t('vehicleSetup.safetyOverview')}</span>
          <h3>{t(`vehicleSetup.failsafeState.${status?.failsafe ?? 'unknown'}`)}</h3>
          <p>{t('vehicleSetup.safetyHint')}</p>
        </div>
        <span className="mc-safety-status" aria-hidden="true" />
      </section>
      <SetupNotice state="warning">{t('vehicleSetup.safetyBenchWarning')}</SetupNotice>
      {!vehicleReady && <SetupNotice state="waiting">{t('receiver.waitingHint')}</SetupNotice>}
      {status?.armed !== false && vehicleReady && (
        <SetupNotice state="warning">
          {status?.armed ? t('vehicleSetup.disarmRequired') : t('vehicleSetup.armingUnknown')}
        </SetupNotice>
      )}
      {loading && <SetupNotice state="waiting">{t('settings.waitingParams')}</SetupNotice>}

      {[...groups].map(([group, groupFields]) => (
        <section className="mc-card mc-setup-panel" key={group}>
          <header>
            <div>
              <h3>{t(`vehicleSetup.group.${group}`, { defaultValue: group })}</h3>
              <p>{t('vehicleSetup.safetyGroupHint')}</p>
            </div>
            <span className="mc-setup-panel__count">{groupFields.length}</span>
          </header>
          <div className="mc-setup-fields">
            {groupFields.map((field) => (
              <ConfigFieldControl
                key={field.id}
                feature="safety"
                field={field}
                label={t(`vehicleSetup.field.${field.id}`, { defaultValue: field.label })}
                options={parameterEnumOptions(field.id, identity)}
              />
            ))}
          </div>
        </section>
      ))}
      {fields.length === 0 && !loading && (
        <SetupNotice state="warning">{t('vehicleSetup.parametersMissing')}</SetupNotice>
      )}
    </div>
  )
}
