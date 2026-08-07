import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  AM32_SETTINGS_GROUPS,
  am32FieldsForRevision,
  type EscDeviceInfo,
  type EscSettingsField,
  type EscSettingsValues,
} from '../../../shared/esc'
import { sendClientMessage } from '../../hooks/useWebSocket'
import { useEscStore } from '../../stores/escStore'
import Icon from '../ui/Icon'

const REASON_LABELS: Record<string, string> = {
  unsupported_signature_or_layout: 'escSettings.reasonUnsupportedLayout',
  not_validated: 'escSettings.reasonNotValidated',
  detect_failed: 'escSettings.reasonDetectFailed',
}

export default function EscSettingsWorkbench() {
  const { t } = useTranslation()
  const session = useEscStore((state) => state.session)
  const devices = useEscStore((state) => state.devices)
  const settings = useEscStore((state) => state.settings)
  const activeJob = useEscStore((state) => state.activeJob)
  const lastJobResult = useEscStore((state) => state.lastJobResult)
  const [activeIndex, setActiveIndex] = useState<number | null>(null)
  const [targets, setTargets] = useState<Set<number>>(new Set())
  const [draft, setDraft] = useState<EscSettingsValues>({})
  const [dirty, setDirty] = useState<Set<string>>(new Set())

  useEffect(() => {
    if (devices.length === 0) {
      setActiveIndex(null)
      setTargets(new Set())
      return
    }
    setActiveIndex((current) => (
      current !== null && devices.some((device) => device.index === current)
        ? current
        : devices.find((device) => settings.has(device.index))?.index ?? devices[0].index
    ))
    setTargets((current) => {
      const valid = new Set([...current].filter((index) => devices.some((device) => device.index === index && device.writable)))
      if (valid.size === 0) {
        const first = devices.find((device) => device.writable && settings.has(device.index))
        if (first) valid.add(first.index)
      }
      return valid
    })
  }, [devices, settings])

  const activeDevice = devices.find((device) => device.index === activeIndex) ?? null
  const activeSnapshot = activeIndex === null ? undefined : settings.get(activeIndex)

  useEffect(() => {
    setDraft(activeSnapshot ? { ...activeSnapshot.values } : {})
    setDirty(new Set())
  }, [activeIndex, activeSnapshot])

  const fields = useMemo(
    () => activeSnapshot?.layoutRevision == null
      ? []
      : am32FieldsForRevision(activeSnapshot.layoutRevision),
    [activeSnapshot?.layoutRevision],
  )
  const busy = activeJob !== null
  const selectedWritable = [...targets].filter((index) => devices.find((device) => device.index === index)?.writable)

  const changeValue = (key: string, value: number) => {
    setDraft((current) => ({ ...current, [key]: value }))
    setDirty((current) => new Set(current).add(key))
  }

  const toggleTarget = (index: number) => {
    setTargets((current) => {
      const next = new Set(current)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }

  const save = () => {
    if (!session?.sessionId || dirty.size === 0 || selectedWritable.length === 0) return
    const values: EscSettingsValues = {}
    dirty.forEach((key) => {
      if (draft[key] !== undefined) values[key] = draft[key]
    })
    sendClientMessage({
      type: 'esc_settings_write',
      data: { sessionId: session.sessionId, targets: selectedWritable, values },
    })
  }

  const reread = () => {
    if (!session?.sessionId) return
    sendClientMessage({
      type: 'esc_settings_read',
      data: { sessionId: session.sessionId, targets: activeIndex === null ? 'all' : [activeIndex] },
    })
  }

  const reset = () => {
    setDraft(activeSnapshot ? { ...activeSnapshot.values } : {})
    setDirty(new Set())
  }

  return (
    <section className="mc-esc-workbench">
      <header className="mc-esc-workbench__topbar">
        <div>
          <span className="mc-eyebrow">AM32 PARAMETER WORKBENCH</span>
          <h2>{t('escSettings.title')}</h2>
          <p>{t('escSettings.subtitle')}</p>
        </div>
        <button type="button" className="mc-btn mc-btn-ghost" onClick={reread} disabled={busy}>
          <Icon name="refresh" size={15} /> {t('escSettings.reread')}
        </button>
      </header>

      <div className="mc-esc-device-strip" role="list" aria-label={t('escSettings.detectedEscs')}>
        {devices.map((device) => (
          <DeviceSelector
            key={device.index}
            device={device}
            active={device.index === activeIndex}
            targeted={targets.has(device.index)}
            hasSettings={settings.has(device.index)}
            onActivate={() => setActiveIndex(device.index)}
            onToggleTarget={() => toggleTarget(device.index)}
          />
        ))}
      </div>

      {!activeSnapshot || !activeDevice || fields.length === 0 ? (
        <div className="mc-esc-settings-empty">
          <span><Icon name="warning" size={20} /></span>
          <div>
            <strong>{t('escSettings.noEditableParams')}</strong>
            <p>{activeDevice?.reason ? t(REASON_LABELS[activeDevice.reason]) : t('escSettings.confirmAm32Hint')}</p>
          </div>
        </div>
      ) : (
        <div className="mc-esc-settings-groups">
          {AM32_SETTINGS_GROUPS.map((group) => {
            const groupFields = fields.filter((field) => (
              field.group === group.key
              && (!field.visibleIf || draft[field.visibleIf.key] === field.visibleIf.equals)
            ))
            if (groupFields.length === 0) return null
            return (
              <fieldset key={group.key} className="mc-esc-setting-group">
                <legend>
                  <strong>{t(group.label)}</strong>
                  <span>{t(group.description)}</span>
                </legend>
                <div className="mc-esc-setting-grid">
                  {groupFields.map((field) => (
                    <SettingControl
                      key={field.key}
                      field={field}
                      value={draft[field.key] ?? 0}
                      values={draft}
                      changed={dirty.has(field.key)}
                      busy={busy || !activeSnapshot.writable}
                      onChange={(value) => changeValue(field.key, value)}
                    />
                  ))}
                </div>
              </fieldset>
            )
          })}
        </div>
      )}

      {activeSnapshot && fields.length > 0 && (
        <footer className="mc-esc-savebar">
          <div className="mc-esc-savebar__status">
            <span data-dirty={dirty.size > 0 || undefined} />
            <div>
              <strong>{dirty.size > 0 ? t('escSettings.changesUnsaved', { count: dirty.size }) : t('escSettings.paramsSynced')}</strong>
              <small>
                {lastJobResult?.kind === 'settings_write'
                  ? lastJobResult.ok ? t('escSettings.lastWriteVerified') : t('escSettings.lastWriteFailed')
                  : t('escSettings.currentTargets', { count: selectedWritable.length })}
              </small>
            </div>
          </div>
          <div className="mc-esc-savebar__actions">
            <button type="button" className="mc-btn mc-btn-ghost" onClick={reset} disabled={busy || dirty.size === 0}>
              {t('escSettings.discardChanges')}
            </button>
            <button
              type="button"
              className="mc-btn mc-btn-primary"
              onClick={save}
              disabled={busy || dirty.size === 0 || selectedWritable.length === 0}
            >
              {busy ? t('escSettings.processing') : t('escSettings.saveToEscs', { count: selectedWritable.length })}
            </button>
          </div>
        </footer>
      )}
    </section>
  )
}

function DeviceSelector({
  device,
  active,
  targeted,
  hasSettings,
  onActivate,
  onToggleTarget,
}: {
  device: EscDeviceInfo
  active: boolean
  targeted: boolean
  hasSettings: boolean
  onActivate: () => void
  onToggleTarget: () => void
}) {
  const { t } = useTranslation()
  return (
    <div className="mc-esc-device-selector" data-active={active || undefined} data-ready={hasSettings || undefined} role="listitem">
      <button type="button" onClick={onActivate} aria-pressed={active}>
        <span className="mc-esc-device-selector__index">{device.index + 1}</span>
        <span>
          <strong>ESC {device.index + 1}</strong>
          <small>{device.firmwareName ?? (device.interfaceMode === null ? t('escSettings.notResponding') : device.firmwareKind.toUpperCase())}</small>
        </span>
      </button>
      <label title={device.writable ? t('escSettings.includeInBatchTitle') : t('escSettings.notWritableTitle')}>
        <input
          type="checkbox"
          checked={targeted}
          disabled={!device.writable}
          onChange={onToggleTarget}
          aria-label={t('escSettings.selectEscTarget', { index: device.index + 1 })}
        />
      </label>
    </div>
  )
}

function SettingControl({
  field,
  value,
  values,
  changed,
  busy,
  onChange,
}: {
  field: EscSettingsField
  value: number
  values: EscSettingsValues
  changed: boolean
  busy: boolean
  onChange: (value: number) => void
}) {
  const { t } = useTranslation()
  const dependencyDisabled = field.disabledIf
    ? values[field.disabledIf.key] === field.disabledIf.equals
    : false
  const disabled = busy || dependencyDisabled

  if (field.kind === 'bool') {
    return (
      <div className="mc-esc-field mc-esc-field--switch" data-changed={changed || undefined}>
        <div className="mc-esc-field__heading">
          <span>
            <strong>{t(field.label)}</strong>
            {field.description && <small>{t(field.description)}</small>}
          </span>
          <button
            type="button"
            className="mc-switch"
            role="switch"
            aria-checked={value === 1}
            disabled={disabled}
            onClick={() => onChange(value === 1 ? 0 : 1)}
          >
            <span />
          </button>
        </div>
      </div>
    )
  }

  if (field.kind === 'enum') {
    return (
      <div className="mc-esc-field" data-changed={changed || undefined}>
        <div className="mc-esc-field__heading">
          <strong>{t(field.label)}</strong>
          <HealthDots />
        </div>
        <select
          className="mc-select"
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(Number(event.target.value))}
        >
          {field.options?.map((option) => (
            <option key={option.value} value={option.value}>{t(option.label)}</option>
          ))}
        </select>
      </div>
    )
  }

  const sentinel = field.disabledValue
  const limitEnabled = sentinel === undefined || value !== sentinel
  const sliderValue = limitEnabled ? value : (field.max ?? field.min ?? 0)
  const precision = field.precision ?? decimals(field.step ?? 1)

  return (
    <div className="mc-esc-field" data-changed={changed || undefined} data-disabled={disabled || undefined}>
      <div className="mc-esc-field__heading">
        <strong>{t(field.label)}</strong>
        <HealthDots />
      </div>
      {sentinel !== undefined && (
        <label className="mc-esc-limit-toggle">
          <input
            type="checkbox"
            checked={limitEnabled}
            disabled={busy}
            onChange={(event) => onChange(event.target.checked ? (field.max ?? 0) : sentinel)}
          />
          <span>{limitEnabled ? t('escSettings.limitEnabled') : t('escSettings.limitDisabled')}</span>
        </label>
      )}
      <div className="mc-esc-range-row">
        <input
          type="range"
          min={field.min}
          max={field.max}
          step={field.step}
          value={sliderValue}
          disabled={disabled || !limitEnabled}
          onChange={(event) => onChange(Number(event.target.value))}
          aria-label={t(field.label)}
        />
        <label>
          <input
            className="mc-input mc-mono"
            type="number"
            min={field.min}
            max={field.max}
            step={field.step}
            value={limitEnabled ? Number(value.toFixed(precision)) : ''}
            placeholder={t('escSettings.limitOffPlaceholder')}
            disabled={disabled || !limitEnabled}
            onChange={(event) => {
              if (event.target.value !== '') onChange(Number(event.target.value))
            }}
          />
          {field.unit && <span>{field.unit}</span>}
        </label>
      </div>
      {dependencyDisabled && <small className="mc-esc-field__hint">{t('escSettings.controlledByDependency')}</small>}
    </div>
  )
}

function HealthDots() {
  return <span className="mc-esc-health" aria-hidden="true"><i /><i /><i /></span>
}

function decimals(step: number): number {
  const text = String(step)
  return text.includes('.') ? text.length - text.indexOf('.') - 1 : 0
}
