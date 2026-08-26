// ArduPilot DataFlash log transfer client (LOG_REQUEST_LIST / LOG_ENTRY /
// LOG_REQUEST_DATA / LOG_DATA / LOG_ERASE / LOG_REQUEST_END): log enumeration,
// interval-tracked download and full-chip erase. Mirrors the MavlinkFtp
// structure: one operation at a time, quiet-timeout retries, interval
// bookkeeping for gap recovery, and a browser-local temporary artifact registry.
import { ByteBuffer } from '../platform/ByteBuffer'
import {
  artifactFs as fsp,
  artifactOs as os,
  artifactPath as path,
  type ArtifactFileHandle as FileHandle,
} from '../platform/artifactFs'
import { randomHex } from '../platform/crypto'
import { subtractInterval } from './MavlinkFtp'
import type { DataflashLogEntry, RuntimeEvent } from '../../shared/types'
import { assertDownloadCapacity, DownloadCapacityError } from './downloadLimits'

// LOG_DATA carries at most 90 payload bytes; a shorter chunk marks the end of
// the log (count === 0 is an explicit end-of-log marker).
export const LOG_DATA_CHUNK_SIZE = 90

const SERIAL_REQUEST_TIMEOUT_MS = 1000
const BLUETOOTH_REQUEST_TIMEOUT_MS = 2200
const REQUEST_MAX_ATTEMPTS = 4
const SERIAL_STREAM_QUIET_MS = 1500
const BLUETOOTH_STREAM_QUIET_MS = 3200
// A download pass that recovers zero new bytes counts as no progress; give up
// after this many consecutive futile passes.
const MAX_NO_PROGRESS_PASSES = 5
const MAX_LIST_ENTRIES = 2000
const MAX_RETAINED_DOWNLOADS = 5
const PROGRESS_INTERVAL_MS = 500
const DOWNLOAD_ID_BYTES = 8
// LOG_ERASE has no reply; completion is verified by polling the log list
// until it reports zero logs (chip format can take several seconds).
const ERASE_VERIFY_DELAY_MS = 1500
const ERASE_VERIFY_MAX_ROUNDS = 5

export type LogTransferOperation = 'list' | 'download' | 'erase'

/**
 * Outbound LOG_* requests as plain descriptors. The bridge converts them to
 * mavlink-mappings classes and stamps the selected target system/component;
 * keeping the wire classes out of this service makes the protocol state
 * machine directly unit-testable.
 */
export type LogTransferRequest =
  | { kind: 'list'; start: number; end: number }
  | { kind: 'data'; logId: number; ofs: number; count: number }
  | { kind: 'erase' }
  | { kind: 'end' }

export interface LogTransferTransport {
  sendLogRequest(request: LogTransferRequest): boolean
  emitMessage(message: RuntimeEvent): void
  linkIsBluetooth(): boolean
}

export interface LogEntryReply {
  id: number
  numLogs: number
  lastLogNum: number
  /** UTC seconds since 1970, 0 when the FC has no valid clock. */
  timeUtc: number
  size: number
}

export interface LogDataReply {
  id: number
  ofs: number
  count: number
  data: ByteBuffer
}

export interface LogDownloadRecord {
  filePath: string
  fileName: string
  sizeBytes: number
}

/** Timeout overrides for tests; production uses the link-type defaults. */
export interface LogTransferTimings {
  requestTimeoutMs?: number
  streamQuietMs?: number
  eraseVerifyDelayMs?: number
}

export class LogTransferError extends Error {
  readonly code: string
  readonly retryable: boolean

  constructor(code: string, message: string, retryable = false) {
    super(message)
    this.name = 'LogTransferError'
    this.code = code
    this.retryable = retryable
  }
}

function remainingBytes(intervals: Array<[number, number]>): number {
  return intervals.reduce((sum, [a, b]) => sum + (b - a), 0)
}

