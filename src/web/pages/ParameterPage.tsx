import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import Icon from '../components/ui/Icon'
import { Button } from '../components/ui/Button'
import Dialog from '../components/ui/Dialog'
import { Notice } from '../components/ui/Feedback'
import StatePanel from '../components/ui/StatePanel'
import { TabPanel, Tabs } from '../components/ui/Tabs'
import Toolbar from '../components/ui/Toolbar'
import { sendRuntimeCommand } from '../hooks/useLocalRuntime'
import { useParameterStore } from '../stores/parameterStore'
import { useConnectionStore } from '../stores/connectionStore'
import { useTelemetryStore } from '../stores/telemetryStore'
import { vehicleCapabilities } from '../../shared/vehicleProfiles'
import { isSensitiveParameter } from '../../shared/parameterSafety'
import { parameterEnumLabel, parameterEnumOptions, parameterEnumValuesMatch } from '../utils/parameterEnumMetadata'
import { parameterGroupKey, parameterMetadata, parameterSearchText } from '../utils/parameterMetadata'
import {
  buildQgcParameterPreview,
  filterQgcParameterPreview,
  parseQgcParameterFile,
  serializeQgcParameterFile,
  type QgcParameterPreview,
  type QgcParameterPreviewEntry,
  type QgcParameterPreviewFilter,
} from '../utils/qgcParameterFile'

const QGC_PARAMETER_FILE_MAX_BYTES = 2 * 1024 * 1024
const PARAM_IMPORT_WRITE_TIMEOUT_MS = 5000

interface ParameterImportSelection {
  fileName: string
  preview: QgcParameterPreview
  systemId: number
  componentId: number
}

interface ParameterImportFailure {
  id: string
  reason: string
}

