// Protocol tests for the MAVLink FTP client: payload codec, directory listing
// pagination, burst download with loss recovery, cancellation, deletion order
// and single-task mutual exclusion. Run directly: tsx src/server/mavlink/MavlinkFtp.test.ts
import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { FTP_NAK_ERRORS, FTP_OPCODES } from '../../shared/constants'
import { crc32Buffer, MavlinkFtp, subtractInterval, type FtpTransport } from './MavlinkFtp'
import {
  FTP_DOWNLOAD_DIR_PREFIX,
  MAX_LOG_DOWNLOAD_BYTES,
  removeStaleInstanceDirs,
} from './downloadLimits'
import type { ServerMessage } from '../../shared/types'

// Independent, bit-at-a-time reference for PX4's crc32part convention. Keep
// this separate from the production lookup-table implementation so a shared
// initialization/finalization mistake cannot make both sides agree falsely.
function px4ReferenceCrc32(data: Buffer): number {
  let crc = 0
  for (const byte of data) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc & 1) !== 0 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
    }
  }
  return crc >>> 0
}

assert.equal(crc32Buffer(Buffer.alloc(0)), 0)
assert.equal(crc32Buffer(Buffer.from('123456789')), 0x2dfd2d88)
assert.equal(crc32Buffer(Buffer.from('123456789')), px4ReferenceCrc32(Buffer.from('123456789')))
const wait = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds))

async function waitFor(predicate: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail('timed out waiting for asynchronous condition')
    await wait(5)
  }
}

interface ParsedRequest {
  seq: number
  session: number
  opcode: number
  size: number
  offset: number
  data: Buffer
}

function parseRequest(payload: Buffer): ParsedRequest {
  return {
    seq: payload.readUInt16LE(0),
    session: payload[2],
    opcode: payload[3],
    size: payload[4],
    offset: payload.readUInt32LE(8),
    data: payload.subarray(12, 12 + payload[4]),
  }
}

function buildReply(options: {
  seq: number
  session?: number
  opcode: number
  reqOpcode: number
  offset?: number
  data?: Buffer
  burstComplete?: boolean
}): Buffer {
  const data = options.data ?? Buffer.alloc(0)
  const payload = Buffer.alloc(12 + data.length)
  payload.writeUInt16LE(options.seq, 0)
  payload[2] = options.session ?? 0
  payload[3] = options.opcode
  payload[4] = data.length
  payload[5] = options.reqOpcode
  payload[6] = options.burstComplete ? 1 : 0
  payload.writeUInt32LE(options.offset ?? 0, 8)
  data.copy(payload, 12)
  return payload
}

function nakData(code: number): Buffer {
  return Buffer.from([code])
}

class FakeTransport implements FtpTransport {
  ftp!: MavlinkFtp
  readonly requests: ParsedRequest[] = []
  readonly messages: ServerMessage[] = []
  responder: ((request: ParsedRequest) => void) | null = null
  rejectWrites = false

  sendFtpPayload(payload: Buffer): boolean {
    if (this.rejectWrites) return false
    const request = parseRequest(payload)
    this.requests.push(request)
    const responder = this.responder
    if (responder) setImmediate(() => responder(request))
    return true
  }

  emitMessage(message: ServerMessage): void {
    this.messages.push(message)
  }

  linkIsBluetooth(): boolean {
    return false
  }

  reply(request: ParsedRequest, options: {
    seq?: number
    opcode: number
    session?: number
    offset?: number
    data?: Buffer
    burstComplete?: boolean
    reqOpcode?: number
  }): void {
    this.ftp.handleFtpPayload(buildReply({
      seq: options.seq ?? (request.seq + 1) & 0xffff,
      session: options.session ?? request.session,
      opcode: options.opcode,
      reqOpcode: options.reqOpcode ?? request.opcode,
      offset: options.offset ?? request.offset,
      data: options.data,
      burstComplete: options.burstComplete,
    }))
  }

  messagesOf<T extends ServerMessage['type']>(type: T): Array<Extract<ServerMessage, { type: T }>> {
    return this.messages.filter((message) => message.type === type) as Array<
      Extract<ServerMessage, { type: T }>
    >
  }
}

async function makeFtp(): Promise<{ transport: FakeTransport; ftp: MavlinkFtp; dir: string }> {
  const transport = new FakeTransport()
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'oc-ftp-test-'))
  const ftp = new MavlinkFtp(transport, dir)
  transport.ftp = ftp
  return { transport, ftp, dir }
}

/**
 * Serve a complete small download (single ReadFile gap-fill pass) so tests can
 * drive ensureDownloadDir()/directory selection through a real operation.
 */
function serveTinyDownload(transport: FakeTransport, content: Buffer, session = 4): void {
  transport.responder = (request) => {
    switch (request.opcode) {
      case FTP_OPCODES.ResetSessions:
        transport.reply(request, { opcode: FTP_OPCODES.Ack })
        break
      case FTP_OPCODES.OpenFileRO: {
        const size = Buffer.alloc(4)
        size.writeUInt32LE(content.length, 0)
        transport.reply(request, { opcode: FTP_OPCODES.Ack, session, data: size })
        break
      }
      case FTP_OPCODES.ReadFile:
        transport.reply(request, {
          opcode: FTP_OPCODES.Ack,
          session,
          offset: request.offset,
          data: content.subarray(request.offset, request.offset + request.size),
        })
        break
      case FTP_OPCODES.CalcFileCRC32: {
        const crc = Buffer.alloc(4)
        crc.writeUInt32LE(px4ReferenceCrc32(content), 0)
        transport.reply(request, { opcode: FTP_OPCODES.Ack, data: crc })
        break
      }
      case FTP_OPCODES.TerminateSession:
        transport.reply(request, { opcode: FTP_OPCODES.Ack })
        break
      default:
        assert.fail(`unexpected opcode ${request.opcode}`)
    }
  }
}