function formatLogFileName(logId: number, timeUtcMs: number | null): string {
  const id = String(logId).padStart(4, '0')
  if (timeUtcMs === null) return `LOG_${id}_unknown.bin`
  const date = new Date(timeUtcMs)
  const pad = (value: number) => String(value).padStart(2, '0')
  const stamp = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
    + `_${pad(date.getUTCHours())}-${pad(date.getUTCMinutes())}-${pad(date.getUTCSeconds())}`
  return `LOG_${id}_${stamp}.bin`
}

function toDataflashEntry(reply: LogEntryReply): DataflashLogEntry {
  return {
    id: reply.id,
    timeUtcMs: reply.timeUtc > 0 ? reply.timeUtc * 1000 : null,
    sizeBytes: reply.size,
  }
}

interface ListSink {
  onEntry(entry: LogEntryReply): void
}

interface DataSink {
  onChunk(chunk: LogDataReply): void
}

export class MavlinkLogTransfer {
  private readonly transport: LogTransferTransport
  private readonly downloadDir: string
  private readonly timings: LogTransferTimings
  private state: 'idle' | LogTransferOperation = 'idle'
  private cancelRequested = false
  private destroyed = false
  private listSink: ListSink | null = null
  private dataSink: DataSink | null = null
  private readonly downloads = new Map<string, LogDownloadRecord>()
  private downloadDirReady: Promise<void> | null = null

  constructor(
    transport: LogTransferTransport,
    options: { downloadDir?: string; timings?: LogTransferTimings } = {},
  ) {
    this.transport = transport
    // Separate directory from the FTP downloads: both services wipe stale
    // files from their directory on first use, so sharing one directory could
    // delete the other service's registered downloads.
    this.downloadDir = options.downloadDir
      ?? path.join(os.tmpdir(), 'openconfigurator-dataflash-logs')
    this.timings = options.timings ?? {}
  }

  get busy(): boolean {
    return this.state !== 'idle'
  }

  getDownload(artifactId: string): LogDownloadRecord | null {
    return this.downloads.get(artifactId) ?? null
  }

  /** Route a decoded LOG_ENTRY from the selected FC. */
  handleLogEntry(entry: LogEntryReply): void {
    if (this.destroyed) return
    this.listSink?.onEntry(entry)
  }

  /** Route a decoded LOG_DATA chunk from the selected FC. */
  handleLogData(chunk: LogDataReply): void {
    if (this.destroyed) return
    this.dataSink?.onChunk(chunk)
  }

  /** Abort whatever operation is running (link drop, target switch, destroy). */
  cancelAll(reason: string): void {
    if (this.state === 'idle') return
    this.cancelRequested = true
    // Active sinks observe cancelRequested through their quiet timers; also
    // ask the FC to stop streaming so a dead transfer does not keep flooding
    // the link.
    this.transport.sendLogRequest({ kind: 'end' })
    void reason
  }

  destroy(): void {
    this.destroyed = true
    this.cancelAll('bridge_destroyed')
    for (const record of this.downloads.values()) void fsp.unlink(record.filePath).catch(() => undefined)
    this.downloads.clear()
  }

  consumeDownload(artifactId: string): LogDownloadRecord | null {
    const record = this.downloads.get(artifactId) ?? null
    if (record) this.downloads.delete(artifactId)
    return record
  }

  startList(requestId?: string): void {
    if (!this.claim('list', requestId)) return
    void this.runList(requestId)
  }

  startDownload(logId: number, requestId?: string): void {
    if (!Number.isInteger(logId) || logId < 0 || logId > 0xffff) {
      this.emitError('download', 'invalid_log_id', `无效的日志编号 ${logId}`, requestId, false)
      return
    }
    if (!this.claim('download', requestId)) return
    void this.runDownload(logId, requestId)
  }

  startErase(requestId?: string): void {
    if (!this.claim('erase', requestId)) return
    void this.runErase(requestId)
  }

