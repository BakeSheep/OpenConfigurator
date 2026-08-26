// ArduPilot DataFlash log browser: flat id-addressed log list over
// LOG_REQUEST_LIST, per-log download (save / analyze) over LOG_REQUEST_DATA,
// and an explicit "erase ALL logs" action (LOG_ERASE has no per-log delete).
// Reuses the flight-log explorer's visual language (sortable detail table,
// context menu, transfer status bar, double-confirmation dialog).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import Icon from '../ui/Icon'
import ConfirmDialog from '../ui/ConfirmDialog'
import { sendRuntimeCommand } from '../../hooks/useLocalRuntime'
import { localRuntime } from '../../runtime/LocalRuntimeClient'
import { useLogTransferStore } from '../../stores/logTransferStore'
import { useParameterStore } from '../../stores/parameterStore'
import { useConnectionStore } from '../../stores/connectionStore'
import { stashLogBlob } from '../../utils/logAnalysisSession'
import { formatBytes } from '../../utils/formatBytes'
import type { DataflashLogEntry } from '../../../shared/types'

type SortKey = 'name' | 'date' | 'size'

interface ContextMenuState {
  x: number
  y: number
  entry: DataflashLogEntry
  targetKey: string
}

export function dataflashLogName(entry: DataflashLogEntry): string {
  return `LOG_${String(entry.id).padStart(4, '0')}.bin`
}