// ---------------------------------------------------------------------------
// Interval arithmetic used by the download gap tracker.
// ---------------------------------------------------------------------------
{
  assert.deepEqual(subtractInterval([[0, 100]], 0, 40), [[40, 100]])
  assert.deepEqual(subtractInterval([[0, 100]], 60, 100), [[0, 60]])
  assert.deepEqual(subtractInterval([[0, 100]], 30, 50), [[0, 30], [50, 100]])
  assert.deepEqual(subtractInterval([[0, 100]], 0, 100), [])
  assert.deepEqual(subtractInterval([[0, 10], [20, 30]], 5, 25), [[0, 5], [25, 30]])
  // Out-of-range and duplicate chunks must be no-ops.
  assert.deepEqual(subtractInterval([[10, 20]], 0, 5), [[10, 20]])
  assert.deepEqual(subtractInterval([[10, 20]], 12, 12), [[10, 20]])
}

// ---------------------------------------------------------------------------
// Directory listing: pagination, entry parsing, skip records, EOF stop.
// ---------------------------------------------------------------------------
await (async () => {
  const { transport, ftp } = await makeFtp()
  const pages: Array<Buffer | null> = [
    Buffer.from('D2026-01-01\0Ffoo.ulg\t1234\0S\0', 'utf8'),
    Buffer.from('Fbar.ulg\t99\0D.\0D..\0', 'utf8'),
    null, // EOF
  ]
  transport.responder = (request) => {
    assert.equal(request.opcode, FTP_OPCODES.ListDirectory)
    assert.equal(request.data.toString('utf8'), '/fs/microsd/log')
    const page = pages.shift()
    if (page === null || page === undefined) {
      transport.reply(request, { opcode: FTP_OPCODES.Nak, data: nakData(FTP_NAK_ERRORS.EOF) })
    } else {
      transport.reply(request, { opcode: FTP_OPCODES.Ack, data: page })
    }
  }
  ftp.startList('/fs/microsd/log')
  await waitFor(() => transport.messagesOf('fs_list').length === 1)
  const list = transport.messagesOf('fs_list')[0]
  assert.equal(list.data.path, '/fs/microsd/log')
  assert.deepEqual(list.data.entries, [
    { name: '2026-01-01', kind: 'dir', sizeBytes: null },
    { name: 'foo.ulg', kind: 'file', sizeBytes: 1234 },
    { name: 'bar.ulg', kind: 'file', sizeBytes: 99 },
  ])
  // Second page request must advance by the wire count (3, including skip).
  assert.equal(transport.requests[1].offset, 3)
  assert.equal(transport.requests[2].offset, 6)
  assert.ok(!ftp.busy)
  ftp.destroy()
})()

// ---------------------------------------------------------------------------
// Directory listing failure surfaces a typed fs_op_error.
// ---------------------------------------------------------------------------
await (async () => {
  const { transport, ftp } = await makeFtp()
  transport.responder = (request) => {
    transport.reply(request, { opcode: FTP_OPCODES.Nak, data: nakData(FTP_NAK_ERRORS.FileNotFound) })
  }
  ftp.startList('/nope', 'req-1')
  await waitFor(() => transport.messagesOf('fs_op_error').length === 1)
  const error = transport.messagesOf('fs_op_error')[0]
  assert.equal(error.data.operation, 'list')
  assert.equal(error.data.code, 'ftp_nak_filenotfound')
  assert.equal(error.data.requestId, 'req-1')
  assert.ok(!ftp.busy)
  ftp.destroy()
})()

