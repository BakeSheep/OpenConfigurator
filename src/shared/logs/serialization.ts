import type { StructuredJsonValue } from './types'

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

export function bytesToBase64(bytes: Uint8Array): string {
  let output = ''
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index]
    const b = index + 1 < bytes.length ? bytes[index + 1] : 0
    const c = index + 2 < bytes.length ? bytes[index + 2] : 0
    const bits = (a << 16) | (b << 8) | c
    output += BASE64_ALPHABET[(bits >>> 18) & 63]
    output += BASE64_ALPHABET[(bits >>> 12) & 63]
    output += index + 1 < bytes.length ? BASE64_ALPHABET[(bits >>> 6) & 63] : '='
    output += index + 2 < bytes.length ? BASE64_ALPHABET[bits & 63] : '='
  }
  return output
}

export function toStructuredJson(value: unknown): StructuredJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return { $number: 'NaN' }
    if (value === Number.POSITIVE_INFINITY) return { $number: '+Infinity' }
    if (value === Number.NEGATIVE_INFINITY) return { $number: '-Infinity' }
    return value
  }
  if (value instanceof Uint8Array) return { $binary: bytesToBase64(value), encoding: 'base64' }
  if (ArrayBuffer.isView(value)) {
    return {
      $binary: bytesToBase64(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)),
      encoding: 'base64',
    }
  }
  if (value instanceof ArrayBuffer) return { $binary: bytesToBase64(new Uint8Array(value)), encoding: 'base64' }
  if (Array.isArray(value)) return value.map(toStructuredJson)
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, toStructuredJson(entry)]),
    )
  }
  return String(value)
}

export function stringifyStructuredJson(value: unknown): string {
  return JSON.stringify(toStructuredJson(value))
}
