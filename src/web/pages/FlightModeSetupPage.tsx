import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { RcChannelsData } from '../../shared/types'
import {
  arduFlightModeSlot,
  calibratedPx4FlightModeSlot,
  setupFields,
  type VehicleConfigField,
} from '../../shared/vehicleSetupProfiles'
import { availableModes, vehicleCapabilities } from '../../shared/vehicleProfiles'
import { ConfigFieldControl, setupRequestId, SetupNotice } from '../components/setup/SetupControls'
import { sendClientMessage } from '../hooks/useWebSocket'
import { useConnectionStore } from '../stores/connectionStore'
import { useParameterStore } from '../stores/parameterStore'
import { useTelemetryStore } from '../stores/telemetryStore'
import { parameterEnumLabel, parameterEnumOptions } from '../utils/parameterEnumMetadata'

function ModeMaskControl({ field, label }: { field: VehicleConfigField; label: string }) {
  const { t } = useTranslation()
  const param = useParameterStore((state) => state.params.get(field.id))
  const vehicleReady = useConnectionStore((state) => state.vehicleReady)
  const canControl = useConnectionStore((state) => state.canControl)
  const armed = useTelemetryStore((state) => state.status?.armed)
  if (!param) return null
  const value = Math.round(param.value)
  const toggle = (slot: number) => {
    const connection = useConnectionStore.getState()
    const liveParam = useParameterStore.getState().params.get(field.id)
    const liveArmed = useTelemetryStore.getState().status?.armed
    if (!connection.vehicleReady || !connection.canControl || liveArmed !== false || !liveParam) return
    sendClientMessage({
      type: 'vehicle_config_set',
      requestId: setupRequestId(`mask-${field.id}`),
      feature: 'flight_modes',
      data: { id: field.id, value: Math.round(liveParam.value) ^ (1 << slot) },
    })
  }
  return (
    <div className="mc-setup-field mc-mode-mask">
      <div className="mc-mode-mask__label"><span>{label}</span><code>{field.id}</code></div>
      <div role="group" aria-label={label}>
        {Array.from({ length: 6 }, (_, slot) => (
          <button
            type="button"
            key={slot}
            aria-pressed={Boolean(value & (1 << slot))}
            data-active={Boolean(value & (1 << slot))}
            disabled={!vehicleReady || !canControl || armed !== false}
            onClick={() => toggle(slot)}
          >
            {t('vehicleSetup.modeSlotShort', { slot: slot + 1 })}
          </button>
        ))}
      </div>
    </div>
  )
}

function rcValue(data: RcChannelsData | null, channel: number): number | null {
  if (!data || channel < 1 || channel > 18) return null
  const value = data[`ch${channel}` as keyof RcChannelsData]
  return typeof value === 'number' ? value : null
}