function formatEntryDate(timestamp: number | null): string {
  if (timestamp === null) return '-'
  const date = new Date(timestamp)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} `
    + `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} UTC`
}

function eraseConfirmationKey(targetKey: string, entries: DataflashLogEntry[]): string {
  const objects = entries
    .map((entry) => [entry.id, entry.sizeBytes, entry.timeUtcMs] as const)
    .sort((a, b) => a[0] - b[0])
  return JSON.stringify([targetKey, 'erase-all', objects])
}

export default function DataflashLogPanel({ vehicleReady }: { vehicleReady: boolean }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const entries = useLogTransferStore((state) => state.entries)
  const listed = useLogTransferStore((state) => state.listed)
  const loading = useLogTransferStore((state) => state.loading)
  const listError = useLogTransferStore((state) => state.listError)
  const selection = useLogTransferStore((state) => state.selection)
  const lastSelected = useLogTransferStore((state) => state.lastSelected)
  const download = useLogTransferStore((state) => state.download)
  const erase = useLogTransferStore((state) => state.erase)
  const parameterSyncActive = useParameterStore((state) => state.loading)
  const targetSystemId = useConnectionStore((state) => state.targetSystemId)
  const targetComponentId = useConnectionStore((state) => state.targetComponentId)
  const canControl = useConnectionStore((state) => state.canControl)
  const safetyEpoch = useConnectionStore((state) => state.safetyEpoch)
  const safetyAuthorityId = useConnectionStore((state) => state.safetyAuthorityId)

  const [sortKey, setSortKey] = useState<SortKey>('name')
  const [sortAsc, setSortAsc] = useState(false)
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [eraseDialogOpen, setEraseDialogOpen] = useState(false)
  const [focusedLogId, setFocusedLogId] = useState<number | null>(null)
  const handledDownloadRef = useRef<string | null>(null)
  const listedTargetRef = useRef<string | null>(null)
  const contextMenuRef = useRef<HTMLDivElement | null>(null)
  const contextTriggerRef = useRef<HTMLDivElement | null>(null)
  const targetKey = `${targetSystemId ?? '-'}:${targetComponentId ?? '-'}`
  const previousTargetKeyRef = useRef<string | null>(null)
  const previousVehicleReadyRef = useRef(vehicleReady)
  const [boundTargetKey, setBoundTargetKey] = useState<string | null>(null)
  const targetStateCurrent = vehicleReady && boundTargetKey === targetKey

  const closeContextMenu = useCallback((restoreFocus = false) => {
    const trigger = contextTriggerRef.current
    setContextMenu(null)
    if (restoreFocus) requestAnimationFrame(() => trigger?.focus())
  }, [])

  // Never carry a list, selection, task or destructive acknowledgement from
  // one flight-controller target to another. Reset on mount as well, since the
  // store can outlive this panel while the user navigates elsewhere.
  useEffect(() => {
    const initialBinding = previousTargetKeyRef.current === null
    const targetChanged = previousTargetKeyRef.current !== targetKey
    const readinessChanged = previousVehicleReadyRef.current !== vehicleReady
    previousTargetKeyRef.current = targetKey
    previousVehicleReadyRef.current = vehicleReady
    setBoundTargetKey(vehicleReady ? targetKey : null)
    if (!initialBinding && !targetChanged && !readinessChanged) return
    listedTargetRef.current = null
    handledDownloadRef.current = null
    contextTriggerRef.current = null
    setFocusedLogId(null)
    setEraseDialogOpen(false)
    closeContextMenu(false)
    useLogTransferStore.getState().reset()
  }, [closeContextMenu, targetKey, vehicleReady])

  useEffect(() => {
    setEraseDialogOpen(false)
    closeContextMenu(false)
    useLogTransferStore.getState().clearSelection()
  }, [canControl, closeContextMenu, safetyAuthorityId, safetyEpoch])

  const requestList = useCallback(() => {
    useLogTransferStore.getState().setLoading(true)
    sendRuntimeCommand({ type: 'log_list' })
  }, [])

  // List once the link is ready and the automatic parameter sync has yielded
  // the MAVLink channel. DataFlash and parameter transfers intentionally do
  // not overlap; waiting here avoids a nondeterministic startup ftp_busy race.
  useEffect(() => {
    if (!vehicleReady) {
      listedTargetRef.current = null
      return
    }
    if (parameterSyncActive || targetSystemId === null || targetComponentId === null) return
    const targetKey = `${targetSystemId}:${targetComponentId}`
    if (listedTargetRef.current === targetKey) return
    listedTargetRef.current = targetKey
    requestList()
  }, [parameterSyncActive, requestList, targetComponentId, targetSystemId, vehicleReady])

  // Erase finished: the local runtime already pushed the fresh (empty) list;
  // dismiss the task shortly after.
  useEffect(() => {
    if (erase?.status !== 'done') return
    const timer = setTimeout(() => useLogTransferStore.getState().clearErase(), 1500)
    return () => clearTimeout(timer)
  }, [erase?.status])

  // Download finished: hand the file to the browser or to the analysis page.
  useEffect(() => {
    if (download?.status !== 'done' || !download.artifactId) return
    if (handledDownloadRef.current === download.artifactId) return
    handledDownloadRef.current = download.artifactId
    let cancelled = false
    void (async () => {
      try {
        const { blob, fileName } = await localRuntime.readArtifact(download.artifactId!, true)
        if (cancelled) return
        if (download.intent === 'save') {
          const url = URL.createObjectURL(blob)
          const anchor = document.createElement('a')
          anchor.href = url
          anchor.download = download.fileName ?? fileName
          document.body.appendChild(anchor)
          anchor.click()
          anchor.remove()
          URL.revokeObjectURL(url)
          useLogTransferStore.getState().clearDownload()
          return
        }
        stashLogBlob(download.fileName ?? 'log.bin', blob)
        useLogTransferStore.getState().clearDownload()
        navigate('/log-analysis')
      } catch (error) {
        console.error('[Logs] failed to fetch downloaded file:', error)
        if (!cancelled) {
          useLogTransferStore.getState().failDownload(t('flightLogs.readFileFailed'))
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [download, navigate])

  // Focus the menu on open and close it on any outside click / escape.
  useEffect(() => {
    if (!contextMenu) return
    const frame = requestAnimationFrame(() => {
      const firstItem = contextMenuRef.current?.querySelector<HTMLButtonElement>(
        '[role="menuitem"]:not(:disabled)',
      )
      if (firstItem) firstItem.focus()
      else contextMenuRef.current?.focus()
    })
    const close = () => closeContextMenu(false)
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeContextMenu(true)
      }
    }
    window.addEventListener('click', close)
    window.addEventListener('keydown', onKey)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('click', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [closeContextMenu, contextMenu])

  const sortedEntries = useMemo(() => {
    const factor = sortAsc ? 1 : -1
    const compare = (a: DataflashLogEntry, b: DataflashLogEntry): number => {
      switch (sortKey) {
        case 'size':
          return (a.sizeBytes - b.sizeBytes) * factor
        case 'date':
          return ((a.timeUtcMs ?? 0) - (b.timeUtcMs ?? 0)) * factor
        default:
          return (a.id - b.id) * factor
      }
    }
    return [...entries].sort(compare)
  }, [entries, sortKey, sortAsc])

  const selectedEntries = useMemo(
    () => sortedEntries.filter((entry) => selection.has(entry.id)),
    [sortedEntries, selection],
  )
  const rovingLogId = sortedEntries.some((entry) => entry.id === focusedLogId)
    ? focusedLogId
    : (sortedEntries[0]?.id ?? null)
  const currentEraseConfirmationKey = eraseConfirmationKey(
    `${targetKey}@safety:${safetyAuthorityId ?? '-'}:${safetyEpoch}`,
    entries,
  )
  const busy = !targetStateCurrent
    || download?.status === 'active'
    || erase?.status === 'active'
  const singleLog = selectedEntries.length === 1 ? selectedEntries[0] : null

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortAsc((asc) => !asc)
    else {
      setSortKey(key)
      setSortAsc(true)
    }
  }

  const handleRowClick = (event: React.MouseEvent, entry: DataflashLogEntry) => {
    event.stopPropagation()
    setFocusedLogId(entry.id)
    const store = useLogTransferStore.getState()
    if (event.ctrlKey || event.metaKey) {
      const next = new Set(selection)
      if (next.has(entry.id)) next.delete(entry.id)
      else next.add(entry.id)
      store.setSelection(next, entry.id)
      return
    }
    if (event.shiftKey && lastSelected !== null) {
      const ids = sortedEntries.map((item) => item.id)
      const from = ids.indexOf(lastSelected)
      const to = ids.indexOf(entry.id)
      if (from >= 0 && to >= 0) {
        const [start, end] = from <= to ? [from, to] : [to, from]
        store.setSelection(new Set(ids.slice(start, end + 1)))
        return
      }
    }
    store.setSelection(new Set([entry.id]), entry.id)
  }

  const startDownload = useCallback((entry: DataflashLogEntry, intent: 'save' | 'analyze') => {
    if (busy) return
    handledDownloadRef.current = null
    useLogTransferStore.getState().beginDownload(entry.id, intent)
    sendRuntimeCommand({ type: 'log_download', data: { logId: entry.id } })
  }, [busy])

  const openContextMenu = (
    entry: DataflashLogEntry,
    x: number,
    y: number,
    trigger: HTMLDivElement,
  ) => {
    if (!selection.has(entry.id)) {
      useLogTransferStore.getState().setSelection(new Set([entry.id]), entry.id)
    }
    contextTriggerRef.current = trigger
    setContextMenu({ x, y, entry, targetKey })
  }

  const handleContextMenu = (event: React.MouseEvent, entry: DataflashLogEntry) => {
    event.preventDefault()
    event.stopPropagation()
    const row = event.currentTarget as HTMLDivElement
    const rect = row.getBoundingClientRect()
    const keyboardInvocation = event.clientX === 0 && event.clientY === 0
    openContextMenu(
      entry,
      keyboardInvocation ? rect.left + 24 : event.clientX,
      keyboardInvocation ? rect.top + 24 : event.clientY,
      row,
    )
  }

  const handleRowKeyDown = (
    event: React.KeyboardEvent<HTMLDivElement>,
    entry: DataflashLogEntry,
  ) => {
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      const rows = Array.from(
        event.currentTarget.parentElement?.querySelectorAll<HTMLDivElement>('[data-dataflash-row]') ?? [],
      )
      if (rows.length === 0) return
      event.preventDefault()
      event.stopPropagation()
      const currentIndex = rows.indexOf(event.currentTarget)
      let nextIndex = currentIndex
      if (event.key === 'Home') nextIndex = 0
      else if (event.key === 'End') nextIndex = rows.length - 1
      else if (event.key === 'ArrowUp') nextIndex = Math.max(0, currentIndex - 1)
      else if (event.key === 'ArrowDown') nextIndex = Math.min(rows.length - 1, currentIndex + 1)
      rows[nextIndex]?.focus()
      return
    }

    if (event.key === ' ') {
      event.preventDefault()
      event.stopPropagation()
      const store = useLogTransferStore.getState()
      if (event.shiftKey && lastSelected !== null) {
        const ids = sortedEntries.map((item) => item.id)
        const from = ids.indexOf(lastSelected)
        const to = ids.indexOf(entry.id)
        if (from >= 0 && to >= 0) {
          const [start, end] = from <= to ? [from, to] : [to, from]
          store.setSelection(new Set(ids.slice(start, end + 1)))
          return
        }
      }
      if (event.ctrlKey || event.metaKey) {
        const next = new Set(selection)
        if (next.has(entry.id)) next.delete(entry.id)
        else next.add(entry.id)
        store.setSelection(next, entry.id)
        return
      }
      store.setSelection(new Set([entry.id]), entry.id)
      return
    }

    if (event.key === 'Enter') {
      event.preventDefault()
      event.stopPropagation()
      useLogTransferStore.getState().setSelection(new Set([entry.id]), entry.id)
      startDownload(entry, 'analyze')
      return
    }

    if ((event.key === 'F10' && event.shiftKey) || event.key === 'ContextMenu') {
      event.preventDefault()
      event.stopPropagation()
      const rect = event.currentTarget.getBoundingClientRect()
      openContextMenu(entry, rect.left + 24, rect.top + 24, event.currentTarget)
    }
  }

  const handleMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      closeContextMenu(true)
      return
    }
    if (event.key === 'Tab') {
      event.preventDefault()
      event.stopPropagation()
      closeContextMenu(true)
      return
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return

    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'),
    )
    if (items.length === 0) return
    event.preventDefault()
    event.stopPropagation()
    const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement)
    let nextIndex = 0
    if (event.key === 'End') nextIndex = items.length - 1
    else if (event.key === 'ArrowUp') nextIndex = currentIndex <= 0 ? items.length - 1 : currentIndex - 1
    else if (event.key === 'ArrowDown') nextIndex = currentIndex >= items.length - 1 ? 0 : currentIndex + 1
    items[nextIndex]?.focus()
  }

  const confirmErase = () => {
    const connection = useConnectionStore.getState()
    const liveTargetKey = `${connection.targetSystemId ?? '-'}:${connection.targetComponentId ?? '-'}`
    const liveEntries = useLogTransferStore.getState().entries
    if (
      !targetStateCurrent
      || !connection.vehicleReady
      || !connection.canControl
      || connection.safetyAuthorityId === null
      || connection.targetSystemId === null
      || connection.targetComponentId === null
      || liveEntries.length === 0
      || eraseConfirmationKey(
        `${liveTargetKey}@safety:${connection.safetyAuthorityId ?? '-'}:${connection.safetyEpoch}`,
        liveEntries,
      ) !== currentEraseConfirmationKey
    ) {
      setEraseDialogOpen(false)
      return
    }
    setEraseDialogOpen(false)
    useLogTransferStore.getState().beginErase()
    sendRuntimeCommand({
      type: 'log_erase',
      safetyConfirmation: 'erase_all_logs',
      expectedSafetyEpoch: connection.safetyEpoch,
      expectedSafetyAuthorityId: connection.safetyAuthorityId,
    })
  }

  const totalSize = entries.reduce((sum, entry) => sum + entry.sizeBytes, 0)
  const selectionSize = selectedEntries.reduce((sum, entry) => sum + entry.sizeBytes, 0)

  return (
    <>
      <section
        className="mc-card mc-explorer"
        onClick={() => useLogTransferStore.getState().clearSelection()}
      >
        {/* Action toolbar (the log list is flat - no navigation) */}
        <div className="mc-explorer__actions" onClick={(event) => event.stopPropagation()}>
          <button
            type="button"
            className="mc-btn mc-btn-primary"
            disabled={!singleLog || busy}
            onClick={() => singleLog && startDownload(singleLog, 'save')}
          >
            <Icon name="download" size={14} /> {t('flightLogs.download')}
          </button>
          <button
            type="button"
            className="mc-btn"
            disabled={!singleLog || busy}
            onClick={() => singleLog && startDownload(singleLog, 'analyze')}
          >
            <Icon name="waveform" size={14} /> {t('flightLogs.downloadAnalyze')}
          </button>
          <button
            type="button"
            className="mc-btn mc-btn-danger"
            disabled={
              entries.length === 0
              || busy
              || !vehicleReady
              || !canControl
              || targetSystemId === null
              || targetComponentId === null
            }
            onClick={() => setEraseDialogOpen(true)}
          >
            <Icon name="trash" size={14} /> {t('flightLogs.df.eraseAll')}
          </button>
          <span className="mc-explorer__action-spacer" aria-hidden="true" />
          {listError && (
            <span className="mc-explorer__error" role="alert">
              <Icon name="warning" size={14} /> {listError}
            </span>
          )}
          <button
            type="button"
            className="mc-icon-btn mc-icon-btn--bordered"
            aria-label={t('flightLogs.refresh')}
            disabled={busy}
            onClick={() => requestList()}
          >
            <Icon name="refresh" size={15} />
          </button>
        </div>

        {/* Detail table */}
        <div
          className="mc-explorer__table"
          role="grid"
          aria-colcount={3}
          aria-rowcount={sortedEntries.length + 1}
        >
          <div
            className="mc-explorer__row mc-explorer__row--header mc-explorer__row--dataflash"
            role="row"
          >
            {([
              ['name', t('flightLogs.colName')],
              ['date', t('flightLogs.colDate')],
              ['size', t('flightLogs.colSize')],
            ] as Array<[SortKey, string]>).map(([key, label]) => (
              <button key={key} type="button" role="columnheader" onClick={(event) => {
                event.stopPropagation()
                toggleSort(key)
              }}>
                {label}
                {sortKey === key && <span className="mc-explorer__sort">{sortAsc ? '▲' : '▼'}</span>}
              </button>
            ))}
          </div>
          <div className="mc-explorer__body" role="rowgroup">
            {loading && !listed ? (
              <div className="mc-explorer__notice" role="row">
                <span role="gridcell" aria-colspan={3}>{t('flightLogs.readingLogList')}</span>
              </div>
            ) : sortedEntries.length === 0 ? (
              <div className="mc-explorer__notice" role="row">
                <span role="gridcell" aria-colspan={3}>
                  {listError ? t('flightLogs.readFailed') : t('flightLogs.noLogsOnFc')}
                </span>
              </div>
            ) : (
              sortedEntries.map((entry) => (
                <div
                  key={entry.id}
                  role="row"
                  data-dataflash-row
                  tabIndex={entry.id === rovingLogId ? 0 : -1}
                  aria-selected={selection.has(entry.id)}
                  className={
                    'mc-explorer__row mc-explorer__row--dataflash'
                    + (selection.has(entry.id) ? ' is-selected' : '')
                  }
                  onClick={(event) => handleRowClick(event, entry)}
                  onFocus={() => setFocusedLogId(entry.id)}
                  onDoubleClick={() => startDownload(entry, 'analyze')}
                  onKeyDown={(event) => handleRowKeyDown(event, entry)}
                  onContextMenu={(event) => handleContextMenu(event, entry)}
                >
                  <span className="mc-explorer__name" role="gridcell">
                    <Icon name="log" size={16} style={{ color: 'var(--accent)' }} />
                    <span className="mc-mono">{dataflashLogName(entry)}</span>
                  </span>
                  <span className="mc-mono" role="gridcell">{formatEntryDate(entry.timeUtcMs)}</span>
                  <span className="mc-mono" role="gridcell">{formatBytes(entry.sizeBytes)}</span>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Status bar */}
        <div className="mc-explorer__statusbar" onClick={(event) => event.stopPropagation()}>
          <span>
            {t('flightLogs.totalItems', { count: entries.length })}
            {entries.length > 0 && <>（{formatBytes(totalSize)}）</>}
            {selectedEntries.length > 0 && (
              <>
                {' · '}{t('flightLogs.selectedItems', { count: selectedEntries.length })}
                {selectionSize > 0 && <>（{formatBytes(selectionSize)}）</>}
              </>
            )}
          </span>
          {download && (
            <span className="mc-explorer__transfer">
              {download.status === 'active' && (
                <>
                  <progress
                    value={download.totalBytes > 0 ? download.receivedBytes : undefined}
                    max={download.totalBytes > 0 ? download.totalBytes : undefined}
                  />
                  <span className="mc-mono">
                    {formatBytes(download.receivedBytes)} / {formatBytes(download.totalBytes)}
                    {' · '}{formatBytes(Math.round(download.rateBps))}/s
                    {download.rateBps > 0 && download.totalBytes > download.receivedBytes && (
                      <>
                        {' · '}{t('flightLogs.remaining')} {Math.ceil((download.totalBytes - download.receivedBytes) / download.rateBps)} {t('flightLogs.seconds')}
                      </>
                    )}
                  </span>
                  <button
                    type="button"
                    className="mc-icon-btn"
                    aria-label={t('flightLogs.cancelDownload')}
                    onClick={() => sendRuntimeCommand({ type: 'log_download_cancel' })}
                  >
                    <Icon name="close" size={13} />
                  </button>
                </>
              )}
              {download.status === 'done' && download.intent === 'save' && (
                <span style={{ color: download.sizeAdjusted ? 'var(--warning-foreground)' : 'var(--success)' }}>
                  {download.sizeAdjusted
                    ? t('flightLogs.df.sizeAdjusted', {
                        advertised: formatBytes(download.advertisedSizeBytes ?? 0),
                        final: formatBytes(download.receivedBytes),
                      })
                    : t('flightLogs.downloadDone')}
                </span>
              )}
              {download.status === 'done' && download.intent === 'analyze' && (
                <span>{t('flightLogs.downloadDoneAnalyze')}</span>
              )}
              {download.status === 'error' && (
                <span style={{ color: 'var(--danger)' }}>
                  {t('flightLogs.downloadFailed', { error: download.error })}
                  <button
                    type="button"
                    className="mc-icon-btn"
                    aria-label={t('common.close')}
                    onClick={() => useLogTransferStore.getState().clearDownload()}
                  >
                    <Icon name="close" size={13} />
                  </button>
                </span>
              )}
            </span>
          )}
          {erase && (
            <span className="mc-explorer__transfer">
              {erase.status === 'active' && <span>{t('flightLogs.df.erasing')}</span>}
              {erase.status === 'done' && (
                <span style={{ color: 'var(--success)' }}>{t('flightLogs.df.eraseDone')}</span>
              )}
              {erase.status === 'error' && (
                <span style={{ color: 'var(--danger)' }}>
                  {t('flightLogs.df.eraseFailed', { error: erase.error })}
                  <button
                    type="button"
                    className="mc-icon-btn"
                    aria-label={t('common.close')}
                    onClick={() => useLogTransferStore.getState().clearErase()}
                  >
                    <Icon name="close" size={13} />
                  </button>
                </span>
              )}
            </span>
          )}
        </div>
      </section>

      {/* Context menu */}
      {contextMenu && contextMenu.targetKey === targetKey && (
        <div
          ref={contextMenuRef}
          className="mc-context-menu"
          role="menu"
          aria-label={t('flightLogs.contextMenuLabel', { name: dataflashLogName(contextMenu.entry) })}
          tabIndex={-1}
          style={{
            left: Math.max(8, Math.min(contextMenu.x, window.innerWidth - 200)),
            top: Math.max(8, Math.min(contextMenu.y, window.innerHeight - 160)),
          }}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={handleMenuKeyDown}
        >
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            disabled={busy}
            onClick={() => {
              closeContextMenu(true)
              startDownload(contextMenu.entry, 'save')
            }}
          >
            <Icon name="download" size={14} /> {t('flightLogs.download')}
          </button>
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            disabled={busy}
            onClick={() => {
              closeContextMenu(true)
              startDownload(contextMenu.entry, 'analyze')
            }}
          >
            <Icon name="waveform" size={14} /> {t('flightLogs.downloadAnalyze')}
          </button>
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            className="is-danger"
            disabled={
              busy
              || entries.length === 0
              || !vehicleReady
              || !canControl
              || targetSystemId === null
              || targetComponentId === null
            }
            onClick={() => {
              contextTriggerRef.current?.focus()
              closeContextMenu(false)
              setEraseDialogOpen(true)
            }}
          >
            <Icon name="trash" size={14} /> {t('flightLogs.df.eraseAllEllipsis')}
          </button>
        </div>
      )}

      <ConfirmDialog
        open={eraseDialogOpen}
        confirmationKey={currentEraseConfirmationKey}
        title={t('flightLogs.df.eraseTitle')}
        consequence={t('flightLogs.df.eraseConfirm', {
          count: entries.length,
          size: formatBytes(totalSize),
        })}
        commitmentLabel={t('flightLogs.df.eraseAcknowledge')}
        confirmLabel={t('flightLogs.df.eraseAllLogs')}
        cancelLabel={t('flightLogs.cancel')}
        closeLabel={t('common.close')}
        confirmIcon={<Icon name="trash" size={14} />}
        busy={erase?.status === 'active'}
        busyLabel={t('flightLogs.df.erasing')}
        onCancel={() => setEraseDialogOpen(false)}
        onConfirm={confirmErase}
      />
    </>
  )
}
