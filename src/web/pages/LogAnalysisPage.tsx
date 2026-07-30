// Flight-Review-grade log analysis page for PX4 ULog (.ulg) and ArduPilot
// DataFlash (.bin). Data enters through three doors: a local file (drag &
// drop / picker), the hand-off stash from the flight-log explorer, or a
// direct FC import (FTP / LOG_REQUEST download -> analyze). Parsing happens
// entirely inside a format-selected Web Worker; this page only renders the
// pre-digested dataset.
import {
  Fragment,
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import Icon from '../components/ui/Icon'
import { PageHeader } from '../components/ui/PageFrame'
import UPlotChart, { seriesColor } from '../components/logs/UPlotChart'
import { sendClientMessage } from '../hooks/useWebSocket'
import { useConnectionStore } from '../stores/connectionStore'
import { useFileExplorerStore } from '../stores/fileExplorerStore'
import { useLogTransferStore } from '../stores/logTransferStore'
import { useTelemetryStore } from '../stores/telemetryStore'
import { dataflashLogName } from '../components/logs/DataflashLogPanel'
import { logSupport } from '../utils/logProfiles'
import { isDataflashFileName } from '../utils/dataflashAnalysis'
import { takeStashedLog } from '../utils/logAnalysisSession'
import { formatBytes } from '../utils/formatBytes'
import { backendEnabled } from '../runtime'
import type {
  SeriesData,
  UlogAnalysisDataset,
  UlogWorkerResult,
} from '../utils/ulogAnalysis'
import { parsePx4LogPathDate } from '../utils/ulogAnalysis'
import type { DataflashLogEntry, FsEntry } from '../../shared/types'

// Leaflet is only pulled in when the log actually contains a GPS track.
const TrackMap = lazy(() => import('../components/logs/TrackMap'))
const LogAttitudeVisualizer = lazy(() => import('../components/logs/LogAttitudeVisualizer'))

interface SeriesSelectionGroup {
  id: string
  label: string
  labels: string[]
}

const ATTITUDE_GROUPS: SeriesSelectionGroup[] = [
  { id: 'roll', label: 'Roll', labels: ['横滚', '横滚设定'] },
  { id: 'pitch', label: 'Pitch', labels: ['俯仰', '俯仰设定'] },
  { id: 'yaw', label: 'Yaw', labels: ['偏航', '偏航设定'] },
]
const RATE_GROUPS: SeriesSelectionGroup[] = [
  { id: 'roll', label: 'Roll', labels: ['横滚速率', '横滚速率设定'] },
  { id: 'pitch', label: 'Pitch', labels: ['俯仰速率', '俯仰速率设定'] },
  { id: 'yaw', label: 'Yaw', labels: ['偏航速率', '偏航速率设定'] },
]
const BATTERY_SECONDARY_SCALE = ['功率 (W)']
const ALTITUDE_SECONDARY_SCALE = ['气压高度 (m)', 'GPS 海拔 (m)']

const LOG_LEVEL_LABELS: Record<number, { label: string; color: string }> = {
  0: { label: 'EMERG', color: 'var(--danger)' },
  1: { label: 'ALERT', color: 'var(--danger)' },
  2: { label: 'CRIT', color: 'var(--danger)' },
  3: { label: 'ERROR', color: 'var(--danger)' },
  4: { label: 'WARN', color: 'var(--warning)' },
  5: { label: 'NOTICE', color: 'var(--info)' },
  6: { label: 'INFO', color: 'var(--text-secondary)' },
  7: { label: 'DEBUG', color: 'var(--text-disabled)' },
}

type LogFormat = 'ulog' | 'dataflash'

function analyzeInWorker(
  buffer: ArrayBuffer,
  signal: AbortSignal,
  format: LogFormat,
): Promise<UlogAnalysisDataset> {
  return new Promise((resolve, reject) => {
    // Vite requires literal new URL() arguments to bundle each worker.
    const worker = format === 'dataflash'
      ? new Worker(new URL('../workers/dataflashWorker.ts', import.meta.url), { type: 'module' })
      : new Worker(new URL('../workers/ulogWorker.ts', import.meta.url), { type: 'module' })
    let settled = false
    const cleanup = () => {
      signal.removeEventListener('abort', abort)
      worker.terminate()
    }
    const abort = () => {
      if (settled) return
      settled = true
      cleanup()
      const error = new Error('日志解析已取消')
      error.name = 'AbortError'
      reject(error)
    }
    worker.onmessage = (event: MessageEvent<UlogWorkerResult>) => {
      if (settled) return
      settled = true
      cleanup()
      if (event.data.dataset) resolve(event.data.dataset)
      else reject(new Error(event.data.error ?? '日志解析失败'))
    }
    worker.onerror = (event) => {
      if (settled) return
      settled = true
      cleanup()
      reject(new Error(event.message || '日志解析线程异常'))
    }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) {
      abort()
      return
    }
    worker.postMessage(buffer, [buffer])
  })
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—'
  const minutes = Math.floor(seconds / 60)
  const rest = Math.round(seconds - minutes * 60)
  return minutes > 0 ? `${minutes} 分 ${rest} 秒` : `${rest} 秒`
}

