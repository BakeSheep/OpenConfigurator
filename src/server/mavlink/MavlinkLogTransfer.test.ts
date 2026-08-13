// Protocol tests for the ArduPilot DataFlash log-transfer client: log list
// enumeration with retry, interval-tracked download with out-of-order chunks
// and gap recovery, end-of-log truncation, cancellation, erase verification
// and single-task mutual exclusion.
// Run directly: tsx src/server/mavlink/MavlinkLogTransfer.test.ts
import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  LOG_DATA_CHUNK_SIZE,
  MavlinkLogTransfer,
  type LogTransferRequest,
  type LogTransferTransport,
} from './MavlinkLogTransfer'
import { MAX_LOG_DOWNLOAD_BYTES } from './downloadLimits'
import type { ServerMessage } from '../../shared/types'

const wait = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds))

async function waitFor(predicate: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail('timed out waiting for asynchronous condition')
    await wait(5)
  }
}

// Fast timings so retry/timeout paths run quickly under test.
const TEST_TIMINGS = {
  requestTimeoutMs: 60,
  streamQuietMs: 60,
  eraseVerifyDelayMs: 10,
}

class FakeTransport implements LogTransferTransport {
  service!: MavlinkLogTransfer
  readonly requests: LogTransferRequest[] = []
  readonly messages: ServerMessage[] = []
  responder: ((request: LogTransferRequest) => void) | null = null
  rejectWrites = false

  sendLogRequest(request: LogTransferRequest): boolean {
    if (this.rejectWrites) return false
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

  entry(options: { id: number; numLogs: number; lastLogNum: number; timeUtc?: number; size?: number }): void {
    this.service.handleLogEntry({
      id: options.id,
      numLogs: options.numLogs,
      lastLogNum: options.lastLogNum,
      timeUtc: options.timeUtc ?? 0,
      size: options.size ?? 0,
    })
  }

  chunk(logId: number, ofs: number, data: Buffer): void {
    this.service.handleLogData({ id: logId, ofs, count: data.length, data })
  }

  endMarker(logId: number, ofs: number): void {
    this.service.handleLogData({ id: logId, ofs, count: 0, data: Buffer.alloc(0) })
  }

  messagesOfType<T extends ServerMessage['type']>(type: T): Array<Extract<ServerMessage, { type: T }>> {
    return this.messages.filter((message): message is Extract<ServerMessage, { type: T }> =>
      message.type === type)
  }
}

async function makeService(): Promise<{
  transport: FakeTransport
  service: MavlinkLogTransfer
  dir: string
}> {
  const transport = new FakeTransport()
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'oc-logxfer-test-'))
  const service = new MavlinkLogTransfer(transport, {
    downloadDir: dir,
    timings: TEST_TIMINGS,
  })
  transport.service = service
  return { transport, service, dir }
}

/** Serve a complete in-order log stream for the given content. */
function serveLog(
  transport: FakeTransport,
  logId: number,
  content: Buffer,
  options: { timeUtc?: number; advertisedSize?: number; dropOffsets?: Set<number> } = {},
): void {
  transport.responder = (request) => {
    if (request.kind === 'list') {
      transport.entry({
        id: logId,
        numLogs: 1,
        lastLogNum: logId,
        timeUtc: options.timeUtc ?? 0,
        size: options.advertisedSize ?? content.length,
      })
      return
    }
    if (request.kind !== 'data') return
    const end = Math.min(content.length, request.ofs + request.count)
    for (let ofs = request.ofs; ofs < end; ofs += LOG_DATA_CHUNK_SIZE) {
      if (options.dropOffsets?.has(ofs)) continue
      transport.chunk(logId, ofs, content.subarray(ofs, Math.min(end, ofs + LOG_DATA_CHUNK_SIZE)))
    }
    // Past the true end of the log the FC replies with an end-of-log marker.
    if (end < request.ofs + request.count && end >= content.length) {
      const tail = content.length % LOG_DATA_CHUNK_SIZE
      if (tail === 0) transport.endMarker(logId, content.length)
    }
  }
}

