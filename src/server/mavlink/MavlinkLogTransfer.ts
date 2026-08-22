// ArduPilot DataFlash log transfer client (LOG_REQUEST_LIST / LOG_ENTRY /
// LOG_REQUEST_DATA / LOG_DATA / LOG_ERASE / LOG_REQUEST_END): log enumeration,
// interval-tracked download and full-chip erase. Mirrors the MavlinkFtp
// structure: one operation at a time, quiet-timeout retries, interval
// bookkeeping for gap recovery, and a temp-file download registry served by
// GET /api/logs/downloads/:downloadId.
import { randomBytes } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { subtractInterval } from './MavlinkFtp'
import type { DataflashLogEntry, ServerMessage } from '../../shared/types'
import {
  assertDownloadCapacity,
  DATAFLASH_DOWNLOAD_DIR_PREFIX,
  DATAFLASH_DOWNLOAD_FILE_PATTERN,
  DownloadCapacityError,
} from './downloadLimits'

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
// OCSA-009: LOG_ENTRY replies reset the quiet timer even when they add nothing,
// so the list collector is bounded by total frames (4x the entry cap: real FCs
// send one entry per log, plus protocol noise) and by frames that never add a
// new in-window id (duplicates or out-of-window entries; 512 is far above any
// legitimate retransmission burst).
const LIST_MAX_FRAMES = MAX_LIST_ENTRIES * 4
const LIST_MAX_NO_PROGRESS_FRAMES = 512
// OCSA-009: data-pass termination budgets. The quiet timer alone is reset by
// every same-log frame, so each pass also runs a traffic-independent hard
// deadline (10 min exceeds any legitimate inter-chunk silence - Bluetooth
// quiet is 3.2 s - by orders of magnitude), a frame budget derived from the
// requested interval (2x the theoretical minimum chunk count plus slack for
// reordering/duplicates) and a no-progress frame budget for chunks that fill
// no missing byte.
const DATA_PASS_HARD_DEADLINE_MS = 10 * 60 * 1000
const DATA_PASS_FRAME_SLACK = 64
const DATA_PASS_NO_PROGRESS_FRAMES = 256
const DATA_MAX_MISSING_INTERVALS = 1024
const MAX_QUEUED_FILE_WRITES = 2048
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
  emitMessage(message: ServerMessage): void
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
  data: Buffer
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
  /** Hard per-download-pass deadline, independent of traffic (OCSA-009). */
  passDeadlineMs?: number
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
  /** Explicitly configured directory; null means "create a private one". */
  private readonly explicitDownloadDir: string | null
  /** Resolved download directory, set once ensureDownloadDir() succeeds. */
  private downloadDir: string | null = null
  private readonly timings: LogTransferTimings
  private state: 'idle' | LogTransferOperation = 'idle'
  private cancelRequested = false
  private destroyed = false
  private listSink: ListSink | null = null
  private dataSink: DataSink | null = null
  private readonly downloads = new Map<string, LogDownloadRecord>()
  private downloadDirReady: Promise<string> | null = null

  constructor(
    transport: LogTransferTransport,
    options: { downloadDir?: string; timings?: LogTransferTimings } = {},
  ) {
    this.transport = transport
    this.explicitDownloadDir = options.downloadDir ?? null
    this.timings = options.timings ?? {}
  }

  get busy(): boolean {
    return this.state !== 'idle'
  }

  /**
   * Directory holding this instance's downloads once prepared (diagnostics and
   * tests); null until the first operation created it.
   */
  get activeDownloadDir(): string | null {
    return this.downloadDir
  }

  getDownload(downloadId: string): LogDownloadRecord | null {
    return this.downloads.get(downloadId) ?? null
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
    this.downloads.clear()
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
      // OCSA-009: every reply resets the quiet timer, so total frames and
      // frames that add no new in-window id bound a hostile peer as well.
      let frames = 0
      let noProgressFrames = 0

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
          frames++
          if (frames > LIST_MAX_FRAMES || noProgressFrames >= LIST_MAX_NO_PROGRESS_FRAMES) {
            finish(new LogTransferError('log_list_overflow', '日志列表回复超出上限', false))
            return
          }
          numLogs = reply.numLogs
          lastLogNum = reply.lastLogNum
          if (reply.numLogs > 0 && reply.id >= start && reply.id <= end) {
            if (!entriesById.has(reply.id)) entriesById.set(reply.id, toDataflashEntry(reply))
            else noProgressFrames++
            if (entriesById.size > MAX_LIST_ENTRIES) {
              finish(new LogTransferError('log_list_overflow', '日志数量超出上限', false))
              return
            }
          } else {
            // Out-of-window or empty replies carry no usable entry.
            noProgressFrames++
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

  /**
   * Prepare the download directory and return its path. The ready promise is
   * cached, but a failure resets it (synchronously with the rejection) so the
   * next call retries instead of replaying the cached error forever (OCSA-014).
   */
  private async ensureDownloadDir(): Promise<string> {
    if (this.downloadDirReady) return this.downloadDirReady
    const ready = this.prepareDownloadDir()
    this.downloadDirReady = ready
    try {
      return await ready
    } catch (error) {
      if (this.downloadDirReady === ready) this.downloadDirReady = null
      throw error
    }
  }

  private async prepareDownloadDir(): Promise<string> {
    let dir: string
    if (this.explicitDownloadDir !== null) {
      // Explicitly configured directory (tests / embedded deployments): keep
      // using it directly, but never widen it beyond mkdir.
      await fsp.mkdir(this.explicitDownloadDir, { recursive: true })
      dir = this.explicitDownloadDir
    } else {
      // OCSA-008: fixed predictable names under os.tmpdir() could be
      // pre-created or symlinked by any local process before the service, and
      // multiple instances shared one wipe-everything cleanup. mkdtemp()
      // creates an atomically unique private directory per service instance,
      // separate from the FTP service's directory by construction.
      dir = await fsp.mkdtemp(path.join(os.tmpdir(), DATAFLASH_DOWNLOAD_DIR_PREFIX))
      // Node creates mkdtemp directories 0700; enforce it in case a umask or
      // platform ever relaxes that default.
      await fsp.chmod(dir, 0o700).catch(() => undefined)
      // Never sweep sibling instance directories based only on age. Graceful
      // Runtime and crash leftovers are delegated to the operating system's
      // tmp cleanup policy so teardown cannot race an in-flight file write.
    }
    this.downloadDir = dir
    await this.removeStaleArtifacts(dir)
    return dir
  }

  /**
   * Remove artifacts of previous runs. Only names matching this instance's own
   * random `<16 hex>.part|bin` format are unlinked - never arbitrary top-level
   * entries, which may belong to another instance or to whoever configured the
   * directory (OCSA-008).
   */
  private async removeStaleArtifacts(dir: string): Promise<void> {
    const names = await fsp.readdir(dir).catch(() => [] as string[])
    await Promise.allSettled(
      names
        .filter((name) => DATAFLASH_DOWNLOAD_FILE_PATTERN.test(name))
        .map((name) => fsp.unlink(path.join(dir, name))),
    )
  }

  private dataPassDeadlineMs(): number {
    return this.timings.passDeadlineMs ?? DATA_PASS_HARD_DEADLINE_MS
  }

  private async runDownload(logId: number, requestId?: string): Promise<void> {
    let handle: FileHandle | null = null
    let completedDownload: {
      logId: number
      downloadId: string
      sizeBytes: number
      advertisedSizeBytes: number
      sizeAdjusted: boolean
      integrity: 'unverified'
      fileName: string
    } | null = null
    const downloadId = randomBytes(DOWNLOAD_ID_BYTES).toString('hex')
    let partPath: string | null = null
    try {
      const downloadDir = await this.ensureDownloadDir()
      partPath = path.join(downloadDir, `${downloadId}.part`)

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
        await assertDownloadCapacity(downloadDir, fileSize)
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
      let queuedFileWrites = 0
      let resourceLimitError: LogTransferError | null = null
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

      // Returns the number of bytes this chunk newly covered, so a download
      // pass can tell progress from duplicate/noise frames (OCSA-009).
      const writeChunk = (offset: number, data: Buffer): number => {
        if (resourceLimitError) return -1
        const end = Math.min(totalSize, offset + data.length)
        if (end <= offset) return 0
        const before = remainingBytes(missing)
        const slice = data.subarray(0, end - offset)
        const nextMissing = subtractInterval(missing, offset, end)
        if (nextMissing.length > DATA_MAX_MISSING_INTERVALS) {
          resourceLimitError = new LogTransferError(
            'download_gap_overflow',
            `下载缺口数量超过 ${DATA_MAX_MISSING_INTERVALS}，已终止本次传输`,
            true,
          )
          return -1
        }
        if (queuedFileWrites >= MAX_QUEUED_FILE_WRITES) {
          resourceLimitError = new LogTransferError(
            'download_write_backlog',
            '本地文件写入积压超过安全上限，已终止本次传输',
            true,
          )
          return -1
        }
        missing = nextMissing
        const added = before - remainingBytes(missing)
        const target = handle!
        queuedFileWrites++
        writeChain = writeChain.then(
          () => target.write(slice, 0, slice.length, offset),
        ).finally(() => { queuedFileWrites-- })
        emitProgress()
        return added
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
        if (resourceLimitError) throw resourceLimitError
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

      const finalPath = path.join(downloadDir, `${downloadId}.bin`)
      await fsp.rename(partPath, finalPath)
      const fileName = formatLogFileName(logId, entry.timeUtcMs)
      this.registerDownload(downloadId, { filePath: finalPath, fileName, sizeBytes: totalSize })
      emitProgress(true)
      completedDownload = {
        logId,
        downloadId,
        sizeBytes: totalSize,
        advertisedSizeBytes: fileSize,
        sizeAdjusted: totalSize !== fileSize,
        // MAVLink LOG_DATA has no CRC/hash response comparable to MAVLink FTP
        // CalcFileCRC32. Do not present transport completion as integrity proof.
        integrity: 'unverified',
        fileName,
      }
    } catch (error) {
      await handle?.close().catch(() => undefined)
      handle = null
      if (partPath !== null) await fsp.unlink(partPath).catch(() => undefined)
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
   *
   * The quiet timer alone is reset by every same-log frame, so the pass is
   * additionally bounded by a traffic-independent hard deadline, a frame
   * budget derived from the requested interval and a no-progress frame budget
   * (OCSA-009). The short-chunk end-of-log semantics are unchanged.
   */
  private dataPass(
    logId: number,
    getMissing: () => Array<[number, number]>,
    writeChunk: (offset: number, data: Buffer) => number,
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
      let frames = 0
      let noProgressFrames = 0
      // Frame budget: a legitimate stream needs at most one frame per
      // LOG_DATA_CHUNK_SIZE bytes of the requested interval; 2x plus slack
      // absorbs reordering and retransmissions.
      const maxFrames =
        Math.ceil((reqEnd - reqStart) / LOG_DATA_CHUNK_SIZE) * 2 + DATA_PASS_FRAME_SLACK
      const finish = () => {
        if (finished) return
        finished = true
        if (quietTimer) clearTimeout(quietTimer)
        if (deadlineTimer) clearTimeout(deadlineTimer)
        this.dataSink = null
        resolve()
      }
      const armQuietTimer = () => {
        if (quietTimer) clearTimeout(quietTimer)
        quietTimer = setTimeout(finish, this.streamQuietMs())
      }
      // Hard deadline: never extended by incoming traffic.
      const deadlineTimer = setTimeout(finish, this.dataPassDeadlineMs())
      const requestedIntervalDone = () =>
        !getMissing().some(([a, b]) => a < reqEnd && b > reqStart)
      this.dataSink = {
        onChunk: (chunk) => {
          if (chunk.id !== logId) return
          frames++
          armQuietTimer()
          if (frames > maxFrames || noProgressFrames >= DATA_PASS_NO_PROGRESS_FRAMES) {
            // Hostile or broken peer: end the pass and let the outer
            // no-progress accounting decide between retry and failure.
            finish()
            return
          }
          let added = 0
          if (chunk.count > 0) {
            added = writeChunk(chunk.ofs, chunk.data.subarray(0, chunk.count))
          }
          if (added < 0) {
            finish()
            return
          }
          // A legitimate stream may reorder or duplicate a frame now and
          // then, but never hundreds in a row; total frames stay bounded by
          // maxFrames.
          if (added > 0) noProgressFrames = 0
          else noProgressFrames++
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

  private registerDownload(downloadId: string, record: LogDownloadRecord): void {
    this.downloads.set(downloadId, record)
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