// ---------------------------------------------------------------------------
// Download: burst with out-of-order + dropped chunk, ReadFile gap fill,
// session lifecycle and final file integrity.
// ---------------------------------------------------------------------------
await (async () => {
  const { transport, ftp, dir } = await makeFtp()
  const fileSize = 70_000
  const content = Buffer.alloc(fileSize)
  for (let index = 0; index < fileSize; index++) content[index] = index & 0xff
  const session = 7
  let terminated = false
  let lastBurstReplySeq: number | null = null
  let firstPostBurstRequestSeq: number | null = null

  transport.responder = (request) => {
    switch (request.opcode) {
      case FTP_OPCODES.ResetSessions:
        transport.reply(request, { opcode: FTP_OPCODES.Ack })
        break
      case FTP_OPCODES.OpenFileRO: {
        assert.equal(request.data.toString('utf8'), '/fs/microsd/log/2026-01-01/10_30_00.ulg')
        const sizeBuf = Buffer.alloc(4)
        sizeBuf.writeUInt32LE(fileSize, 0)
        transport.reply(request, { opcode: FTP_OPCODES.Ack, session, data: sizeBuf })
        break
      }
      case FTP_OPCODES.BurstReadFile: {
        assert.equal(request.session, session)
        // Stream 200-byte chunks, reorder an early pair and drop [400, 600)
        // entirely. The file is larger than the gap-fill threshold so this
        // exercises a real burst before targeted recovery.
        const chunks: Array<[number, number]> = []
        for (let start = 0; start < fileSize; start += 200) {
          if (start === 400) continue
          chunks.push([start, Math.min(fileSize, start + 200)])
        }
        ;[chunks[1], chunks[2]] = [chunks[2], chunks[1]]
        let replySeq = request.seq
        for (const [start, end] of chunks) {
          if (start < request.offset) continue
          replySeq = (replySeq + 1) & 0xffff
          transport.reply(request, {
            seq: replySeq,
            opcode: FTP_OPCODES.Ack,
            session,
            offset: start,
            data: content.subarray(start, end),
            reqOpcode: FTP_OPCODES.BurstReadFile,
            burstComplete: end === fileSize,
          })
        }
        lastBurstReplySeq = replySeq
        break
      }
      case FTP_OPCODES.ReadFile: {
        assert.equal(request.session, session)
        firstPostBurstRequestSeq ??= request.seq
        const start = request.offset
        const end = Math.min(fileSize, start + request.size)
        transport.reply(request, {
          opcode: FTP_OPCODES.Ack,
          session,
          offset: start,
          data: content.subarray(start, end),
        })
        break
      }
      case FTP_OPCODES.CalcFileCRC32: {
        const crc = Buffer.alloc(4)
        crc.writeUInt32LE(px4ReferenceCrc32(content), 0)
        transport.reply(request, { opcode: FTP_OPCODES.Ack, data: crc })
        break
      }
      case FTP_OPCODES.TerminateSession:
        terminated = true
        transport.reply(request, { opcode: FTP_OPCODES.Ack })
        break
      default:
        assert.fail(`unexpected opcode ${request.opcode}`)
    }
  }

  ftp.startDownload('/fs/microsd/log/2026-01-01/10_30_00.ulg')
  await waitFor(() => transport.messagesOf('fs_download_complete').length === 1)
  const complete = transport.messagesOf('fs_download_complete')[0]
  assert.equal(complete.data.sizeBytes, fileSize)
  assert.equal(complete.data.fileName, '10_30_00.ulg')
  assert.ok(transport.messagesOf('fs_download_progress').length >= 1)
  const progressMessages = transport.messagesOf('fs_download_progress')
  const finalProgress = progressMessages[progressMessages.length - 1]!
  assert.equal(finalProgress.data.receivedBytes, fileSize)

  const record = ftp.getDownload(complete.data.downloadId)
  assert.ok(record)
  assert.equal(record!.sizeBytes, fileSize)
  const written = await fsp.readFile(record!.filePath)
  assert.ok(written.equals(content), 'downloaded bytes must match the source file')
  assert.ok(terminated, 'session must be terminated after download')
  assert.equal(
    firstPostBurstRequestSeq,
    ((lastBurstReplySeq ?? 0) + 1) & 0xffff,
    'the first post-burst request must continue after the final burst reply sequence',
  )
  assert.ok(!ftp.busy)
  assert.equal(ftp.getDownload('feedfacefeedface'), null)
  ftp.destroy()
  await fsp.rm(dir, { recursive: true, force: true })
})()

// ---------------------------------------------------------------------------
// Large download falls back to ReadFile when BurstReadFile is unsupported.
// ---------------------------------------------------------------------------
await (async () => {
  const { transport, ftp, dir } = await makeFtp()
  const fileSize = 64 * 1024 + 1
  const content = Buffer.alloc(fileSize)
  for (let index = 0; index < fileSize; index++) content[index] = (index * 17) & 0xff
  const session = 3
  let burstRequests = 0
  let readRequests = 0
  let queuedAtFirstReadReply = 0

  transport.responder = (request) => {
    switch (request.opcode) {
      case FTP_OPCODES.ResetSessions:
        transport.reply(request, { opcode: FTP_OPCODES.Ack })
        break
      case FTP_OPCODES.OpenFileRO: {
        const sizeBuf = Buffer.alloc(4)
        sizeBuf.writeUInt32LE(fileSize, 0)
        transport.reply(request, { opcode: FTP_OPCODES.Ack, session, data: sizeBuf })
        break
      }
      case FTP_OPCODES.BurstReadFile:
        burstRequests++
        transport.reply(request, {
          opcode: FTP_OPCODES.Nak,
          session,
          data: nakData(FTP_NAK_ERRORS.UnknownCommand),
          reqOpcode: FTP_OPCODES.BurstReadFile,
        })
        break
      case FTP_OPCODES.ReadFile: {
        readRequests++
        if (readRequests === 1) {
          queuedAtFirstReadReply = transport.requests.filter(
            (candidate) => candidate.opcode === FTP_OPCODES.ReadFile,
          ).length
        }
        assert.ok(request.size <= 239)
        const end = Math.min(fileSize, request.offset + request.size)
        transport.reply(request, {
          opcode: FTP_OPCODES.Ack,
          session,
          offset: request.offset,
          data: content.subarray(request.offset, end),
        })
        break
      }
      case FTP_OPCODES.CalcFileCRC32: {
        const crc = Buffer.alloc(4)
        crc.writeUInt32LE(px4ReferenceCrc32(content), 0)
        transport.reply(request, { opcode: FTP_OPCODES.Ack, data: crc })
        break
      }
      case FTP_OPCODES.TerminateSession:
        transport.reply(request, { opcode: FTP_OPCODES.Ack })
        break
      default:
        assert.fail(`unexpected opcode ${request.opcode}`)
    }
  }

  ftp.startDownload('/fs/microsd/log/sess113/log110.ulg')
  await waitFor(() => transport.messagesOf('fs_download_complete').length === 1, 10_000)
  const complete = transport.messagesOf('fs_download_complete')[0]
  const record = ftp.getDownload(complete.data.downloadId)
  assert.ok(record)
  assert.equal(burstRequests, 1, 'unsupported burst should not be retried')
  assert.ok(readRequests > 1, 'large file should continue with regular ReadFile requests')
  assert.equal(queuedAtFirstReadReply, 1, 'USB must keep one reliable ReadFile request in flight')
  assert.ok((await fsp.readFile(record!.filePath)).equals(content))
  ftp.destroy()
  await fsp.rm(dir, { recursive: true, force: true })
})()

