import type { NormalizedUlogBuffer } from '../types.js'

const ULOG_MAGIC = new Uint8Array([0x55, 0x4c, 0x6f, 0x67, 0x01, 0x12, 0x35])
const HEADER_SIZE = 16

// Message type bytes (from @foxglove/ulog enums)
const MSG_FLAG_BITS = 0x42 // 'B'
const MSG_FORMAT_DEF = 0x46 // 'F'
const MSG_INFO = 0x49 // 'I'
const MSG_INFO_MULTI = 0x4d // 'M'
const MSG_PARAM = 0x50 // 'P'
const MSG_PARAM_DEFAULT = 0x51 // 'Q'
const MSG_ADD_LOGGED = 0x41 // 'A'
const MSG_REMOVE_LOGGED = 0x52 // 'R'
const MSG_DATA = 0x44 // 'D'
const MSG_LOG = 0x4c // 'L'
const MSG_LOG_TAGGED = 0x43 // 'C'
const MSG_SYNC = 0x53 // 'S'
const MSG_DROPOUT = 0x4f // 'O'

// Known flag bits
const KNOWN_COMPAT_BITS = 0 // bit 0 reserved but no known compatible flags beyond 0
const KNOWN_INCOMPAT_BITS = 0x01 // bit 0 = AppendedData

/**
 * Check whether a message type byte belongs to the data section.
 */
function isDataSectionType(type: number): boolean {
  return (
    type === MSG_ADD_LOGGED ||
    type === MSG_REMOVE_LOGGED ||
    type === MSG_DATA ||
    type === MSG_LOG ||
    type === MSG_LOG_TAGGED ||
    type === MSG_SYNC ||
    type === MSG_DROPOUT
  )
}

/**
 * Read one record header at `offset` in `src`.
 * Returns null if fewer than 3 bytes remain.
 */
function readRecordHeader(
  src: Uint8Array,
  view: DataView,
  offset: number,
): { size: number; type: number; totalSize: number } | null {
  if (offset + 3 > src.byteLength) return null
  const size = view.getUint16(offset, true)
  const type = src[offset + 2]
  return { size, type, totalSize: 3 + size }
}

/**
 * Validate and normalise a ULog buffer.
 *
 * - Validates magic bytes and version.
 * - For v2 files with appended data, concatenates all valid sections into one
 *   continuous data stream and clears the appended-data flag so that downstream
 *   consumers (e.g. @foxglove/ulog) see a single log.
 * - Truncated trailing records are trimmed and a warning is emitted.
 * - Unknown incompatible flags cause an immediate error (fail-closed).
 * - Unknown compatible flags emit a warning but processing continues.
 */
