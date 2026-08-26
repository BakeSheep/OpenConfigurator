export type ByteEncoding = 'utf8' | 'utf-8' | 'ascii' | 'base64' | 'hex'

const utf8Encoder = new TextEncoder()
const utf8Decoder = new TextDecoder()

function encodeString(value: string, encoding: ByteEncoding): Uint8Array {
  if (encoding === 'utf8' || encoding === 'utf-8') return utf8Encoder.encode(value)
  if (encoding === 'ascii') return Uint8Array.from(value, (character) => character.charCodeAt(0) & 0x7f)
  if (encoding === 'hex') {
    if (value.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(value)) throw new TypeError('Invalid hex input')
    return Uint8Array.from({ length: value.length / 2 }, (_, index) => Number.parseInt(value.slice(index * 2, index * 2 + 2), 16))
  }
  const binary = atob(value)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

function decodeBytes(value: Uint8Array, encoding: ByteEncoding): string {
  if (encoding === 'utf8' || encoding === 'utf-8') return utf8Decoder.decode(value)
  if (encoding === 'ascii') return Array.from(value, (byte) => String.fromCharCode(byte & 0x7f)).join('')
  if (encoding === 'hex') return Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('')
  let binary = ''
  for (const byte of value) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/** Browser-native byte buffer used by protocol code without Node globals. */
export class ByteBuffer extends Uint8Array {
  static alloc(size: number, fill = 0): ByteBuffer {
    const result = new ByteBuffer(size)
    if (fill !== 0) result.fill(fill)
    return result
  }

  static allocUnsafe(size: number): ByteBuffer {
    return new ByteBuffer(size)
  }

  static from(arrayLike: ArrayLike<number>): ByteBuffer
  static from<T>(arrayLike: ArrayLike<T>, mapfn: (value: T, index: number) => number, thisArg?: unknown): ByteBuffer
  static from(elements: Iterable<number>): ByteBuffer
  static from<T>(elements: Iterable<T>, mapfn?: (value: T, index: number) => number, thisArg?: unknown): ByteBuffer
  static from(value: string, encoding?: ByteEncoding): ByteBuffer
  static from(value: ArrayBufferLike): ByteBuffer
  static from<T>(
    value: string | ArrayLike<T> | Iterable<T> | ArrayBufferLike,
    encodingOrMap: ByteEncoding | ((value: T, index: number) => number) = 'utf8',
    thisArg?: unknown,
  ): ByteBuffer {
    const bytes = typeof value === 'string'
      ? encodeString(value, encodingOrMap as ByteEncoding)
      : ArrayBuffer.isView(value)
        ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
        : value instanceof ArrayBuffer || (typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer)
          ? new Uint8Array(value)
          : typeof encodingOrMap === 'function'
            ? Uint8Array.from(value as Iterable<T>, encodingOrMap, thisArg)
            : Uint8Array.from(value as Iterable<number>)
    return new ByteBuffer(bytes)
  }

  static concat(chunks: readonly Uint8Array[], totalLength = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)): ByteBuffer {
    const result = new ByteBuffer(totalLength)
    let offset = 0
    for (const chunk of chunks) {
      const length = Math.min(chunk.byteLength, totalLength - offset)
      if (length <= 0) break
      result.set(chunk.subarray(0, length), offset)
      offset += length
    }
    return result
  }

  static byteLength(value: string, encoding: ByteEncoding = 'utf8'): number {
    return encodeString(value, encoding).byteLength
  }

  override subarray(begin?: number, end?: number): ByteBuffer {
    const view = super.subarray(begin, end)
    return new ByteBuffer(view.buffer, view.byteOffset, view.byteLength)
  }

  override slice(start?: number, end?: number): ByteBuffer {
    return new ByteBuffer(super.slice(start, end))
  }

  copy(target: Uint8Array, targetStart = 0, sourceStart = 0, sourceEnd = this.length): number {
    const source = this.subarray(sourceStart, sourceEnd)
    const length = Math.min(source.length, Math.max(0, target.length - targetStart))
    target.set(source.subarray(0, length), targetStart)
    return length
  }

  override includes(searchElement: number, fromIndex?: number): boolean
  includes(searchElement: Uint8Array, fromIndex?: number): boolean
  override includes(searchElement: number | Uint8Array, fromIndex = 0): boolean {
    if (typeof searchElement === 'number') return super.includes(searchElement, fromIndex)
    if (searchElement.length === 0) return true
    const end = this.length - searchElement.length
    for (let offset = Math.max(0, fromIndex); offset <= end; offset++) {
      let matches = true
      for (let index = 0; index < searchElement.length; index++) {
        if (this[offset + index] !== searchElement[index]) {
          matches = false
          break
        }
      }
      if (matches) return true
    }
    return false
  }

  override toString(encoding: ByteEncoding = 'utf8', start = 0, end = this.length): string {
    return decodeBytes(this.subarray(start, end), encoding)
  }

  private view(): DataView {
    return new DataView(this.buffer, this.byteOffset, this.byteLength)
  }

  readUInt8(offset: number): number { return this.view().getUint8(offset) }
  readInt8(offset: number): number { return this.view().getInt8(offset) }
  readUInt16LE(offset: number): number { return this.view().getUint16(offset, true) }
  readInt16LE(offset: number): number { return this.view().getInt16(offset, true) }
  readUInt32LE(offset: number): number { return this.view().getUint32(offset, true) }
  readInt32LE(offset: number): number { return this.view().getInt32(offset, true) }
  readBigUInt64LE(offset: number): bigint { return this.view().getBigUint64(offset, true) }
  readBigInt64LE(offset: number): bigint { return this.view().getBigInt64(offset, true) }
  readFloatLE(offset: number): number { return this.view().getFloat32(offset, true) }
  readDoubleLE(offset: number): number { return this.view().getFloat64(offset, true) }
  readUIntLE(offset: number, byteLength: number): number {
    let result = 0
    for (let index = 0; index < byteLength; index++) result += this[offset + index] * 2 ** (8 * index)
    return result
  }

  writeUInt8(value: number, offset = 0): number { this.view().setUint8(offset, value); return offset + 1 }
  writeInt8(value: number, offset = 0): number { this.view().setInt8(offset, value); return offset + 1 }
  writeUInt16LE(value: number, offset = 0): number { this.view().setUint16(offset, value, true); return offset + 2 }
  writeInt16LE(value: number, offset = 0): number { this.view().setInt16(offset, value, true); return offset + 2 }
  writeUInt32LE(value: number, offset = 0): number { this.view().setUint32(offset, value, true); return offset + 4 }
  writeInt32LE(value: number, offset = 0): number { this.view().setInt32(offset, value, true); return offset + 4 }
  writeBigUInt64LE(value: bigint, offset = 0): number { this.view().setBigUint64(offset, value, true); return offset + 8 }
  writeBigInt64LE(value: bigint, offset = 0): number { this.view().setBigInt64(offset, value, true); return offset + 8 }
  writeFloatLE(value: number, offset = 0): number { this.view().setFloat32(offset, value, true); return offset + 4 }
  writeDoubleLE(value: number, offset = 0): number { this.view().setFloat64(offset, value, true); return offset + 8 }
  writeUIntLE(value: number, offset: number, byteLength: number): number {
    let remaining = value
    for (let index = 0; index < byteLength; index++) {
      this[offset + index] = remaining & 0xff
      remaining = Math.floor(remaining / 256)
    }
    return offset + byteLength
  }
}