// ---------------------------------------------------------------------------
// Download CRC mismatch rejects and removes a size-complete local file.
// ---------------------------------------------------------------------------
await (async () => {
  const { transport, ftp, dir } = await makeFtp()
  const content = Buffer.from('crc-corruption-check')
  const session = 9
  transport.responder = (request) => {
    switch (request.opcode) {
      case FTP_OPCODES.ResetSessions:
        transport.reply(request, { opcode: FTP_OPCODES.Ack })
        break
      case FTP_OPCODES.OpenFileRO: {
        const size = Buffer.alloc(4)
        size.writeUInt32LE(content.length, 0)
        transport.reply(request, { opcode: FTP_OPCODES.Ack, session, data: size })
        break
      }
      case FTP_OPCODES.ReadFile:
        transport.reply(request, {
          opcode: FTP_OPCODES.Ack,
          session,
          offset: request.offset,
          data: content.subarray(request.offset, request.offset + request.size),
        })
        break
      case FTP_OPCODES.CalcFileCRC32: {
        const wrongCrc = Buffer.alloc(4)
        wrongCrc.writeUInt32LE((px4ReferenceCrc32(content) + 1) >>> 0, 0)
        transport.reply(request, { opcode: FTP_OPCODES.Ack, data: wrongCrc })
        break
      }
      case FTP_OPCODES.TerminateSession:
        transport.reply(request, { opcode: FTP_OPCODES.Ack })
        break
      default:
        assert.fail(`unexpected opcode ${request.opcode}`)
    }
  }

  ftp.startDownload('/fs/microsd/log/corrupt.ulg', 'crc-request')
  await waitFor(() => transport.messagesOf('fs_op_error').length === 1)
  const error = transport.messagesOf('fs_op_error')[0]
  assert.equal(error.data.code, 'ftp_crc_mismatch')
  assert.equal(transport.messagesOf('fs_download_complete').length, 0)
  await waitFor(() => !ftp.busy)
  assert.deepEqual(await fsp.readdir(dir), [], 'CRC-failed files must not be retained')
  ftp.destroy()
  await fsp.rm(dir, { recursive: true, force: true })
})()
// ---------------------------------------------------------------------------
// Download cancellation removes the partial file and reports 'cancelled'.
// ---------------------------------------------------------------------------
await (async () => {
  const { transport, ftp, dir } = await makeFtp()
  const session = 2
  transport.responder = (request) => {
    switch (request.opcode) {
      case FTP_OPCODES.ResetSessions:
        transport.reply(request, { opcode: FTP_OPCODES.Ack })
        break
      case FTP_OPCODES.OpenFileRO: {
        const sizeBuf = Buffer.alloc(4)
        sizeBuf.writeUInt32LE(100_000, 0)
        transport.reply(request, { opcode: FTP_OPCODES.Ack, session, data: sizeBuf })
        break
      }
      case FTP_OPCODES.BurstReadFile:
        // Send one chunk, then go silent: the user cancels before the quiet
        // timer would end the pass.
        transport.reply(request, {
          opcode: FTP_OPCODES.Ack,
          session,
          offset: 0,
          data: Buffer.alloc(200, 0xaa),
          reqOpcode: FTP_OPCODES.BurstReadFile,
        })
        setImmediate(() => ftp.cancelDownload())
        break
      case FTP_OPCODES.TerminateSession:
        transport.reply(request, { opcode: FTP_OPCODES.Ack })
        break
      default:
        break
    }
  }
  ftp.startDownload('/fs/microsd/log/big.ulg')
  await waitFor(() => transport.messagesOf('fs_op_error').length === 1, 12_000)
  const error = transport.messagesOf('fs_op_error')[0]
  assert.equal(error.data.operation, 'download')
  assert.equal(error.data.code, 'cancelled')
  await waitFor(() => !ftp.busy)
  const leftovers = (await fsp.readdir(dir)).filter((name) => name.endsWith('.part'))
  assert.deepEqual(leftovers, [], 'partial download must be deleted')
  ftp.destroy()
  await fsp.rm(dir, { recursive: true, force: true })
})()