  cancelDownload(requestId?: string): void {
    if (this.state !== 'download') {
      this.emitError('download', 'no_active_download', '当前没有进行中的日志下载', requestId, false)
      return
    }
    this.cancelAll('user_cancelled')
  }

  private claim(operation: LogTransferOperation, requestId?: string): boolean {
    if (this.destroyed) return false
    if (this.state !== 'idle') {
      this.emitError(
        operation,
        'log_transfer_busy',
        `已有日志操作（${this.state}）进行中`,
        requestId,
        true,
      )
      return false
    }
    this.state = operation
    this.cancelRequested = false
    return true
  }

  private release(): void {
    this.state = 'idle'
    this.listSink = null
    this.dataSink = null
  }

  private emitError(
    operation: LogTransferOperation,
    code: string,
    message: string,
    requestId: string | undefined,
    retryable: boolean,
  ): void {
    this.transport.emitMessage({
      type: 'log_op_error',
      data: {
        ...(requestId ? { requestId } : {}),
        operation,
        code,
        message,
        retryable,
      },
    })
  }

  private reportFailure(operation: LogTransferOperation, error: unknown, requestId?: string): void {
    if (error instanceof LogTransferError) {
      this.emitError(operation, error.code, error.message, requestId, error.retryable)
      return
    }
    this.emitError(
      operation,
      'log_transfer_internal',
      error instanceof Error ? error.message : String(error),
      requestId,
      false,
    )
  }

  private requestTimeoutMs(): number {
    return this.timings.requestTimeoutMs ?? (this.transport.linkIsBluetooth()
      ? BLUETOOTH_REQUEST_TIMEOUT_MS
      : SERIAL_REQUEST_TIMEOUT_MS)
  }

  private streamQuietMs(): number {
    return this.timings.streamQuietMs ?? (this.transport.linkIsBluetooth()
      ? BLUETOOTH_STREAM_QUIET_MS
      : SERIAL_STREAM_QUIET_MS)
  }

  private sendRequest(request: LogTransferRequest): void {
    if (!this.transport.sendLogRequest(request)) {
      throw new LogTransferError('write_rejected', '连接发送队列拒绝日志请求', true)
    }
  }

  // ------------------------------------------------------------------
  // Log list (also used for download sizing and erase verification)
  // ------------------------------------------------------------------

