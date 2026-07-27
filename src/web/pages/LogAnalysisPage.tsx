// Structured ULog analysis page. Data enters through three doors:
// a local .ulg file (drag & drop / picker), the hand-off stash from the
// flight-log explorer, or a direct FC import (FTP download -> analyze).
// Parsing happens inside a persistent Web Worker via UlogAnalysisClient;
// this page only renders the pre-digested dataset.
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import Icon from '../components/ui/Icon'
import { PageHeader } from '../components/ui/PageFrame'
import UPlotChart from '../components/logs/UPlotChart'
import { sendClientMessage } from '../hooks/useWebSocket'
import { useConnectionStore } from '../stores/connectionStore'
import { useFileExplorerStore } from '../stores/fileExplorerStore'
import { takeStashedLog } from '../utils/logAnalysisSession'
import { formatBytes } from '../utils/formatBytes'
import { UlogAnalysisClient, UlogAnalysisError } from '../log-analysis/UlogAnalysisClient'
import type {
  UlogAnalysisDataset,
  AnalysisSectionId,
  RawSeriesResult,
  UlogTopicCatalogEntry,
  LogSource,
} from '../log-analysis/types'
import { buildViewModel, getPrimaryFindings } from '../log-analysis/uiModel'
import { parsePx4LogPathDate } from '../utils/ulogAnalysis'
import type { FsEntry } from '../../shared/types'
import AnalysisSectionNav from '../components/logs/AnalysisSectionNav'
import AnalysisGroup from '../components/logs/AnalysisGroup'
import HealthSummary from '../components/logs/HealthSummary'
import CoverageSummary from '../components/logs/CoverageSummary'
import FindingsList from '../components/logs/FindingsList'
import LogTimeline from '../components/logs/LogTimeline'
import RawTopicExplorer from '../components/logs/RawTopicExplorer'
import AnalysisProgress from '../components/logs/AnalysisProgress'
import RawFieldPicker from '../components/logs/RawFieldPicker'
import RawDataTable from '../components/logs/RawDataTable'
import MetricChartGroup from '../components/logs/MetricChartGroup'

