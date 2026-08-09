import assert from 'node:assert/strict'
import test from 'node:test'
import { BlobReader, TextWriter, ZipReader } from '@zip.js/zip.js'
import { stringifyStructuredJson } from '../../shared/logs'
import { BlobLogSource } from '../../shared/logs'
import {
  createStructuredFlightLogPackage,
  structuredLogBaseName,
  structuredLogFileName,
} from './structuredLogExport'
import {
  MAX_BLOB_EXPORT_SOURCE_BYTES,
  canUseBlobExportFallback,
} from './structuredLogExportClient'
import type { UlogAnalysisDataset } from './ulogAnalysis'

function writeFixedString(buffer: Buffer, offset: number, value: string, length: number): void {
  buffer.fill(0, offset, offset + length)
  buffer.write(value, offset, Math.min(length, Buffer.byteLength(value)), 'utf8')
}

function dataflashFixture(): Blob {
  const format = Buffer.alloc(89)
  Buffer.from([0xa3, 0x95, 0x80, 0x81, 12]).copy(format)
  writeFixedString(format, 5, 'TEST', 4)
  writeFixedString(format, 9, 'QB', 16)
  writeFixedString(format, 25, 'TimeUS,Value', 64)
  const record = Buffer.alloc(12)
  Buffer.from([0xa3, 0x95, 0x81]).copy(record)
  record.writeBigUInt64LE(1_250_000n, 3)
  record[11] = 7
  return new Blob([Uint8Array.from(Buffer.concat([format, record]))])
}

const EMPTY_DATASET: UlogAnalysisDataset = {
  overview: {
    durationSec: 1.25,
    startTimeUtcMs: null,
    startTimeSource: null,
    firmware: 'ArduCopter V4',
    firmwareBranch: null,
    hardware: null,
    sysName: null,
    totalArmedSec: 0,
    droppedMessages: 0,
  },
  modeSegments: [], armedSegments: [], events: [], attitude: [], rates: [], pidLoops: [],
  actuators: [], actuatorSaturation: null, battery: [], gpsQuality: [], altitude: [],
  velocity: [], vibration: null, rawAcc: [], params: [], track: null,
}

async function readZip(blob: Blob): Promise<Map<string, string>> {
  const reader = new ZipReader(new BlobReader(blob))
  try {
    const entries = await reader.getEntries()
    const output = new Map<string, string>()
    for (const entry of entries) {
      if (!('getData' in entry)) continue
      output.set(entry.filename, await entry.getData(new TextWriter()))
    }
    return output
  } finally {
    await reader.close()
  }
}

test('structured export contains the versioned contract and valid JSONL', async () => {
  const sourceBlob = dataflashFixture()
  const progress = new Map<string, number>()
  const result = await createStructuredFlightLogPackage({
    source: new BlobLogSource('../unsafe.bin', sourceBlob),
    format: 'dataflash',
    summary: EMPTY_DATASET,
    vehicleIdentity: null,
    options: { includeSource: false, privacyMode: 'full' },
    onProgress: (value) => {
      assert.ok(value.processedBytes >= (progress.get(value.phase) ?? 0))
      progress.set(value.phase, value.processedBytes)
    },
  })
  assert.ok(result.blob)
  const files = await readZip(result.blob)
  const required = [
    'manifest.json', 'schemas.json', 'summary.json', 'parameters.json',
    'events.jsonl', 'messages.jsonl', 'README.md',
  ]
  assert.deepEqual([...required].sort(), [...files.keys()].sort())
  const manifest = JSON.parse(files.get('manifest.json')!)
  assert.equal(manifest.schemaVersion, 'openconfigurator.flight-log/v1')
  assert.deepEqual(manifest.entries, required)
  assert.equal(manifest.source.included, false)
  assert.match(manifest.source.sha256, /^[a-f0-9]{64}$/)
  assert.deepEqual(manifest.time.boots, [{ bootId: 0, firstTimeUs: '1250000', lastTimeUs: '1250000' }])
  assert.equal(manifest.time.startTimeUtc, null)
  assert.equal(manifest.privacy.contains.parameters, false)
  for (const line of files.get('messages.jsonl')!.trim().split('\n')) JSON.parse(line)
  const record = JSON.parse(files.get('messages.jsonl')!.trim())
  assert.equal(record.streamId, 'ardupilot:TEST:129')
  assert.equal(record.timeUs, '1250000')
})

