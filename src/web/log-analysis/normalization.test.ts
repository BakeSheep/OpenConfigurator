import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeUlogBuffer } from './parser/normalizeUlogBuffer.js'
import { UlogFixtureBuilder } from './testing/ulogFixtureBuilder.js'

// ─── Helpers ────────────────────────────────────────────────────────────────

const ULOG_MAGIC = new Uint8Array([0x55, 0x4c, 0x6f, 0x67, 0x01, 0x12, 0x35])
const HEADER_SIZE = 16

/** Encode a single ULog record: uint16 size + uint8 type + payload */
function encodeRecord(type: number, payload: Uint8Array): Uint8Array {
  const result = new Uint8Array(3 + payload.byteLength)
  const view = new DataView(result.buffer)
  view.setUint16(0, payload.byteLength, true)
  result[2] = type
  result.set(payload, 3)
  return result
}

/** Build a minimal v1 header (16 bytes) */
function buildHeader(version: number, timestampUs = 0n): Uint8Array {
  const header = new Uint8Array(16)
  header.set(ULOG_MAGIC)
  const view = new DataView(header.buffer)
  view.setUint8(7, version)
  view.setBigUint64(8, timestampUs, true)
  return header
}

/** Build a FlagBits record payload (40 bytes) */
function buildFlagBitsPayload(
  compatFlags: number,
  incompatFlags: number,
  offsets: [bigint, bigint, bigint],
): Uint8Array {
  const payload = new Uint8Array(40)
  payload[0] = compatFlags
  payload[8] = incompatFlags
  const view = new DataView(payload.buffer)
  view.setBigUint64(16, offsets[0], true)
  view.setBigUint64(24, offsets[1], true)
  view.setBigUint64(32, offsets[2], true)
  return payload
}

/** Build a minimal v2 file with definitions + data records.
 *  Definitions section: FlagBits + FormatDef (+ extraDefs).
 *  Data section 1: subscription + dataRecords1.
 *  Data section 2: subscription + dataRecords2.
 *  This mirrors real ULog appended data where each section has its own subscriptions.
 */
function buildV2Buffer(opts: {
  compatFlags?: number
  incompatFlags?: number
  offsets?: [bigint, bigint, bigint]
  extraDefs?: Uint8Array[]
  dataRecords1?: Uint8Array[]
  dataRecords2?: Uint8Array[]
  truncateLastRecord?: boolean
}): ArrayBuffer {
  const compatFlags = opts.compatFlags ?? 0
  const incompatFlags = opts.incompatFlags ?? 0
  const offsets = opts.offsets ?? [0n, 0n, 0n]

  const header = buildHeader(2)
  const flagBitsRec = encodeRecord(0x42, buildFlagBitsPayload(compatFlags, incompatFlags, offsets))

  // A minimal format definition
  const formatPayload = new TextEncoder().encode('sensor_combined:uint64_t timestamp;float value')
  const formatRec = encodeRecord(0x46, formatPayload)

  // Definitions section: FlagBits + FormatDef (+ extraDefs)
  const defRecords = [flagBitsRec, formatRec, ...(opts.extraDefs ?? [])]

  // Subscription record (AddLogged) — prepended to each data section
  const subPayload = new Uint8Array(3 + new TextEncoder().encode('sensor_combined').byteLength)
  subPayload[0] = 0 // multiId
  new DataView(subPayload.buffer).setUint16(1, 100, true)
  subPayload.set(new TextEncoder().encode('sensor_combined'), 3)
  const subRec = encodeRecord(0x41, subPayload)

  // Data records for each section (each section gets its own subscription)
  const data1 = [subRec, ...(opts.dataRecords1 ?? [])]
  const data2 = opts.dataRecords2 ? [subRec, ...opts.dataRecords2] : []

  // Calculate sizes
  const defSize = defRecords.reduce((s, r) => s + r.byteLength, 0)
  const data1Size = data1.reduce((s, r) => s + r.byteLength, 0)
  const data2Size = data2.reduce((s, r) => s + r.byteLength, 0)

  const totalSize = HEADER_SIZE + defSize + data1Size + data2Size
  const result = new Uint8Array(opts.truncateLastRecord ? totalSize - 2 : totalSize)

  let offset = 0
  result.set(header, offset); offset += header.byteLength
  for (const rec of defRecords) {
    result.set(rec, offset); offset += rec.byteLength
  }
  for (const rec of data1) {
    result.set(rec, offset); offset += rec.byteLength
  }
  for (const rec of data2) {
    result.set(rec, offset); offset += rec.byteLength
  }

  return result.buffer
}