export default function FlightModeSetupPage() {
  const { t } = useTranslation()
  const identity = useTelemetryStore((state) => state.vehicleIdentity)
  const status = useTelemetryStore((state) => state.status)
  const rcChannels = useTelemetryStore((state) => state.rcChannels)
  const params = useParameterStore((state) => state.params)
  const loading = useParameterStore((state) => state.loading)
  const vehicleReady = useConnectionStore((state) => state.vehicleReady)
  const caps = vehicleCapabilities(identity)
  const fields = useMemo(() => {
    const base = setupFields(identity, 'flight_modes').filter((field) => params.has(field.id))
    if (identity?.family === 'ardupilot') {
      for (const id of [...params.keys()]
        .filter((candidate) => /^(?:RC(?:[6-9]|1[0-6])_OPTION|CH(?:[7-9]|1[0-6])_OPT)$/.test(candidate))
        .sort()) {
        base.push({ id, label: `${id.split('_')[0]} option`, group: 'Auxiliary functions', kind: 'enum' })
      }
    }
    return base
  }, [identity, params])
  const groups = useMemo(() => fields.reduce((result, field) => {
    const group = result.get(field.group) ?? []
    group.push(field)
    result.set(field.group, group)
    return result
  }, new Map<string, VehicleConfigField[]>()), [fields])

  const modeChannelId = identity?.family === 'px4' ? 'RC_MAP_FLTMODE' : 'FLTMODE_CH'
  const modeChannel = Math.round(params.get(modeChannelId)?.value ?? 0)
  const pwm = rcValue(rcChannels, modeChannel)
  let activeSlot: number | null = null
  if (identity?.family === 'px4' && modeChannel > 0) {
    const min = params.get(`RC${modeChannel}_MIN`)?.value ?? 1000
    const max = params.get(`RC${modeChannel}_MAX`)?.value ?? 2000
    const trim = params.get(`RC${modeChannel}_TRIM`)?.value ?? 1500
    const reverse = (params.get(`RC${modeChannel}_REV`)?.value ?? 1) < 0
    activeSlot = calibratedPx4FlightModeSlot(pwm, min, max, trim, reverse)
  } else if (identity?.family === 'ardupilot') {
    activeSlot = arduFlightModeSlot(pwm)
  }

  const modePrefix = identity?.family === 'px4' ? 'COM_FLTMODE' : 'FLTMODE'
  const channelAssignments = fields
    .filter((field) => field.kind === 'channel')
    .map((field) => ({ id: field.id, channel: Math.round(params.get(field.id)?.value ?? 0) }))
    .filter((entry) => entry.channel > 0)
  const conflicts = channelAssignments.filter((entry, index, all) => (
    all.findIndex((candidate) => candidate.channel === entry.channel) !== index
  ))
  const knownModes = availableModes(identity)

  if (!caps.flightModeConfig) {
    return <SetupNotice state="warning">{t('vehicleSetup.readOnlyProfile')}</SetupNotice>
  }

  return (
    <div className="mc-setup-page mc-fade-in">
      <section className="mc-card mc-mode-live">
        <header>
          <div>
            <span className="mc-eyebrow">{t('vehicleSetup.liveSwitch')}</span>
            <h3>{t('vehicleSetup.sixPositionModes')}</h3>
          </div>
          <code>{modeChannel ? `CH${modeChannel} · ${pwm ?? '—'} µs` : t('vehicleSetup.disabled')}</code>
        </header>
        <div className="mc-mode-slots" role="list" aria-label={t('vehicleSetup.sixPositionModes')}>
          {Array.from({ length: 6 }, (_, index) => {
            const id = `${modePrefix}${index + 1}`
            const value = params.get(id)?.value
            const label = value === undefined
              ? '—'
              : parameterEnumLabel(id, value, identity)
                ?? knownModes.find((mode) => mode.id === value)?.name
                ?? `${t('vehicleSetup.unknownValue')} ${value}`
            return (
              <div key={id} className="mc-mode-slot" data-active={activeSlot === index} role="listitem">
                <span>{index + 1}</span><strong>{label}</strong><small>{id}</small>
              </div>
            )
          })}
        </div>
      </section>

      {!vehicleReady && <SetupNotice state="waiting">{t('receiver.waitingHint')}</SetupNotice>}
      {status?.armed !== false && vehicleReady && (
        <SetupNotice state="warning">
          {status?.armed ? t('vehicleSetup.disarmRequired') : t('vehicleSetup.armingUnknown')}
        </SetupNotice>
      )}
      {loading && <SetupNotice state="waiting">{t('settings.waitingParams')}</SetupNotice>}
      {conflicts.length > 0 && (
        <SetupNotice state="warning">
          {t('vehicleSetup.channelConflict', {
            channels: [...new Set(conflicts.map((entry) => `CH${entry.channel}`))].join(', '),
          })}
        </SetupNotice>
      )}

      {identity?.family === 'px4' && channelAssignments.some((entry) => entry.id !== 'RC_MAP_FLTMODE') && (
        <section className="mc-switch-live-grid" aria-label={t('vehicleSetup.dedicatedSwitchState')}>
          {channelAssignments.filter((entry) => entry.id !== 'RC_MAP_FLTMODE').map((entry) => {
            const live = rcValue(rcChannels, entry.channel)
            return (
              <div className="mc-card" key={entry.id} data-active={live !== null && live >= 1500}>
                <code>{entry.id}</code><strong>CH{entry.channel}</strong><small>{live ?? '—'} µs</small>
              </div>
            )
          })}
        </section>
      )}

      {[...groups].map(([group, groupFields]) => (
        <section className="mc-card mc-setup-panel" key={group}>
          <header>
            <div>
              <h3>{t(`vehicleSetup.group.${group}`, { defaultValue: group })}</h3>
              <p>{t('vehicleSetup.immediateWriteHint')}</p>
            </div>
          </header>
          <div className="mc-setup-fields">
            {groupFields.map((field) => (
              field.id === 'SIMPLE' || field.id === 'SUPER_SIMPLE'
                ? <ModeMaskControl key={field.id} field={field} label={t(`vehicleSetup.field.${field.id}`, { defaultValue: field.label })} />
                : (
                    <ConfigFieldControl
                      key={field.id}
                      feature="flight_modes"
                      field={field}
                      label={t(`vehicleSetup.field.${field.id}`, { defaultValue: field.label })}
                      options={parameterEnumOptions(field.id, identity)}
                    />
                  )
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}
