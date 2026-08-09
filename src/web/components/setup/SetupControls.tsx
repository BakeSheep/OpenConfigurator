import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { VehicleConfigFeature, VehicleConfigField } from '../../../shared/vehicleSetupProfiles'
import { isSafetyReduction } from '../../../shared/vehicleSetupProfiles'
import type { ParameterEnumOption } from '../../utils/parameterEnumMetadata'
import { sendClientMessage } from '../../hooks/useWebSocket'
import { useConnectionStore } from '../../stores/connectionStore'
import { useParameterStore } from '../../stores/parameterStore'
import { useTelemetryStore } from '../../stores/telemetryStore'
import { useVehicleSetupStore } from '../../stores/vehicleSetupStore'
import Icon from '../ui/Icon'

export function setupRequestId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

export function SetupNotice({ state, children }: { state: 'detected' | 'waiting' | 'warning'; children: ReactNode }) {
  return (
    <div className="mc-capability-note" data-state={state} role="status">
      <Icon name={state === 'detected' ? 'check' : 'warning'} size={15} />
      <span>{children}</span>
    </div>
  )
}

export function ConfirmDialog({
  title,
  description,
  confirmLabel,
  danger = false,
  onConfirm,
  onCancel,
}: {
  title: string
  description: string
  confirmLabel: string
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  const { t } = useTranslation()
  return (
    <div className="mc-modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="setup-confirm-title">
      <section className="mc-card mc-modal mc-setup-confirm">
        <span className="mc-setup-confirm__icon"><Icon name="warning" size={22} /></span>
        <h2 id="setup-confirm-title">{title}</h2>
        <p>{description}</p>
        <footer>
          <button type="button" className="mc-btn mc-btn-ghost" onClick={onCancel}>{t('common.cancel')}</button>
          <button type="button" className={`mc-btn ${danger ? 'mc-btn-danger' : 'mc-btn-primary'}`} onClick={onConfirm}>{confirmLabel}</button>
        </footer>
      </section>
    </div>
  )
}

export function ConfigFieldControl({
  feature,
  field,
  options,
  label,
}: {
  feature: VehicleConfigFeature
  field: VehicleConfigField
  options?: ParameterEnumOption[] | null
  label?: string
}) {
  const { t } = useTranslation()
  const param = useParameterStore((state) => state.params.get(field.id))
  const configResults = useVehicleSetupStore((state) => state.configResults)
  const vehicleReady = useConnectionStore((state) => state.vehicleReady)
  const canControl = useConnectionStore((state) => state.canControl)
  const armed = useTelemetryStore((state) => state.status?.armed)
  const [draft, setDraft] = useState(param?.value?.toString() ?? '')
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirmation, setConfirmation] = useState<number | null>(null)

  useEffect(() => setDraft(param?.value?.toString() ?? ''), [param?.value])
  const result = pending ? configResults.get(pending) : undefined
  useEffect(() => {
    if (!pending || !result) return
    setError(result.accepted ? null : result.reason ?? t('vehicleSetup.writeFailed'))
    setPending(null)
  }, [pending, result, t])

  const mergedOptions = useMemo(() => {
    if (!options?.length || !param) return options ?? []
    return options.some((option) => option.value === param.value)
      ? options
      : [{ value: param.value, label: `${t('vehicleSetup.unknownValue')} (${param.value})` }, ...options]
  }, [options, param, t])

  const send = (value: number, confirmed = false) => {
    if (!param || value === param.value || !Number.isFinite(value)) {
      setDraft(param?.value?.toString() ?? '')
      return
    }
    if (feature === 'safety' && isSafetyReduction(field.id, param.value, value) && !confirmed) {
      setConfirmation(value)
      return
    }
    const requestId = setupRequestId(`cfg-${field.id}`)
    const sent = sendClientMessage({
      type: 'vehicle_config_set',
      requestId,
      feature,
      data: { id: field.id, value },
      ...(confirmed ? { safetyConfirmation: 'reduce_failsafe_protection' as const } : {}),
    })
    if (sent) {
      setPending(requestId)
      setError(null)
    } else {
      setError(t('vehicleSetup.connectionUnavailable'))
      setDraft(param.value.toString())
    }
  }

  if (!param) return null
  const disabled = !vehicleReady || !canControl || armed !== false || Boolean(pending)
  const control = mergedOptions.length > 0 || field.kind === 'channel'
    ? (
        <select
          className="mc-select"
          value={param.value}
          disabled={disabled}
          onChange={(event) => send(Number(event.target.value))}
          aria-label={label ?? field.label}
        >
          {field.kind === 'channel'
            ? [<option key={0} value={0}>{t('vehicleSetup.disabled')}</option>, ...Array.from({ length: field.max ?? 18 }, (_, index) => (
                <option key={index + 1} value={index + 1}>CH{index + 1}</option>
              ))]
            : mergedOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      )
    : (
        <input
          className="mc-input mc-mono"
          type="number"
          value={draft}
          min={field.min}
          max={field.max}
          step={field.step ?? 'any'}
          disabled={disabled}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => send(Number(draft))}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur()
            if (event.key === 'Escape') { setDraft(param.value.toString()); event.currentTarget.blur() }
          }}
          aria-label={label ?? field.label}
        />
      )

  return (
    <div className="mc-setup-field" data-pending={Boolean(pending)}>
      <label htmlFor={undefined}>
        <span>{label ?? field.label}</span>
        <code>{field.id}</code>
      </label>
      <div className="mc-setup-field__control">
        {control}
        {field.unit && <span>{field.unit}</span>}
        {pending && <span className="mc-setup-field__spinner" aria-label={t('vehicleSetup.writing')} />}
      </div>
      {error && <small className="mc-setup-field__error" role="alert">{error}</small>}
      {confirmation !== null && (
        <ConfirmDialog
          title={t('vehicleSetup.reduceSafetyTitle')}
          description={t('vehicleSetup.reduceSafetyDescription', { parameter: field.id })}
          confirmLabel={t('vehicleSetup.confirmReduction')}
          danger
          onCancel={() => { setConfirmation(null); setDraft(param.value.toString()) }}
          onConfirm={() => { const value = confirmation; setConfirmation(null); send(value, true) }}
        />
      )}
    </div>
  )
}