// ---------------------------------------------------------------------------
// Deletion: recursive expansion removes children before the directory,
// tolerates FileNotFound, and reports progress + done.
// ---------------------------------------------------------------------------
await (async () => {
  const { transport, ftp } = await makeFtp()
  const removed: Array<{ opcode: number; path: string }> = []
  transport.responder = (request) => {
    switch (request.opcode) {
      case FTP_OPCODES.ListDirectory: {
        if (request.offset > 0) {
          transport.reply(request, { opcode: FTP_OPCODES.Nak, data: nakData(FTP_NAK_ERRORS.EOF) })
          return
        }
        assert.equal(request.data.toString('utf8'), '/fs/microsd/log/2026-01-01')
        transport.reply(request, {
          opcode: FTP_OPCODES.Ack,
          data: Buffer.from('Fa.ulg\t10\0Fb.ulg\t20\0', 'utf8'),
        })
        break
      }
      case FTP_OPCODES.RemoveFile:
      case FTP_OPCODES.RemoveDirectory: {
        const target = request.data.toString('utf8')
        removed.push({ opcode: request.opcode, path: target })
        if (target === '/fs/microsd/log/stale.ulg') {
          transport.reply(request, { opcode: FTP_OPCODES.Nak, data: nakData(FTP_NAK_ERRORS.FileNotFound) })
        } else {
          transport.reply(request, { opcode: FTP_OPCODES.Ack })
        }
        break
      }
      default:
        assert.fail(`unexpected opcode ${request.opcode}`)
    }
  }
  ftp.startDelete([
    { path: '/fs/microsd/log/2026-01-01', kind: 'dir' },
    { path: '/fs/microsd/log/stale.ulg', kind: 'file' },
  ])
  await waitFor(() => transport.messagesOf('fs_delete_done').length === 1)
  assert.deepEqual(removed, [
    { opcode: FTP_OPCODES.RemoveFile, path: '/fs/microsd/log/2026-01-01/a.ulg' },
    { opcode: FTP_OPCODES.RemoveFile, path: '/fs/microsd/log/2026-01-01/b.ulg' },
    { opcode: FTP_OPCODES.RemoveDirectory, path: '/fs/microsd/log/2026-01-01' },
    { opcode: FTP_OPCODES.RemoveFile, path: '/fs/microsd/log/stale.ulg' },
  ])
  assert.equal(transport.messagesOf('fs_delete_done')[0].data.deleted, 4)
  assert.ok(transport.messagesOf('fs_delete_progress').length >= 4)
  ftp.destroy()
})()

// ---------------------------------------------------------------------------
// Single-task mutual exclusion + request retry after silence.
// ---------------------------------------------------------------------------
await (async () => {
  const { transport, ftp } = await makeFtp()
  let listRequests = 0
  let firstSequence: number | null = null
  transport.responder = (request) => {
    if (request.opcode !== FTP_OPCODES.ListDirectory) return
    listRequests++
    // Stay silent on the first attempt. The retry must carry the exact same
    // sequence number so the FC recognizes it as a retransmission and replays
    // the cached response instead of executing the command again.
    if (listRequests === 1) {
      firstSequence = request.seq
      return
    }
    assert.equal(request.seq, firstSequence)
    transport.reply(request, { opcode: FTP_OPCODES.Nak, data: nakData(FTP_NAK_ERRORS.EOF) })
  }
  ftp.startList('/fs/microsd/log')
  assert.ok(ftp.busy)
  ftp.startDownload('/fs/microsd/log/x.ulg', 'busy-req')
  const busyError = transport.messagesOf('fs_op_error')[0]
  assert.equal(busyError.data.code, 'ftp_busy')
  assert.equal(busyError.data.operation, 'download')
  await waitFor(() => transport.messagesOf('fs_list').length === 1, 10_000)
  assert.equal(listRequests, 2)
  assert.deepEqual(transport.messagesOf('fs_list')[0].data.entries, [])
  ftp.destroy()
})()

// ---------------------------------------------------------------------------
// Write rejection is reported instead of hanging the state machine.
// ---------------------------------------------------------------------------
await (async () => {
  const { transport, ftp } = await makeFtp()
  transport.rejectWrites = true
  ftp.startList('/fs/microsd/log', 'req-w')
  await waitFor(() => transport.messagesOf('fs_op_error').length === 1)
  assert.equal(transport.messagesOf('fs_op_error')[0].data.code, 'write_rejected')
  assert.ok(!ftp.busy)
  ftp.destroy()
})()

// ---------------------------------------------------------------------------
// Advertised files over the product limit are rejected before temp-file IO.
// ---------------------------------------------------------------------------
await (async () => {
  const { transport, ftp, dir } = await makeFtp()
  transport.responder = (request) => {
    if (request.opcode === FTP_OPCODES.ResetSessions) {
      transport.reply(request, { opcode: FTP_OPCODES.Ack })
    } else if (request.opcode === FTP_OPCODES.OpenFileRO) {
      const size = Buffer.alloc(4)
      size.writeUInt32LE(MAX_LOG_DOWNLOAD_BYTES + 1)
      transport.reply(request, { opcode: FTP_OPCODES.Ack, session: 9, data: size })
    } else if (request.opcode === FTP_OPCODES.TerminateSession) {
      transport.reply(request, { opcode: FTP_OPCODES.Ack })
    } else {
      assert.fail(`unexpected opcode ${request.opcode}`)
    }
  }
  ftp.startDownload('/fs/microsd/log/oversized.ulg', 'oversized')
  await waitFor(() => transport.messagesOf('fs_op_error').length === 1)
  assert.equal(transport.messagesOf('fs_op_error')[0].data.code, 'download_too_large')
  assert.deepEqual(await fsp.readdir(dir), [])
  assert.equal(ftp.busy, false)
  ftp.destroy()
  await fsp.rm(dir, { recursive: true, force: true })
})()