interface ParameterImportJob {
  entries: QgcParameterPreviewEntry[]
  nextIndex: number
  pendingRequestId: string | null
  succeeded: string[]
  failed: ParameterImportFailure[]
  status: 'writing' | 'done'
}

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
  const send = sendRuntimeCommand
  const canAccess = useConnectionStore((state) => state.vehicleReady && state.canControl)
  const vehicleReady = useConnectionStore((state) => state.vehicleReady)
  const setConnectDialogOpen = useConnectionStore((state) => state.setConnectDialogOpen)
  const targetSystemId = useConnectionStore((state) => state.targetSystemId)
  const targetComponentId = useConnectionStore((state) => state.targetComponentId)
  const safetyEpoch = useConnectionStore((state) => state.safetyEpoch)
  const safetyAuthorityId = useConnectionStore((state) => state.safetyAuthorityId)
  const vehicleIdentity = useTelemetryStore((state) => state.vehicleIdentity)
  const firmwareVersion = useTelemetryStore((state) => state.autopilotVersion?.firmwareVersion ?? null)
  const lastOperationError = useTelemetryStore((state) => state.lastOperationError)
  const lastWriteResult = useParameterStore((state) => state.lastWriteResult)
  const armed = useTelemetryStore((state) => state.status?.armed)
  const profileWritable = vehicleCapabilities(vehicleIdentity).writeOperations
  // OCSA-001: mirror the Worker gate — raw parameter writes require a
  // confirmed disarmed vehicle, not just a writable profile.
  const canWrite = canAccess && profileWritable && armed === false
  const [search, setSearch] = useState('')
  const [editId, setEditId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [editRaw, setEditRaw] = useState(false)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [visibleCounts, setVisibleCounts] = useState<Record<string, number>>({})
  const [pendingWrite, setPendingWrite] = useState<{ id: string; value: number } | null>(null)
  const [writeError, setWriteError] = useState<string | null>(null)
  const [importSelection, setImportSelection] = useState<ParameterImportSelection | null>(null)
  const [importJob, setImportJob] = useState<ParameterImportJob | null>(null)
  const [importPreviewFilter, setImportPreviewFilter] = useState<QgcParameterPreviewFilter>('write')
  const [dangerousImportAcknowledged, setDangerousImportAcknowledged] = useState(false)
  const writeTimer = useRef<number | null>(null)
  const importInput = useRef<HTMLInputElement | null>(null)
  const importRunSequence = useRef(0)
  const importResyncPending = useRef(false)
  const importWriting = importJob?.status === 'writing'

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

  useEffect(() => {
    if (!importJob || importJob.status !== 'writing' || !importJob.pendingRequestId) return
    if (lastWriteResult?.requestId !== importJob.pendingRequestId) return
    setImportJob((current) => {
      if (!current || current.pendingRequestId !== lastWriteResult.requestId) return current
      const entry = current.entries[current.nextIndex]
      if (!entry) return { ...current, status: 'done', pendingRequestId: null }
      return {
        ...current,
        nextIndex: current.nextIndex + 1,
        pendingRequestId: null,
        succeeded: lastWriteResult.accepted ? [...current.succeeded, entry.row.name] : current.succeeded,
        failed: lastWriteResult.accepted
          ? current.failed
          : [...current.failed, { id: entry.row.name, reason: lastWriteResult.reason ?? t('parameter.importWriteRejected') }],
      }
    })
  }, [importJob, lastWriteResult, t])

  useEffect(() => {
    if (!importJob || importJob.status !== 'writing' || !importJob.pendingRequestId) return
    if (lastOperationError?.requestId !== importJob.pendingRequestId) return
    setImportJob((current) => {
      if (!current || current.pendingRequestId !== lastOperationError.requestId) return current
      const entry = current.entries[current.nextIndex]
      if (!entry) return { ...current, status: 'done', pendingRequestId: null }
      return {
        ...current,
        nextIndex: current.nextIndex + 1,
        pendingRequestId: null,
        failed: [...current.failed, { id: entry.row.name, reason: lastOperationError.message }],
      }
    })
  }, [importJob, lastOperationError])

  useEffect(() => {
    if (!importJob || importJob.status !== 'writing' || !importJob.pendingRequestId) return
    const requestId = importJob.pendingRequestId
    const timer = window.setTimeout(() => {
      setImportJob((current) => {
        if (!current || current.status !== 'writing' || current.pendingRequestId !== requestId) {
          return current
        }
        const entry = current.entries[current.nextIndex]
        if (!entry) return { ...current, status: 'done', pendingRequestId: null }
        return {
          ...current,
          nextIndex: current.nextIndex + 1,
          pendingRequestId: null,
          failed: [...current.failed, {
            id: entry.row.name,
            reason: t('parameter.importWriteTimeout'),
          }],
        }
      })
    }, PARAM_IMPORT_WRITE_TIMEOUT_MS)
    return () => window.clearTimeout(timer)
  }, [importJob?.pendingRequestId, importJob?.status, t])

  useEffect(() => {
    if (!importJob || importJob.status !== 'writing' || importJob.pendingRequestId) return
    const targetChanged = !canWrite
      || !importSelection
      || targetSystemId !== importSelection.systemId
      || targetComponentId !== importSelection.componentId
    if (targetChanged) {
      setImportJob((current) => {
        if (!current || current.status !== 'writing') return current
        const remaining = current.entries.slice(current.nextIndex).map((entry) => ({
          id: entry.row.name,
          reason: t('parameter.importTargetChanged'),
        }))
        return { ...current, status: 'done', pendingRequestId: null, failed: [...current.failed, ...remaining] }
      })
      return
    }
    if (importJob.nextIndex >= importJob.entries.length) {
      importResyncPending.current = true
      setImportJob((current) => current ? { ...current, status: 'done' } : current)
      return
    }

    const entry = importJob.entries[importJob.nextIndex]
    if (!entry) return
    const requestId = `param-import-${importRunSequence.current}-${importJob.nextIndex}-${Date.now().toString(36)}`
    setImportJob((current) => current ? { ...current, pendingRequestId: requestId } : current)
    const sensitive = entry.dangerous
    if (!send({
      type: 'param_set',
      requestId,
      data: { id: entry.row.name, value: entry.row.value, paramType: entry.row.type },
      ...(sensitive && safetyAuthorityId ? {
        safetyConfirmation: 'sensitive_param' as const,
        expectedSafetyEpoch: safetyEpoch,
        expectedSafetyAuthorityId: safetyAuthorityId,
      } : {}),
    })) {
      setImportJob((current) => {
        if (!current || current.pendingRequestId !== requestId) return current
        return {
          ...current,
          nextIndex: current.nextIndex + 1,
          pendingRequestId: null,
          failed: [...current.failed, { id: entry.row.name, reason: t('parameter.importSendFailed') }],
        }
      })
    }
  }, [canWrite, importJob, importSelection, safetyAuthorityId, safetyEpoch, send, t, targetComponentId, targetSystemId])

  useEffect(() => {
    if (importJob?.status !== 'done' || !importResyncPending.current || !canAccess) return
    importResyncPending.current = false
    useParameterStore.getState().clear()
    useParameterStore.getState().setLoading(true)
    send({ type: 'param_request_list' })
  }, [canAccess, importJob?.status, send])

  const requestParams = () => {
    if (!canAccess || importWriting) return
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
    if (!canWrite || importWriting) return
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
      isSensitiveParameter(id)
      && !window.confirm(
        t('parameter.circuitBreakerConfirm', { id, value }),
      )
    ) return
    setWriteError(null)
    setPendingWrite({ id, value })
    const sensitive = isSensitiveParameter(id)
    send({
      type: 'param_set',
      requestId: `param-${id}-${Date.now().toString(36)}`,
      data: { id, value, paramType: param.type },
      ...(sensitive && safetyAuthorityId ? {
        safetyConfirmation: 'sensitive_param' as const,
        expectedSafetyEpoch: safetyEpoch,
        expectedSafetyAuthorityId: safetyAuthorityId,
      } : {}),
    })
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
    if (targetSystemId === null || targetComponentId === null) return
    const content = serializeQgcParameterFile({
      systemId: targetSystemId,
      componentId: targetComponentId,
      params: params.values(),
      identity: vehicleIdentity,
      firmwareVersion,
    })
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${vehicleIdentity?.family ?? 'autopilot'}_${targetSystemId}.params`
    anchor.click()
    anchor.remove()
    URL.revokeObjectURL(url)
  }

  const selectImportFile = async (file: File) => {
    if (targetSystemId === null || targetComponentId === null) {
      setWriteError(t('parameter.importTargetUnavailable'))
      return
    }
    if (file.size > QGC_PARAMETER_FILE_MAX_BYTES) {
      setWriteError(t('parameter.importFileTooLarge'))
      return
    }
    try {
      const parsed = parseQgcParameterFile(await file.text())
      const preview = buildQgcParameterPreview(parsed, params, targetSystemId, targetComponentId)
      setWriteError(null)
      setDangerousImportAcknowledged(false)
      setImportPreviewFilter('write')
      setImportJob(null)
      setImportSelection({ fileName: file.name, preview, systemId: targetSystemId, componentId: targetComponentId })
    } catch {
      setWriteError(t('parameter.importReadFailed'))
    }
  }

  const startImport = () => {
    if (
      !importSelection
      || !canWrite
      || loading
      || pendingWrite !== null
      || importSelection.preview.writable.length === 0
      || targetSystemId !== importSelection.systemId
      || targetComponentId !== importSelection.componentId
      || (importSelection.preview.dangerousCount > 0 && !dangerousImportAcknowledged)
    ) return
    importRunSequence.current += 1
    importResyncPending.current = false
    setImportJob({
      entries: importSelection.preview.writable,
      nextIndex: 0,
      pendingRequestId: null,
      succeeded: [],
      failed: [],
      status: 'writing',
    })
  }

  const closeImportDialog = () => {
    if (importWriting) return
    setImportSelection(null)
    setImportJob(null)
    setImportPreviewFilter('write')
    setDangerousImportAcknowledged(false)
  }

  const cancelImport = () => {
    if (!importJob || importJob.status !== 'writing') return
    importResyncPending.current = true
    setImportJob((current) => {
      if (!current || current.status !== 'writing') return current
      const remaining = current.entries.slice(current.nextIndex).map((entry) => ({
        id: entry.row.name,
        reason: t('parameter.importCancelled'),
      }))
      return {
        ...current,
        status: 'done',
        pendingRequestId: null,
        failed: [...current.failed, ...remaining],
      }
    })
  }

  const preview = importSelection?.preview ?? null
  const unchangedImportCount = preview?.entries.filter((entry) => entry.status === 'unchanged').length ?? 0
  const skippedImportCount = preview
    ? preview.entries.length - preview.writable.length - unchangedImportCount + preview.issues.length
    : 0
  const completedImportCount = importJob ? importJob.succeeded.length + importJob.failed.length : 0
  const filteredImportPreview = preview
    ? filterQgcParameterPreview(preview, importPreviewFilter)
    : { entries: [], issues: [] }

  return (
    <div className={embedded ? 'mc-fade-in' : 'mc-workspace mc-fade-in mc-workspace--wide'}>
      <Toolbar
        summary={loading
          ? t('parameter.receiving', { received: receivedCount, total: totalCount })
          : t('parameter.paramCount', { count: params.size || totalCount })}
      >
        <Button tone="primary" leadingIcon={<Icon name="refresh" size={15} />} onClick={requestParams} disabled={!canAccess || loading || importWriting}>
          {loading ? `${receivedCount}/${totalCount}` : t('parameter.resync')}
        </Button>
        <input
          ref={importInput}
          type="file"
          accept=".params,text/plain"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0]
            event.target.value = ''
            if (file) void selectImportFile(file)
          }}
        />
        <Button
          tone="secondary"
          leadingIcon={<Icon name="upload" size={15} />}
          onClick={() => importInput.current?.click()}
          disabled={!canWrite || loading || pendingWrite !== null || params.size === 0 || targetSystemId === null || targetComponentId === null || importWriting}
        >
          {t('parameter.importParams')}
        </Button>
        <Button
          tone="secondary"
          leadingIcon={<Icon name="download" size={15} />}
          onClick={exportParams}
          disabled={loading || params.size === 0 || targetSystemId === null || targetComponentId === null || importWriting}
        >
          {t('parameter.exportParams')}
        </Button>
      </Toolbar>

      {!canAccess && params.size > 0 && <Notice tone="warning">{t('parameter.connectToSync')}</Notice>}
      {canAccess && !profileWritable && <Notice tone="warning">{t('parameter.writeNotSupported')}</Notice>}
      {canAccess && profileWritable && armed !== false && (
        <Notice tone="warning">
          {armed ? t('vehicleSetup.disarmRequired') : t('vehicleSetup.armingUnknown')}
        </Notice>
      )}
      {writeError && <Notice tone="danger">{writeError}</Notice>}

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
        <StatePanel
          kind={!vehicleReady ? 'disconnected' : canAccess ? 'empty' : 'read-only'}
          icon="parameters"
          title={t('parameter.emptyDescription')}
          description={!vehicleReady
            ? t('parameter.connectToSync')
            : canAccess
              ? t('parameter.connectToSync')
              : t('parameter.readOnlyEmpty')}
          action={canAccess
            ? <Button tone="primary" onClick={requestParams}>{t('common.retry')}</Button>
            : !vehicleReady
              ? <Button tone="primary" onClick={() => setConnectDialogOpen(true)}>{t('common.connect')}</Button>
              : undefined}
        />
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
                                className="mc-input mc-input--compact mc-param-row__select"
                                value={editValue}
                                onChange={(event) => setEditValue(event.target.value)}
                                onKeyDown={(event) => { if (event.key === 'Enter') saveParam(param.id); if (event.key === 'Escape') setEditId(null) }}
                              >
                                {editorOptions.map((option) => (
                                  <option key={option.value} value={option.value}>{option.value}: {option.label}</option>
                                ))}
                              </select>
                            ) : (
                              <input autoFocus className="mc-input mc-input--compact mc-param-row__value-input" value={editValue} onChange={(event) => setEditValue(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') saveParam(param.id); if (event.key === 'Escape') setEditId(null) }} />
                            )}
                            {editorOptions && (
                              <button type="button" className="mc-btn mc-btn-ghost mc-btn--compact mc-param-row__raw-toggle" onClick={() => setEditRaw((current) => !current)}>
                                {editRaw ? t('parameter.options') : t('parameter.rawValue')}
                              </button>
                            )}
                            <button type="button" className="mc-btn mc-btn-primary mc-btn--compact" disabled={!canWrite || pendingWrite !== null || importWriting} onClick={() => saveParam(param.id)}>{t('parameter.save')}</button>
                          </div>
                        ) : (
                          <button type="button" disabled={!canWrite || pendingWrite !== null || importWriting} className="mc-param-row__value mc-mono" onClick={() => { setEditId(param.id); setEditValue(String(param.value)); setEditRaw(false) }}>
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

      {importSelection && preview && (
        <Dialog
          open
          title={t('parameter.importDialogTitle')}
          closeLabel={t('common.close')}
          closeDisabled={importWriting}
          onClose={closeImportDialog}
          className="mc-param-import-modal"
          footer={!importJob ? (
            <>
              <Button data-autofocus tone="quiet" onClick={closeImportDialog}>
                {t('parameter.importCancel')}
              </Button>
              <Button
                tone="primary"
                leadingIcon={<Icon name="upload" size={15} />}
                onClick={startImport}
                disabled={preview.writable.length === 0
                  || !canWrite
                  || loading
                  || pendingWrite !== null
                  || targetSystemId !== importSelection.systemId
                  || targetComponentId !== importSelection.componentId
                  || (preview.dangerousCount > 0 && !dangerousImportAcknowledged)}
              >
                {t('parameter.importStartWrite', { count: preview.writable.length })}
              </Button>
            </>
          ) : (
            <Button
              data-autofocus
              tone={importWriting ? 'danger' : 'primary'}
              onClick={importWriting ? cancelImport : closeImportDialog}
            >
              {importWriting ? t('parameter.importCancel') : t('parameter.importClose')}
            </Button>
          )}
        >
          <div className="space-y-3">
            <p className="mc-param-import-file mc-mono">{importSelection.fileName}</p>

            {!importJob ? (
              <>
                <Tabs
                  tabs={[
                    { id: 'write', label: t('parameter.importSummaryWrite', { count: preview.writable.length }) },
                    { id: 'unchanged', label: t('parameter.importSummaryUnchanged', { count: unchangedImportCount }) },
                    { id: 'skipped', label: t('parameter.importSummarySkipped', { count: skippedImportCount }) },
                  ]}
                  active={importPreviewFilter}
                  onChange={(filter) => setImportPreviewFilter(filter as QgcParameterPreviewFilter)}
                  ariaLabel={t('parameter.importFilterAria')}
                  idBase="parameter-import-filter"
                  panelId="parameter-import-filter-panel"
                  className="mc-param-import-summary"
                />
                <TabPanel
                  id="parameter-import-filter-panel"
                  idBase="parameter-import-filter"
                  tabId={importPreviewFilter}
                  className="mc-param-import-filter-panel"
                >
                  <ul className="mc-modal__list mc-param-import-list">
                    {filteredImportPreview.entries.map((entry) => (
                      <li key={`${entry.row.line}:${entry.row.name}`} data-state={entry.status}>
                        <span>
                          <code>{entry.row.name}</code>
                          <small>{t(`parameter.importStatus.${entry.status}`)}</small>
                        </span>
                        <span className="mc-mono">
                          {entry.current ? `${entry.current.value} → ${entry.row.value}` : String(entry.row.value)}
                        </span>
                      </li>
                    ))}
                    {filteredImportPreview.issues.map((issue) => (
                      <li key={`issue:${issue.line}`} data-state="invalid_value">
                        <span>
                          <code>{t('parameter.importLine', { line: issue.line })}</code>
                          <small>{t(`parameter.importIssue.${issue.reason}`)}</small>
                        </span>
                      </li>
                    ))}
                    {filteredImportPreview.entries.length === 0 && filteredImportPreview.issues.length === 0 && (
                      <li>{preview.entries.length === 0 && preview.issues.length === 0
                        ? t('parameter.importEmptyFile')
                        : t('parameter.importFilterEmpty')}</li>
                    )}
                  </ul>
                </TabPanel>

                {preview.dangerousCount > 0 && (
                  <label className="mc-param-import-danger">
                    <input
                      type="checkbox"
                      checked={dangerousImportAcknowledged}
                      onChange={(event) => setDangerousImportAcknowledged(event.target.checked)}
                    />
                    <span>{t('parameter.importDangerousConfirm', { count: preview.dangerousCount })}</span>
                  </label>
                )}
              </>
            ) : (
              <>
                <div className="mc-param-import-progress" aria-live="polite">
                  <div>
                    <strong>{importJob.status === 'writing' ? t('parameter.importWriting') : t('parameter.importDone')}</strong>
                    <span>{completedImportCount}/{importJob.entries.length}</span>
                  </div>
                  <div className="mc-param-import-progress__track">
                    <i style={{ width: `${importJob.entries.length ? completedImportCount / importJob.entries.length * 100 : 100}%` }} />
                  </div>
                  {importJob.status === 'writing' && importJob.entries[importJob.nextIndex] && (
                    <code>{importJob.entries[importJob.nextIndex].row.name}</code>
                  )}
                </div>

                {importJob.status === 'done' && (
                  <p className="mc-param-import-result">
                    {t('parameter.importDoneSummary', { succeeded: importJob.succeeded.length, failed: importJob.failed.length })}
                  </p>
                )}
                {importJob.failed.length > 0 && (
                  <ul className="mc-modal__list mc-param-import-failures">
                    {importJob.failed.map((failure, index) => (
                      <li key={`${failure.id}:${index}`}><code>{failure.id}</code><span>{failure.reason}</span></li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>
        </Dialog>
      )}
    </div>
  )
}