function CopyableOverviewValue({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false)
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => {
    if (resetTimerRef.current !== null) clearTimeout(resetTimerRef.current)
  }, [])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      if (resetTimerRef.current !== null) clearTimeout(resetTimerRef.current)
      resetTimerRef.current = setTimeout(() => setCopied(false), 1600)
    } catch (error) {
      console.error(`[Analysis] failed to copy ${label}:`, error)
    }
  }

  return (
    <div className="mc-analysis-overview__value-row">
      <strong className="mc-analysis-overview__value" title={value}>{value}</strong>
      <button
        type="button"
        className="mc-icon-btn mc-analysis-copy-btn"
        aria-label={copied ? `${label}已复制` : `复制${label}`}
        title={copied ? '已复制' : `复制${label}`}
        onClick={() => void copy()}
      >
        <Icon name={copied ? 'check' : 'copy'} size={13} />
      </button>
    </div>
  )
}

function ChartPanel({
  title,
  series,
  unit,
  bands,
  height,
  wide = false,
  secondaryScaleLabels,
  selectionGroups,
  selectionMode = 'multi',
  headerAside,
  children,
  onCursorTimeChange,
}: {
  title: string
  series?: SeriesData[]
  unit?: string
  bands?: UlogAnalysisDataset['armedSegments']
  height?: number
  wide?: boolean
  secondaryScaleLabels?: string[]
  selectionGroups?: SeriesSelectionGroup[]
  /** 'single': the groups behave as an exclusive loop switch. */
  selectionMode?: 'multi' | 'single'
  headerAside?: React.ReactNode
  onCursorTimeChange?: (timeSec: number) => void
  children?: React.ReactNode
}) {
  const [expanded, setExpanded] = useState(false)
  const [stretched, setStretched] = useState(false)
  const [selectedGroups, setSelectedGroups] = useState<Set<string>>(
    () => selectionMode === 'single'
      ? new Set(selectionGroups?.slice(0, 1).map((group) => group.id) ?? [])
      : new Set(selectionGroups?.map((group) => group.id) ?? []),
  )
  useEffect(() => {
    setSelectedGroups((current) => {
      const availableIds = new Set(selectionGroups?.map((group) => group.id) ?? [])
      if (selectionMode === 'single') {
        const selectedId = [...current].find((id) => availableIds.has(id))
          ?? selectionGroups?.[0]?.id
        if (selectedId && current.size === 1 && current.has(selectedId)) return current
        return selectedId ? new Set([selectedId]) : new Set()
      }
      const next = new Set([...current].filter((id) => availableIds.has(id)))
      if (next.size === current.size) return current
      return next
    })
  }, [selectionGroups, selectionMode])
  const visibleSeries = useMemo(() => {
    const indexed = series?.map((entry, index) => ({
      ...entry,
      colorIndex: entry.colorIndex ?? index,
    })) ?? []
    if (!selectionGroups) return indexed
    const selectedLabels = new Set(
      selectionGroups
        .filter((group) => selectedGroups.has(group.id))
        .flatMap((group) => group.labels),
    )
    return indexed.filter((entry) => selectedLabels.has(entry.label))
  }, [series, selectionGroups, selectedGroups])
  const hasChart = visibleSeries.length > 0
  const expandedHeight = typeof window === 'undefined'
    ? 520
    : Math.max(360, Math.min(640, window.innerHeight - 250))

  useEffect(() => {
    if (!expanded) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setExpanded(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = previousOverflow
    }
  }, [expanded])

  const legend = hasChart && (
    <div className="mc-analysis-legend">
      {visibleSeries.map((entry, index) => (
        <span key={entry.label}>
          <i style={{ background: seriesColor(entry.colorIndex ?? index) }} />
          {entry.label}
        </span>
      ))}
    </div>
  )

  // Shared by the panel header and the fullscreen dialog, so the loop/series
  // switch stays available after expanding.
  const seriesToggles = selectionGroups && (
    <div className="mc-analysis-series-toggles" aria-label={`${title}曲线选择`}>
      {selectionGroups.map((group) => (
        <button
          key={group.id}
          type="button"
          aria-pressed={selectedGroups.has(group.id)}
          onClick={() => setSelectedGroups((current) => {
            if (selectionMode === 'single') return new Set([group.id])
            const next = new Set(current)
            if (next.has(group.id)) next.delete(group.id)
            else next.add(group.id)
            return next
          })}
        >
          {group.label}
        </button>
      ))}
    </div>
  )

  return (
    <Fragment>
      <section className={`mc-card mc-analysis-panel${wide || stretched ? ' mc-analysis-panel--wide' : ''}`}>
        <header className="mc-analysis-panel__header">
          <div className="mc-analysis-panel__title">
            <h3 className="mc-section-title">{title}</h3>
            {headerAside}
          </div>
          <div className="mc-analysis-panel__actions">
            {seriesToggles}
            {series && (
              <button
                type="button"
                className="mc-icon-btn mc-icon-btn--bordered"
                aria-label={stretched ? `恢复${title}宽度` : `拓宽${title}`}
                title={stretched ? '恢复宽度' : '横向铺满'}
                aria-pressed={stretched}
                onClick={() => setStretched((current) => !current)}
              >
                <Icon name="stretch" size={14} />
              </button>
            )}
            {hasChart && (
              <button
                type="button"
                className="mc-icon-btn mc-icon-btn--bordered mc-analysis-expand-btn"
                aria-label={`放大查看${title}`}
                title="全屏放大"
                onClick={() => setExpanded(true)}
              >
                <Icon name="maximize" size={14} />
              </button>
            )}
          </div>
        </header>
        {legend}
        {series && (
          <UPlotChart
            series={visibleSeries}
            unit={unit}
            bands={bands}
            height={height}
            secondaryScaleLabels={secondaryScaleLabels}
            onCursorTimeChange={onCursorTimeChange}
          />
        )}
        {children}
      </section>
      {expanded && visibleSeries.length > 0 && createPortal(
        <div
          className="mc-analysis-chart-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label={`${title}放大图表`}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setExpanded(false)
          }}
        >
          <section className="mc-card mc-analysis-chart-dialog">
            <header className="mc-analysis-chart-dialog__header">
              <div>
                <span className="mc-analysis-chart-dialog__eyebrow">曲线详细视图</span>
                <h2>{title}</h2>
              </div>
              <div className="mc-analysis-panel__actions">
                {seriesToggles}
                <button
                  type="button"
                  className="mc-icon-btn mc-icon-btn--bordered"
                  aria-label="关闭放大图表"
                  title="关闭（Esc）"
                  autoFocus
                  onClick={() => setExpanded(false)}
                >
                  <Icon name="close" size={15} />
                </button>
              </div>
            </header>
            {legend}
            <div className="mc-analysis-chart-dialog__plot">
              <UPlotChart
                series={visibleSeries}
                unit={unit}
                bands={bands}
                height={expandedHeight}
                secondaryScaleLabels={secondaryScaleLabels}
                onCursorTimeChange={onCursorTimeChange}
              />
            </div>
          </section>
        </div>,
        document.body,
      )}
    </Fragment>
  )
}