// ---------------------------------------------------------------------------
// OCSA-009: a peer that keeps resending the same burst frame resets the quiet
// timer forever; the per-pass hard deadline / frame / no-progress budgets must
// terminate the pass and the download must fail as stalled instead of hanging.
// ---------------------------------------------------------------------------
await (async () => {
  const { transport, ftp, dir } = await makeFtp()
  const session = 5
  const noise = Buffer.alloc(200, 0x77)
  let floodSeq = 100
  let readFileRequests = 0
  transport.responder = (request) => {
    switch (request.opcode) {
      case FTP_OPCODES.ResetSessions:
        transport.reply(request, { opcode: FTP_OPCODES.Ack })
        break
      case FTP_OPCODES.OpenFileRO: {
        const size = Buffer.alloc(4)
        size.writeUInt32LE(100_000, 0)
        transport.reply(request, { opcode: FTP_OPCODES.Ack, session, data: size })
        break
      }
      case FTP_OPCODES.BurstReadFile:
        // Never answered directly - the interval below keeps the link busy.
        break
      case FTP_OPCODES.ReadFile:
        // The gap-fill fallback also only ever receives already-covered data.
        readFileRequests++
        transport.reply(request, {
          opcode: FTP_OPCODES.Ack,
          session,
          offset: 0,
          data: noise,
        })
        break
      case FTP_OPCODES.TerminateSession:
        transport.reply(request, { opcode: FTP_OPCODES.Ack })
        break
      default:
        assert.fail(`unexpected opcode ${request.opcode}`)
    }
  }
  // Endless duplicate burst traffic for offset 0: the first frame may write,
  // every later frame recovers nothing yet still resets the legacy quiet
  // timer. Without per-pass budgets this pass never returns.
  const flooder = setInterval(() => {
    floodSeq = (floodSeq + 1) & 0xffff
    ftp.handleFtpPayload(buildReply({
      seq: floodSeq,
      session,
      opcode: FTP_OPCODES.Ack,
      reqOpcode: FTP_OPCODES.BurstReadFile,
      offset: 0,
      data: noise,
    }))
  }, 1)
  ftp.startDownload('/fs/microsd/log/flood.ulg')
  await waitFor(() => transport.messagesOf('fs_op_error').length === 1, 12_000)
  clearInterval(flooder)
  const error = transport.messagesOf('fs_op_error')[0]
  assert.equal(error.data.operation, 'download')
  assert.equal(error.data.code, 'download_stalled')
  assert.ok(readFileRequests >= 1, 'the fallback strategy must have been exercised')
  await waitFor(() => !ftp.busy)
  const leftovers = (await fsp.readdir(dir)).filter((name) => name.endsWith('.part'))
  assert.deepEqual(leftovers, [], 'stalled download must not leave a partial file')
  ftp.destroy()
  await fsp.rm(dir, { recursive: true, force: true })
})()

// ---------------------------------------------------------------------------
// OCSA-009: pages consisting only of `S` (skip) records advance the wire
// offset without producing entries; the wire-record/page caps must end the
// listing with an explicit error instead of looping forever.
// ---------------------------------------------------------------------------
await (async () => {
  const { transport, ftp } = await makeFtp()
  transport.responder = (request) => {
    assert.equal(request.opcode, FTP_OPCODES.ListDirectory)
    // 50 skip records per page: never an entry, always offset progress.
    transport.reply(request, {
      opcode: FTP_OPCODES.Ack,
      data: Buffer.from('S\0'.repeat(50), 'utf8'),
    })
  }
  ftp.startList('/fs/microsd/log')
  await waitFor(() => transport.messagesOf('fs_op_error').length === 1)
  const error = transport.messagesOf('fs_op_error')[0]
  assert.equal(error.data.operation, 'list')
  assert.equal(error.data.code, 'ftp_list_overflow')
  assert.ok(!ftp.busy)
  ftp.destroy()
})()

// ---------------------------------------------------------------------------
// OCSA-014: a failed directory preparation must not be cached forever - the
// next attempt retries and can succeed. The blocking placeholder file is a
// regular file at the configured path (OCSA-008 "wrong existing type") and
// must be left untouched by the failed attempt.
// ---------------------------------------------------------------------------
await (async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'oc-ftp-dirprep-'))
  const blocked = path.join(base, 'blocked')
  await fsp.writeFile(blocked, 'placeholder')
  const transport = new FakeTransport()
  const ftp = new MavlinkFtp(transport, blocked)
  transport.ftp = ftp
  const content = Buffer.from('retry-download-payload')
  serveTinyDownload(transport, content)

  ftp.startDownload('/fs/microsd/log/retry.ulg', 'attempt-1')
  await waitFor(() => transport.messagesOf('fs_op_error').length === 1)
  const failure = transport.messagesOf('fs_op_error')[0]
  assert.equal(failure.data.operation, 'download')
  assert.equal(failure.data.code, 'ftp_internal')
  assert.equal(
    await fsp.readFile(blocked, 'utf8'),
    'placeholder',
    'a regular file occupying the download path must not be deleted',
  )
  await waitFor(() => !ftp.busy)

  await fsp.unlink(blocked)
  ftp.startDownload('/fs/microsd/log/retry.ulg', 'attempt-2')
  await waitFor(() => transport.messagesOf('fs_download_complete').length === 1)
  const complete = transport.messagesOf('fs_download_complete')[0]
  assert.equal(
    (await fsp.readFile(ftp.getDownload(complete.data.downloadId)!.filePath)).toString(),
    'retry-download-payload',
  )
  ftp.destroy()
  await fsp.rm(base, { recursive: true, force: true })
})()

