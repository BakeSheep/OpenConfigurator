// Windows-Explorer-style browser for the FC SD card over MAVLink FTP:
// navigation history + breadcrumb, sortable detail columns, multi-select,
// context menu, download (save / analyze) and recursive deletion.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import i18next from 'i18next'
import Icon from '../components/ui/Icon'
import ConfirmDialog from '../components/ui/ConfirmDialog'
import { EmptyState, PageHeader } from '../components/ui/PageFrame'
import DataflashLogPanel from '../components/logs/DataflashLogPanel'
import { sendClientMessage } from '../hooks/useWebSocket'
import { useConnectionStore } from '../stores/connectionStore'
import { useFileExplorerStore } from '../stores/fileExplorerStore'
import { useTelemetryStore } from '../stores/telemetryStore'
import { PX4_ULOG_LOG_DIRECTORY } from '../../shared/constants'
import { logSupport } from '../utils/logProfiles'
import { parsePx4DirectoryDate, parsePx4FileDate } from '../utils/ulogAnalysis'
import { stashLogBuffer } from '../utils/logAnalysisSession'
import { formatBytes } from '../utils/formatBytes'
import { backendEnabled } from '../runtime'
import type { FsEntry } from '../../shared/types'

type SortKey = 'name' | 'date' | 'type' | 'size'

interface ContextMenuState {
  x: number
  y: number
  entry: FsEntry
  targetKey: string
}

function formatEntryDate(timestamp: number | null): string {
  if (timestamp === null) return '—'
  const date = new Date(timestamp)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} `
    + `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} UTC`
}

const t = i18next.t.bind(i18next)

function entryTypeLabel(entry: FsEntry): string {
  if (entry.kind === 'dir') return t('flightLogs.folder')
  const dot = entry.name.lastIndexOf('.')
  if (dot <= 0) return t('flightLogs.file')
  const extension = entry.name.slice(dot + 1).toUpperCase()
  return extension === 'ULG' ? t('flightLogs.ulogFile') : t('flightLogs.fileType', { ext: extension })
}

function isUlgFile(entry: FsEntry): boolean {
  return entry.kind === 'file' && entry.name.toLowerCase().endsWith('.ulg')
}

function joinPath(dir: string, name: string): string {
  return dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`
}

function parentOf(path: string): string | null {
  if (path === '/' || path === '') return null
  const trimmed = path.endsWith('/') ? path.slice(0, -1) : path
  const index = trimmed.lastIndexOf('/')
  return index <= 0 ? '/' : trimmed.slice(0, index)
}

function entryTimestamp(entry: FsEntry, currentPath: string): number | null {
  const dirName = currentPath.split('/').filter(Boolean).pop()
  return entry.kind === 'dir'
    ? parsePx4DirectoryDate(entry.name)
    : parsePx4FileDate(entry.name, dirName)
}

function fileDeleteConfirmationKey(
  targetKey: string,
  path: string,
  entries: FsEntry[],
  selection: Set<string>,
): string {
  const objects = entries
    .filter((entry) => selection.has(entry.name))
    .map((entry) => [entry.kind, entry.name] as const)
    .sort((a, b) => a[1].localeCompare(b[1]) || a[0].localeCompare(b[0]))
  return JSON.stringify([targetKey, path, objects])
}

