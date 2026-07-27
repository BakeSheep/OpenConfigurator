/**
 * Deterministic ULog v2 binary fixture builder for tests.
 * Generates tiny valid ULog buffers without network or filesystem access.
 */

const ULOG_MAGIC = [0x55, 0x4c, 0x6f, 0x67, 0x01, 0x12, 0x35]

const BASIC_SIZES: Record<string, number> = {
  int8_t: 1,
  uint8_t: 1,
  int16_t: 2,
  uint16_t: 2,
  int32_t: 4,
  uint32_t: 4,
  int64_t: 8,
  uint64_t: 8,
  float: 4,
  double: 8,
  bool: 1,
  char: 1,
}

interface FieldDef {
  type: string
  fieldName: string
  arrayLength: number | null
  baseType: string
}

export class UlogFixtureBuilder {
  private records: Uint8Array[] = []
  private version = 1
  private timestampUs = 0n
  private formatFields = new Map<number, FieldDef[]>()
  private formatNames = new Map<number, string>()

  setVersion(v: number): this {
    this.version = v
    return this
  }

  setTimestamp(us: bigint): this {
    this.timestampUs = us
    return this
  }

  addFormat(msgId: number, name: string, fields: Array<{ type: string; fieldName: string }>): this {
    this.formatNames.set(msgId, name)

    const parsedFields: FieldDef[] = fields.map((f) => {
      const match = /([^[]+)\[(\d+)\]/.exec(f.type)
      if (match) {
        return {
          type: f.type,
          fieldName: f.fieldName,
          baseType: match[1]!,
          arrayLength: parseInt(match[2]!),
        }
      }
      return {
        type: f.type,
        fieldName: f.fieldName,
        baseType: f.type,
        arrayLength: null,
      }
    })
    this.formatFields.set(msgId, parsedFields)

    const formatParts = fields.map((f) => `${f.type} ${f.fieldName}`)
    const formatStr = `${name}:${formatParts.join(';')}`
    const payload = new TextEncoder().encode(formatStr)
    this.records.push(encodeRecord('F', payload))
    return this
  }

  addInformation(key: string, value: string | number): this {
    // ULog Information keys must be field definitions: "type name"
    const effectiveKey = typeof value === 'string'
      ? `char[${value.length + 1}] ${key}`
      : `int32_t ${key}`
    const keyBytes = new TextEncoder().encode(effectiveKey)
    let valueBytes: Uint8Array
    if (typeof value === 'string') {
      const strBytes = new TextEncoder().encode(value)
      valueBytes = new Uint8Array(strBytes.byteLength + 1)
      valueBytes.set(strBytes)
      valueBytes[strBytes.byteLength] = 0
    } else {
      valueBytes = new Uint8Array(4)
      new DataView(valueBytes.buffer).setInt32(0, value, true)
    }
    const payload = new Uint8Array(1 + keyBytes.byteLength + valueBytes.byteLength)
    payload[0] = keyBytes.byteLength
    payload.set(keyBytes, 1)
    payload.set(valueBytes, 1 + keyBytes.byteLength)
    this.records.push(encodeRecord('I', payload))
    return this
  }

  addMultiInformation(key: string, value: string | number): this {
    // ULog Multi-Information keys must be field definitions: "type name"
    const effectiveKey = typeof value === 'string'
      ? `char[${value.length + 1}] ${key}`
      : `int32_t ${key}`
    const keyBytes = new TextEncoder().encode(effectiveKey)
    let valueBytes: Uint8Array
    if (typeof value === 'string') {
      const strBytes = new TextEncoder().encode(value)
      valueBytes = new Uint8Array(strBytes.byteLength + 1)
      valueBytes.set(strBytes)
      valueBytes[strBytes.byteLength] = 0
    } else {
      valueBytes = new Uint8Array(4)
      new DataView(valueBytes.buffer).setInt32(0, value, true)
    }
    const payload = new Uint8Array(2 + keyBytes.byteLength + valueBytes.byteLength)
    payload[0] = 0 // isContinued = false
    payload[1] = keyBytes.byteLength
    payload.set(keyBytes, 2)
    payload.set(valueBytes, 2 + keyBytes.byteLength)
    this.records.push(encodeRecord('M', payload))
    return this
  }

  addParameter(name: string, value: number | string): this {
    let typeStr: string
    let valueBytes: Uint8Array
    if (typeof value === 'string') {
      typeStr = 'char'
      const strBytes = new TextEncoder().encode(value)
      valueBytes = new Uint8Array(strBytes.byteLength + 1)
      valueBytes.set(strBytes)
      valueBytes[strBytes.byteLength] = 0
    } else {
      typeStr = 'int32_t'
      valueBytes = new Uint8Array(4)
      new DataView(valueBytes.buffer).setInt32(0, value, true)
    }
    const keyStr = `${typeStr} ${name}`
    const keyBytes = new TextEncoder().encode(keyStr)
    const payload = new Uint8Array(1 + keyBytes.byteLength + valueBytes.byteLength)
    payload[0] = keyBytes.byteLength
    payload.set(keyBytes, 1)
    payload.set(valueBytes, 1 + keyBytes.byteLength)
    this.records.push(encodeRecord('P', payload))
    return this
  }

  addSubscription(msgId: number, multiId: number): this {
    const name = this.formatNames.get(msgId)
    if (!name) {
      throw new Error(`No format defined for msgId ${msgId}`)
    }
    const nameBytes = new TextEncoder().encode(name)
    const payload = new Uint8Array(3 + nameBytes.byteLength)
    const view = new DataView(payload.buffer)
    view.setUint8(0, multiId)
    view.setUint16(1, msgId, true)
    payload.set(nameBytes, 3)
    this.records.push(encodeRecord('A', payload))
    return this
  }

  addData(msgId: number, timestampUs: bigint, fields: Record<string, number>): this {
    const fieldDefs = this.formatFields.get(msgId)
    if (!fieldDefs) {
      throw new Error(`No format defined for msgId ${msgId}`)
    }

    const dataParts: Uint8Array[] = []

    // First field must be timestamp (uint64_t)
    const tsBuf = new Uint8Array(8)
    new DataView(tsBuf.buffer).setBigUint64(0, timestampUs, true)
    dataParts.push(tsBuf)

    for (const field of fieldDefs) {
      if (field.fieldName === 'timestamp') continue

      const size = BASIC_SIZES[field.baseType] ?? 4
      const count = field.arrayLength ?? 1

      for (let i = 0; i < count; i++) {
        const key = field.arrayLength !== null ? `${field.fieldName}[${i}]` : field.fieldName
        const value = fields[key] ?? 0
        const buf = new Uint8Array(size)
        const dv = new DataView(buf.buffer)
        switch (field.baseType) {
          case 'float':
            dv.setFloat32(0, value, true)
            break
          case 'double':
            dv.setFloat64(0, value, true)
            break
          case 'int8_t':
            dv.setInt8(0, value)
            break
          case 'uint8_t':
            dv.setUint8(0, value)
            break
          case 'int16_t':
            dv.setInt16(0, value, true)
            break
          case 'uint16_t':
            dv.setUint16(0, value, true)
            break
          case 'int32_t':
            dv.setInt32(0, value, true)
            break
          case 'uint32_t':
            dv.setUint32(0, value, true)
            break
          case 'int64_t':
            dv.setBigInt64(0, BigInt(value), true)
            break
          case 'uint64_t':
            dv.setBigUint64(0, BigInt(value), true)
            break
        }
        dataParts.push(buf)
      }
    }

    const totalLen = dataParts.reduce((s, p) => s + p.byteLength, 0)
    const data = new Uint8Array(totalLen)
    let offset = 0
    for (const part of dataParts) {
      data.set(part, offset)
      offset += part.byteLength
    }

    const payload = new Uint8Array(2 + data.byteLength)
    new DataView(payload.buffer).setUint16(0, msgId, true)
    payload.set(data, 2)
    this.records.push(encodeRecord('D', payload))
    return this
  }

  addLog(timestampUs: bigint, level: number, message: string): this {
    const msgBytes = new TextEncoder().encode(message)
    const payload = new Uint8Array(9 + msgBytes.byteLength)
    const view = new DataView(payload.buffer)
    view.setUint8(0, level)
    view.setBigUint64(1, timestampUs, true)
    payload.set(msgBytes, 9)
    this.records.push(encodeRecord('L', payload))
    return this
  }

  addTaggedLog(timestampUs: bigint, level: number, tag: number, message: string): this {
    const msgBytes = new TextEncoder().encode(message)
    const payload = new Uint8Array(11 + msgBytes.byteLength)
    const view = new DataView(payload.buffer)
    view.setUint8(0, level)
    view.setUint16(1, tag, true)
    view.setBigUint64(3, timestampUs, true)
    payload.set(msgBytes, 11)
    this.records.push(encodeRecord('C', payload))
    return this
  }

  addDropout(durationMs: number): this {
    const payload = new Uint8Array(2)
    new DataView(payload.buffer).setUint16(0, durationMs, true)
    this.records.push(encodeRecord('O', payload))
    return this
  }

  addParameterDefault(name: string, value: number | string, defaultTypes: number = 1): this {
    let typeStr: string
    let valueBytes: Uint8Array
    if (typeof value === 'string') {
      typeStr = 'char'
      const strBytes = new TextEncoder().encode(value)
      valueBytes = new Uint8Array(strBytes.byteLength + 1)
      valueBytes.set(strBytes)
      valueBytes[strBytes.byteLength] = 0
    } else {
      typeStr = 'int32_t'
      valueBytes = new Uint8Array(4)
      new DataView(valueBytes.buffer).setInt32(0, value, true)
    }
    const keyStr = `${typeStr} ${name}`
    const keyBytes = new TextEncoder().encode(keyStr)
    const payload = new Uint8Array(2 + keyBytes.byteLength + valueBytes.byteLength)
    payload[0] = defaultTypes
    payload[1] = keyBytes.byteLength
    payload.set(keyBytes, 2)
    payload.set(valueBytes, 2 + keyBytes.byteLength)
    this.records.push(encodeRecord('Q', payload))
    return this
  }

  build(): ArrayBuffer {
    const header = new Uint8Array(16)
    for (let i = 0; i < ULOG_MAGIC.length; i++) {
      header[i] = ULOG_MAGIC[i]!
    }
    // Byte 7: version, bytes 8-15: timestamp (uint64 LE)
    const view = new DataView(header.buffer)
    view.setUint8(7, this.version)
    view.setBigUint64(8, this.timestampUs, true)

    // ULog requires definition records (F, I, M, P, Q) to appear before
    // data-section records (A, D, L, C, O, S, R).  Sort accordingly so
    // that addInformation / addParameter calls work regardless of the
    // order the caller invokes them relative to addSubscription / addData.
    const DEFINITION_TYPES = new Set(['F', 'I', 'M', 'P', 'Q'])
    const definitions: Uint8Array[] = []
    const dataSection: Uint8Array[] = []
    for (const rec of this.records) {
      // The type byte is at offset 2 (after the 2-byte size field)
      const typeChar = String.fromCharCode(rec[2]!)
      if (DEFINITION_TYPES.has(typeChar)) {
        definitions.push(rec)
      } else {
        dataSection.push(rec)
      }
    }
    const ordered = [...definitions, ...dataSection]

    const totalSize =
      header.byteLength + ordered.reduce((sum, r) => sum + r.byteLength, 0)
    const result = new Uint8Array(totalSize)
    let offset = 0
    result.set(header, offset)
    offset += header.byteLength
    for (const record of ordered) {
      result.set(record, offset)
      offset += record.byteLength
    }
    return result.buffer
  }
}

function encodeRecord(type: string, payload: Uint8Array): Uint8Array {
  const result = new Uint8Array(3 + payload.byteLength)
  const view = new DataView(result.buffer)
  view.setUint16(0, payload.byteLength, true)
  result[2] = type.charCodeAt(0)
  result.set(payload, 3)
  return result
}