  /**
   * Enumerate logs in [start, end]. LOG_ENTRY replies stream in without
   * per-entry requests; on a quiet timeout the still-missing id range is
   * re-requested. `numLogs === 0` (one empty LOG_ENTRY) means no logs at all.
   */
  private collectList(start: number, end: number): Promise<DataflashLogEntry[]> {
    return new Promise<DataflashLogEntry[]>((resolve, reject) => {
      const entriesById = new Map<number, DataflashLogEntry>()
      let numLogs: number | null = null
      let lastLogNum: number | null = null
      let attempts = 0
      let quietTimer: ReturnType<typeof setTimeout> | null = null
      let finished = false

      const finish = (error: Error | null) => {
        if (finished) return
        finished = true
        if (quietTimer) clearTimeout(quietTimer)
        this.listSink = null
        if (error) reject(error)
        else resolve([...entriesById.values()].sort((a, b) => a.id - b.id))
      }

      // Ids the FC advertised for this window but has not delivered yet.
      // ArduPilot reports consecutive ids ending at lastLogNum.
      const missingIds = (): number[] => {
        if (numLogs === null || lastLogNum === null || numLogs === 0) return []
        const firstId = Math.max(start, lastLogNum - numLogs + 1)
        const lastId = Math.min(end, lastLogNum)
        const missing: number[] = []
        for (let id = firstId; id <= lastId; id++) {
          if (!entriesById.has(id)) missing.push(id)
        }
        return missing
      }

      const isComplete = (): boolean => {
        if (numLogs === null) return false
        if (numLogs === 0) return true
        return missingIds().length === 0 && entriesById.size > 0
      }

      const requestWindow = () => {
        const missing = missingIds()
        const reqStart = missing.length > 0 ? missing[0] : start
        const reqEnd = missing.length > 0 ? missing[missing.length - 1] : end
        try {
          this.sendRequest({ kind: 'list', start: reqStart, end: reqEnd })
        } catch (error) {
          finish(error as Error)
        }
      }

      const armQuietTimer = () => {
        if (quietTimer) clearTimeout(quietTimer)
        quietTimer = setTimeout(() => {
          if (this.cancelRequested) {
            finish(new LogTransferError('cancelled', '日志列表已取消', true))
            return
          }
          if (++attempts >= REQUEST_MAX_ATTEMPTS) {
            finish(new LogTransferError('log_list_timeout', '获取日志列表超时', true))
            return
          }
          requestWindow()
          armQuietTimer()
        }, this.requestTimeoutMs())
      }

      this.listSink = {
        onEntry: (reply) => {
          if (this.cancelRequested) {
            finish(new LogTransferError('cancelled', '日志列表已取消', true))
            return
          }
          numLogs = reply.numLogs
          lastLogNum = reply.lastLogNum
          if (reply.numLogs > 0 && reply.id >= start && reply.id <= end) {
            entriesById.set(reply.id, toDataflashEntry(reply))
            if (entriesById.size > MAX_LIST_ENTRIES) {
              finish(new LogTransferError('log_list_overflow', '日志数量超出上限', false))
              return
            }
          }
          if (isComplete()) {
            finish(null)
            return
          }
          armQuietTimer()
        },
      }

      requestWindow()
      armQuietTimer()
    })
  }

  private async runList(requestId?: string): Promise<void> {
    try {
      const entries = await this.collectList(0, 0xffff)
      this.transport.emitMessage({ type: 'log_list', data: { entries } })
    } catch (error) {
      this.reportFailure('list', error, requestId)
    } finally {
      this.release()
    }
  }

  // ------------------------------------------------------------------
  // Download
  // ------------------------------------------------------------------

  private async ensureDownloadDir(): Promise<void> {
    if (!this.downloadDirReady) {
      this.downloadDirReady = (async () => {
        await fsp.mkdir(this.downloadDir, { recursive: true })
        // Stale files from a previous server run are unreachable (their ids
        // died with the process), so clear them out.
        const names = await fsp.readdir(this.downloadDir).catch(() => [] as string[])
        await Promise.allSettled(
          names.map((name) => fsp.unlink(path.join(this.downloadDir, name))),
        )
      })()
    }
    await this.downloadDirReady
  }