export default function FlightLogsPage({ embedded = false }: { embedded?: boolean }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const vehicleReady = useConnectionStore((state) => state.vehicleReady)
  const canControl = useConnectionStore((state) => state.canControl)
  const safetyEpoch = useConnectionStore((state) => state.safetyEpoch)
  const safetyAuthorityId = useConnectionStore((state) => state.safetyAuthorityId)
  const targetSystemId = useConnectionStore((state) => state.targetSystemId)
  const targetComponentId = useConnectionStore((state) => state.targetComponentId)
  const vehicleIdentity = useTelemetryStore((state) => state.vehicleIdentity)
  const logs = logSupport(vehicleIdentity)
  const currentPath = useFileExplorerStore((state) => state.currentPath)
  const entries = useFileExplorerStore((state) => state.entries)
  const listedPath = useFileExplorerStore((state) => state.listedPath)
  const loading = useFileExplorerStore((state) => state.loading)
  const listError = useFileExplorerStore((state) => state.listError)
  const backStack = useFileExplorerStore((state) => state.backStack)
  const forwardStack = useFileExplorerStore((state) => state.forwardStack)
  const selection = useFileExplorerStore((state) => state.selection)
  const lastSelected = useFileExplorerStore((state) => state.lastSelected)
  const download = useFileExplorerStore((state) => state.download)
  const deletion = useFileExplorerStore((state) => state.deletion)

  const [sortKey, setSortKey] = useState<SortKey>('name')
  const [sortAsc, setSortAsc] = useState(true)
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [focusedEntryName, setFocusedEntryName] = useState<string | null>(null)
  const handledDownloadRef = useRef<string | null>(null)
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

  // A listing, selection or destructive acknowledgement from one vehicle must
  // never survive a target switch. A live page also refreshes on mount, because
  // the store may have remained populated while this route was unmounted.
  useEffect(() => {
    const initialBinding = previousTargetKeyRef.current === null
    const targetChanged = previousTargetKeyRef.current !== targetKey
    const readinessChanged = previousVehicleReadyRef.current !== vehicleReady
    previousTargetKeyRef.current = targetKey
    previousVehicleReadyRef.current = vehicleReady
    setBoundTargetKey(vehicleReady ? targetKey : null)
    if (!initialBinding && !targetChanged && !readinessChanged) return
    setDeleteDialogOpen(false)
    closeContextMenu(false)
    contextTriggerRef.current = null
    handledDownloadRef.current = null
    setFocusedEntryName(null)
    if (backendEnabled) useFileExplorerStore.getState().reset()
  }, [closeContextMenu, targetKey, vehicleReady])

  // A destructive commitment also belongs to the current controller-lease
  // epoch. Downloads remain available to read-only clients, but deletion must
  // be reconfirmed whenever control is lost or reacquired.
  useEffect(() => {
    setDeleteDialogOpen(false)
    closeContextMenu(false)
    useFileExplorerStore.getState().clearSelection()
  }, [canControl, closeContextMenu, safetyAuthorityId, safetyEpoch])

  const requestListing = useCallback((path: string) => {
    if (!backendEnabled) return
    useFileExplorerStore.getState().setLoading(true)
    sendClientMessage({ type: 'fs_list', data: { path } })
  }, [])

  // (Re-)list whenever the target directory or the link readiness changes.
  // Only the PX4/ULog profile browses the filesystem over MAVLink FTP; the
  // DataFlash panel issues its own log_list requests.
  useEffect(() => {
    if (
      backendEnabled
      && vehicleReady
      && targetSystemId !== null
      && targetComponentId !== null
      && logs.format === 'ulog'
    ) requestListing(currentPath)
  }, [vehicleReady, targetSystemId, targetComponentId, targetKey, logs.format, currentPath, requestListing])

  // Deletion finished: refresh the listing and dismiss the task shortly after.
  useEffect(() => {
    if (deletion?.status !== 'done') return
    requestListing(useFileExplorerStore.getState().currentPath)
    const timer = setTimeout(() => useFileExplorerStore.getState().clearDeletion(), 1500)
    return () => clearTimeout(timer)
  }, [deletion?.status, requestListing])

  // Download finished: hand the file to the browser or to the analysis page.
  useEffect(() => {
    if (download?.status !== 'done' || !download.downloadId) return
    if (handledDownloadRef.current === download.downloadId) return
    handledDownloadRef.current = download.downloadId
    const url = `/api/logs/downloads/${download.downloadId}`
    if (download.intent === 'save') {
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = download.fileName ?? 'log.ulg'
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      const timer = setTimeout(() => useFileExplorerStore.getState().clearDownload(), 2500)
      return () => clearTimeout(timer)
    }
    let cancelled = false
    void (async () => {
      try {
        const response = await fetch(url)
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const buffer = await response.arrayBuffer()
        if (cancelled) return
        stashLogBuffer(download.fileName ?? 'log.ulg', buffer, download.path)
        useFileExplorerStore.getState().clearDownload()
        navigate('/log-analysis')
      } catch (error) {
        console.error('[Logs] failed to fetch downloaded file:', error)
        if (!cancelled) {
          useFileExplorerStore.getState().failDownload(t('flightLogs.readFileFailed'))
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
  }, [contextMenu, closeContextMenu])

  const sortedEntries = useMemo(() => {
    const factor = sortAsc ? 1 : -1
    const compare = (a: FsEntry, b: FsEntry): number => {
      // Directories always group before files, like the Windows explorer.
      if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1
      switch (sortKey) {
        case 'size':
          return ((a.sizeBytes ?? -1) - (b.sizeBytes ?? -1)) * factor
        case 'date':
          return ((entryTimestamp(a, currentPath) ?? 0) - (entryTimestamp(b, currentPath) ?? 0)) * factor
        case 'type':
          return entryTypeLabel(a).localeCompare(entryTypeLabel(b)) * factor
            || a.name.localeCompare(b.name, undefined, { numeric: true })
        default:
          return a.name.localeCompare(b.name, undefined, { numeric: true }) * factor
      }
    }
    return [...entries].sort(compare)
  }, [entries, sortKey, sortAsc, currentPath])

  const selectedEntries = useMemo(
    () => sortedEntries.filter((entry) => selection.has(entry.name)),
    [sortedEntries, selection],
  )
  const rovingEntryName = sortedEntries.some((entry) => entry.name === focusedEntryName)
    ? focusedEntryName
    : (sortedEntries[0]?.name ?? null)
  const deleteConfirmationKey = fileDeleteConfirmationKey(
    `${targetKey}@safety:${safetyAuthorityId ?? '-'}:${safetyEpoch}`,
    currentPath,
    sortedEntries,
    selection,
  )
  const busy = !targetStateCurrent
    || download?.status === 'active'
    || deletion?.status === 'active'
  const singleFile = selectedEntries.length === 1 && selectedEntries[0].kind === 'file'
    ? selectedEntries[0]
    : null
  const singleUlg = singleFile && isUlgFile(singleFile) ? singleFile : null

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortAsc((asc) => !asc)
    else {
      setSortKey(key)
      setSortAsc(true)
    }
  }

  const handleRowClick = (event: React.MouseEvent, entry: FsEntry) => {
    event.stopPropagation()
    setFocusedEntryName(entry.name)
    const store = useFileExplorerStore.getState()
    if (event.ctrlKey || event.metaKey) {
      const next = new Set(selection)
      if (next.has(entry.name)) next.delete(entry.name)
      else next.add(entry.name)
      store.setSelection(next, entry.name)
      return
    }
    if (event.shiftKey && lastSelected) {
      const names = sortedEntries.map((item) => item.name)
      const from = names.indexOf(lastSelected)
      const to = names.indexOf(entry.name)
      if (from >= 0 && to >= 0) {
        const [start, end] = from <= to ? [from, to] : [to, from]
        store.setSelection(new Set(names.slice(start, end + 1)))
        return
      }
    }
    store.setSelection(new Set([entry.name]), entry.name)
  }

  const startDownload = useCallback((entry: FsEntry, intent: 'save' | 'analyze') => {
    if (busy || entry.kind !== 'file') return
    const path = joinPath(useFileExplorerStore.getState().currentPath, entry.name)
    handledDownloadRef.current = null
    useFileExplorerStore.getState().beginDownload(path, intent)
    sendClientMessage({ type: 'fs_download', data: { path } })
  }, [busy])

  const handleRowDoubleClick = (entry: FsEntry) => {
    if (entry.kind === 'dir') {
      useFileExplorerStore.getState().navigateTo(joinPath(currentPath, entry.name))
      return
    }
    startDownload(entry, isUlgFile(entry) ? 'analyze' : 'save')
  }

  const openContextMenu = (
    entry: FsEntry,
    x: number,
    y: number,
    trigger: HTMLDivElement,
  ) => {
    if (!selection.has(entry.name)) {
      useFileExplorerStore.getState().setSelection(new Set([entry.name]), entry.name)
    }
    contextTriggerRef.current = trigger
    setContextMenu({ x, y, entry, targetKey })
  }

  const handleContextMenu = (event: React.MouseEvent, entry: FsEntry) => {
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

  const handleRowKeyDown = (event: React.KeyboardEvent<HTMLDivElement>, entry: FsEntry) => {
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      const rows = Array.from(
        event.currentTarget.parentElement?.querySelectorAll<HTMLDivElement>('[data-explorer-row]') ?? [],
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
      const store = useFileExplorerStore.getState()
      if (event.shiftKey && lastSelected) {
        const names = sortedEntries.map((item) => item.name)
        const from = names.indexOf(lastSelected)
        const to = names.indexOf(entry.name)
        if (from >= 0 && to >= 0) {
          const [start, end] = from <= to ? [from, to] : [to, from]
          store.setSelection(new Set(names.slice(start, end + 1)))
          return
        }
      }
      if (event.ctrlKey || event.metaKey) {
        const next = new Set(selection)
        if (next.has(entry.name)) next.delete(entry.name)
        else next.add(entry.name)
        store.setSelection(next, entry.name)
        return
      }
      store.setSelection(new Set([entry.name]), entry.name)
      return
    }

    if (event.key === 'Enter') {
      event.preventDefault()
      event.stopPropagation()
      useFileExplorerStore.getState().setSelection(new Set([entry.name]), entry.name)
      handleRowDoubleClick(entry)
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

  const confirmDelete = () => {
    const connection = useConnectionStore.getState()
    const liveTargetKey = `${connection.targetSystemId ?? '-'}:${connection.targetComponentId ?? '-'}`
    const store = useFileExplorerStore.getState()
    const liveConfirmationKey = fileDeleteConfirmationKey(
      `${liveTargetKey}@safety:${connection.safetyAuthorityId ?? '-'}:${connection.safetyEpoch}`,
      store.currentPath,
      store.entries,
      store.selection,
    )
    if (
      !targetStateCurrent
      || !connection.vehicleReady
      || !connection.canControl
      || connection.safetyAuthorityId === null
      || connection.targetSystemId === null
      || connection.targetComponentId === null
      || logSupport(useTelemetryStore.getState().vehicleIdentity).format !== 'ulog'
      || liveConfirmationKey !== deleteConfirmationKey
    ) {
      setDeleteDialogOpen(false)
      return
    }
    const targets = store.entries
      .filter((entry) => store.selection.has(entry.name))
      .map((entry) => ({
        path: joinPath(store.currentPath, entry.name),
        kind: entry.kind,
      }))
    if (targets.length === 0) return
    setDeleteDialogOpen(false)
    store.beginDeletion()
    sendClientMessage({
      type: 'fs_delete',
      data: { entries: targets },
      safetyConfirmation: 'delete_files',
      expectedSafetyEpoch: connection.safetyEpoch,
      expectedSafetyAuthorityId: connection.safetyAuthorityId,
    })
  }

  const breadcrumbSegments = useMemo(() => {
    const segments = currentPath.split('/').filter(Boolean)
    return segments.map((segment, index) => ({
      label: segment,
      path: '/' + segments.slice(0, index + 1).join('/'),
    }))
  }, [currentPath])

  const selectionSize = selectedEntries.reduce(
    (sum, entry) => sum + (entry.sizeBytes ?? 0),
    0,
  )
  const parentPath = parentOf(currentPath)

  return (
    <div className={`${embedded ? 'mc-embedded-page' : 'mc-workspace'} mc-fade-in`}>
      {!embedded && <PageHeader
        title={t('flightLogs.title')}
        description={logs.format === 'dataflash'
          ? t('flightLogs.descDataflash')
          : t('flightLogs.descUlog')}
        actions={
          <button
            type="button"
            className="mc-btn mc-btn-ghost"
            onClick={() => navigate('/log-analysis')}
          >
            <Icon name="waveform" size={15} /> {t('flightLogs.logAnalysis')}
          </button>
        }
      />}

      {!backendEnabled ? (
        <EmptyState
          title={t('flightLogs.demoMode')}
          description={t('flightLogs.demoModeDesc')}
          icon="folder"
        />
      ) : !vehicleReady ? (
        <EmptyState
          title={t('flightLogs.connectFirst')}
          description={t('flightLogs.connectFirstDesc')}
          icon="folder"
        />
      ) : !logs.browse ? (
        <EmptyState
          title={t('flightLogs.notSupported')}
          description={t('flightLogs.notSupportedDesc')}
          icon="folder"
        />
      ) : logs.format === 'dataflash' ? (
        // ArduPilot: flat DataFlash log list over LOG_REQUEST_* (no filesystem).
        <DataflashLogPanel vehicleReady={vehicleReady} />
      ) : (
        <section
          className="mc-card mc-explorer"
          onClick={() => useFileExplorerStore.getState().clearSelection()}
        >
          {/* Navigation toolbar */}
          <div className="mc-explorer__toolbar" onClick={(event) => event.stopPropagation()}>
            <div className="flex items-center gap-1">
              <button
                type="button"
                className="mc-icon-btn mc-icon-btn--bordered"
                aria-label={t('flightLogs.back')}
                disabled={backStack.length === 0}
                onClick={() => useFileExplorerStore.getState().goBack()}
              >
                <Icon name="arrowLeft" size={15} />
              </button>
              <button
                type="button"
                className="mc-icon-btn mc-icon-btn--bordered"
                aria-label={t('flightLogs.forward')}
                disabled={forwardStack.length === 0}
                onClick={() => useFileExplorerStore.getState().goForward()}
              >
                <Icon name="arrowRight" size={15} />
              </button>
              <button
                type="button"
                className="mc-icon-btn mc-icon-btn--bordered"
                aria-label={t('flightLogs.up')}
                disabled={parentPath === null}
                onClick={() => parentPath && useFileExplorerStore.getState().navigateTo(parentPath)}
              >
                <Icon name="arrowUp" size={15} />
              </button>
            </div>
            <nav className="mc-explorer__breadcrumb" aria-label={t('flightLogs.path')}>
              <button
                type="button"
                onClick={() => useFileExplorerStore.getState().navigateTo('/')}
              >
                /
              </button>
              {breadcrumbSegments.map((segment) => (
                <span key={segment.path} className="mc-explorer__crumb">
                  <button
                    type="button"
                    onClick={() => useFileExplorerStore.getState().navigateTo(segment.path)}
                  >
                    {segment.label}
                  </button>
                </span>
              ))}
            </nav>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                className="mc-btn mc-btn-ghost"
                onClick={() => useFileExplorerStore.getState().navigateTo(PX4_ULOG_LOG_DIRECTORY)}
              >
                <Icon name="log" size={14} /> {t('flightLogs.logDir')}
              </button>
              <button
                type="button"
                className="mc-icon-btn mc-icon-btn--bordered"
                aria-label={t('flightLogs.refresh')}
                onClick={() => requestListing(currentPath)}
              >
                <Icon name="refresh" size={15} />
              </button>
            </div>
          </div>

          {/* Action toolbar */}
          <div className="mc-explorer__actions" onClick={(event) => event.stopPropagation()}>
            <button
              type="button"
              className="mc-btn mc-btn-primary"
              disabled={!singleFile || busy}
              onClick={() => singleFile && startDownload(singleFile, 'save')}
            >
              <Icon name="download" size={14} /> {t('flightLogs.download')}
            </button>
            <button
              type="button"
              className="mc-btn"
              disabled={!singleUlg || busy}
              onClick={() => singleUlg && startDownload(singleUlg, 'analyze')}
            >
              <Icon name="waveform" size={14} /> {t('flightLogs.downloadAnalyze')}
            </button>
            <button
              type="button"
              className="mc-btn mc-btn-danger"
              disabled={selectedEntries.length === 0 || busy || !canControl}
              onClick={() => setDeleteDialogOpen(true)}
            >
              <Icon name="trash" size={14} /> {t('flightLogs.delete')}
            </button>
            {listError && (
              <span className="mc-explorer__error" role="alert">
                <Icon name="warning" size={14} /> {listError}
              </span>
            )}
          </div>

          {/* Detail table */}
          <div
            className="mc-explorer__table"
            role="grid"
            aria-colcount={4}
            aria-rowcount={sortedEntries.length + 1}
          >
            <div className="mc-explorer__row mc-explorer__row--header" role="row">
              {([
                ['name', t('flightLogs.colName')],
                ['date', t('flightLogs.colDate')],
                ['type', t('flightLogs.colType')],
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
              {loading && listedPath !== currentPath ? (
                <div className="mc-explorer__notice" role="row">
                  <span role="gridcell" aria-colspan={4}>{t('flightLogs.readingDir')}</span>
                </div>
              ) : sortedEntries.length === 0 ? (
                <div className="mc-explorer__notice" role="row">
                  <span role="gridcell" aria-colspan={4}>
                    {listError ? t('flightLogs.readFailed') : t('flightLogs.emptyDir')}
                  </span>
                </div>
              ) : (
                sortedEntries.map((entry) => (
                  <div
                    key={entry.name}
                    role="row"
                    data-explorer-row
                    tabIndex={entry.name === rovingEntryName ? 0 : -1}
                    aria-selected={selection.has(entry.name)}
                    className={
                      'mc-explorer__row'
                      + (selection.has(entry.name) ? ' is-selected' : '')
                    }
                    onClick={(event) => handleRowClick(event, entry)}
                    onFocus={() => setFocusedEntryName(entry.name)}
                    onDoubleClick={() => handleRowDoubleClick(entry)}
                    onKeyDown={(event) => handleRowKeyDown(event, entry)}
                    onContextMenu={(event) => handleContextMenu(event, entry)}
                  >
                    <span className="mc-explorer__name" role="gridcell">
                      <Icon
                        name={entry.kind === 'dir' ? 'folder' : isUlgFile(entry) ? 'log' : 'file'}
                        size={16}
                        style={{
                          color: entry.kind === 'dir'
                            ? 'var(--warning)'
                            : isUlgFile(entry) ? 'var(--accent)' : 'var(--text-secondary)',
                        }}
                      />
                      <span className="mc-mono">{entry.name}</span>
                    </span>
                    <span className="mc-mono" role="gridcell">{formatEntryDate(entryTimestamp(entry, currentPath))}</span>
                    <span role="gridcell">{entryTypeLabel(entry)}</span>
                    <span className="mc-mono" role="gridcell">{entry.kind === 'dir' ? '—' : formatBytes(entry.sizeBytes)}</span>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Status bar */}
          <div className="mc-explorer__statusbar" onClick={(event) => event.stopPropagation()}>
            <span>
              {t('flightLogs.totalItems', { count: entries.length })}
              {selectedEntries.length > 0 && (
                <>
                  {' · '}{t('flightLogs.selectedItems', { count: selectedEntries.length })}
                  {selectionSize > 0 && <>({formatBytes(selectionSize)})</>}
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
                          {' · '}{t('flightLogs.remaining', { seconds: Math.ceil((download.totalBytes - download.receivedBytes) / download.rateBps) })}
                        </>
                      )}
                    </span>
                    <button
                      type="button"
                      className="mc-icon-btn"
                      aria-label={t('flightLogs.cancelDownload')}
                      onClick={() => sendClientMessage({ type: 'fs_download_cancel' })}
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
                      onClick={() => useFileExplorerStore.getState().clearDownload()}
                    >
                      <Icon name="close" size={13} />
                    </button>
                  </span>
                )}
              </span>
            )}
            {deletion && (
              <span className="mc-explorer__transfer">
                {deletion.status === 'active' && (
                  <span>
                    {t('flightLogs.deleting', { done: deletion.done, total: deletion.total || '…' })}
                    {deletion.current && <span className="mc-mono"> {deletion.current}</span>}
                  </span>
                )}
                {deletion.status === 'done' && (
                  <span style={{ color: 'var(--success)' }}>{t('flightLogs.deleteDone')}</span>
                )}
                {deletion.status === 'error' && (
                  <span style={{ color: 'var(--danger)' }}>
                    {t('flightLogs.deleteFailed', { error: deletion.error })}
                    <button
                      type="button"
                      className="mc-icon-btn"
                      aria-label={t('common.close')}
                      onClick={() => useFileExplorerStore.getState().clearDeletion()}
                    >
                      <Icon name="close" size={13} />
                    </button>
                  </span>
                )}
              </span>
            )}
          </div>
        </section>
      )}

      {/* Context menu */}
      {contextMenu && contextMenu.targetKey === targetKey && (
        <div
          ref={contextMenuRef}
          className="mc-context-menu"
          role="menu"
          aria-label={t('flightLogs.contextMenuLabel', { name: contextMenu.entry.name })}
          tabIndex={-1}
          style={{
            left: Math.max(8, Math.min(contextMenu.x, window.innerWidth - 200)),
            top: Math.max(8, Math.min(contextMenu.y, window.innerHeight - 180)),
          }}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={handleMenuKeyDown}
        >
          {contextMenu.entry.kind === 'dir' && (
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              onClick={() => {
                closeContextMenu(true)
                useFileExplorerStore.getState().navigateTo(joinPath(currentPath, contextMenu.entry.name))
              }}
            >
              <Icon name="folder" size={14} /> {t('flightLogs.open')}
            </button>
          )}
          {contextMenu.entry.kind === 'file' && (
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
          )}
          {isUlgFile(contextMenu.entry) && (
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
          )}
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            className="is-danger"
            disabled={busy || !canControl}
            onClick={() => {
              contextTriggerRef.current?.focus()
              closeContextMenu(false)
              setDeleteDialogOpen(true)
            }}
          >
            <Icon name="trash" size={14} /> {t('flightLogs.delete')}
          </button>
        </div>
      )}

      <ConfirmDialog
        open={deleteDialogOpen}
        confirmationKey={deleteConfirmationKey}
        title={t('flightLogs.deleteTitle')}
        consequence={t('flightLogs.deleteConfirm', { count: selectedEntries.length })}
        commitmentLabel={t('flightLogs.deleteAcknowledge')}
        confirmLabel={t('flightLogs.permanentDelete')}
        cancelLabel={t('flightLogs.cancel')}
        closeLabel={t('common.close')}
        confirmIcon={<Icon name="trash" size={14} />}
        busy={deletion?.status === 'active'}
        busyLabel={t('flightLogs.deleting', {
          done: deletion?.done ?? 0,
          total: deletion?.total || selectedEntries.length,
        })}
        details={(
          <ul className="mc-modal__list mc-mono">
            {selectedEntries.slice(0, 8).map((entry) => (
              <li key={entry.name}>
                {entry.kind === 'dir' ? '📁 ' : ''}{joinPath(currentPath, entry.name)}
              </li>
            ))}
            {selectedEntries.length > 8 && (
              <li>{t('flightLogs.andMore', { count: selectedEntries.length - 8 })}</li>
            )}
          </ul>
        )}
        onCancel={() => setDeleteDialogOpen(false)}
        onConfirm={confirmDelete}
      />
    </div>
  )
}
