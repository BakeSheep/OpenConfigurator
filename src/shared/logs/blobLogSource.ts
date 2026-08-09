import type { RandomAccessLogSource } from './types'

const DEFAULT_CHUNK_SIZE = 1024 * 1024

export class BlobLogSource implements RandomAccessLogSource {
  readonly name: string
  readonly size: number
  readonly blob: Blob

  constructor(name: string, blob: Blob) {
    this.name = name
    this.size = blob.size
    this.blob = blob
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0) {
      throw new RangeError('Invalid log source read range')
    }
    const end = Math.min(this.size, offset + length)
    if (offset >= end) return new Uint8Array()
    return new Uint8Array(await this.blob.slice(offset, end).arrayBuffer())
  }

  async *chunks(chunkSize = DEFAULT_CHUNK_SIZE): AsyncIterable<Uint8Array> {
    if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) throw new RangeError('Invalid chunk size')
    for (let offset = 0; offset < this.size; offset += chunkSize) {
      yield await this.read(offset, chunkSize)
    }
  }
}

export function arrayBufferLogSource(name: string, buffer: ArrayBuffer): BlobLogSource {
  return new BlobLogSource(name, new Blob([buffer]))
}
