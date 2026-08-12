import { useEffect, useId, useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  isSafetyReduction,
  type VehicleConfigFeature,
  type VehicleConfigField,
} from '../../../shared/vehicleSetupProfiles'
import type { ParameterEnumOption } from '../../utils/parameterEnumMetadata'
import { sendClientMessage } from '../../hooks/useWebSocket'
import { useConnectionStore } from '../../stores/connectionStore'
import { useParameterStore } from '../../stores/parameterStore'
import { useTelemetryStore } from '../../stores/telemetryStore'
import { useVehicleSetupStore } from '../../stores/vehicleSetupStore'
import ConfirmDialog from '../ui/ConfirmDialog'
import Field from '../ui/Field'
import { Notice } from '../ui/Feedback'

export function setupRequestId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

export function SetupNotice({
  state,
  children,
}: {
  state: 'detected' | 'waiting' | 'warning'
  children: ReactNode
}) {
  return (
    <Notice
      tone={state === 'detected' ? 'success' : state === 'waiting' ? 'info' : 'warning'}
      icon={state === 'detected' ? 'check' : undefined}
    >
      {children}
    </Notice>
  )
}

interface SafetyCommitment {
  value: number
  epoch: number
  authorityId: string
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
  const controlId = useId()
  const param = useParameterStore((state) => state.params.get(field.id))
  const configResults = useVehicleSetupStore((state) => state.configResults)
  const vehicleReady = useConnectionStore((state) => state.vehicleReady)
  const canControl = useConnectionStore((state) => state.canControl)
  const safetyEpoch = useConnectionStore((state) => state.safetyEpoch)
  const safetyAuthorityId = useConnectionStore((state) => state.safetyAuthorityId)
  const armed = useTelemetryStore((state) => state.status?.armed)
  const [draft, setDraft] = useState(param?.value?.toString() ?? '')
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirmation, setConfirmation] = useState<SafetyCommitment | null>(null)

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

  const send = (value: number, commitment?: SafetyCommitment) => {
    const liveParam = useParameterStore.getState().params.get(field.id)
    const connection = useConnectionStore.getState()
    const liveArmed = useTelemetryStore.getState().status?.armed
    if (!liveParam || value === liveParam.value || !Number.isFinite(value)) {
      setDraft(liveParam?.value?.toString() ?? '')
      return
    }
    if (!connection.vehicleReady || !connection.canControl || liveArmed !== false) {
      setError(t('vehicleSetup.writeContextChanged'))
      setDraft(liveParam.value.toString())
      return
    }

    const reduction = feature === 'safety' && isSafetyReduction(field.id, liveParam.value, value)
    if (reduction && !commitment) {
      if (connection.safetyAuthorityId === null) {
        setError(t('vehicleSetup.writeContextChanged'))
        return
      }
      setConfirmation({
        value,
        epoch: connection.safetyEpoch,
        authorityId: connection.safetyAuthorityId,
      })
      setDraft(liveParam.value.toString())
      return
    }
    if (
      commitment
      && (
        connection.safetyEpoch !== commitment.epoch
        || connection.safetyAuthorityId !== commitment.authorityId
      )
    ) {
      setConfirmation(null)
      setError(t('vehicleSetup.safetyContextChanged'))
      setDraft(liveParam.value.toString())
      return
    }

    const requestId = setupRequestId(`cfg-${field.id}`)
    const sent = sendClientMessage({
      type: 'vehicle_config_set',
      requestId,
      feature,
      data: { id: field.id, value },
      ...(commitment
        ? {
            safetyConfirmation: 'reduce_failsafe_protection' as const,
            expectedSafetyEpoch: commitment.epoch,
            expectedSafetyAuthorityId: commitment.authorityId,
          }
        : {}),
    })
    if (sent) {
      setPending(requestId)
      setError(null)
    } else {
      setError(t('vehicleSetup.connectionUnavailable'))
      setDraft(liveParam.value.toString())
    }
  }

  if (!param) return null
  const disabled = !vehicleReady || !canControl || armed !== false || Boolean(pending)
  const fieldLabel = label ?? field.label
  const control = mergedOptions.length > 0 || field.kind === 'channel'
    ? (
        <select
          id={controlId}
          className="mc-select"
          value={draft}
          disabled={disabled}
          onChange={(event) => {
            const value = Number(event.target.value)
            setDraft(String(value))
            send(value)
          }}
        >
          {field.kind === 'channel'
            ? [
                <option key={0} value={0}>{t('vehicleSetup.disabled')}</option>,
                ...Array.from({ length: field.max ?? 18 }, (_, index) => (
                  <option key={index + 1} value={index + 1}>CH{index + 1}</option>
                )),
              ]
            : mergedOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
        </select>
      )
    : (
        <input
          id={controlId}
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
            if (event.key === 'Escape') {
              setDraft(param.value.toString())
              event.currentTarget.blur()
            }
          }}
        />
      )

  const liveSafetyKey = `${safetyAuthorityId ?? '-'}:${safetyEpoch}`
  const confirmationKey = confirmation
    ? `${confirmation.authorityId}:${confirmation.epoch}:${field.id}:${confirmation.value}:${liveSafetyKey}`
    : ''

  return (
    <div className="mc-setup-field" data-pending={Boolean(pending)}>
      <Field
        label={fieldLabel}
        controlId={controlId}
        helper={field.id}
        error={error ?? undefined}
      >
        <div className="mc-setup-field__control">
          {control}
          {field.unit && <span>{field.unit}</span>}
          {pending && <span className="mc-setup-field__spinner" aria-label={t('vehicleSetup.writing')} />}
        </div>
      </Field>

      <ConfirmDialog
        open={confirmation !== null}
        title={t('vehicleSetup.reduceSafetyTitle')}
        consequence={t('vehicleSetup.reduceSafetyDescription', { parameter: field.id })}
        commitmentLabel={t('vehicleSetup.reduceSafetyCommitment')}
        confirmLabel={t('vehicleSetup.confirmReduction')}
        cancelLabel={t('common.cancel')}
        closeLabel={t('common.close')}
        tone="danger"
        confirmationKey={confirmationKey}
        onCancel={() => {
          setConfirmation(null)
          setDraft(param.value.toString())
        }}
        onConfirm={() => {
          const committed = confirmation
          setConfirmation(null)
          if (committed) send(committed.value, committed)
        }}
      />
    </div>
  )
}
