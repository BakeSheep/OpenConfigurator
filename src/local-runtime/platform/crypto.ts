import { sha256 } from '@noble/hashes/sha2.js'

export function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length)
  globalThis.crypto.getRandomValues(bytes)
  return bytes
}

export function randomUUID(): string {
  return globalThis.crypto.randomUUID()
}

export function timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false
  let mismatch = 0
  for (let index = 0; index < left.length; index++) mismatch |= left[index] ^ right[index]
  return mismatch === 0
}

export function signingKey(secret: string): Uint8Array {
  if (/^[0-9a-f]{64}$/i.test(secret)) {
    return Uint8Array.from(secret.match(/.{2}/g) ?? [], (pair) => Number.parseInt(pair, 16))
  }
  return sha256(new TextEncoder().encode(secret))
}

export function shortSignature(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const input = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    input.set(part, offset)
    offset += part.length
  }
  return sha256(input).subarray(0, 6)
}

export function randomHex(bytes: number): string {
  return Array.from(randomBytes(bytes), (value) => value.toString(16).padStart(2, '0')).join('')
}

export function randomBase64Url(bytes: number): string {
  let binary = ''
  for (const value of randomBytes(bytes)) binary += String.fromCharCode(value)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}