async function testListComplete(): Promise<void> {
  const { transport, service } = await makeService()
  transport.responder = (request) => {
    if (request.kind !== 'list') return
    transport.entry({ id: 1, numLogs: 3, lastLogNum: 3, timeUtc: 1_700_000_000, size: 1000 })
    transport.entry({ id: 2, numLogs: 3, lastLogNum: 3, timeUtc: 0, size: 2000 })
    transport.entry({ id: 3, numLogs: 3, lastLogNum: 3, timeUtc: 1_700_000_100, size: 3000 })
  }
  service.startList()
  await waitFor(() => transport.messagesOfType('log_list').length === 1)
  const list = transport.messagesOfType('log_list')[0]
  assert.deepEqual(list.data.entries, [
    { id: 1, timeUtcMs: 1_700_000_000_000, sizeBytes: 1000 },
    { id: 2, timeUtcMs: null, sizeBytes: 2000 },
    { id: 3, timeUtcMs: 1_700_000_100_000, sizeBytes: 3000 },
  ])
  assert.equal(transport.requests.filter((request) => request.kind === 'list').length, 1)
  assert.equal(service.busy, false)
}

async function testListEmpty(): Promise<void> {
  const { transport, service } = await makeService()
  transport.responder = (request) => {
    if (request.kind !== 'list') return
    // ArduPilot reports "no logs" with a single empty LOG_ENTRY.
    transport.entry({ id: 0, numLogs: 0, lastLogNum: 0 })
  }
  service.startList()
  await waitFor(() => transport.messagesOfType('log_list').length === 1)
  assert.deepEqual(transport.messagesOfType('log_list')[0].data.entries, [])
}

async function testListRetryMissingRange(): Promise<void> {
  const { transport, service } = await makeService()
  let attempt = 0
  const listRequests: Array<{ start: number; end: number }> = []
  transport.responder = (request) => {
    if (request.kind !== 'list') return
    listRequests.push({ start: request.start, end: request.end })
    attempt++
    if (attempt === 1) {
      // First reply drops entry 2.
      transport.entry({ id: 1, numLogs: 3, lastLogNum: 3, size: 100 })
      transport.entry({ id: 3, numLogs: 3, lastLogNum: 3, size: 300 })
      return
    }
    transport.entry({ id: 2, numLogs: 3, lastLogNum: 3, size: 200 })
  }
  service.startList()
  await waitFor(() => transport.messagesOfType('log_list').length === 1)
  const entries = transport.messagesOfType('log_list')[0].data.entries
  assert.deepEqual(entries.map((entry) => entry.id), [1, 2, 3])
  // The retry after the quiet timeout targets exactly the missing id.
  assert.deepEqual(listRequests[1], { start: 2, end: 2 })
}

async function testListTimeout(): Promise<void> {
  const { transport, service } = await makeService()
  transport.responder = null // FC never answers
  service.startList()
  await waitFor(() => transport.messagesOfType('log_op_error').length === 1)
  const error = transport.messagesOfType('log_op_error')[0]
  assert.equal(error.data.operation, 'list')
  assert.equal(error.data.code, 'log_list_timeout')
  assert.equal(error.data.retryable, true)
  assert.equal(service.busy, false)
}

async function testDownloadSequential(): Promise<void> {
  const { transport, service } = await makeService()
  const content = Buffer.alloc(90 * 3 + 17)
  for (let index = 0; index < content.length; index++) content[index] = index % 251
  serveLog(transport, 7, content, { timeUtc: 1_700_000_000 })
  service.startDownload(7)
  await waitFor(() => transport.messagesOfType('log_download_complete').length === 1)
  const complete = transport.messagesOfType('log_download_complete')[0]
  assert.equal(complete.data.logId, 7)
  assert.equal(complete.data.sizeBytes, content.length)
  assert.match(complete.data.fileName, /^LOG_0007_2023-11-14_22-13-20\.bin$/)
  const record = service.getDownload(complete.data.downloadId)
  assert.ok(record)
  assert.deepEqual(await fsp.readFile(record.filePath), content)
  // The transfer is closed with LOG_REQUEST_END.
  assert.ok(transport.requests.some((request) => request.kind === 'end'))
  assert.equal(service.busy, false)
}

