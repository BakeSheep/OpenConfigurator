// MAVLink FTP (FILE_TRANSFER_PROTOCOL #110) client used by the flight-log
// explorer: directory listing, burst file download and recursive deletion.
//
// The 251-byte FTP payload is encoded/decoded by hand (the MAVLink message
// only carries it as an opaque uint8 array):
//   0-1  seq_number (u16 LE)     8-11 offset (u32 LE)
//   2    session                 12.. data (max 239 bytes)
//   3    opcode
//   4    size (bytes of data)
//   5    req_opcode (replies)
//   6    burst_complete (replies)
//   7    padding
import { ByteBuffer } from '../platform/ByteBuffer'
import {
  artifactFs as fsp,
  artifactOs as os,
  artifactPath as path,
  type ArtifactFileHandle as FileHandle,
} from '../platform/artifactFs'
import { randomHex } from '../platform/crypto'
import { FTP_NAK_ERRORS, FTP_OPCODES } from '../../shared/constants'
import type { FsEntry, RuntimeEvent } from '../../shared/types'
import { assertDownloadCapacity, DownloadCapacityError } from './downloadLimits'

const FTP_HEADER_SIZE = 12
const FTP_MAX_DATA = 239
// Some Bluetooth SPP/firmware combinations fail to deliver a completely full
// 254-byte MAVLink FILE_TRANSFER_PROTOCOL payload. Keep compatibility reads
// below that boundary; the small framing overhead is preferable to a transfer
// that never advances. Burst mode remains available on links that support it.
const FTP_COMPAT_READ_DATA = 200
const SERIAL_REQUEST_TIMEOUT_MS = 1000
const BLUETOOTH_REQUEST_TIMEOUT_MS = 2200
const REQUEST_MAX_ATTEMPTS = 4
const SERIAL_BURST_QUIET_MS = 1500
const BLUETOOTH_BURST_QUIET_MS = 3200
// The tested PX4 FTP worker becomes unreliable with multiple ReadFile requests
// in flight. Keep one request outstanding and recover throughput by using the
// full USB chunk size plus a reduced telemetry profile during the transfer.
// INVARIANT: these MUST stay 1 while transact() tracks a single `pending`
// slot. A window > 1 would make later transact() calls overwrite the slot and
// time out every earlier request; switch `pending` to a Map keyed by
// expectedSeq before widening (gapFillPass() enforces this at runtime).
const SERIAL_READ_WINDOW = 1
const BLUETOOTH_READ_WINDOW = 1
// A download pass (burst or gap fill) that recovers zero new bytes counts as
// no progress; give up after this many consecutive futile passes.
const MAX_NO_PROGRESS_PASSES = 5
// Small residual gaps are cheaper to fetch with targeted ReadFile requests
// than by re-bursting the remainder of the file.
const GAP_FILL_MAX_BYTES = 64 * 1024
const GAP_FILL_MAX_INTERVALS = 32
const LIST_MAX_ENTRIES = 2000
const DELETE_MAX_DEPTH = 6
const DELETE_MAX_ITEMS = 512
const MAX_RETAINED_DOWNLOADS = 5
const PROGRESS_INTERVAL_MS = 500
const DOWNLOAD_ID_BYTES = 8

const CRC32_TABLE = new Uint32Array(256)
for (let index = 0; index < CRC32_TABLE.length; index++) {
  let value = index
  for (let bit = 0; bit < 8; bit++) {
    value = (value & 1) !== 0 ? (value >>> 1) ^ 0xedb88320 : value >>> 1
  }
  CRC32_TABLE[index] = value >>> 0
}

function updateCrc32(state: number, data: ByteBuffer): number {
  let crc = state
  for (const byte of data) crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return crc >>> 0
}

export function crc32Buffer(data: ByteBuffer): number {
  // PX4's CalcFileCRC32 uses crc32part() with an initial value of zero and
  // returns the accumulator directly (no initial/final XOR).
  return updateCrc32(0, data)
}

