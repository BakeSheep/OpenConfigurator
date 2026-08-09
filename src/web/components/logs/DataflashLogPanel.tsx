// ArduPilot DataFlash log browser: flat id-addressed log list over
// LOG_REQUEST_LIST, per-log download (save / analyze) over LOG_REQUEST_DATA,
// and an explicit "erase ALL logs" action (LOG_ERASE has no per-log delete).
// Reuses the flight-log explorer's visual language (sortable detail table,
// context menu, transfer status bar, double-confirmation dialog).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import Icon from '../ui/Icon'
import { sendClientMessage } from '../../hooks/useWebSocket'
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

  const [sortKey, setSortKey] = useState<SortKey>('name')
  const [sortAsc, setSortAsc] = useState(false)
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [eraseDialogOpen, setEraseDialogOpen] = useState(false)
  const [eraseAcknowledged, setEraseAcknowledged] = useState(false)
  const handledDownloadRef = useRef<string | null>(null)
  const listedTargetRef = useRef<string | null>(null)

  const requestList = useCallback(() => {
    useLogTransferStore.getState().setLoading(true)
    sendClientMessage({ type: 'log_list' })
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

  // Erase finished: the backend already pushed the fresh (empty) list;
  // dismiss the task shortly after.
  useEffect(() => {
    if (erase?.status !== 'done') return
    const timer = setTimeout(() => useLogTransferStore.getState().clearErase(), 1500)
    return () => clearTimeout(timer)
  }, [erase?.status])

  // Download finished: hand the file to the browser or to the analysis page.
  useEffect(() => {
    if (download?.status !== 'done' || !download.downloadId) return
    if (handledDownloadRef.current === download.downloadId) return
    handledDownloadRef.current = download.downloadId
    const url = `/api/logs/downloads/${download.downloadId}`
    if (download.intent === 'save') {
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = download.fileName ?? 'log.bin'
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      const timer = setTimeout(() => useLogTransferStore.getState().clearDownload(), 2500)
      return () => clearTimeout(timer)
    }
    let cancelled = false
    void (async () => {
      try {
        const response = await fetch(url)
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const blob = await response.blob()
        if (cancelled) return
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

  // Close the context menu on any outside click / escape.
  useEffect(() => {
    if (!contextMenu) return
    const close = () => setContextMenu(null)
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    window.addEventListener('click', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [contextMenu])

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
  const busy = download?.status === 'active' || erase?.status === 'active'
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
    sendClientMessage({ type: 'log_download', data: { logId: entry.id } })
  }, [busy])

  const handleContextMenu = (event: React.MouseEvent, entry: DataflashLogEntry) => {
    event.preventDefault()
    event.stopPropagation()
    if (!selection.has(entry.id)) {
      useLogTransferStore.getState().setSelection(new Set([entry.id]), entry.id)
    }
    setContextMenu({ x: event.clientX, y: event.clientY, entry })
  }

  const confirmErase = () => {
    setEraseDialogOpen(false)
    setEraseAcknowledged(false)
    useLogTransferStore.getState().beginErase()
    sendClientMessage({ type: 'log_erase', safetyConfirmation: 'erase_all_logs' })
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
            disabled={entries.length === 0 || busy}
            onClick={() => setEraseDialogOpen(true)}
          >
            <Icon name="trash" size={14} /> {t('flightLogs.df.eraseAll')}
          </button>
          <span style={{ flex: 1 }} />
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
        <div className="mc-explorer__table" role="grid">
          <div
            className="mc-explorer__row mc-explorer__row--header"
            role="row"
            style={{ gridTemplateColumns: 'minmax(0, 1fr) 200px 110px' }}
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
          <div className="mc-explorer__body">
            {loading && !listed ? (
              <p className="mc-explorer__notice">{t('flightLogs.readingLogList')}</p>
            ) : sortedEntries.length === 0 ? (
              <p className="mc-explorer__notice">
                {listError ? t('flightLogs.readFailed') : t('flightLogs.noLogsOnFc')}
              </p>
            ) : (
              sortedEntries.map((entry) => (
                <div
                  key={entry.id}
                  role="row"
                  aria-selected={selection.has(entry.id)}
                  className={
                    'mc-explorer__row'
                    + (selection.has(entry.id) ? ' is-selected' : '')
                  }
                  style={{ gridTemplateColumns: 'minmax(0, 1fr) 200px 110px' }}
                  onClick={(event) => handleRowClick(event, entry)}
                  onDoubleClick={() => startDownload(entry, 'analyze')}
                  onContextMenu={(event) => handleContextMenu(event, entry)}
                >
                  <span className="mc-explorer__name">
                    <Icon name="log" size={16} style={{ color: 'var(--accent)' }} />
                    <span className="mc-mono">{dataflashLogName(entry)}</span>
                  </span>
                  <span className="mc-mono">{formatEntryDate(entry.timeUtcMs)}</span>
                  <span className="mc-mono">{formatBytes(entry.sizeBytes)}</span>
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
                    onClick={() => sendClientMessage({ type: 'log_download_cancel' })}
                  >
                    <Icon name="close" size={13} />
                  </button>
                </>
              )}
              {download.status === 'done' && download.intent === 'save' && (
                <span style={{ color: 'var(--success)' }}>{t('flightLogs.downloadDone')}</span>
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
      {contextMenu && (
        <div
          className="mc-context-menu"
          style={{
            left: Math.min(contextMenu.x, window.innerWidth - 200),
            top: Math.min(contextMenu.y, window.innerHeight - 160),
          }}
          onClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setContextMenu(null)
              startDownload(contextMenu.entry, 'save')
            }}
          >
            <Icon name="download" size={14} /> {t('flightLogs.download')}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setContextMenu(null)
              startDownload(contextMenu.entry, 'analyze')
            }}
          >
            <Icon name="waveform" size={14} /> {t('flightLogs.downloadAnalyze')}
          </button>
          <button
            type="button"
            className="is-danger"
            disabled={busy || entries.length === 0}
            onClick={() => {
              setContextMenu(null)
              setEraseDialogOpen(true)
            }}
          >
            <Icon name="trash" size={14} /> {t('flightLogs.df.eraseAllEllipsis')}
          </button>
        </div>
      )}

      {/* Erase-all confirmation dialog */}
      {eraseDialogOpen && (
        <div className="mc-modal-backdrop" role="dialog" aria-modal="true">
          <div className="mc-card mc-modal">
            <h3 className="mc-section-title" style={{ color: 'var(--danger)' }}>
              {t('flightLogs.df.eraseTitle')}
            </h3>
            <p style={{ color: 'var(--text-secondary)', fontSize: 13 }}>
              {t('flightLogs.df.eraseConfirm', { count: entries.length, size: formatBytes(totalSize) })}
              {t('flightLogs.df.eraseConfirmText')}
            </p>
            <label className="flex items-center gap-2" style={{ fontSize: 13 }}>
              <input
                type="checkbox"
                checked={eraseAcknowledged}
                onChange={(event) => setEraseAcknowledged(event.target.checked)}
              />
              {t('flightLogs.df.eraseAcknowledge')}
            </label>
            <div className="flex justify-end gap-2 mt-4">
              <button
                type="button"
                className="mc-btn mc-btn-ghost"
                onClick={() => {
                  setEraseDialogOpen(false)
                  setEraseAcknowledged(false)
                }}
              >
                {t('flightLogs.cancel')}
              </button>
              <button
                type="button"
                className="mc-btn mc-btn-danger"
                disabled={!eraseAcknowledged}
                onClick={confirmErase}
              >
                <Icon name="trash" size={14} /> {t('flightLogs.df.eraseAllLogs')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