async function testDownloadGapRecovery(): Promise<void> {
  const { transport, service } = await makeService()
  const content = Buffer.alloc(90 * 5)
  for (let index = 0; index < content.length; index++) content[index] = (index * 7) % 251
  // Drop the second chunk on the first pass only.
  let dropped = false
  transport.responder = (request) => {
    if (request.kind === 'list') {
      transport.entry({ id: 3, numLogs: 1, lastLogNum: 3, size: content.length })
      return
    }
    if (request.kind !== 'data') return
    const end = Math.min(content.length, request.ofs + request.count)
    for (let ofs = request.ofs; ofs < end; ofs += LOG_DATA_CHUNK_SIZE) {
      if (!dropped && ofs === 90) {
        dropped = true
        continue
      }
      transport.chunk(3, ofs, content.subarray(ofs, Math.min(end, ofs + LOG_DATA_CHUNK_SIZE)))
    }
  }
  service.startDownload(3)
  await waitFor(() => transport.messagesOfType('log_download_complete').length === 1)
  const complete = transport.messagesOfType('log_download_complete')[0]
  const record = service.getDownload(complete.data.downloadId)!
  assert.deepEqual(await fsp.readFile(record.filePath), content)
  // A gap re-request for the dropped chunk was issued.
  const dataRequests = transport.requests.filter(
    (request): request is Extract<LogTransferRequest, { kind: 'data' }> => request.kind === 'data',
  )
  assert.ok(dataRequests.some((request) => request.ofs === 90))
}

async function testDownloadOutOfOrderChunks(): Promise<void> {
  const { transport, service } = await makeService()
  const content = Buffer.alloc(90 * 2 + 30)
  for (let index = 0; index < content.length; index++) content[index] = (index * 13) % 256
  transport.responder = (request) => {
    if (request.kind === 'list') {
      transport.entry({ id: 9, numLogs: 1, lastLogNum: 9, size: content.length })
      return
    }
    if (request.kind !== 'data') return
    const end = Math.min(content.length, request.ofs + request.count)
    const offsets: number[] = []
    for (let ofs = request.ofs; ofs < end; ofs += LOG_DATA_CHUNK_SIZE) offsets.push(ofs)
    for (const ofs of offsets.reverse()) {
      transport.chunk(9, ofs, content.subarray(ofs, Math.min(end, ofs + LOG_DATA_CHUNK_SIZE)))
    }
  }
  service.startDownload(9)
  await waitFor(() => transport.messagesOfType('log_download_complete').length === 1)
  const complete = transport.messagesOfType('log_download_complete')[0]
  const record = service.getDownload(complete.data.downloadId)!
  assert.deepEqual(await fsp.readFile(record.filePath), content)
}

async function testDownloadTruncatedByEndMarker(): Promise<void> {
  const { transport, service } = await makeService()
  // The FC advertises 400 bytes but the log really ends at 200 (LOG_ENTRY
  // sizes are approximate for the newest log).
  const content = Buffer.alloc(200, 0xab)
  transport.responder = (request) => {
    if (request.kind === 'list') {
      transport.entry({ id: 5, numLogs: 1, lastLogNum: 5, size: 400 })
      return
    }
    if (request.kind !== 'data') return
    const end = Math.min(content.length, request.ofs + request.count)
    for (let ofs = request.ofs; ofs < end; ofs += LOG_DATA_CHUNK_SIZE) {
      transport.chunk(5, ofs, content.subarray(ofs, Math.min(end, ofs + LOG_DATA_CHUNK_SIZE)))
    }
    // 200 % 90 = 20 -> the final chunk is already short, marking end-of-log.
  }
  service.startDownload(5)
  await waitFor(() => transport.messagesOfType('log_download_complete').length === 1)
  const complete = transport.messagesOfType('log_download_complete')[0]
  assert.equal(complete.data.sizeBytes, 200)
  const record = service.getDownload(complete.data.downloadId)!
  assert.deepEqual(await fsp.readFile(record.filePath), content)
}

