// Protocol tests for the MAVLink FTP client: payload codec, directory listing
// pagination, burst download with loss recovery, cancellation, deletion order
// and single-task mutual exclusion. Run directly: tsx src/server/mavlink/MavlinkFtp.test.ts
import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { FTP_NAK_ERRORS, FTP_OPCODES } from '../../shared/constants'
import { crc32Buffer, MavlinkFtp, subtractInterval, type FtpTransport } from './MavlinkFtp'
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

console.log('MavlinkFtp protocol tests passed')