/** Lightweight FC file picker reusing the explorer store (only .ulg files). */
function FcImportDialog({
  onClose,
}: {
  onClose: () => void
}) {
  const currentPath = useFileExplorerStore((state) => state.currentPath)
  const entries = useFileExplorerStore((state) => state.entries)
  const loading = useFileExplorerStore((state) => state.loading)
  const listError = useFileExplorerStore((state) => state.listError)
  const download = useFileExplorerStore((state) => state.download)

  useEffect(() => {
    useFileExplorerStore.getState().setLoading(true)
    sendClientMessage({ type: 'fs_list', data: { path: currentPath } })
  }, [currentPath])

  const visible = useMemo(
    () => entries.filter((entry) =>
      entry.kind === 'dir' || entry.name.toLowerCase().endsWith('.ulg'),
    ),
    [entries],
  )

  const open = (entry: FsEntry) => {
    const store = useFileExplorerStore.getState()
    if (entry.kind === 'dir') {
      store.navigateTo(
        currentPath.endsWith('/') ? `${currentPath}${entry.name}` : `${currentPath}/${entry.name}`,
      )
      return
    }
    if (download?.status === 'active') return
    const path = currentPath.endsWith('/') ? `${currentPath}${entry.name}` : `${currentPath}/${entry.name}`
    store.beginDownload(path, 'analyze')
    sendClientMessage({ type: 'fs_download', data: { path } })
  }

  const goUp = () => {
    const trimmed = currentPath.endsWith('/') ? currentPath.slice(0, -1) : currentPath
    const index = trimmed.lastIndexOf('/')
    useFileExplorerStore.getState().navigateTo(index <= 0 ? '/' : trimmed.slice(0, index))
  }

  return (
    <div className="mc-modal-backdrop" role="dialog" aria-modal="true">
      <div className="mc-card mc-modal">
        <div className="flex items-center justify-between">
          <h3 className="mc-section-title">从飞控导入日志</h3>
          <button type="button" className="mc-icon-btn" aria-label="关闭" onClick={onClose}>
            <Icon name="close" size={15} />
          </button>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="mc-icon-btn mc-icon-btn--bordered"
            aria-label="上一级"
            disabled={currentPath === '/'}
            onClick={goUp}
          >
            <Icon name="arrowUp" size={14} />
          </button>
          <span className="mc-mono" style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
            {currentPath}
          </span>
        </div>
        {download?.status === 'active' ? (
          <div className="mc-explorer__transfer" style={{ padding: '12px 0' }}>
            <progress
              value={download.totalBytes > 0 ? download.receivedBytes : undefined}
              max={download.totalBytes > 0 ? download.totalBytes : undefined}
            />
            <span className="mc-mono" style={{ fontSize: 12 }}>
              {formatBytes(download.receivedBytes)} / {formatBytes(download.totalBytes)}
            </span>
            <button
              type="button"
              className="mc-btn mc-btn-ghost"
              onClick={() => sendClientMessage({ type: 'fs_download_cancel' })}
            >
              取消
            </button>
          </div>
        ) : (
          <ul className="mc-modal__list" style={{ maxHeight: 300 }}>
            {loading && <li style={{ color: 'var(--text-disabled)' }}>正在读取目录…</li>}
            {!loading && listError && (
              <li style={{ color: 'var(--danger)' }}>{listError}</li>
            )}
            {!loading && !listError && visible.length === 0 && (
              <li style={{ color: 'var(--text-disabled)' }}>此目录没有 .ulg 日志</li>
            )}
            {!loading && visible.map((entry) => (
              <li key={entry.name}>
                <button
                  type="button"
                  className="flex items-center gap-2"
                  style={{
                    background: 'none',
                    border: 'none',
                    color: 'var(--text-primary)',
                    cursor: 'pointer',
                    font: 'inherit',
                    padding: '2px 0',
                  }}
                  onClick={() => open(entry)}
                >
                  <Icon
                    name={entry.kind === 'dir' ? 'folder' : 'log'}
                    size={14}
                    style={{ color: entry.kind === 'dir' ? 'var(--warning)' : 'var(--accent)' }}
                  />
                  {entry.name}
                  {entry.kind === 'file' && (
                    <span style={{ color: 'var(--text-disabled)' }}>
                      {formatBytes(entry.sizeBytes)}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
        {download?.status === 'error' && (
          <p style={{ color: 'var(--danger)', fontSize: 12, margin: 0 }}>
            下载失败：{download.error}
          </p>
        )}
      </div>
    </div>
  )
}

/** Lightweight DataFlash log picker for ArduPilot (LOG_REQUEST_* protocol). */
function FcDataflashImportDialog({
  onClose,
}: {
  onClose: () => void
}) {
  const entries = useLogTransferStore((state) => state.entries)
  const loading = useLogTransferStore((state) => state.loading)
  const listError = useLogTransferStore((state) => state.listError)
  const download = useLogTransferStore((state) => state.download)

  useEffect(() => {
    useLogTransferStore.getState().setLoading(true)
    sendClientMessage({ type: 'log_list' })
  }, [])

  const newestFirst = useMemo(
    () => [...entries].sort((a, b) => b.id - a.id),
    [entries],
  )

  const open = (entry: DataflashLogEntry) => {
    if (download?.status === 'active') return
    useLogTransferStore.getState().beginDownload(entry.id, 'analyze')
    sendClientMessage({ type: 'log_download', data: { logId: entry.id } })
  }

  return (
    <div className="mc-modal-backdrop" role="dialog" aria-modal="true">
      <div className="mc-card mc-modal">
        <div className="flex items-center justify-between">
          <h3 className="mc-section-title">从飞控导入日志</h3>
          <button type="button" className="mc-icon-btn" aria-label="关闭" onClick={onClose}>
            <Icon name="close" size={15} />
          </button>
        </div>
        {download?.status === 'active' ? (
          <div className="mc-explorer__transfer" style={{ padding: '12px 0' }}>
            <progress
              value={download.totalBytes > 0 ? download.receivedBytes : undefined}
              max={download.totalBytes > 0 ? download.totalBytes : undefined}
            />
            <span className="mc-mono" style={{ fontSize: 12 }}>
              {formatBytes(download.receivedBytes)} / {formatBytes(download.totalBytes)}
            </span>
            <button
              type="button"
              className="mc-btn mc-btn-ghost"
              onClick={() => sendClientMessage({ type: 'log_download_cancel' })}
            >
              取消
            </button>
          </div>
        ) : (
          <ul className="mc-modal__list" style={{ maxHeight: 300 }}>
            {loading && <li style={{ color: 'var(--text-disabled)' }}>正在获取日志列表…</li>}
            {!loading && listError && (
              <li style={{ color: 'var(--danger)' }}>{listError}</li>
            )}
            {!loading && !listError && newestFirst.length === 0 && (
              <li style={{ color: 'var(--text-disabled)' }}>飞控上没有日志</li>
            )}
            {!loading && newestFirst.map((entry) => (
              <li key={entry.id}>
                <button
                  type="button"
                  className="flex items-center gap-2"
                  style={{
                    background: 'none',
                    border: 'none',
                    color: 'var(--text-primary)',
                    cursor: 'pointer',
                    font: 'inherit',
                    padding: '2px 0',
                  }}
                  onClick={() => open(entry)}
                >
                  <Icon name="log" size={14} style={{ color: 'var(--accent)' }} />
                  {dataflashLogName(entry)}
                  <span style={{ color: 'var(--text-disabled)' }}>
                    {formatBytes(entry.sizeBytes)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {download?.status === 'error' && (
          <p style={{ color: 'var(--danger)', fontSize: 12, margin: 0 }}>
            下载失败：{download.error}
          </p>
        )}
      </div>
    </div>
  )
}

export default function LogAnalysisPage({ embedded = false }: { embedded?: boolean }) {
  const vehicleReady = useConnectionStore((state) => state.vehicleReady)
  const vehicleIdentity = useTelemetryStore((state) => state.vehicleIdentity)
  const logs = logSupport(vehicleIdentity)
  const download = useFileExplorerStore((state) => state.download)
  const logDownload = useLogTransferStore((state) => state.download)
  const [dataset, setDataset] = useState<UlogAnalysisDataset | null>(null)
  const [fileName, setFileName] = useState<string | null>(null)
  const [parsing, setParsing] = useState(false)
  const [parseError, setParseError] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [paramFilter, setParamFilter] = useState('')
  const [eventsOpen, setEventsOpen] = useState(false)
  const [chartCursorTimeSec, setChartCursorTimeSec] = useState<number | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const handledDownloadRef = useRef<string | null>(null)
  const analysisAbortRef = useRef<AbortController | null>(null)
  const unmountAbortTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const replayStartSec = useMemo(() => {
    if (!dataset) return 0
    const takeoffSegment = dataset.modeSegments.find(
      (segment) => segment.label === 'Takeoff' || segment.label === 'VTOL Takeoff',
    )
    return takeoffSegment?.startSec ?? dataset.armedSegments[0]?.startSec ?? 0
  }, [dataset])

  const handleChartCursorTimeChange = useCallback((timeSec: number) => {
    setChartCursorTimeSec(timeSec)
  }, [])

  useEffect(() => {
    setChartCursorTimeSec(null)
    // Each new analysis starts with the event list collapsed.
    setEventsOpen(false)
  }, [dataset])

  const analyzeBuffer = useCallback((
    name: string,
    buffer: ArrayBuffer,
    options?: { sourcePath?: string; fileModifiedMs?: number },
  ) => {
    analysisAbortRef.current?.abort()
    const controller = new AbortController()
    analysisAbortRef.current = controller
    const format: LogFormat = isDataflashFileName(name) ? 'dataflash' : 'ulog'
    setParsing(true)
    setParseError(null)
    setFileName(name)
    analyzeInWorker(buffer, controller.signal, format)
      .then((result) => {
        if (controller.signal.aborted) return
        if (result.overview.startTimeUtcMs === null) {
          // DataFlash file names carry no PX4-style timestamp; fall straight
          // through to the file-modified estimate for .bin logs.
          const pathTime = format === 'ulog'
            ? parsePx4LogPathDate(options?.sourcePath ?? name)
            : null
          if (pathTime !== null) {
            result.overview.startTimeUtcMs = pathTime
            result.overview.startTimeSource = 'filename'
          } else if (options?.fileModifiedMs && options.fileModifiedMs > 0) {
            result.overview.startTimeUtcMs = Math.max(
              0,
              options.fileModifiedMs - result.overview.durationSec * 1000,
            )
            result.overview.startTimeSource = 'file-modified'
          }
        }
        setDataset(result)
      })
      .catch((error: Error) => {
        if (error.name === 'AbortError') return
        setDataset(null)
        setParseError(error.message)
      })
      .finally(() => {
        if (analysisAbortRef.current !== controller) return
        analysisAbortRef.current = null
        setParsing(false)
      })
  }, [])

  useEffect(() => {
    // React StrictMode replays effects in development by running cleanup and
    // setup again in the same tick. Deferring the abort lets the replayed
    // setup retain the in-flight worker, while a real route change still
    // cancels parsing on the next task.
    if (unmountAbortTimerRef.current !== null) {
      clearTimeout(unmountAbortTimerRef.current)
      unmountAbortTimerRef.current = null
    }
    return () => {
      unmountAbortTimerRef.current = setTimeout(() => {
        analysisAbortRef.current?.abort()
        analysisAbortRef.current = null
        unmountAbortTimerRef.current = null
      }, 0)
    }
  }, [])

  // Hand-off from the flight-log explorer ("download & analyze").
  useEffect(() => {
    const stashed = takeStashedLog()
    if (stashed) analyzeBuffer(stashed.name, stashed.buffer, { sourcePath: stashed.sourcePath })
  }, [analyzeBuffer])

  // FC import completed while this page is open: fetch and analyze in place.
  useEffect(() => {
    if (download?.status !== 'done' || !download.downloadId) return
    if (download.intent !== 'analyze') return
    if (handledDownloadRef.current === download.downloadId) return
    const downloadId = download.downloadId
    let cancelled = false
    void (async () => {
      try {
        const response = await fetch(`/api/logs/downloads/${downloadId}`)
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const buffer = await response.arrayBuffer()
        if (cancelled) return
        handledDownloadRef.current = downloadId
        useFileExplorerStore.getState().clearDownload()
        setImportOpen(false)
        analyzeBuffer(download.fileName ?? 'log.ulg', buffer, { sourcePath: download.path })
      } catch (error) {
        if (!cancelled) {
          useFileExplorerStore.getState().failDownload('读取已下载文件失败')
          console.error('[Analysis] failed to fetch downloaded log:', error)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [download, analyzeBuffer])

  // ArduPilot DataFlash FC import completed: fetch and analyze in place.
  useEffect(() => {
    if (logDownload?.status !== 'done' || !logDownload.downloadId) return
    if (logDownload.intent !== 'analyze') return
    if (handledDownloadRef.current === logDownload.downloadId) return
    const downloadId = logDownload.downloadId
    let cancelled = false
    void (async () => {
      try {
        const response = await fetch(`/api/logs/downloads/${downloadId}`)
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const buffer = await response.arrayBuffer()
        if (cancelled) return
        handledDownloadRef.current = downloadId
        useLogTransferStore.getState().clearDownload()
        setImportOpen(false)
        analyzeBuffer(logDownload.fileName ?? 'log.bin', buffer)
      } catch (error) {
        if (!cancelled) {
          useLogTransferStore.getState().failDownload('读取已下载文件失败')
          console.error('[Analysis] failed to fetch downloaded DataFlash log:', error)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [logDownload, analyzeBuffer])

  const handleFiles = useCallback((files: FileList | null) => {
    const file = files?.[0]
    if (!file) return
    const lower = file.name.toLowerCase()
    if (!lower.endsWith('.ulg') && !lower.endsWith('.bin')) {
      setParseError('请选择 .ulg（PX4 ULog）或 .bin（ArduPilot DataFlash）格式的飞行日志文件')
      return
    }
    void file.arrayBuffer().then((buffer) => analyzeBuffer(file.name, buffer, {
      sourcePath: file.name,
      fileModifiedMs: file.lastModified,
    }))
  }, [analyzeBuffer])

  const filteredParams = useMemo(() => {
    if (!dataset) return []
    const filter = paramFilter.trim().toUpperCase()
    if (!filter) return dataset.params
    return dataset.params.filter((param) => param.name.toUpperCase().includes(filter))
  }, [dataset, paramFilter])

  const modeTimeline = useMemo(() => {
    if (!dataset || dataset.overview.durationSec <= 0) return []
    return dataset.modeSegments.map((segment, index) => ({
      label: segment.label,
      widthPct: Math.max(
        0.5,
        ((segment.endSec - segment.startSec) / dataset.overview.durationSec) * 100,
      ),
      color: seriesColor(index),
      durationSec: segment.endSec - segment.startSec,
    }))
  }, [dataset])

  const vibrationSeries = useMemo<SeriesData[]>(() => {
    if (!dataset?.vibration) return []
    const axes = ['X 轴', 'Y 轴', 'Z 轴']
    return dataset.vibration.amp.map((amp, index) => ({
      label: axes[index],
      times: dataset.vibration!.freq,
      values: amp,
    }))
  }, [dataset])

  // PID loop tracking: all loops flattened; the panel's single-select groups
  // show exactly one loop's target/actual/error at a time. Fixed colorIndex
  // per role keeps colors stable across loop switches.
  const pidSeries = useMemo<SeriesData[]>(
    () => dataset?.pidLoops.flatMap((loop) =>
      loop.series.map((entry, index) => ({ ...entry, colorIndex: index }))) ?? [],
    [dataset],
  )
  const pidGroups = useMemo<SeriesSelectionGroup[]>(
    () => dataset?.pidLoops.map((loop) => ({
      id: loop.id,
      label: loop.label,
      labels: loop.series.map((entry) => entry.label),
    })) ?? [],
    [dataset],
  )

  return (
    <div
      className={`${embedded ? 'mc-embedded-page' : 'mc-workspace'} mc-fade-in`}
      onDragOver={(event) => {
        event.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(event) => {
        event.preventDefault()
        setDragOver(false)
        handleFiles(event.dataTransfer.files)
      }}
    >
      <PageHeader
        title="日志分析"
        description="解析 PX4 ULog 与 ArduPilot DataFlash 飞行日志，提供 Flight Review 级的全面分析"
        actions={
          <>
            <input
              ref={fileInputRef}
              type="file"
              accept=".ulg,.bin"
              hidden
              onChange={(event) => {
                handleFiles(event.target.files)
                event.target.value = ''
              }}
            />
            <button
              type="button"
              className="mc-btn mc-btn-ghost"
              onClick={() => fileInputRef.current?.click()}
            >
              <Icon name="upload" size={15} /> 打开本地日志
            </button>
            <button
              type="button"
              className="mc-btn mc-btn-primary"
              disabled={!backendEnabled || !vehicleReady}
              title={!backendEnabled
                ? '演示模式不连接飞控；仍可打开本地日志'
                : vehicleReady ? undefined : '连接飞控后可直接导入日志'}
              onClick={() => setImportOpen(true)}
            >
              <Icon name="download" size={15} /> 从飞控导入
            </button>
          </>
        }
      />

      {parseError && (
        <div className="mc-card" style={{ borderColor: 'var(--danger)', marginBottom: 14 }}>
          <p style={{ color: 'var(--danger)', margin: 0, fontSize: 13 }}>
            <Icon name="warning" size={14} /> {parseError}
          </p>
        </div>
      )}

      {parsing && (
        <div className="mc-analysis-dropzone">
          <p style={{ margin: 0 }}>正在解析 {fileName}…（大日志可能需要数秒）</p>
        </div>
      )}

      {!parsing && !dataset && (
        <div
          className={`mc-analysis-dropzone${dragOver ? ' is-over' : ''}`}
          onClick={() => fileInputRef.current?.click()}
          role="button"
          tabIndex={0}
        >
          <Icon name="log" size={34} style={{ margin: '0 auto', color: 'var(--accent)' }} />
          <p style={{ margin: '12px 0 4px', fontSize: 15, color: 'var(--text-primary)' }}>
            拖入 .ulg / .bin 日志文件，或点击选择本地文件
          </p>
          <p style={{ margin: 0, fontSize: 12.5 }}>
            支持 PX4 ULog 与 ArduPilot DataFlash
            {backendEnabled && '；也可在已连接飞控时点击右上角“从飞控导入”直接下载并分析'}
          </p>
        </div>
      )}

      {!parsing && dataset && (
        <div className="mc-analysis-grid">
          {/* 1. Flight overview */}
          <section className="mc-card mc-analysis-panel mc-analysis-panel--wide">
            <div className="flex items-center justify-between">
              <h3 className="mc-section-title">飞行概览</h3>
              <span className="mc-mono" style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                {fileName}
              </span>
            </div>
            <div className="mc-analysis-overview">
              <div>
                <span>日志时长</span>
                <strong>{formatDuration(dataset.overview.durationSec)}</strong>
              </div>
              <div>
                <span>解锁时长</span>
                <strong>{formatDuration(dataset.overview.totalArmedSec)}</strong>
              </div>
              <div>
                <span>
                  起飞时间 (UTC)
                  {dataset.overview.startTimeSource === 'filename' && ' · 文件名推断'}
                  {dataset.overview.startTimeSource === 'file-modified' && ' · 修改时间估算'}
                </span>
                <strong>
                  {dataset.overview.startTimeUtcMs
                    ? new Date(dataset.overview.startTimeUtcMs).toISOString().replace('T', ' ').slice(0, 19)
                    : '—'}
                </strong>
              </div>
              <div>
                <span>固件</span>
                {dataset.overview.firmware
                  ? <CopyableOverviewValue label="固件信息" value={dataset.overview.firmware} />
                  : <strong>—</strong>}
              </div>
              <div>
                <span>硬件</span>
                <strong>{dataset.overview.hardware ?? '—'}</strong>
              </div>
              <div>
                <span>机型</span>
                <strong>{dataset.overview.sysName ?? '—'}</strong>
              </div>
              <div>
                <span>日志丢帧</span>
                <strong style={{ color: dataset.overview.droppedMessages > 0 ? 'var(--warning)' : undefined }}>
                  {dataset.overview.droppedMessages}
                </strong>
              </div>
            </div>
            {modeTimeline.length > 0 && (
              <>
                <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--text-secondary)' }}>
                  飞行模式时间轴
                </p>
                <div className="mc-analysis-timeline">
                  {modeTimeline.map((segment, index) => (
                    <div
                      key={index}
                      style={{ width: `${segment.widthPct}%`, background: segment.color }}
                      title={`${segment.label}（${formatDuration(segment.durationSec)}）`}
                    >
                      {segment.widthPct > 9 ? segment.label : ''}
                    </div>
                  ))}
                </div>
              </>
            )}
            {dataset.events.length > 0 && (
              <>
                <button
                  type="button"
                  className="mc-analysis-events-toggle"
                  aria-expanded={eventsOpen}
                  onClick={() => setEventsOpen((current) => !current)}
                >
                  <Icon name="message" size={15} />
                  <strong>事件与消息</strong>
                  <span className="mc-analysis-events-count">{dataset.events.length}</span>
                  <em>{eventsOpen ? '收起' : '展开查看'}</em>
                  <Icon name="chevronDown" size={14} style={{ transform: eventsOpen ? 'rotate(180deg)' : undefined, transition: 'transform 160ms ease' }} />
                </button>
                {eventsOpen && (
                  <ul className="mc-analysis-events">
                    {dataset.events.map((event, index) => {
                      const level = LOG_LEVEL_LABELS[event.level] ?? LOG_LEVEL_LABELS[6]
                      return (
                        <li key={index}>
                          <time>{event.timeSec.toFixed(1)}s</time>
                          <span className="mc-mono" style={{ color: level.color, flexShrink: 0 }}>
                            {level.label}
                          </span>
                          <span>{event.message}</span>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </>
            )}
          </section>

          <section className="mc-card mc-analysis-panel">
            <header className="mc-analysis-panel__header">
              <h3 className="mc-section-title">日志姿态回放</h3>
              <span className="mc-analysis-panel__hint">拖动时间轴或播放日志姿态</span>
            </header>
            <Suspense fallback={<p className="mc-explorer__notice">正在加载三维姿态…</p>}>
              <LogAttitudeVisualizer
                series={dataset.attitude}
                durationSec={dataset.overview.durationSec}
                startSec={replayStartSec}
                syncTimeSec={chartCursorTimeSec}
              />
            </Suspense>
          </section>

          {/* Attitude & rate tracking */}
          <ChartPanel
            title="姿态跟踪（实际 vs 设定，°）"
            series={dataset.attitude}
            unit="°"
            onCursorTimeChange={handleChartCursorTimeChange}
            bands={dataset.armedSegments}
            selectionGroups={ATTITUDE_GROUPS}
          />
          <ChartPanel
            title="角速率跟踪（实际 vs 设定，°/s）"
            series={dataset.rates}
            unit="°/s"
            bands={dataset.armedSegments}
            selectionGroups={RATE_GROUPS}
          />

          {/* PID loop tracking: one loop (target/actual/error) at a time. */}
          {pidSeries.length > 0 && (
            <ChartPanel
              title="PID 环跟踪（目标 / 实际 / 误差）"
              series={pidSeries}
              bands={dataset.armedSegments}
              selectionGroups={pidGroups}
              selectionMode="single"
            />
          )}

          {/* 4. Actuators */}
          <ChartPanel
            title="执行器输出"
            series={dataset.actuators}
            bands={dataset.armedSegments}
            headerAside={dataset.actuatorSaturation && (
              <span
                className="mc-analysis-saturation"
                data-level={dataset.actuatorSaturation.saturationPct > 5
                  ? 'danger'
                  : dataset.actuatorSaturation.saturationPct > 1
                    ? 'warning'
                    : 'success'}
              >
                饱和 {dataset.actuatorSaturation.saturationPct.toFixed(1)}%
              </span>
            )}
          >
            {dataset.actuatorSaturation && dataset.actuatorSaturation.saturationPct > 1 && (
              <p style={{ margin: 0, fontSize: 12, color: 'var(--warning)' }}>
                <Icon name="warning" size={13} /> 有 {dataset.actuatorSaturation.saturationPct.toFixed(1)}%
                的采样存在电机输出饱和，控制余量不足（考虑降低负载或调整 PID）
              </p>
            )}
          </ChartPanel>

          {/* 5. Battery */}
          <ChartPanel
            title="电池（电压 / 电流 / 功率）"
            series={dataset.battery}
            bands={dataset.armedSegments}
            secondaryScaleLabels={BATTERY_SECONDARY_SCALE}
          />

          {/* 6. GPS quality */}
          <ChartPanel
            title="GPS 质量"
            series={dataset.gpsQuality}
            bands={dataset.armedSegments}
          />

          {/* 7. Altitude & velocity */}
          <ChartPanel
            title="高度剖面（m）"
            series={dataset.altitude}
            unit="m"
            bands={dataset.armedSegments}
            secondaryScaleLabels={ALTITUDE_SECONDARY_SCALE}
          />
          <ChartPanel
            title="速度（m/s）"
            series={dataset.velocity}
            unit="m/s"
            bands={dataset.armedSegments}
          />

          {/* 8. Vibration */}
          {dataset.vibration && (
            <ChartPanel
              title={`振动频谱（FFT，采样率 ${dataset.vibration.sampleRateHz.toFixed(0)} Hz）`}
              series={vibrationSeries}
              unit="m/s²"
              height={240}
            >
              <p style={{ margin: 0, fontSize: 11.5, color: 'var(--text-secondary)' }}>
                Hann 窗 + 分段平均（{dataset.vibration.segments} 段）。健康机架的高频振动幅值应低于
                约 1 m/s²；桨叶/电机不平衡通常表现为窄带尖峰。
              </p>
            </ChartPanel>
          )}
          <ChartPanel
            title="原始加速度包络（m/s²）"
            series={dataset.rawAcc}
            unit="m/s²"
            bands={dataset.armedSegments}
          />

          {/* 9. Parameters */}
          <section className="mc-card mc-analysis-panel">
            <h3 className="mc-section-title">参数快照（{dataset.params.length}）</h3>
            <input
              type="search"
              className="mc-input"
              placeholder="搜索参数名…"
              value={paramFilter}
              onChange={(event) => setParamFilter(event.target.value)}
            />
            <div className="mc-param-table">
              <table>
                <thead>
                  <tr><th>参数</th><th>值</th></tr>
                </thead>
                <tbody>
                  {filteredParams.slice(0, 400).map((param) => (
                    <tr key={param.name}>
                      <td className="mc-mono">{param.name}</td>
                      <td className="mc-mono">{Number.isInteger(param.value)
                        ? param.value
                        : param.value.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')}
                      </td>
                    </tr>
                  ))}
                  {filteredParams.length > 400 && (
                    <tr><td colSpan={2} style={{ color: 'var(--text-disabled)' }}>
                      仅显示前 400 项，请细化搜索
                    </td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>

          {/* 10. GPS track */}
          {dataset.track && (
            <section className="mc-card mc-analysis-panel mc-analysis-panel--wide">
              <h3 className="mc-section-title">GPS 飞行轨迹（按高度着色）</h3>
              <Suspense fallback={<p className="mc-explorer__notice">正在加载地图…</p>}>
                <TrackMap track={dataset.track} />
              </Suspense>
            </section>
          )}
        </div>
      )}

      {importOpen && (logs.format === 'dataflash'
        ? <FcDataflashImportDialog onClose={() => setImportOpen(false)} />
        : <FcImportDialog onClose={() => setImportOpen(false)} />)}
    </div>
  )
}