async function testDownloadStalled(): Promise<void> {
  const { transport, service } = await makeService()
  transport.responder = (request) => {
    if (request.kind === 'list') {
      transport.entry({ id: 4, numLogs: 1, lastLogNum: 4, size: 1000 })
    }
    // Never answer data requests.
  }
  service.startDownload(4)
  await waitFor(() => transport.messagesOfType('log_op_error').length === 1)
  const error = transport.messagesOfType('log_op_error')[0]
  assert.equal(error.data.operation, 'download')
  assert.equal(error.data.code, 'download_stalled')
  assert.equal(service.busy, false)
}

async function testDownloadNotFound(): Promise<void> {
  const { transport, service } = await makeService()
  transport.responder = (request) => {
    if (request.kind === 'list') {
      transport.entry({ id: 0, numLogs: 0, lastLogNum: 0 })
    }
  }
  service.startDownload(42)
  await waitFor(() => transport.messagesOfType('log_op_error').length === 1)
  assert.equal(transport.messagesOfType('log_op_error')[0].data.code, 'log_not_found')
}

async function testDownloadCancel(): Promise<void> {
  const { transport, service } = await makeService()
  const content = Buffer.alloc(90 * 100, 0x55)
  let sentChunks = 0
  transport.responder = (request) => {
    if (request.kind === 'list') {
      transport.entry({ id: 6, numLogs: 1, lastLogNum: 6, size: content.length })
      return
    }
    if (request.kind !== 'data') return
    // Serve only the first few chunks, keeping the transfer alive.
    const end = Math.min(request.ofs + request.count, request.ofs + 3 * LOG_DATA_CHUNK_SIZE)
    for (let ofs = request.ofs; ofs < end; ofs += LOG_DATA_CHUNK_SIZE) {
      sentChunks++
      transport.chunk(6, ofs, content.subarray(ofs, ofs + LOG_DATA_CHUNK_SIZE))
    }
  }
  service.startDownload(6)
  await waitFor(() => sentChunks >= 3)
  service.cancelDownload()
  await waitFor(() => transport.messagesOfType('log_op_error').length === 1)
  const error = transport.messagesOfType('log_op_error')[0]
  assert.equal(error.data.code, 'cancelled')
  // Cancellation also asks the FC to stop streaming.
  assert.ok(transport.requests.some((request) => request.kind === 'end'))
  assert.equal(service.busy, false)
}

async function testEraseVerified(): Promise<void> {
  const { transport, service } = await makeService()
  let erased = false
  transport.responder = (request) => {
    if (request.kind === 'erase') {
      erased = true
      return
    }
    if (request.kind === 'list') {
      if (erased) transport.entry({ id: 0, numLogs: 0, lastLogNum: 0 })
      else transport.entry({ id: 1, numLogs: 1, lastLogNum: 1, size: 100 })
    }
  }
  service.startErase()
  await waitFor(() => transport.messagesOfType('log_erase_done').length === 1)
  // The erase result also pushes an empty list so the UI refreshes.
  const lists = transport.messagesOfType('log_list')
  assert.deepEqual(lists[lists.length - 1].data.entries, [])
  assert.equal(service.busy, false)
}

async function testEraseWaitsForStaleListToClear(): Promise<void> {
  const { transport, service } = await makeService()
  let listPolls = 0
  transport.responder = (request) => {
    if (request.kind !== 'list') return
    listPolls++
    if (listPolls === 1) {
      // Some boards remain responsive but report the pre-erase directory
      // while the flash format is still completing.
      transport.entry({ id: 1, numLogs: 1, lastLogNum: 1, size: 100 })
      return
    }
    transport.entry({ id: 0, numLogs: 0, lastLogNum: 0 })
  }
  service.startErase()
  await waitFor(() => transport.messagesOfType('log_erase_done').length === 1)
  assert.equal(listPolls, 2)
  assert.equal(transport.messagesOfType('log_op_error').length, 0)
  assert.equal(service.busy, false)
}