async function crc32File(filePath: string): Promise<number> {
  const handle = await fsp.open(filePath, 'r')
  const buffer = ByteBuffer.allocUnsafe(64 * 1024)
  let crc = 0
  let position = 0
  try {
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position)
      if (bytesRead === 0) break
      crc = updateCrc32(crc, buffer.subarray(0, bytesRead))
      position += bytesRead
    }
  } finally {
    await handle.close()
  }
  return crc >>> 0
}
const NAK_ERROR_NAMES: Record<number, string> = Object.fromEntries(
  Object.entries(FTP_NAK_ERRORS).map(([name, value]) => [value, name]),
)

export type FtpOperation = 'list' | 'download' | 'delete'

export interface FtpTransport {
  /** Frame the 251-byte FTP payload into FILE_TRANSFER_PROTOCOL and write it. */
  sendFtpPayload(payload: ByteBuffer): boolean
  emitMessage(message: RuntimeEvent): void
  linkIsBluetooth(): boolean
}

export interface FtpDownloadRecord {
  filePath: string
  fileName: string
  sizeBytes: number
}

interface FtpReply {
  seq: number
  session: number
  opcode: number
  size: number
  reqOpcode: number
  burstComplete: boolean
  offset: number
  data: ByteBuffer
}

interface PendingRequest {
  reqOpcode: number
  expectedSeq: number
  resolve: (reply: FtpReply) => void
  reject: (error: Error) => void
}

export class FtpError extends Error {
  readonly code: string
  readonly retryable: boolean

  constructor(code: string, message: string, retryable = false) {
    super(message)
    this.name = 'FtpError'
    this.code = code
    this.retryable = retryable
  }
}

function nakError(reply: FtpReply, context: string): FtpError {
  const code = reply.data.length > 0 ? reply.data[0] : FTP_NAK_ERRORS.Fail
  const errno = code === FTP_NAK_ERRORS.FailErrno && reply.data.length > 1
    ? ` (errno ${reply.data[1]})`
    : ''
  const name = NAK_ERROR_NAMES[code] ?? `Unknown(${code})`
  return new FtpError(
    `ftp_nak_${name.toLowerCase()}`,
    `${context}: 飞控返回 ${name}${errno}`,
    code === FTP_NAK_ERRORS.Fail || code === FTP_NAK_ERRORS.FailErrno,
  )
}

function isEofNak(reply: FtpReply): boolean {
  return reply.opcode === FTP_OPCODES.Nak
    && reply.data.length > 0
    && reply.data[0] === FTP_NAK_ERRORS.EOF
}

/** Remove [start, end) from a sorted, non-overlapping interval list. */
export function subtractInterval(
  intervals: Array<[number, number]>,
  start: number,
  end: number,
): Array<[number, number]> {
  if (end <= start) return intervals
  const result: Array<[number, number]> = []
  for (const [a, b] of intervals) {
    if (end <= a || start >= b) {
      result.push([a, b])
      continue
    }
    if (start > a) result.push([a, start])
    if (end < b) result.push([end, b])
  }
  return result
}

function remainingBytes(intervals: Array<[number, number]>): number {
  return intervals.reduce((sum, [a, b]) => sum + (b - a), 0)
}

