import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import Icon from '../components/ui/Icon'
import { EmptyState } from '../components/ui/PageFrame'
import { sendClientMessage } from '../hooks/useWebSocket'
import { useParameterStore } from '../stores/parameterStore'
import { useConnectionStore } from '../stores/connectionStore'
import { useTelemetryStore } from '../stores/telemetryStore'
import { vehicleCapabilities } from '../../shared/vehicleProfiles'
import { parameterEnumLabel, parameterEnumOptions, parameterEnumValuesMatch } from '../utils/parameterEnumMetadata'
import { parameterGroupKey, parameterMetadata, parameterSearchText } from '../utils/parameterMetadata'

// PX4 circuit-breaker parameters disable safety protections outright; writing
// them by accident must require an explicit confirmation.
const DANGEROUS_PARAM_PREFIXES = ['CBRK_']

const INTEGER_PARAM_RANGES: Record<number, readonly [number, number]> = {
  1: [0, 0xff],
  2: [-0x80, 0x7f],
  3: [0, 0xffff],
  4: [-0x8000, 0x7fff],
  5: [0, 0xffffffff],
  6: [-0x80000000, 0x7fffffff],
  // JS numbers cannot exactly represent the full 64-bit integer domain. Keep
  // writes inside the exact range instead of silently rounding an unsafe value.
  7: [0, Number.MAX_SAFE_INTEGER],
  8: [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
}

function validateParamValue(value: number, type: number, t: TFunction): string | null {
  if (!Number.isFinite(value)) return t('parameter.valueMustBeFinite')
  if (type === 9) return Number.isFinite(Math.fround(value)) ? null : t('parameter.valueOutOfRangeReal32')
  if (type === 10) return null
  const range = INTEGER_PARAM_RANGES[type]
  if (!range) return t('parameter.unsupportedParamType', { type })
  if (!Number.isInteger(value) || value < range[0] || value > range[1]) {
    return t('parameter.valueMustBeInRange', { min: range[0], max: range[1] })
  }
  return null
}
export default function ParameterPage({ embedded = false }: { embedded?: boolean }) {
  const { t } = useTranslation()
  const { params, loading, totalCount, receivedCount } = useParameterStore()
  const send = sendClientMessage
  const canAccess = useConnectionStore((state) => state.vehicleReady && state.canControl)
  const vehicleIdentity = useTelemetryStore((state) => state.vehicleIdentity)
  const profileWritable = vehicleCapabilities(vehicleIdentity).writeOperations
  const canWrite = canAccess && profileWritable
  const [search, setSearch] = useState('')
  const [editId, setEditId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [editRaw, setEditRaw] = useState(false)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [visibleCounts, setVisibleCounts] = useState<Record<string, number>>({})
  const [pendingWrite, setPendingWrite] = useState<{ id: string; value: number } | null>(null)
  const [writeError, setWriteError] = useState<string | null>(null)
  const writeTimer = useRef<number | null>(null)

  useEffect(() => {
    if (!pendingWrite) return
    const echoedValue = params.get(pendingWrite.id)?.value
    if (echoedValue === undefined || Math.abs(echoedValue - pendingWrite.value) > 1e-6) return
    if (writeTimer.current !== null) window.clearTimeout(writeTimer.current)
    writeTimer.current = null
    setPendingWrite(null)
  }, [params, pendingWrite])

  useEffect(() => () => {
    if (writeTimer.current !== null) window.clearTimeout(writeTimer.current)
  }, [])

  const requestParams = () => {
    if (!canAccess) return
    useParameterStore.getState().clear()
    useParameterStore.getState().setLoading(true)
    send({ type: 'param_request_list' })
  }

  const filteredParams = useMemo(() => {
    const values = Array.from(params.values())
    if (!search) return values
    const query = search.toUpperCase()
    return values.filter((param) => parameterSearchText(param.id, vehicleIdentity).includes(query))
  }, [params, search, vehicleIdentity])

  const groups = useMemo(() => {
    const result: Record<string, typeof filteredParams> = {}
    for (const param of filteredParams) {
      const prefix = parameterGroupKey(param.id)
      if (!result[prefix]) result[prefix] = []
      result[prefix].push(param)
    }
    return result
  }, [filteredParams])

  const saveParam = (id: string) => {
    if (!canWrite) return
    const param = params.get(id)
    if (!param) return
    const rawValue = editValue.trim()
    const parsedValue = rawValue === '' ? Number.NaN : Number(rawValue)
    if (!Number.isFinite(parsedValue)) {
      setWriteError(t('parameter.invalidValue', { id }))
      return
    }
    const value = parsedValue
    const rangeError = validateParamValue(value, param.type, t)
    if (rangeError) {
      setWriteError(t('parameter.paramError', { id, error: rangeError }))
      return
    }
    if (
      DANGEROUS_PARAM_PREFIXES.some((prefix) => id.startsWith(prefix))
      && !window.confirm(
        t('parameter.circuitBreakerConfirm', { id, value }),
      )
    ) return
    setWriteError(null)
    setPendingWrite({ id, value })
    send({ type: 'param_set', requestId: `param-${id}-${Date.now().toString(36)}`, data: { id, value, paramType: param.type } })
    if (writeTimer.current !== null) window.clearTimeout(writeTimer.current)
    writeTimer.current = window.setTimeout(() => {
      setPendingWrite((current) => {
        if (current?.id === id) setWriteError(t('parameter.noEchoConfirm', { id }))
        return current?.id === id ? null : current
      })
    }, 5000)
    setEditId(null)
  }

  const exportParams = () => {
    const content = Array.from(params.values()).map((param) => [param.id, param.value, param.type].join(',')).join('\n')
    const blob = new Blob([content], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${vehicleIdentity?.family ?? 'autopilot'}_params.params`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className={embedded ? 'mc-fade-in' : 'mc-workspace mc-fade-in mc-workspace--wide'}>
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <span className="text-[12px] font-semibold" style={{ color: 'var(--text-secondary)' }}>
          {loading ? t('parameter.receiving', { received: receivedCount, total: totalCount }) : t('parameter.paramCount', { count: params.size || totalCount })}
        </span>
        <span className="flex-1" />
        <button type="button" className="mc-btn mc-btn-primary" onClick={requestParams} disabled={!canAccess || loading}>
          <Icon name="refresh" size={15} />{loading ? `${receivedCount}/${totalCount}` : t('parameter.resync')}
        </button>
        <button type="button" className="mc-btn mc-btn-ghost" onClick={exportParams} disabled={params.size === 0}><Icon name="log" size={15} />{t('parameter.exportParams')}</button>
      </div>

      {!canAccess && <div className="mc-capability-note" data-state="waiting"><Icon name="warning" size={15} /><span>{t('parameter.connectToSync')}</span></div>}
      {canAccess && !profileWritable && <div className="mc-capability-note" data-state="waiting"><Icon name="warning" size={15} /><span>{t('parameter.writeNotSupported')}</span></div>}
      {writeError && <div className="mc-capability-note" data-state="error"><Icon name="warning" size={15} /><span>{writeError}</span></div>}

      <div className="mc-param-search">
        <Icon name="search" size={17} aria-hidden="true" />
        <input className="mc-input" value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t('parameter.searchPlaceholder')} />
      </div>

      {loading && (
        <div className="mb-4 h-1.5 overflow-hidden rounded-full" style={{ background: 'var(--bg-tertiary)' }}>
          <i className="block h-full rounded-full" style={{ width: totalCount ? receivedCount / totalCount * 100 + '%' : '8%', background: 'var(--accent)' }} />
        </div>
      )}

      {params.size === 0 && !loading ? (
        <EmptyState icon="parameters" description={t('parameter.emptyDescription')} />
      ) : (
        <div className="space-y-3">
          {Object.entries(groups).map(([prefix, items]) => {
            const isCollapsed = search ? false : (collapsed[prefix] ?? true)
            const groupLabel = parameterMetadata(items[0]?.id ?? prefix, vehicleIdentity).groupLabel
            return (
              <section key={prefix} className="mc-card overflow-hidden">
                <button
                  type="button"
                  className="mc-param-group__header"
                  onClick={() => setCollapsed((current) => ({ ...current, [prefix]: current[prefix] === undefined ? false : !current[prefix] }))}
                >
                  <Icon name="chevronDown" size={15} style={{ color: 'var(--text-secondary)', transform: isCollapsed ? 'rotate(-90deg)' : undefined, transition: 'transform 160ms ease' }} />
                  <span><strong className="mc-mono">{prefix}</strong><small>{groupLabel}</small></span>
                  <i className="mc-mono">{items.length}</i>
                </button>
                {!isCollapsed && (
                  <div className="mc-param-group__body">
                    {items.slice(0, visibleCounts[prefix] ?? 80).map((param) => {
                      const metadata = parameterMetadata(param.id, vehicleIdentity)
                      const enumOptions = parameterEnumOptions(param.id, vehicleIdentity)
                      const enumLabel = parameterEnumLabel(param.id, param.value, vehicleIdentity)
                      const knownEnumValue = enumOptions
                        ?.some((option) => parameterEnumValuesMatch(option.value, param.value)) ?? false
                      const editorOptions = enumOptions && !knownEnumValue
                        ? [{ value: param.value, label: t('parameter.unknownEnumValue') }, ...enumOptions]
                        : enumOptions
                      return (
                      <div key={param.id} className="mc-param-row">
                        <div className="mc-param-row__identity">
                          <span>
                            <code>{param.id}</code>
                            <strong>{metadata.title}</strong>
                            {metadata.unit && <i>{metadata.unit}</i>}
                          </span>
                          <p>{metadata.description}</p>
                        </div>
                        {editId === param.id ? (
                          <div className="mc-param-row__editor">
                            {editorOptions && !editRaw ? (
                              <select
                                autoFocus
                                aria-label={t('parameter.enumValueAria', { id: param.id })}
                                className="mc-input mc-param-row__select h-8"
                                value={editValue}
                                onChange={(event) => setEditValue(event.target.value)}
                                onKeyDown={(event) => { if (event.key === 'Enter') saveParam(param.id); if (event.key === 'Escape') setEditId(null) }}
                              >
                                {editorOptions.map((option) => (
                                  <option key={option.value} value={option.value}>{option.value}: {option.label}</option>
                                ))}
                              </select>
                            ) : (
                              <input autoFocus className="mc-input h-8 w-28" value={editValue} onChange={(event) => setEditValue(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') saveParam(param.id); if (event.key === 'Escape') setEditId(null) }} />
                            )}
                            {editorOptions && (
                              <button type="button" className="mc-btn mc-btn-ghost h-8 mc-param-row__raw-toggle" onClick={() => setEditRaw((current) => !current)}>
                                {editRaw ? t('parameter.options') : t('parameter.rawValue')}
                              </button>
                            )}
                            <button type="button" className="mc-btn mc-btn-primary h-8" disabled={!canWrite || pendingWrite !== null} onClick={() => saveParam(param.id)}>{t('parameter.save')}</button>
                          </div>
                        ) : (
                          <button type="button" disabled={!canWrite || pendingWrite !== null} className="mc-param-row__value mc-mono" onClick={() => { setEditId(param.id); setEditValue(String(param.value)); setEditRaw(false) }}>
                            {pendingWrite?.id === param.id ? t('parameter.confirming') : enumLabel ? `${param.value}: ${enumLabel}` : param.value}
                          </button>
                        )}
                        <span className="mc-param-row__type mc-mono">T{param.type}</span>
                      </div>
                    )})}
                    {items.length > (visibleCounts[prefix] ?? 80) && (
                      <button type="button" className="mc-load-more" onClick={() => setVisibleCounts((current) => ({ ...current, [prefix]: (current[prefix] ?? 80) + 80 }))}>
                        {t('parameter.showMore', { count: items.length - (visibleCounts[prefix] ?? 80) })}
                      </button>
                    )}
                  </div>
                )}
              </section>
            )
          })}
        </div>
      )}
    </div>
  )
}