// ---------------------------------------------------------------------------
// OCSA-008: without an explicit directory the service creates a private
// mkdtemp directory under os.tmpdir() with 0700 permissions.
// ---------------------------------------------------------------------------
await (async () => {
  const transport = new FakeTransport()
  const ftp = new MavlinkFtp(transport)
  transport.ftp = ftp
  serveTinyDownload(transport, Buffer.from('private-dir-check'))
  ftp.startDownload('/fs/microsd/log/private.ulg')
  await waitFor(() => transport.messagesOf('fs_download_complete').length === 1)
  const dir = ftp.activeDownloadDir
  assert.ok(dir, 'the private download directory must exist after a download')
  assert.ok(
    dir.startsWith(path.join(os.tmpdir(), FTP_DOWNLOAD_DIR_PREFIX)),
    `unexpected download directory ${dir}`,
  )
  const stats = await fsp.stat(dir)
  // The 0700 isolation guarantee is POSIX-only; Windows directories have no mode bits.
  if (process.platform !== 'win32') {
    assert.equal(stats.mode & 0o777, 0o700, 'the private directory must be 0700')
  }
  ftp.destroy()
  await fsp.rm(dir, { recursive: true, force: true })
})()

// ---------------------------------------------------------------------------
// OCSA-008: first-use cleanup only removes files matching this instance's own
// `<16 hex>.part|ulg` naming - foreign files, other instances' artifacts and
// subdirectories are never touched.
// ---------------------------------------------------------------------------
await (async () => {
  const { transport, ftp, dir } = await makeFtp()
  await fsp.writeFile(path.join(dir, '0123456789abcdef.part'), 'stale part')
  await fsp.writeFile(path.join(dir, 'ffffffffffffffff.ulg'), 'stale final')
  await fsp.writeFile(path.join(dir, 'notes.txt'), 'keep me')
  await fsp.writeFile(path.join(dir, 'other-instance.log'), 'keep me too')
  await fsp.mkdir(path.join(dir, 'subdir'))
  serveTinyDownload(transport, Buffer.from('selective-cleanup'))
  ftp.startDownload('/fs/microsd/log/cleanup.ulg')
  await waitFor(() => transport.messagesOf('fs_download_complete').length === 1)
  const remaining = (await fsp.readdir(dir)).sort()
  assert.ok(remaining.includes('notes.txt'), 'foreign files must survive cleanup')
  assert.ok(remaining.includes('other-instance.log'), 'foreign artifacts must survive cleanup')
  assert.ok(remaining.includes('subdir'), 'subdirectories must survive cleanup')
  assert.ok(!remaining.includes('0123456789abcdef.part'), 'own stale .part must be removed')
  assert.ok(!remaining.includes('ffffffffffffffff.ulg'), 'own stale .ulg must be removed')
  assert.equal(
    remaining.filter((name) => name.endsWith('.ulg')).length,
    1,
    'exactly the new download remains',
  )
  ftp.destroy()
  await fsp.rm(dir, { recursive: true, force: true })
})()

// ---------------------------------------------------------------------------
// OCSA-008: crash-leftover instance directories are reclaimed by age from the
// shared parent; live siblings, symlinks and plain files are never followed.
// ---------------------------------------------------------------------------
await (async () => {
  const parent = await fsp.mkdtemp(path.join(os.tmpdir(), 'oc-ftp-sweep-'))
  const now = Date.now()
  const ancient = path.join(parent, `${FTP_DOWNLOAD_DIR_PREFIX}ancient`)
  const fresh = path.join(parent, `${FTP_DOWNLOAD_DIR_PREFIX}fresh`)
  const linkName = path.join(parent, `${FTP_DOWNLOAD_DIR_PREFIX}link`)
  const linkTarget = path.join(parent, 'link-target')
  const plainFile = path.join(parent, `${FTP_DOWNLOAD_DIR_PREFIX}plainfile`)
  await fsp.mkdir(ancient)
  await fsp.writeFile(path.join(ancient, 'leftover.ulg'), 'crashed instance data')
  const ancientTime = new Date(now - 60 * 60 * 1000)
  await fsp.utimes(ancient, ancientTime, ancientTime)
  await fsp.mkdir(fresh)
  await fsp.mkdir(linkTarget)
  await fsp.writeFile(path.join(linkTarget, 'secret.txt'), 'do not delete')
  await fsp.symlink(linkTarget, linkName)
  await fsp.lutimes(linkName, ancientTime, ancientTime)
  await fsp.writeFile(plainFile, 'not a directory')

  const removed = await removeStaleInstanceDirs(
    parent,
    FTP_DOWNLOAD_DIR_PREFIX,
    30 * 60 * 1000,
    now,
  )
  assert.deepEqual(removed, [`${FTP_DOWNLOAD_DIR_PREFIX}ancient`])
  assert.ok((await fsp.stat(fresh)).isDirectory(), 'a young sibling instance must survive')
  const linkStats = await fsp.lstat(linkName)
  assert.ok(linkStats.isSymbolicLink(), 'a symlink at a prefixed name must not be removed')
  assert.ok(
    await fsp.readFile(path.join(linkTarget, 'secret.txt')),
    'the symlink target must not be followed or deleted',
  )
  assert.equal(await fsp.readFile(plainFile, 'utf8'), 'not a directory')

  // Once the remaining directories age past the threshold they go too.
  const removedLater = await removeStaleInstanceDirs(
    parent,
    FTP_DOWNLOAD_DIR_PREFIX,
    30 * 60 * 1000,
    now + 25 * 60 * 60 * 1000,
  )
  assert.deepEqual(removedLater.sort(), [`${FTP_DOWNLOAD_DIR_PREFIX}fresh`])
  await fsp.rm(parent, { recursive: true, force: true })
})()