function joinDevicePath(dir: string, name: string): string {
  return dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`
}

function sanitizeFileName(devicePath: string): string {
  const base = devicePath.split('/').filter(Boolean).pop() ?? 'log.ulg'
  const cleaned = base.replace(/[\\/:*?"<>|\x00-\x1f\x7f]/g, '_').slice(0, 100)
  return cleaned || 'log.ulg'
}

export class MavlinkFtp {
  private readonly transport: FtpTransport
  private readonly downloadDir: string
  private state: 'idle' | FtpOperation = 'idle'
  private seq = 0
  private pending: PendingRequest | null = null
  private burstSink: ((reply: FtpReply) => void) | null = null
  private cancelRequested = false
  private destroyed = false
  private readonly downloads = new Map<string, FtpDownloadRecord>()
  private downloadDirReady: Promise<void> | null = null

  constructor(transport: FtpTransport, downloadDir?: string) {
    this.transport = transport
    this.downloadDir = downloadDir ?? path.join(os.tmpdir(), 'openconfigurator-logs')
  }

  get busy(): boolean {
    return this.state !== 'idle'
  }

  getDownload(artifactId: string): FtpDownloadRecord | null {
    return this.downloads.get(artifactId) ?? null
  }

  /** Route a decoded FILE_TRANSFER_PROTOCOL payload from the selected FC. */
  handleFtpPayload(payload: ByteBuffer): void {
    if (this.destroyed || payload.length < FTP_HEADER_SIZE) return
    const size = Math.min(payload[4], FTP_MAX_DATA, payload.length - FTP_HEADER_SIZE)
    const reply: FtpReply = {
      seq: payload.readUInt16LE(0),
      session: payload[2],
      opcode: payload[3],
      size,
      reqOpcode: payload[5],
      burstComplete: payload[6] !== 0,
      offset: payload.readUInt32LE(8),
      data: payload.subarray(FTP_HEADER_SIZE, FTP_HEADER_SIZE + Math.max(0, size)),
    }
    if (reply.opcode !== FTP_OPCODES.Ack && reply.opcode !== FTP_OPCODES.Nak) return

    const pending = this.pending
    if (
      pending
      && reply.reqOpcode === pending.reqOpcode
      && reply.seq === pending.expectedSeq
    ) {
      this.advanceSeqFromReply(reply.seq)
      this.pending = null
      pending.resolve(reply)
      return
    }
    // Burst chunks stream without individual requests; they carry the burst
    // req_opcode and are consumed by the active download pass.
    if (this.burstSink && reply.reqOpcode === FTP_OPCODES.BurstReadFile) {
      this.advanceSeqFromReply(reply.seq)
      this.burstSink(reply)
    }
  }

  /**
   * MAVLink FTP uses one sequence across requests and replies. BurstReadFile
   * can advance it many times without another client request, so the next
   * outbound command must continue after the newest accepted reply. Ignore
   * duplicates/stale replies using modular ordering so they cannot move the
   * local sequence backwards around the uint16 wrap point.
   */
  private advanceSeqFromReply(replySeq: number): void {
    const next = (replySeq + 1) & 0xffff
    const forward = (next - this.seq + 0x10000) & 0xffff
    if (forward > 0 && forward < 0x8000) this.seq = next
  }

  /** Abort whatever operation is running (link drop, target switch, destroy). */
  cancelAll(reason: string): void {
    this.cancelRequested = true
    const pending = this.pending
    this.pending = null
    pending?.reject(new FtpError('cancelled', `FTP 操作已取消：${reason}`, true))
    // An active burst pass ends on its own via the quiet timeout; the download
    // loop then observes cancelRequested and stops.
  }

  destroy(): void {
    this.destroyed = true
    this.cancelAll('bridge_destroyed')
    for (const record of this.downloads.values()) void fsp.unlink(record.filePath).catch(() => undefined)
    this.downloads.clear()
  }

  consumeDownload(artifactId: string): FtpDownloadRecord | null {
    const record = this.downloads.get(artifactId) ?? null
    if (record) this.downloads.delete(artifactId)
    return record
  }

  startList(dirPath: string, requestId?: string): void {
    if (!this.claim('list', requestId)) return
    void this.runList(dirPath, requestId)
  }

  startDownload(filePath: string, requestId?: string): void {
    if (!this.claim('download', requestId)) return
    void this.runDownload(filePath, requestId)
  }

  startDelete(entries: Array<{ path: string; kind: 'file' | 'dir' }>, requestId?: string): void {
    if (!this.claim('delete', requestId)) return
    void this.runDelete(entries, requestId)
  }

  cancelDownload(requestId?: string): void {
    if (this.state !== 'download') {
      this.emitError('download', 'no_active_download', '当前没有进行中的下载', requestId, false)
      return
    }
    this.cancelAll('user_cancelled')
  }

  private claim(operation: FtpOperation, requestId?: string): boolean {
    if (this.destroyed) return false
    if (this.state !== 'idle') {
      this.emitError(
        operation,
        'ftp_busy',
        `已有文件操作（${this.state}）进行中`,
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
    this.burstSink = null
    this.pending = null
  }

  private emitError(
    operation: FtpOperation,
    code: string,
    message: string,
    requestId: string | undefined,
    retryable: boolean,
  ): void {
    this.transport.emitMessage({
      type: 'fs_op_error',
      data: {
        ...(requestId ? { requestId } : {}),
        operation,
        code,
        message,
        retryable,
      },
    })
  }

  private reportFailure(operation: FtpOperation, error: unknown, requestId?: string): void {
    if (error instanceof FtpError) {
      this.emitError(operation, error.code, error.message, requestId, error.retryable)
      return
    }
    this.emitError(operation, 'ftp_internal', error instanceof Error ? error.message : String(error), requestId, false)
  }

  private requestTimeoutMs(): number {
    return this.transport.linkIsBluetooth()
      ? BLUETOOTH_REQUEST_TIMEOUT_MS
      : SERIAL_REQUEST_TIMEOUT_MS
  }

  private burstQuietMs(): number {
    return this.transport.linkIsBluetooth()
      ? BLUETOOTH_BURST_QUIET_MS
      : SERIAL_BURST_QUIET_MS
  }

  private buildRequestPayload(
    seq: number,
    opcode: number,
    options: { session?: number; offset?: number; size?: number; data?: ByteBuffer } = {},
  ): ByteBuffer {
    const data = options.data ?? ByteBuffer.alloc(0)
    if (data.length > FTP_MAX_DATA) throw new FtpError('payload_too_large', 'FTP 数据超出 239 字节')
    const payload = ByteBuffer.alloc(FTP_HEADER_SIZE + data.length)
    payload.writeUInt16LE(seq, 0)
    payload[2] = options.session ?? 0
    payload[3] = opcode
    payload[4] = options.size ?? data.length
    payload.writeUInt32LE(options.offset ?? 0, 8)
    data.copy(payload, FTP_HEADER_SIZE)
    return payload
  }

  private allocSeq(): number {
    const seq = this.seq
    this.seq = (this.seq + 1) & 0xffff
    return seq
  }

  private sendRequest(
    opcode: number,
    options: { session?: number; offset?: number; size?: number; data?: ByteBuffer } = {},
  ): number {
    const seq = this.allocSeq()
    if (!this.transport.sendFtpPayload(this.buildRequestPayload(seq, opcode, options))) {
      throw new FtpError('write_rejected', '连接发送队列拒绝 FTP 请求', true)
    }
    return seq
  }

  /** Send a request and await its matching reply, retrying on silence. */
  private async transact(
    opcode: number,
    options: { session?: number; offset?: number; size?: number; data?: ByteBuffer } = {},
    attempts = REQUEST_MAX_ATTEMPTS,
  ): Promise<FtpReply> {
    let lastError: Error = new FtpError('ftp_timeout', 'FTP 请求超时', true)
    // MAVLink FTP retransmissions must keep the original sequence number. The
    // server uses it to recognize a duplicate command and replay its cached
    // response instead of executing a stateful operation (such as OpenFileRO)
    // for a second time.
    const seq = this.allocSeq()
    const expectedSeq = (seq + 1) & 0xffff
    const payload = this.buildRequestPayload(seq, opcode, options)
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (this.cancelRequested) throw new FtpError('cancelled', 'FTP 操作已取消', true)
      try {
        return await new Promise<FtpReply>((resolve, reject) => {
          const timer = setTimeout(() => {
            if (this.pending?.expectedSeq === expectedSeq) this.pending = null
            reject(new FtpError('ftp_timeout', `FTP 请求超时（opcode ${opcode}）`, true))
          }, this.requestTimeoutMs())
          // Register before writing so same-tick replies cannot be dropped.
          this.pending = {
            reqOpcode: opcode,
            // PX4/ArduPilot reply with request seq + 1, which lets stale
            // replies from a timed-out attempt be ignored safely.
            expectedSeq,
            resolve: (reply) => {
              clearTimeout(timer)
              resolve(reply)
            },
            reject: (error) => {
              clearTimeout(timer)
              reject(error)
            },
          }
          if (!this.transport.sendFtpPayload(payload)) {
            clearTimeout(timer)
            this.pending = null
            reject(new FtpError('write_rejected', '连接发送队列拒绝 FTP 请求', true))
          }
        })
      } catch (error) {
        lastError = error as Error
        if (error instanceof FtpError && error.code === 'cancelled') throw error
        if (error instanceof FtpError && error.code === 'payload_too_large') throw error
      }
    }
    throw lastError
  }

  // ------------------------------------------------------------------
  // Directory listing
  // ------------------------------------------------------------------

  private async runList(dirPath: string, requestId?: string): Promise<void> {
    try {
      const entries = await this.collectDirectory(dirPath)
      this.transport.emitMessage({ type: 'fs_list', data: { path: dirPath, entries } })
    } catch (error) {
      this.reportFailure('list', error, requestId)
    } finally {
      this.release()
    }
  }

  private async collectDirectory(dirPath: string): Promise<FsEntry[]> {
    const entries: FsEntry[] = []
    let offset = 0
    for (;;) {
      const reply = await this.transact(FTP_OPCODES.ListDirectory, {
        offset,
        data: ByteBuffer.from(dirPath, 'utf8'),
      })
      if (reply.opcode === FTP_OPCODES.Nak) {
        if (isEofNak(reply)) break
        throw nakError(reply, `列目录 ${dirPath} 失败`)
      }
      const { parsed, wireCount } = this.parseListChunk(reply.data)
      if (wireCount === 0) break
      entries.push(...parsed)
      offset += wireCount
      if (entries.length >= LIST_MAX_ENTRIES) break
    }
    return entries
  }

  /**
   * ListDirectory data: NUL-separated records. `F<name>\t<size>` for files,
   * `D<name>` for directories, `S` for entries the firmware skipped. Skip
   * records still advance the wire offset.
   */
  private parseListChunk(data: ByteBuffer): { parsed: FsEntry[]; wireCount: number } {
    const parsed: FsEntry[] = []
    let wireCount = 0
    for (const record of data.toString('utf8').split('\0')) {
      if (record.length === 0) continue
      wireCount++
      const kindChar = record[0]
      const rest = record.slice(1)
      if (kindChar === 'D') {
        if (rest && rest !== '.' && rest !== '..') {
          parsed.push({ name: rest, kind: 'dir', sizeBytes: null })
        }
      } else if (kindChar === 'F') {
        const tabIndex = rest.lastIndexOf('\t')
        const name = tabIndex >= 0 ? rest.slice(0, tabIndex) : rest
        const size = tabIndex >= 0 ? Number.parseInt(rest.slice(tabIndex + 1), 10) : Number.NaN
        if (name) {
          parsed.push({
            name,
            kind: 'file',
            sizeBytes: Number.isFinite(size) && size >= 0 ? size : null,
          })
        }
      }
      // 'S' and unknown records only advance the offset.
    }
    return { parsed, wireCount }
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

  private async runDownload(filePath: string, requestId?: string): Promise<void> {
    let session: number | null = null
    let handle: FileHandle | null = null
    let completedDownload: {
      path: string
      artifactId: string
      sizeBytes: number
      fileName: string
    } | null = null
    const artifactId = randomHex(DOWNLOAD_ID_BYTES)
    const partPath = path.join(this.downloadDir, `${artifactId}.part`)
    try {
      await this.ensureDownloadDir()
      // Clear any half-open session a crashed GCS left on the FC.
      await this.transact(FTP_OPCODES.ResetSessions, {}, 2).catch(() => undefined)

      const openReply = await this.transact(FTP_OPCODES.OpenFileRO, {
        data: ByteBuffer.from(filePath, 'utf8'),
      })
      if (openReply.opcode === FTP_OPCODES.Nak) {
        throw nakError(openReply, `打开文件 ${filePath} 失败`)
      }
      if (openReply.size < 4) throw new FtpError('ftp_protocol', 'OpenFileRO 应答缺少文件大小')
      session = openReply.session
      const fileSize = openReply.data.readUInt32LE(0)

      try {
        await assertDownloadCapacity(this.downloadDir, fileSize)
      } catch (error) {
        if (error instanceof DownloadCapacityError) {
          throw new FtpError(error.code, error.message)
        }
        throw error
      }

      handle = await fsp.open(partPath, 'w')
      let missing: Array<[number, number]> =
        fileSize > 0 ? [[0, fileSize]] : []
      let writeChain: Promise<unknown> = Promise.resolve()
      let lastProgressAt = 0
      let lastProgressBytes = 0

      const emitProgress = (force = false) => {
        const now = Date.now()
        if (!force && now - lastProgressAt < PROGRESS_INTERVAL_MS) return
        const received = fileSize - remainingBytes(missing)
        const elapsed = Math.max(0.001, (now - lastProgressAt) / 1000)
        const rateBps = lastProgressAt === 0
          ? 0
          : Math.max(0, received - lastProgressBytes) / elapsed
        lastProgressAt = now
        lastProgressBytes = received
        this.transport.emitMessage({
          type: 'fs_download_progress',
          data: { path: filePath, receivedBytes: received, totalBytes: fileSize, rateBps },
        })
      }

      const writeChunk = (offset: number, data: ByteBuffer) => {
        const end = Math.min(fileSize, offset + data.length)
        if (end <= offset) return
        const slice = data.subarray(0, end - offset)
        missing = subtractInterval(missing, offset, end)
        const target = handle!
        writeChain = writeChain.then(() => target.write(slice, 0, slice.length, offset))
        emitProgress()
      }

      emitProgress(true)
      let noProgressPasses = 0
      let forceReadFileFallback = false
      const readChunkSize = FTP_COMPAT_READ_DATA
      const readWindowSize = this.transport.linkIsBluetooth()
        ? BLUETOOTH_READ_WINDOW
        : SERIAL_READ_WINDOW
      while (missing.length > 0 && !this.cancelRequested) {
        const before = remainingBytes(missing)
        const useGapFill = forceReadFileFallback || (before <= GAP_FILL_MAX_BYTES
          && missing.length <= GAP_FILL_MAX_INTERVALS
        )
        if (useGapFill) {
          await this.gapFillPass(
            session,
            missing,
            writeChunk,
            readChunkSize,
            readWindowSize,
          )
        } else {
          await this.burstPass(session, missing[0][0], writeChunk)
        }
        await writeChain
        const after = remainingBytes(missing)
        if (after < before) {
          noProgressPasses = 0
        } else {
          // Some older/custom MAVLink FTP servers implement ReadFile but NAK
          // or silently ignore BurstReadFile. Falling back after the first
          // empty burst keeps large downloads interoperable instead of
          // retrying the unsupported opcode until the transfer stalls.
          let changedStrategy = false
          if (!useGapFill) {
            forceReadFileFallback = true
            changedStrategy = true
          }
          if (changedStrategy) {
            noProgressPasses = 0
          } else if (++noProgressPasses >= MAX_NO_PROGRESS_PASSES) {
            throw new FtpError('download_stalled', '下载多次重试后仍无进展', true)
          }
        }
      }
      await writeChain
      if (this.cancelRequested) throw new FtpError('cancelled', '下载已取消', true)

      await handle.close()
      handle = null

      // MAVLink FTP can verify the complete remote file independently of the
      // interval tracker. Compare it with a streaming local CRC before making
      // the download visible; size-complete but corrupted data must never be
      // registered as a valid ULog.
      const crcReply = await this.transact(FTP_OPCODES.CalcFileCRC32, {
        data: ByteBuffer.from(filePath, 'utf8'),
      })
      if (crcReply.opcode === FTP_OPCODES.Nak) {
        throw nakError(crcReply, `计算文件 ${filePath} CRC32 失败`)
      }
      if (crcReply.size < 4) {
        throw new FtpError('ftp_protocol', 'CalcFileCRC32 应答缺少 CRC32')
      }
      const remoteCrc = crcReply.data.readUInt32LE(0)
      const localCrc = await crc32File(partPath)
      if (remoteCrc !== localCrc) {
        throw new FtpError(
          'ftp_crc_mismatch',
          `下载文件 CRC32 不匹配（飞控 ${remoteCrc.toString(16).padStart(8, '0')}，本地 ${localCrc.toString(16).padStart(8, '0')}）`,
          true,
        )
      }

      const finalPath = path.join(this.downloadDir, `${artifactId}.ulg`)
      await fsp.rename(partPath, finalPath)
      const fileName = sanitizeFileName(filePath)
      this.registerDownload(artifactId, { filePath: finalPath, fileName, sizeBytes: fileSize })
      emitProgress(true)
      // Do not expose the download as complete until the FTP session below is
      // closed and this operation releases the link. A client receiving this
      // event may immediately begin a parameter sync; advertising completion
      // earlier races that request against TerminateSession.
      completedDownload = { path: filePath, artifactId, sizeBytes: fileSize, fileName }
    } catch (error) {
      await handle?.close().catch(() => undefined)
      handle = null
      await fsp.unlink(partPath).catch(() => undefined)
      this.reportFailure('download', error, requestId)
    } finally {
      if (session !== null) {
        // Best-effort: free the FC-side session even after failures.
        this.cancelRequested = false
        await this.transact(FTP_OPCODES.TerminateSession, { session }, 1).catch(() => undefined)
      }
      this.release()
    }
    if (completedDownload) {
      this.transport.emitMessage({ type: 'fs_download_complete', data: completedDownload })
    }
  }

  /** One burst pass: the FC streams chunks until EOF/complete or the link goes quiet. */
  private burstPass(
    session: number,
    startOffset: number,
    writeChunk: (offset: number, data: ByteBuffer) => void,
  ): Promise<void> {
    return new Promise((resolve) => {
      let finished = false
      let quietTimer: ReturnType<typeof setTimeout> | null = null
      const finish = () => {
        if (finished) return
        finished = true
        if (quietTimer) clearTimeout(quietTimer)
        this.burstSink = null
        resolve()
      }
      const armQuietTimer = () => {
        if (quietTimer) clearTimeout(quietTimer)
        quietTimer = setTimeout(finish, this.burstQuietMs())
      }
      this.burstSink = (reply) => {
        if (reply.session !== session) return
        armQuietTimer()
        if (reply.opcode === FTP_OPCODES.Nak) {
          // EOF marks the natural end of the stream; any other NAK also ends
          // the pass and the outer loop decides whether to retry.
          finish()
          return
        }
        if (reply.size > 0) writeChunk(reply.offset, reply.data)
        if (reply.burstComplete) finish()
      }
      armQuietTimer()
      try {
        this.sendRequest(FTP_OPCODES.BurstReadFile, {
          session,
          offset: startOffset,
          size: FTP_MAX_DATA,
        })
      } catch {
        finish()
      }
    })
  }

  /** Fetch small residual gaps with targeted ReadFile requests. */
  private async gapFillPass(
    session: number,
    missingSnapshot: Array<[number, number]>,
    writeChunk: (offset: number, data: ByteBuffer) => void,
    chunkSize: number,
    windowSize: number,
  ): Promise<void> {
    // Guard the single-slot `pending` invariant (see the READ_WINDOW
    // constants): concurrent transact() calls would overwrite each other.
    if (windowSize > 1) {
      throw new FtpError(
        'ftp_window_unsupported',
        'FTP 读取窗口 >1 需要先将 pending 改为按 seq 索引的 Map',
      )
    }
    for (const [start, end] of [...missingSnapshot]) {
      let offset = start
      while (offset < end) {
        if (this.cancelRequested) return
        const batch: Array<Promise<FtpReply>> = []
        for (let slot = 0; slot < windowSize && offset < end; slot++) {
          const requestOffset = offset
          const want = Math.min(chunkSize, end - requestOffset)
          batch.push(this.transact(FTP_OPCODES.ReadFile, {
            session,
            offset: requestOffset,
            size: want,
          }))
          offset += want
        }

        // Wait for the whole window so no pending requests leak into a retry
        // pass. Responses may arrive out of order; writeChunk uses their wire
        // offsets and the interval tracker preserves correctness.
        const replies = await Promise.allSettled(batch)
        let retryPass = false
        for (const result of replies) {
          if (result.status === 'rejected') {
            if (result.reason instanceof FtpError && result.reason.code === 'cancelled') {
              throw result.reason
            }
            retryPass = true
            continue
          }
          const reply = result.value
          if (reply.opcode === FTP_OPCODES.Nak) {
            if (isEofNak(reply)) return
            throw nakError(reply, '读取文件块失败')
          }
          if (reply.size === 0) return
          writeChunk(reply.offset, reply.data)
        }
        if (retryPass) return // outer loop retains missing intervals and retries
      }
    }
  }

  private registerDownload(artifactId: string, record: FtpDownloadRecord): void {
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
  // Deletion
  // ------------------------------------------------------------------

  private async runDelete(
    entries: Array<{ path: string; kind: 'file' | 'dir' }>,
    requestId?: string,
  ): Promise<void> {
    try {
      // Expand directories depth-first so files are removed before their
      // parent directory (the firmware can only remove empty directories).
      const work: Array<{ path: string; kind: 'file' | 'dir' }> = []
      for (const entry of entries) {
        await this.expandDeleteTarget(entry.path, entry.kind, 0, work)
      }
      let done = 0
      for (const item of work) {
        if (this.cancelRequested) throw new FtpError('cancelled', '删除已取消', true)
        this.transport.emitMessage({
          type: 'fs_delete_progress',
          data: { done, total: work.length, current: item.path },
        })
        const opcode = item.kind === 'dir' ? FTP_OPCODES.RemoveDirectory : FTP_OPCODES.RemoveFile
        const reply = await this.transact(opcode, { data: ByteBuffer.from(item.path, 'utf8') })
        if (reply.opcode === FTP_OPCODES.Nak) {
          const code = reply.data.length > 0 ? reply.data[0] : FTP_NAK_ERRORS.Fail
          // Already gone counts as success (e.g. duplicated selection).
          if (code !== FTP_NAK_ERRORS.FileNotFound) {
            throw nakError(reply, `删除 ${item.path} 失败`)
          }
        }
        done++
      }
      this.transport.emitMessage({ type: 'fs_delete_done', data: { deleted: done } })
    } catch (error) {
      this.reportFailure('delete', error, requestId)
    } finally {
      this.release()
    }
  }

  private async expandDeleteTarget(
    targetPath: string,
    kind: 'file' | 'dir',
    depth: number,
    out: Array<{ path: string; kind: 'file' | 'dir' }>,
  ): Promise<void> {
    if (out.length >= DELETE_MAX_ITEMS) {
      throw new FtpError('delete_too_many', `单次删除不能超过 ${DELETE_MAX_ITEMS} 项`)
    }
    if (kind === 'file') {
      out.push({ path: targetPath, kind: 'file' })
      return
    }
    if (depth >= DELETE_MAX_DEPTH) {
      throw new FtpError('delete_too_deep', `目录嵌套超过 ${DELETE_MAX_DEPTH} 层`)
    }
    const children = await this.collectDirectory(targetPath)
    for (const child of children) {
      await this.expandDeleteTarget(
        joinDevicePath(targetPath, child.name),
        child.kind,
        depth + 1,
        out,
      )
    }
    out.push({ path: targetPath, kind: 'dir' })
  }
}