function formatAnalysisError(error: Error, fallback: string): string {
  if (error instanceof UlogAnalysisError) {
    const messages: Record<UlogAnalysisError['code'], string> = {
      invalid_file: '文件不是有效的 ULog 日志',
      unsupported_version: '不支持该 ULog 版本',
      encrypted: '暂不支持加密日志',
      out_of_memory: '日志过大，浏览器内存不足',
      canceled: '操作已取消',
      module_error: '分析模块处理失败',
      corrupt_topic: '日志主题数据损坏或不完整',
      unknown: fallback,
    }
    return messages[error.code]
  }
  return fallback
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

// ─── Overview section ────────────────────────────────────────────────────────

function OverviewSection({
  dataset,
  vm,
}: {
  dataset: UlogAnalysisDataset
  vm: ReturnType<typeof buildViewModel>
}) {
  const [detailsOpen, setDetailsOpen] = useState(false)
  const overviewSection = dataset.sections.overview
  const findings = overviewSection?.findings ?? []
  const primaryFindings = getPrimaryFindings(findings, 8)

  return (
    <div className="analysis-section-body">
      {/* Primary metrics */}
      <div className="mc-analysis-overview">
        {vm.overviewMetrics.map((m) => (
          <div key={m.label}>
            <span>{m.label}</span>
            <strong className="mc-mono">{m.value}</strong>
          </div>
        ))}
      </div>

      {/* Findings */}
      {primaryFindings.length > 0 && (
        <FindingsList findings={primaryFindings} compact />
      )}

      {/* Log details disclosure */}
      <div className="analysis-group__details">
        <button
          type="button"
          className="analysis-group__details-toggle"
          onClick={() => setDetailsOpen((v) => !v)}
          aria-expanded={detailsOpen}
        >
          查看日志详情
        </button>
        {detailsOpen && (
          <div className="analysis-group__details-content">
            {/* Firmware & hardware */}
            <div className="coverage-summary__grid">
              <div className="coverage-summary__cell">
                <span>固件版本</span>
                <strong className="mc-mono">{dataset.metadata.firmwareVersion ?? '—'}</strong>
              </div>
              <div className="coverage-summary__cell">
                <span>硬件版本</span>
                <strong className="mc-mono">{dataset.metadata.hardwareVersion ?? '—'}</strong>
              </div>
              <div className="coverage-summary__cell">
                <span>机型</span>
                <strong className="mc-mono">{dataset.metadata.vehicleType ?? '—'}</strong>
              </div>
              <div className="coverage-summary__cell">
                <span>参数数量</span>
                <strong className="mc-mono">{dataset.parameters.length}</strong>
              </div>
              <div className="coverage-summary__cell">
                <span>消息主题</span>
                <strong className="mc-mono">{dataset.catalog.length}</strong>
              </div>
              <div className="coverage-summary__cell">
                <span>事件数量</span>
                <strong className="mc-mono">{dataset.events.length}</strong>
              </div>
            </div>

            {/* Coverage */}
            <CoverageSummary dataset={dataset} />

            {/* Mode changes */}
            {dataset.timeline.modeChanges.length > 0 && (
              <>
                <p style={{ margin: '8px 0 4px', fontSize: 12, color: 'var(--text-secondary)' }}>
                  飞行模式变更（{dataset.timeline.modeChanges.length}）
                </p>
                <ul className="mc-analysis-events" style={{ maxHeight: 120 }}>
                  {dataset.timeline.modeChanges.map((mc, index) => (
                    <li key={index}>
                      <time>{mc.timeSec.toFixed(1)} 秒</time>
                      <span>{mc.mode}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Events-raw section ──────────────────────────────────────────────────────

function EventsRawSection({
  dataset,
  client,
}: {
  dataset: UlogAnalysisDataset
  client: UlogAnalysisClient | null
}) {
  const section = dataset.sections['events-raw']
  const findings = section?.findings ?? []
  const [selectedTopic, setSelectedTopic] = useState<UlogTopicCatalogEntry | null>(null)
  const [rawResult, setRawResult] = useState<RawSeriesResult | null>(null)
  const [rawLoading, setRawLoading] = useState(false)
  const [rawError, setRawError] = useState<string | null>(null)
  const rawAbortRef = useRef<AbortController | null>(null)

  useEffect(() => () => rawAbortRef.current?.abort(), [])

  const selectTopic = useCallback((entry: UlogTopicCatalogEntry) => {
    rawAbortRef.current?.abort()
    rawAbortRef.current = null
    setSelectedTopic(entry)
    setRawResult(null)
    setRawError(null)
    setRawLoading(false)
  }, [])

  const plotFields = useCallback((fields: string[]) => {
    if (!client || !selectedTopic) {
      setRawError('日志分析会话已关闭，请重新加载日志')
      return
    }

    rawAbortRef.current?.abort()
    const controller = new AbortController()
    rawAbortRef.current = controller
    setRawLoading(true)
    setRawError(null)
    setRawResult(null)

    void client.getSeries({
      topic: selectedTopic.name,
      multiId: selectedTopic.multiId,
      fields,
      pointBudget: 5000,
    }, controller.signal).then((result) => {
      if (rawAbortRef.current !== controller) return
      setRawResult(result)
    }).catch((error: Error) => {
      if (rawAbortRef.current !== controller || error.name === 'AbortError') return
      setRawError(formatAnalysisError(error, '读取原始字段失败'))
    }).finally(() => {
      if (rawAbortRef.current !== controller) return
      rawAbortRef.current = null
      setRawLoading(false)
    })
  }, [client, selectedTopic])

  const rawTable = useMemo(() => {
    if (!rawResult) return null
    const times = [...new Set(rawResult.series.flatMap((series) => series.times))]
      .sort((a, b) => a - b)
    const values: Record<string, number[]> = {}
    for (const series of rawResult.series) {
      const byTime = new Map(series.times.map((time, index) => [time, series.values[index]]))
      values[series.field] = times.map((time) => byTime.get(time) ?? Number.NaN)
    }
    return { times, values, fields: rawResult.series.map((series) => series.field) }
  }, [rawResult])

  return (
    <div className="analysis-section-body">
      {/* Existing findings from the events module */}
      {findings.length > 0 && (
        <FindingsList findings={findings} />
      )}

      {/* Events list */}
      {dataset.events.length > 0 && (
        <AnalysisGroup title={`事件日志（${dataset.events.length}）`}>
          <ul className="mc-analysis-events" style={{ maxHeight: 300 }}>
            {dataset.events.slice(0, 500).map((ev, i) => (
              <li key={i}>
                <time>{ev.timeSec.toFixed(1)} 秒</time>
                <span style={{ color: ev.level === 'error' || ev.level === 'critical' ? 'var(--danger)' : ev.level === 'warning' ? 'var(--warning)' : 'var(--text-primary)' }}>
                  {ev.message}
                </span>
              </li>
            ))}
          </ul>
          {dataset.events.length > 500 && (
            <p style={{ fontSize: 12, color: 'var(--text-disabled)', margin: '4px 0 0' }}>
              仅显示前 500 条事件，共 {dataset.events.length} 条
            </p>
          )}
        </AnalysisGroup>
      )}

      {/* Raw topic explorer */}
      <AnalysisGroup title={`原始主题浏览（${dataset.catalog.length} 实例）`}>
        <RawTopicExplorer catalog={dataset.catalog} onSelectTopic={selectTopic} />
      </AnalysisGroup>

      {selectedTopic && (
        <AnalysisGroup title={`原始字段：${selectedTopic.name}[${selectedTopic.multiId}]`}>
          <RawFieldPicker
            key={`${selectedTopic.name}:${selectedTopic.multiId}`}
            topicEntry={selectedTopic}
            onPlot={plotFields}
          />
          {rawLoading && <p className="mc-explorer__notice">正在读取并整理原始数据…</p>}
          {rawError && <p style={{ color: 'var(--danger)', margin: 0 }}>{rawError}</p>}
          {rawResult && rawResult.series.length > 0 && (
            <>
              <UPlotChart
                series={rawResult.series.map((series) => ({
                  label: series.field,
                  times: series.times,
                  values: series.values,
                }))}
                height={260}
              />
              <p style={{ margin: 0, fontSize: 12, color: 'var(--text-secondary)' }}>
                原始采样 {rawResult.originalSampleCount.toLocaleString()} 条
                {rawResult.truncated ? '，图表已按点数预算降采样' : ''}
              </p>
              {rawTable && (
                <RawDataTable
                  times={rawTable.times}
                  values={rawTable.values}
                  fields={rawTable.fields}
                />
              )}
            </>
          )}
        </AnalysisGroup>
      )}
    </div>
  )
}

// ─── Generic section renderer ────────────────────────────────────────────────

function SectionBody({
  dataset,
  sectionId,
}: {
  dataset: UlogAnalysisDataset
  sectionId: AnalysisSectionId
}) {
  const section = dataset.sections[sectionId]

  if (!section) {
    return (
      <div className="analysis-section-body">
        <p className="analysis-empty">此分区暂无分析模块</p>
      </div>
    )
  }

  if (!section.available) {
    return (
      <div className="analysis-section-body">
        <div className="analysis-empty">
          <p>缺少必需数据：{section.missingRequirements.join('、') || '未知'}</p>
        </div>
      </div>
    )
  }

  // Render chart series groups and findings
  const hasCharts = section.chartSeries.length > 0
  const hasFindings = section.findings.length > 0
  const hasMetrics = Object.keys(section.metrics).length > 0

  const metrics = hasMetrics
    ? Object.entries(section.metrics).slice(0, 8).map(([key, val]) => ({
        label: key,
        value: typeof val === 'number'
          ? (Number.isInteger(val) ? val : (val as number).toFixed(4).replace(/0+$/, '').replace(/\.$/, ''))
          : String(val),
      }))
    : undefined

  return (
    <div className="analysis-section-body">
      {/* Chart series groups */}
      {hasCharts && (
        <div className="analysis-groups-grid">
          {section.chartSeries.map((group) => (
            <MetricChartGroup
              key={group.id}
              title={group.title}
              description={group.description}
              seriesGroups={[group]}
            />
          ))}
        </div>
      )}

      {/* Findings */}
      {hasFindings && (
        <AnalysisGroup
          title="诊断发现"
          findings={section.findings}
        />
      )}

      {/* Metrics only (no charts, no findings) */}
      {!hasCharts && !hasFindings && hasMetrics && (
        <AnalysisGroup
          title="指标"
          metrics={metrics}
        />
      )}

      {/* Warnings */}
      {section.warnings.length > 0 && (
        <div className="analysis-warnings">
          {section.warnings.map((w, i) => (
            <p key={i} style={{ margin: 0, fontSize: 12, color: 'var(--warning)' }}>
              {w}
            </p>
          ))}
        </div>
      )}

      {/* Empty state */}
      {!hasCharts && !hasFindings && !hasMetrics && (
        <p className="analysis-empty">此分区暂无分析结果</p>
      )}
    </div>
  )
}

// ─── Main page ───────────────────────────────────────────────────────────────

export default function LogAnalysisPage({ embedded = false }: { embedded?: boolean }) {
  const vehicleReady = useConnectionStore((state) => state.vehicleReady)
  const download = useFileExplorerStore((state) => state.download)
  const [dataset, setDataset] = useState<UlogAnalysisDataset | null>(null)
  const [fileName, setFileName] = useState<string | null>(null)
  const [parsing, setParsing] = useState(false)
  const [parseError, setParseError] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [selectedSection, setSelectedSection] = useState<AnalysisSectionId>('overview')
  const [progress, setProgress] = useState<{ phase: string; fraction: number } | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const handledDownloadRef = useRef<string | null>(null)
  const clientRef = useRef<UlogAnalysisClient | null>(null)
  const unmountTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const analyzeBuffer = useCallback((
    name: string,
    buffer: ArrayBuffer,
    options?: { sourcePath?: string; fileModifiedMs?: number; source?: LogSource },
  ) => {
    // Dispose previous client (auto-cancels any in-flight load)
    void clientRef.current?.dispose()
    abortRef.current?.abort()
    const abortController = new AbortController()
    abortRef.current = abortController
    setProgress({ phase: 'starting', fraction: 0 })

    let client: UlogAnalysisClient
    client = new UlogAnalysisClient(
      () => {
        const w = new Worker(
          new URL('../workers/ulogAnalysisWorker.ts', import.meta.url),
          { type: 'module' },
        )
        // Adapt real Worker to WorkerPort interface
        let errorHandler: ((message: string) => void) | null = null
        w.onerror = (e: ErrorEvent) => { errorHandler?.(e.message) }
        return {
          postMessage: (msg: unknown, transfer?: Transferable[]) =>
            transfer ? w.postMessage(msg, transfer) : w.postMessage(msg),
          get onmessage() { return w.onmessage as ((e: MessageEvent) => void) | null },
          set onmessage(fn: ((e: MessageEvent) => void) | null) { w.onmessage = fn },
          get onerror() { return errorHandler },
          set onerror(fn: ((message: string) => void) | null) { errorHandler = fn },
          terminate: () => w.terminate(),
        }
      },
      (phase, fraction) => {
        if (clientRef.current === client) setProgress({ phase, fraction })
      },
    )
    clientRef.current = client
    setParsing(true)
    setParseError(null)
    setFileName(name)

    client.load(buffer, options?.source ?? 'local-file', abortController.signal)
      .then((result) => {
        if (clientRef.current !== client) return
        // Attempt to derive a UTC start time from metadata
        const meta = result.metadata
        if (meta.utcTimeSec == null) {
          const pathTime = parsePx4LogPathDate(options?.sourcePath ?? name)
          if (pathTime !== null) {
            ;(meta as { utcTimeSec: number | null }).utcTimeSec = pathTime / 1000
          } else if (options?.fileModifiedMs && options.fileModifiedMs > 0) {
            ;(meta as { utcTimeSec: number | null }).utcTimeSec = Math.max(
              0,
              options.fileModifiedMs / 1000 - meta.logDuration,
            )
          }
        }
        setDataset(result)
      })
      .catch((error: Error) => {
        if (clientRef.current !== client) return
        if (error.name === 'AbortError') return
        setDataset(null)
        setParseError(formatAnalysisError(error, '日志解析失败'))
      })
      .finally(() => {
        if (clientRef.current !== client) return
        setParsing(false)
        setProgress(null)
        abortRef.current = null
      })
  }, [])

  useEffect(() => {
    // React StrictMode replays effects in development by running cleanup and
    // setup again in the same tick. Deferring the dispose lets the replayed
    // setup retain the in-flight worker, while a real route change still
    // cancels parsing on the next task.
    if (unmountTimerRef.current !== null) {
      clearTimeout(unmountTimerRef.current)
      unmountTimerRef.current = null
    }
    return () => {
      unmountTimerRef.current = setTimeout(() => {
        void clientRef.current?.dispose()
        clientRef.current = null
        unmountTimerRef.current = null
      }, 0)
    }
  }, [])

  // Hand-off from the flight-log explorer ("download & analyze").
  useEffect(() => {
    const stashed = takeStashedLog()
    if (stashed) analyzeBuffer(stashed.name, stashed.buffer, {
      sourcePath: stashed.sourcePath,
      source: 'flight-download',
    })
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
        analyzeBuffer(download.fileName ?? 'log.ulg', buffer, {
          sourcePath: download.path,
          source: 'fc-import',
        })
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

  const handleFiles = useCallback((files: FileList | null) => {
    const file = files?.[0]
    if (!file) return
    if (!file.name.toLowerCase().endsWith('.ulg')) {
      setParseError('请选择 .ulg 格式的 PX4 飞行日志文件')
      return
    }
    void file.arrayBuffer().then((buffer) => analyzeBuffer(file.name, buffer, {
      sourcePath: file.name,
      fileModifiedMs: file.lastModified,
    }))
  }, [analyzeBuffer])

  const vm = useMemo(() => buildViewModel(dataset, selectedSection), [dataset, selectedSection])

  const closeDataset = useCallback(() => {
    void clientRef.current?.dispose()
    clientRef.current = null
    setDataset(null)
    setFileName(null)
    setSelectedSection('overview')
  }, [])

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
        description="结构化 ULog 分析与原始数据检查"
        actions={
          <>
            <input
              ref={fileInputRef}
              type="file"
              accept=".ulg"
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
              disabled={!vehicleReady}
              title={vehicleReady ? undefined : '连接飞控后可直接导入日志'}
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

      {parsing && progress && (
        <AnalysisProgress
          phase={progress.phase}
          fraction={progress.fraction}
          fileName={fileName}
          onCancel={() => abortRef.current?.abort()}
        />
      )}

      {!parsing && !dataset && (
        <div
          className={`mc-analysis-dropzone${dragOver ? ' is-over' : ''}`}
          onClick={() => fileInputRef.current?.click()}
          role="button"
          tabIndex={0}
        >
          <Icon name="log" size={34} style={{ color: 'var(--accent)' }} />
          <p style={{ margin: '12px 0 4px', fontSize: 15, color: 'var(--text-primary)' }}>
            拖入 .ulg 日志文件，或点击选择本地文件
          </p>
          <p style={{ margin: 0, fontSize: 12.5 }}>
            也可以在已连接飞控时点击右上角"从飞控导入"直接下载并分析
          </p>
        </div>
      )}

      {!parsing && dataset && (
        <div className="analysis-layout">
          {/* 1. Compact file header */}
          <div className="analysis-file-header">
            <div className="analysis-file-header__info">
              <span className="analysis-file-header__name mc-mono">{fileName ?? 'log.ulg'}</span>
              <span className="analysis-file-header__meta mc-mono">
                {dataset.metadata.logDuration > 0
                  ? `${Math.round(dataset.metadata.logDuration)} 秒`
                  : '—'}
                {' · '}
                {dataset.catalog.length} 主题
                {vm.hasAppendedData ? ' · 含追加数据' : ''}
              </span>
            </div>
            <button
              type="button"
              className="mc-btn mc-btn-ghost"
              onClick={closeDataset}
            >
              <Icon name="close" size={14} /> 关闭
            </button>
          </div>

          {/* 2. Quality and coverage strip */}
          <HealthSummary dataset={dataset} />

          {/* 3. Flight timeline */}
          <LogTimeline
            timeline={dataset.timeline}
            findings={dataset.findings}
          />

          {/* 4. Section tabs */}
          <AnalysisSectionNav
            sections={vm.sections}
            labels={vm.sectionLabels}
            counts={vm.sectionCounts}
            findingsBySection={vm.findingsBySection}
            selected={vm.selectedSection}
            onSelect={setSelectedSection}
          />

          {/* 5. Active section body */}
          {vm.isEmpty ? (
            <div className="analysis-empty-state mc-card">
              <p>{vm.emptyReason ?? '暂无分析数据'}</p>
            </div>
          ) : (
            <div className="analysis-section-content">
              {vm.selectedSection === 'overview' ? (
                <OverviewSection dataset={dataset} vm={vm} />
              ) : vm.selectedSection === 'events-raw' ? (
                <EventsRawSection dataset={dataset} client={clientRef.current} />
              ) : (
                <SectionBody dataset={dataset} sectionId={vm.selectedSection} />
              )}
            </div>
          )}
        </div>
      )}

      {importOpen && <FcImportDialog onClose={() => setImportOpen(false)} />}
    </div>
  )
}