test('structured JSON preserves special numbers, integers and binary values', () => {
  const value = JSON.parse(stringifyStructuredJson({
    integer: 18_446_744_073_709_551_615n,
    nan: Number.NaN,
    positiveInfinity: Number.POSITIVE_INFINITY,
    bytes: new Uint8Array([0, 1, 255]),
  }))
  assert.equal(value.integer, '18446744073709551615')
  assert.deepEqual(value.nan, { $number: 'NaN' })
  assert.deepEqual(value.positiveInfinity, { $number: '+Infinity' })
  assert.deepEqual(value.bytes, { $binary: 'AAH/', encoding: 'base64' })
})

test('export filename and Blob fallback are bounded', () => {
  assert.equal(structuredLogBaseName(' log100 (5).ulg '), 'log100 (5)')
  assert.equal(structuredLogFileName('../bad:name.ulg'), '__bad_name.zip')
  assert.equal(structuredLogFileName('renamed.zip'), 'renamed.zip')
  assert.equal(structuredLogFileName('legacy.flightlog.zip'), 'legacy.zip')
  assert.equal(canUseBlobExportFallback(MAX_BLOB_EXPORT_SOURCE_BYTES), true)
  assert.equal(canUseBlobExportFallback(MAX_BLOB_EXPORT_SOURCE_BYTES + 1), false)
})

test('an already-cancelled export never produces a completed package', async () => {
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(() => createStructuredFlightLogPackage({
    source: new BlobLogSource('cancel.bin', dataflashFixture()),
    format: 'dataflash',
    summary: EMPTY_DATASET,
    vehicleIdentity: null,
    options: { includeSource: false, privacyMode: 'full' },
    signal: controller.signal,
  }), { name: 'AbortError' })
})

test('ZIP output honors WritableStream backpressure and can include the original', async () => {
  const sourceBlob = dataflashFixture()
  const chunks: Array<Uint8Array<ArrayBuffer>> = []
  let activeWrites = 0
  let maxActiveWrites = 0
  const output = new WritableStream<Uint8Array>({
    async write(chunk) {
      activeWrites++
      maxActiveWrites = Math.max(maxActiveWrites, activeWrites)
      await Promise.resolve()
      chunks.push(Uint8Array.from(chunk))
      activeWrites--
    },
  })
  const result = await createStructuredFlightLogPackage({
    source: new BlobLogSource('source.bin', sourceBlob),
    format: 'dataflash',
    summary: EMPTY_DATASET,
    vehicleIdentity: null,
    options: { includeSource: true, privacyMode: 'full' },
    output,
  })
  assert.equal(result.blob, null)
  assert.equal(maxActiveWrites, 1)
  const files = await readZip(new Blob(chunks))
  assert.ok(files.has('source/original.bin'))
  assert.equal(JSON.parse(files.get('manifest.json')!).source.included, true)
})

test('a failed streaming write can be retried with a fresh writer', async () => {
  const sourceBlob = dataflashFixture()
  await assert.rejects(() => createStructuredFlightLogPackage({
    source: new BlobLogSource('retry.bin', sourceBlob),
    format: 'dataflash',
    summary: EMPTY_DATASET,
    vehicleIdentity: null,
    options: { includeSource: false, privacyMode: 'full' },
    output: new WritableStream<Uint8Array>({ write() { throw new Error('disk full') } }),
  }), /disk full/)
  const retry = await createStructuredFlightLogPackage({
    source: new BlobLogSource('retry.bin', sourceBlob),
    format: 'dataflash',
    summary: EMPTY_DATASET,
    vehicleIdentity: null,
    options: { includeSource: false, privacyMode: 'full' },
  })
  assert.ok(retry.blob)
})