  private async runDownload(logId: number, requestId?: string): Promise<void> {
    let handle: FileHandle | null = null
    let completedDownload: {
      logId: number
      artifactId: string
      sizeBytes: number
      fileName: string
    } | null = null
    const artifactId = randomHex(DOWNLOAD_ID_BYTES)
    const partPath = path.join(this.downloadDir, `${artifactId}.part`)
    try {
      await this.ensureDownloadDir()

      // Size the log with a targeted single-id list request. LOG_ENTRY sizes
      // may be approximate for the newest (still-open) log; the end-of-log
      // marker (count < 90) is authoritative during the data phase.
      const sized = await this.collectList(logId, logId)
      const entry = sized.find((candidate) => candidate.id === logId)
      if (!entry) {
        throw new LogTransferError('log_not_found', `飞控上不存在日志 ${logId}`, false)
      }
      const fileSize = entry.sizeBytes

      try {
        await assertDownloadCapacity(this.downloadDir, fileSize)
      } catch (error) {
        if (error instanceof DownloadCapacityError) {
          throw new LogTransferError(error.code, error.message)
        }
        throw error
      }

      handle = await fsp.open(partPath, 'w')
      // LOG_ENTRY sizes may be approximate for the newest (still-open) log;
      // an end-of-log marker during the data phase shrinks totalSize.
      let totalSize = fileSize
      let missing: Array<[number, number]> = fileSize > 0 ? [[0, fileSize]] : []
      let writeChain: Promise<unknown> = Promise.resolve()
      let lastProgressAt = 0
      let lastProgressBytes = 0

      const emitProgress = (force = false) => {
        const now = Date.now()
        if (!force && now - lastProgressAt < PROGRESS_INTERVAL_MS) return
        const received = totalSize - remainingBytes(missing)
        const elapsed = Math.max(0.001, (now - lastProgressAt) / 1000)
        const rateBps = lastProgressAt === 0
          ? 0
          : Math.max(0, received - lastProgressBytes) / elapsed
        lastProgressAt = now
        lastProgressBytes = received
        this.transport.emitMessage({
          type: 'log_download_progress',
          data: { logId, receivedBytes: received, totalBytes: totalSize, rateBps },
        })
      }

      const writeChunk = (offset: number, data: ByteBuffer) => {
        const end = Math.min(totalSize, offset + data.length)
        if (end <= offset) return
        const slice = data.subarray(0, end - offset)
        missing = subtractInterval(missing, offset, end)
        const target = handle!
        writeChain = writeChain.then(() => target.write(slice, 0, slice.length, offset))
        emitProgress()
      }

      // The FC reported the true end of the log below the advertised size:
      // drop the phantom tail from the tracker instead of stalling on it.
      const truncateTo = (endOffset: number) => {
        if (endOffset >= totalSize) return
        missing = subtractInterval(missing, endOffset, totalSize)
        totalSize = endOffset
      }

      emitProgress(true)
      let noProgressPasses = 0
      while (missing.length > 0 && !this.cancelRequested) {
        const before = remainingBytes(missing)
        await this.dataPass(logId, () => missing, writeChunk, truncateTo)
        await writeChain
        const after = remainingBytes(missing)
        if (after < before) {
          noProgressPasses = 0
        } else if (++noProgressPasses >= MAX_NO_PROGRESS_PASSES) {
          throw new LogTransferError('download_stalled', '下载多次重试后仍无进展', true)
        }
      }
      await writeChain
      if (this.cancelRequested) throw new LogTransferError('cancelled', '下载已取消', true)

      await handle.close()
      handle = null

      const finalPath = path.join(this.downloadDir, `${artifactId}.bin`)
      await fsp.rename(partPath, finalPath)
      const fileName = formatLogFileName(logId, entry.timeUtcMs)
      this.registerDownload(artifactId, { filePath: finalPath, fileName, sizeBytes: totalSize })
      emitProgress(true)
      completedDownload = { logId, artifactId, sizeBytes: totalSize, fileName }
    } catch (error) {
      await handle?.close().catch(() => undefined)
      handle = null
      await fsp.unlink(partPath).catch(() => undefined)
      this.reportFailure('download', error, requestId)
    } finally {
      // Stop the FC-side streaming and resume normal logging even on failure.
      try {
        this.sendRequest({ kind: 'end' })
      } catch {
        // Link already gone; nothing to stop.
      }
      this.release()
    }
    if (completedDownload) {
      this.transport.emitMessage({ type: 'log_download_complete', data: completedDownload })
    }
  }