/** Create a simple Data record for msgId=100 with a timestamp */
function buildDataRecord(msgId: number, timestampUs: bigint, value: number): Uint8Array {
  const data = new Uint8Array(12) // 2 (msgId) + 8 (timestamp) + 4 (float value) - but msgId is in payload header
  const payload = new Uint8Array(2 + 8 + 4) // msgId + timestamp + value
  const view = new DataView(payload.buffer)
  view.setUint16(0, msgId, true)
  view.setBigUint64(2, timestampUs, true)
  view.setFloat32(10, value, true)
  return encodeRecord(0x44, payload)
}

/** Simple in-memory filelike for @foxglove/ulog */
class ArrayFileReader {
  private data: Uint8Array
  constructor(buffer: ArrayBuffer) {
    this.data = new Uint8Array(buffer)
  }
  async open() {
    return this.data.byteLength
  }
  size() {
    return this.data.byteLength
  }
  async read(offset: number, length: number): Promise<Uint8Array> {
    return this.data.slice(offset, offset + length)
  }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('normalizeUlogBuffer', () => {
  it('throws on wrong magic bytes', () => {
    const buf = new ArrayBuffer(16)
    const src = new Uint8Array(buf)
    src.set([0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]) // wrong magic
    src[7] = 1 // version
    assert.throws(() => normalizeUlogBuffer(buf), /Invalid ULog magic bytes/)
  })

  it('throws on buffer too small for header', () => {
    const buf = new ArrayBuffer(10)
    assert.throws(() => normalizeUlogBuffer(buf), /Buffer too small/)
  })

  it('throws on unsupported version', () => {
    const header = buildHeader(99)
    assert.throws(() => normalizeUlogBuffer(header.buffer as ArrayBuffer), /Unsupported ULog version: 99/)
  })

  it('passes a normal v1 file unchanged (with possible trailing truncation repair)', () => {
    const buf = new UlogFixtureBuilder()
      .addFormat(100, 'sensor_combined', [
        { type: 'uint64_t', fieldName: 'timestamp' },
        { type: 'float', fieldName: 'value' },
      ])
      .addSubscription(100, 0)
      .addData(100, 1000n, { timestamp: 1000, value: 3.14 })
      .build()

    const result = normalizeUlogBuffer(buf)
    assert.equal(result.version, 1)
    assert.equal(result.hadAppendedData, false)
    assert.equal(result.appendedSectionCount, 0)
    assert.equal(result.repairedTruncatedTail, false)
    assert.equal(result.warnings.length, 0)
    // The normalised buffer should have the same content as the input
    assert.equal(result.buffer.byteLength, buf.byteLength)
    assert.deepEqual(new Uint8Array(result.buffer), new Uint8Array(buf))
  })

  it('passes a normal v2 file (no appended data) unchanged', () => {
    const dataRec = buildDataRecord(100, 1000n, 1.5)
    const buf = buildV2Buffer({
      incompatFlags: 0,
      dataRecords1: [dataRec],
    })

    const result = normalizeUlogBuffer(buf)
    assert.equal(result.version, 2)
    assert.equal(result.hadAppendedData, false)
    assert.equal(result.appendedSectionCount, 0)
    assert.equal(result.repairedTruncatedTail, false)
    assert.equal(result.warnings.length, 0)
    assert.equal(result.buffer.byteLength, buf.byteLength)
  })

  it('normalises a v2 file with one appended section', () => {
    const data1 = buildDataRecord(100, 1000n, 1.0)
    const data2 = buildDataRecord(100, 2000n, 2.0)

    // Probe to find data section start and subscription record size
    const probeBuf = buildV2Buffer({
      incompatFlags: 0,
      dataRecords1: [data1],
    })
    const probeView = new DataView(probeBuf)
    const probeArr = new Uint8Array(probeBuf)
    let dataSectionStart = HEADER_SIZE
    {
      let pos = HEADER_SIZE
      while (pos + 3 <= probeBuf.byteLength) {
        const size = probeView.getUint16(pos, true)
        const type = probeArr[pos + 2]
        if (type === 0x41 || type === 0x52 || type === 0x44 || type === 0x4c ||
            type === 0x43 || type === 0x53 || type === 0x4f) {
          dataSectionStart = pos
          break
        }
        pos += 3 + size
      }
    }
    // buildV2Buffer puts [subRec, ...dataRecords] in section 1.
    // So section 1 size = subRec + data1 = probeBuf size - header - defs.
    // subRec size = probeBuf size - header - defs - data1 size.
    // We can derive it: probeBuf = header + defs + subRec + data1
    // So subRec = probeBuf - dataSectionStart - data1
    const subRecSize = probeBuf.byteLength - dataSectionStart - data1.byteLength

    // Section 1 layout: [subRec, data1]
    // Section 2 layout: [subRec, data2] (buildV2Buffer prepends subRec to each section)
    // offsets[0] = start of first appended section = end of base section
    // offsets[1] = 0 (no second appended section, file end is used)
    const section1End = dataSectionStart + subRecSize + data1.byteLength

    const buf = buildV2Buffer({
      incompatFlags: 0x01,
      offsets: [BigInt(section1End), 0n, 0n],
      dataRecords1: [data1],
      dataRecords2: [data2],
    })

    const result = normalizeUlogBuffer(buf)
    assert.equal(result.version, 2)
    assert.equal(result.hadAppendedData, true)
    assert.equal(result.appendedSectionCount, 1)
    assert.equal(result.repairedTruncatedTail, false)
    assert.equal(result.warnings.length, 0)

    // Verify the FlagBits in the result has been cleared
    const resultView = new DataView(result.buffer)
    const resultArr = new Uint8Array(result.buffer)
    const fbPayloadOffset = HEADER_SIZE + 3 // after record header
    assert.equal(resultArr[fbPayloadOffset + 8], 0, 'incompatible flags should be cleared')
    assert.equal(resultView.getBigUint64(fbPayloadOffset + 16, true), 0n, 'offset[0] should be zeroed')
    assert.equal(resultView.getBigUint64(fbPayloadOffset + 24, true), 0n, 'offset[1] should be zeroed')
    assert.equal(resultView.getBigUint64(fbPayloadOffset + 32, true), 0n, 'offset[2] should be zeroed')

    // Verify both data records are present in the normalised buffer
    let pos = dataSectionStart
    const dataMsgIds: number[] = []
    const dataTimestamps: bigint[] = []
    while (pos + 3 <= result.buffer.byteLength) {
      const size = resultView.getUint16(pos, true)
      const type = resultArr[pos + 2]
      if (type === 0x44) {
        const msgId = resultView.getUint16(pos + 3, true)
        const ts = resultView.getBigUint64(pos + 5, true)
        dataMsgIds.push(msgId)
        dataTimestamps.push(ts)
      }
      pos += 3 + size
    }
    assert.deepEqual(dataMsgIds, [100, 100], 'both data records should be present')
    assert.deepEqual(dataTimestamps, [1000n, 2000n], 'timestamps from both sections')
  })

  it('warns and repairs on truncated trailing record', () => {
    // Build a valid v1 buffer, then truncate the last 2 bytes
    const builder = new UlogFixtureBuilder()
      .addFormat(100, 'sensor_combined', [
        { type: 'uint64_t', fieldName: 'timestamp' },
        { type: 'float', fieldName: 'value' },
      ])
      .addSubscription(100, 0)
      .addData(100, 1000n, { timestamp: 1000, value: 1.0 })

    const fullBuf = builder.build()
    // Truncate last 2 bytes (partial record header)
    const truncated = fullBuf.slice(0, fullBuf.byteLength - 2)

    const result = normalizeUlogBuffer(truncated)
    assert.equal(result.repairedTruncatedTail, true)
    assert.ok(result.warnings.length > 0, 'should have truncation warning')
    assert.ok(result.warnings[0].includes('不完整'), 'warning should mention truncation')
  })

  it('throws on invalid appended offsets (beyond file end)', () => {
    const dataRec = buildDataRecord(100, 1000n, 1.0)
    const buf = buildV2Buffer({
      incompatFlags: 0x01,
      offsets: [99999n, 0n, 0n], // offset way beyond file
      dataRecords1: [dataRec],
    })

    assert.throws(() => normalizeUlogBuffer(buf), /Invalid appended data offset/)
  })

  it('throws on invalid appended offset order', () => {
    const dataRec = buildDataRecord(100, 1000n, 1.0)
    // Build a buffer large enough to hold both offsets
    const buf = buildV2Buffer({
      incompatFlags: 0x01,
      offsets: [100n, 50n, 0n], // second offset < first, both within a reasonable file size
      dataRecords1: [dataRec],
    })

    assert.throws(() => normalizeUlogBuffer(buf), /Invalid appended offset order/)
  })

  it('tolerates unknown compatible flag bits with a warning', () => {
    const dataRec = buildDataRecord(100, 1000n, 1.0)
    const buf = buildV2Buffer({
      compatFlags: 0x04, // unknown compatible bit
      incompatFlags: 0,
      dataRecords1: [dataRec],
    })

    const result = normalizeUlogBuffer(buf)
    assert.equal(result.version, 2)
    assert.ok(result.warnings.length > 0, 'should have a warning')
    assert.ok(
      result.warnings[0].includes('未知的兼容标志位'),
      'warning should mention unknown compatible flag',
    )
  })

  it('fails closed on unknown incompatible flag bits', () => {
    const dataRec = buildDataRecord(100, 1000n, 1.0)
    const buf = buildV2Buffer({
      incompatFlags: 0x02, // unknown incompatible bit (bit 1)
      dataRecords1: [dataRec],
    })

    assert.throws(() => normalizeUlogBuffer(buf), /Unknown incompatible flag/)
  })

  it('throws on v2 file missing FlagBits record', () => {
    // Build a v2 header but skip the FlagBits record, going straight to data
    const header = buildHeader(2)
    const dataRec = buildDataRecord(100, 1000n, 1.0)
    const buf = new Uint8Array(HEADER_SIZE + dataRec.byteLength)
    buf.set(header, 0)
    buf.set(dataRec, HEADER_SIZE)

    assert.throws(() => normalizeUlogBuffer(buf.buffer as ArrayBuffer), /missing FlagBits/)
  })
})

describe('normalizeUlogBuffer + @foxglove/ulog integration', () => {
  it('normalised v2 appended data is readable by @foxglove/ulog', async () => {
    const { ULog } = await import('@foxglove/ulog')

    const data1 = buildDataRecord(100, 1000n, 1.0)
    const data2 = buildDataRecord(100, 5000n, 5.0)

    // Probe to find data section start using a buffer without appended data
    const probeBuf = buildV2Buffer({ incompatFlags: 0, dataRecords1: [data1] })
    const probeView = new DataView(probeBuf)
    const probeArr = new Uint8Array(probeBuf)
    let dataSectionStart = HEADER_SIZE
    {
      let pos = HEADER_SIZE
      while (pos + 3 <= probeBuf.byteLength) {
        const size = probeView.getUint16(pos, true)
        const type = probeArr[pos + 2]
        if (type === 0x41 || type === 0x52 || type === 0x44 || type === 0x4c ||
            type === 0x43 || type === 0x53 || type === 0x4f) {
          dataSectionStart = pos
          break
        }
        pos += 3 + size
      }
    }

    // section1End = probeBuf size (header + defs + subRec + data1)
    const section1End = probeBuf.byteLength

    const rawBuf = buildV2Buffer({
      incompatFlags: 0x01,
      offsets: [BigInt(section1End), 0n, 0n],
      dataRecords1: [data1],
      dataRecords2: [data2],
    })

    const normalised = normalizeUlogBuffer(rawBuf)

    // Open with @foxglove/ulog
    const reader = new ArrayFileReader(normalised.buffer)
    const ulog = new ULog(reader as any)
    await ulog.open()

    const messages: any[] = []
    for await (const msg of ulog.readMessages()) {
      messages.push(msg)
    }

    const dataMessages = messages.filter((m: any) => m.type === 68) // MessageType.Data = 68
    assert.ok(dataMessages.length >= 2, `expected >= 2 data messages, got ${dataMessages.length}`)
  })
})