// ---------------------------------------------------------------------------
// OCSA-016: recursive deletion must skip (and record) listing names that are
// not single basenames instead of joining them into device paths.
// ---------------------------------------------------------------------------
await (async () => {
  const { transport, ftp } = await makeFtp()
  const longName = 'x'.repeat(101)
  const removed: Array<{ opcode: number; path: string }> = []
  transport.responder = (request) => {
    switch (request.opcode) {
      case FTP_OPCODES.ListDirectory: {
        if (request.offset > 0) {
          transport.reply(request, { opcode: FTP_OPCODES.Nak, data: nakData(FTP_NAK_ERRORS.EOF) })
          return
        }
        const dirPath = request.data.toString('utf8')
        const page = dirPath === '/fs/microsd/log/danger'
          ? Buffer.from(
              'Fa.ulg\t1\0'
              + 'F../victim\t2\0'
              + 'Fsub/x.ulg\t3\0'
              + 'F.\0'
              + 'F..\0'
              + 'Fbad\x01name\t4\0'
              + `F${longName}\t5\0`
              + 'D../escape\0'
              + 'Dokdir\0',
              'utf8',
            )
          : Buffer.alloc(0) // okdir is empty
        transport.reply(request, { opcode: FTP_OPCODES.Ack, data: page })
        break
      }
      case FTP_OPCODES.RemoveFile:
      case FTP_OPCODES.RemoveDirectory:
        removed.push({ opcode: request.opcode, path: request.data.toString('utf8') })
        transport.reply(request, { opcode: FTP_OPCODES.Ack })
        break
      default:
        assert.fail(`unexpected opcode ${request.opcode}`)
    }
  }
  ftp.startDelete([{ path: '/fs/microsd/log/danger', kind: 'dir' }])
  await waitFor(() => transport.messagesOf('fs_delete_done').length === 1)
  assert.deepEqual(removed, [
    { opcode: FTP_OPCODES.RemoveFile, path: '/fs/microsd/log/danger/a.ulg' },
    { opcode: FTP_OPCODES.RemoveDirectory, path: '/fs/microsd/log/danger/okdir' },
    { opcode: FTP_OPCODES.RemoveDirectory, path: '/fs/microsd/log/danger' },
  ])
  for (const item of removed) {
    assert.ok(!item.path.includes('..'), 'no removal may escape the selected directory')
    // eslint-disable-next-line no-control-regex
    assert.ok(!/[\x00-\x1f\x7f]/.test(item.path), 'no control characters may reach the FC')
  }
  assert.equal(transport.messagesOf('fs_delete_done')[0].data.deleted, 3)
  assert.ok(!ftp.busy)
  ftp.destroy()
})()

// ---------------------------------------------------------------------------
// Sparse but technically progressive burst frames must not grow the interval
// tracker without bound. Unlike duplicate traffic, every frame below covers
// new bytes and therefore exercises the hard fragmentation limit.
// ---------------------------------------------------------------------------
await (async () => {
  const { transport, ftp, dir } = await makeFtp()
  const session = 9
  const chunk = Buffer.alloc(1, 0x5a)
  const advertisedSize = 300_000
  transport.responder = (request) => {
    switch (request.opcode) {
      case FTP_OPCODES.ResetSessions:
        transport.reply(request, { opcode: FTP_OPCODES.Ack })
        break
      case FTP_OPCODES.OpenFileRO: {
        const size = Buffer.alloc(4)
        size.writeUInt32LE(advertisedSize, 0)
        transport.reply(request, { opcode: FTP_OPCODES.Ack, session, data: size })
        break
      }
      case FTP_OPCODES.BurstReadFile:
        for (let index = 0; index < 1100; index++) {
          ftp.handleFtpPayload(buildReply({
            seq: (request.seq + index + 1) & 0xffff,
            session,
            opcode: FTP_OPCODES.Ack,
            reqOpcode: FTP_OPCODES.BurstReadFile,
            offset: index * 2,
            data: chunk,
          }))
        }
        break
      case FTP_OPCODES.TerminateSession:
        transport.reply(request, { opcode: FTP_OPCODES.Ack })
        break
      default:
        assert.fail(`unexpected opcode ${request.opcode}`)
    }
  }
  ftp.startDownload('/fs/microsd/log/fragmented.ulg')
  await waitFor(() => transport.messagesOf('fs_op_error').length === 1)
  assert.equal(transport.messagesOf('fs_op_error')[0].data.code, 'download_gap_overflow')
  await waitFor(() => !ftp.busy)
  ftp.destroy()
  await fsp.rm(dir, { recursive: true, force: true })
})()

console.log('MavlinkFtp protocol tests passed')