async function testEraseIncomplete(): Promise<void> {
  const { transport, service } = await makeService()
  transport.responder = (request) => {
    if (request.kind === 'list') {
      transport.entry({ id: 1, numLogs: 1, lastLogNum: 1, size: 100 })
    }
  }
  service.startErase()
  await waitFor(() => transport.messagesOfType('log_op_error').length === 1)
  const error = transport.messagesOfType('log_op_error')[0]
  assert.equal(error.data.operation, 'erase')
  assert.equal(error.data.code, 'log_erase_incomplete')
}

async function testMutualExclusion(): Promise<void> {
  const { transport, service } = await makeService()
  transport.responder = null // keep the first operation running
  service.startList()
  service.startDownload(1)
  await waitFor(() => transport.messagesOfType('log_op_error').length === 1)
  const error = transport.messagesOfType('log_op_error')[0]
  assert.equal(error.data.operation, 'download')
  assert.equal(error.data.code, 'log_transfer_busy')
}

async function testInvalidLogId(): Promise<void> {
  const { transport, service } = await makeService()
  service.startDownload(-1)
  service.startDownload(1.5)
  service.startDownload(0x1_0000)
  await waitFor(() => transport.messagesOfType('log_op_error').length === 3)
  for (const error of transport.messagesOfType('log_op_error')) {
    assert.equal(error.data.code, 'invalid_log_id')
  }
  assert.equal(service.busy, false)
}

async function testWriteRejected(): Promise<void> {
  const { transport, service } = await makeService()
  transport.rejectWrites = true
  service.startList()
  await waitFor(() => transport.messagesOfType('log_op_error').length === 1)
  assert.equal(transport.messagesOfType('log_op_error')[0].data.code, 'write_rejected')
  assert.equal(service.busy, false)
}

async function testDownloadLargerThanUint16Request(): Promise<void> {
  const { transport, service } = await makeService()
  const content = Buffer.alloc(70_000)
  for (let index = 0; index < content.length; index++) content[index] = index % 251
  serveLog(transport, 8, content)
  service.startDownload(8)
  await waitFor(() => transport.messagesOfType('log_download_complete').length === 1)
  const dataRequests = transport.requests.filter((request): request is Extract<LogTransferRequest, { kind: 'data' }> => request.kind === 'data')
  assert.ok(dataRequests.length >= 2)
  assert.ok(dataRequests.every((request) => request.count > 0 && request.count <= 0xffff))
  const record = service.getDownload(transport.messagesOfType('log_download_complete')[0].data.downloadId)
  assert.ok(record)
  assert.deepEqual(await fsp.readFile(record.filePath), content)
}

async function testOversizedDownloadRejectedBeforeTempFile(): Promise<void> {
  const { transport, service, dir } = await makeService()
  transport.responder = (request) => {
    if (request.kind === 'list') {
      transport.entry({
        id: 8,
        numLogs: 1,
        lastLogNum: 8,
        size: MAX_LOG_DOWNLOAD_BYTES + 1,
      })
    }
  }
  service.startDownload(8, 'oversized')
  await waitFor(() => transport.messagesOfType('log_op_error').length === 1)
  assert.equal(transport.messagesOfType('log_op_error')[0].data.code, 'download_too_large')
  assert.deepEqual(await fsp.readdir(dir), [])
  assert.equal(service.busy, false)
  await service.destroy()
  await fsp.rm(dir, { recursive: true, force: true })
}

async function main(): Promise<void> {
  await testListComplete()
  await testListEmpty()
  await testListRetryMissingRange()
  await testListTimeout()
  await testDownloadSequential()
  await testDownloadLargerThanUint16Request()
  await testDownloadGapRecovery()
  await testDownloadOutOfOrderChunks()
  await testDownloadTruncatedByEndMarker()
  await testDownloadStalled()
  await testDownloadNotFound()
  await testDownloadCancel()
  await testEraseVerified()
  await testEraseWaitsForStaleListToClear()
  await testEraseIncomplete()
  await testMutualExclusion()
  await testInvalidLogId()
  await testWriteRejected()
  await testOversizedDownloadRejectedBeforeTempFile()
  console.log('MavlinkLogTransfer protocol tests passed')
}

await main()