  /**
   * One data pass: request the first missing interval and stream LOG_DATA
   * until that interval is filled, an end-of-log marker arrives, or the link
   * goes quiet. The outer loop re-checks the interval tracker and either
   * requests the next gap or gives up after repeated futile passes.
   */
  private dataPass(
    logId: number,
    getMissing: () => Array<[number, number]>,
    writeChunk: (offset: number, data: ByteBuffer) => void,
    truncateTo: (endOffset: number) => void,
  ): Promise<void> {
    return new Promise((resolve) => {
      const missing = getMissing()
      if (missing.length === 0) {
        resolve()
        return
      }
      const [reqStart, reqEnd] = missing[0]
      let finished = false
      let quietTimer: ReturnType<typeof setTimeout> | null = null
      const finish = () => {
        if (finished) return
        finished = true
        if (quietTimer) clearTimeout(quietTimer)
        this.dataSink = null
        resolve()
      }
      const armQuietTimer = () => {
        if (quietTimer) clearTimeout(quietTimer)
        quietTimer = setTimeout(finish, this.streamQuietMs())
      }
      const requestedIntervalDone = () =>
        !getMissing().some(([a, b]) => a < reqEnd && b > reqStart)
      this.dataSink = {
        onChunk: (chunk) => {
          if (chunk.id !== logId) return
          armQuietTimer()
          if (chunk.count > 0) {
            writeChunk(chunk.ofs, chunk.data.subarray(0, chunk.count))
          }
          // A short/zero chunk BELOW the requested end is the end-of-log
          // marker (LOG_ENTRY sizes are approximate for the newest log):
          // shrink the tracked size. A short chunk AT the requested end is
          // just the bounded tail of this gap request.
          const chunkEnd = chunk.ofs + chunk.count
          if (chunk.count < LOG_DATA_CHUNK_SIZE && chunkEnd < reqEnd) {
            truncateTo(chunkEnd)
            finish()
            return
          }
          if (requestedIntervalDone()) finish()
        },
      }
      armQuietTimer()
      try {
        this.sendRequest({
          kind: 'data',
          logId,
          ofs: reqStart,
          count: reqEnd - reqStart,
        })
      } catch {
        finish()
      }
    })
  }

  private registerDownload(artifactId: string, record: LogDownloadRecord): void {
    this.downloads.set(artifactId, record)
    while (this.downloads.size > MAX_RETAINED_DOWNLOADS) {
      const oldest = this.downloads.keys().next().value as string | undefined
      if (!oldest) break
      const evicted = this.downloads.get(oldest)
      this.downloads.delete(oldest)
      if (evicted) void fsp.unlink(evicted.filePath).catch(() => undefined)
    }
  }

  // ------------------------------------------------------------------
  // Erase (all logs - the protocol has no per-log delete)
  // ------------------------------------------------------------------

  private async runErase(requestId?: string): Promise<void> {
    try {
      this.sendRequest({ kind: 'erase' })
      // LOG_ERASE has no acknowledgement. Poll the list until the FC reports
      // zero logs; chip format can block the FC for several seconds, during
      // which list requests simply time out and are retried.
      const delay = this.timings.eraseVerifyDelayMs ?? ERASE_VERIFY_DELAY_MS
      let verified = false
      let observedRemainingLogs = false
      for (let round = 0; round < ERASE_VERIFY_MAX_ROUNDS && !verified; round++) {
        if (this.cancelRequested) throw new LogTransferError('cancelled', '擦除已取消', true)
        await new Promise<void>((resolve) => setTimeout(resolve, delay))
        try {
          const entries = await this.collectList(0, 0xffff)
          if (entries.length > 0) {
            // Formatting is asynchronous on some boards. A responsive FC can
            // continue reporting the old directory for several polls before
            // the erase becomes visible, so keep polling within the budget.
            observedRemainingLogs = true
            continue
          }
          verified = true
        } catch (error) {
          if (error instanceof LogTransferError && error.code === 'log_list_timeout') {
            continue // FC still formatting; poll again
          }
          throw error
        }
      }
      if (!verified) {
        throw observedRemainingLogs
          ? new LogTransferError('log_erase_incomplete', '擦除后飞控仍报告存在日志', true)
          : new LogTransferError('log_erase_unverified', '无法确认日志已被擦除', true)
      }
      this.transport.emitMessage({ type: 'log_list', data: { entries: [] } })
      this.transport.emitMessage({ type: 'log_erase_done' })
    } catch (error) {
      this.reportFailure('erase', error, requestId)
    } finally {
      this.release()
    }
  }
}