export function normalizeUlogBuffer(input: ArrayBuffer): NormalizedUlogBuffer {
  const warnings: string[] = []
  const src = new Uint8Array(input)
  const view = new DataView(input)

  // ── 1. Validate magic ────────────────────────────────────────────────────
  if (src.byteLength < HEADER_SIZE) {
    throw new Error(
      `Buffer too small for ULog header: ${src.byteLength} bytes`,
    )
  }
  for (let i = 0; i < 7; i++) {
    if (src[i] !== ULOG_MAGIC[i]) {
      throw new Error('Invalid ULog magic bytes')
    }
  }

  // ── 2. Read version (byte 7) ─────────────────────────────────────────────
  const version = view.getUint8(7)
  if (version !== 1 && version !== 2) {
    throw new Error(`Unsupported ULog version: ${version}`)
  }

  // ── 3. Locate FlagBits record (v2 only) ──────────────────────────────────
  let flagBitsRecordOffset = -1
  let flagBitsPayloadOffset = -1
  let compatFlags = 0
  let incompatFlags = 0
  let appendedOffsets: bigint[] = [0n, 0n, 0n]

  if (version === 2) {
    let pos = HEADER_SIZE
    while (pos + 3 <= src.byteLength) {
      const rec = readRecordHeader(src, view, pos)
      if (!rec) break
      if (rec.type === MSG_FLAG_BITS) {
        flagBitsRecordOffset = pos
        flagBitsPayloadOffset = pos + 3
        if (rec.size < 40) {
          throw new Error(
            `Invalid FlagBits record: expected >= 40 bytes, got ${rec.size}`,
          )
        }
        // Compatible flags: 8 bytes (only first byte used)
        compatFlags = src[flagBitsPayloadOffset]
        // Incompatible flags: 8 bytes (only first byte used)
        incompatFlags = src[flagBitsPayloadOffset + 8]

        // Check unknown incompatible flags (fail closed)
        const unknownIncompat = incompatFlags & ~KNOWN_INCOMPAT_BITS
        if (unknownIncompat !== 0) {
          throw new Error(
            `Unknown incompatible flag bits set: 0x${unknownIncompat.toString(16)}`,
          )
        }

        // Check unknown compatible flags (warn)
        const unknownCompat = compatFlags & ~KNOWN_COMPAT_BITS
        if (unknownCompat !== 0) {
          warnings.push(
            `检测到未知的兼容标志位：0x${unknownCompat.toString(16)}`,
          )
        }

        // Read 3 appended offsets (uint64 LE each)
        const offBase = flagBitsPayloadOffset + 16
        appendedOffsets = [
          view.getBigUint64(offBase, true),
          view.getBigUint64(offBase + 8, true),
          view.getBigUint64(offBase + 16, true),
        ]
        break
      }
      if (isDataSectionType(rec.type)) {
        // Reached data section without finding FlagBits
        throw new Error('v2 file missing FlagBits record in definitions section')
      }
      pos += rec.totalSize
    }
    if (flagBitsRecordOffset === -1) {
      throw new Error('v2 file missing FlagBits record in definitions section')
    }
  }

  // ── 4. Determine data-section start ──────────────────────────────────────
  let dataSectionStart = HEADER_SIZE
  {
    let pos = HEADER_SIZE
    while (pos + 3 <= src.byteLength) {
      const rec = readRecordHeader(src, view, pos)
      if (!rec) break
      if (isDataSectionType(rec.type)) {
        dataSectionStart = pos
        break
      }
      pos += rec.totalSize
    }
  }

  // ── 5. Validate appended offsets ─────────────────────────────────────────
  const hasAppendedData = (incompatFlags & 0x01) !== 0

  if (hasAppendedData) {
    const firstOff = Number(appendedOffsets[0])
    if (firstOff <= 0 || firstOff > src.byteLength) {
      throw new Error(
        `Invalid appended data offset: ${firstOff} (file size: ${src.byteLength})`,
      )
    }
    // Validate remaining non-zero offsets are in order and within bounds
    for (let i = 1; i < 3; i++) {
      const off = appendedOffsets[i]
      if (off === 0n) break
      const prevOff = appendedOffsets[i - 1]
      if (prevOff === 0n || off <= prevOff) {
        throw new Error(
          `Invalid appended offset order: offset[${i}]=${off} <= offset[${i - 1}]=${prevOff}`,
        )
      }
      if (Number(off) > src.byteLength) {
        throw new Error(
          `Invalid appended data offset: ${off} exceeds file size ${src.byteLength}`,
        )
      }
    }
  }

  // ── 6. Scan sections and collect valid record ranges ─────────────────────
  interface RecordRange {
    start: number
    end: number
  }

  let repairedTruncatedTail = false

  function scanSection(
    start: number,
    end: number,
  ): RecordRange[] {
    const ranges: RecordRange[] = []
    let pos = start
    while (pos + 3 <= end) {
      const rec = readRecordHeader(src, view, pos)
      if (!rec) break
      if (pos + rec.totalSize > end) {
        repairedTruncatedTail = true
        warnings.push(
          `偏移 ${pos} 处的记录不完整：需要 ${rec.totalSize} 字节，但仅剩 ${end - pos} 字节`,
        )
        break
      }
      ranges.push({ start: pos, end: pos + rec.totalSize })
      pos += rec.totalSize
    }
    // Check for trailing bytes that can't form a complete record header
    if (pos < end && pos + 3 > end) {
      repairedTruncatedTail = true
      warnings.push(
        `偏移 ${pos} 处的记录头不完整：仅剩 ${end - pos} 字节`,
      )
    }
    return ranges
  }

  // Build section boundaries
  const sectionBounds: Array<{ start: number; end: number }> = []
  if (hasAppendedData) {
    const offsets = appendedOffsets.map((o) => Number(o))
    // Base section: dataSectionStart → firstOffset
    sectionBounds.push({ start: dataSectionStart, end: offsets[0] })
    // Appended sections: each non-zero offset starts a new section.
    // A section ends at the next non-zero offset or at file end.
    for (let i = 1; i < 3; i++) {
      if (offsets[i - 1] === 0) break
      const end = (i + 1 < 3 && offsets[i] > 0) ? offsets[i] : src.byteLength
      sectionBounds.push({ start: offsets[i - 1], end })
      if (offsets[i] === 0) break
    }
  } else {
    sectionBounds.push({ start: dataSectionStart, end: src.byteLength })
  }

  // Scan all sections
  const allRecordRanges: RecordRange[] = []
  for (const bounds of sectionBounds) {
    const ranges = scanSection(bounds.start, bounds.end)
    allRecordRanges.push(...ranges)
  }

  // ── 7. Build normalised buffer ───────────────────────────────────────────
  // Header part: everything from byte 0 to dataSectionStart (includes definitions)
  const headerPart = new Uint8Array(input, 0, dataSectionStart)

  // Data part: concatenate all valid record bytes
  let dataByteLen = 0
  for (const r of allRecordRanges) {
    dataByteLen += r.end - r.start
  }
  const dataPart = new Uint8Array(dataByteLen)
  let writeOff = 0
  for (const r of allRecordRanges) {
    const len = r.end - r.start
    dataPart.set(new Uint8Array(input, r.start, len), writeOff)
    writeOff += len
  }

  const result = new Uint8Array(headerPart.byteLength + dataPart.byteLength)
  result.set(headerPart, 0)
  result.set(dataPart, headerPart.byteLength)

  // ── 8. Patch FlagBits in the result ──────────────────────────────────────
  if (version === 2 && flagBitsPayloadOffset >= 0) {
    const resultView = new DataView(result.buffer)
    const fbPayload = flagBitsPayloadOffset
    // Clear incompatible flags (clear AppendedData bit)
    result[fbPayload + 8] = 0
    // Zero all three appended offsets
    const offBase = fbPayload + 16
    resultView.setBigUint64(offBase, 0n, true)
    resultView.setBigUint64(offBase + 8, 0n, true)
    resultView.setBigUint64(offBase + 16, 0n, true)
  }

  // Count actual appended sections (each non-zero offset = one section start)
  let appendedSectionCount = 0
  if (hasAppendedData) {
    for (let i = 0; i < 3; i++) {
      if (appendedOffsets[i] > 0n) appendedSectionCount++
      else break
    }
  }

  return {
    buffer: result.buffer,
    version,
    hadAppendedData: hasAppendedData,
    appendedSectionCount,
    repairedTruncatedTail,
    warnings,
  }
}
