import { promises as fsp } from 'node:fs'
import type { Stats } from 'node:fs'
import path from 'node:path'
import { FTP_MAX_PATH_BYTES } from '../../shared/constants'

export const MAX_LOG_DOWNLOAD_BYTES = 512 * 1024 * 1024
const MIN_FREE_SPACE_AFTER_DOWNLOAD_BYTES = 64 * 1024 * 1024

// -- OCSA-008: private per-instance temp download directories ---------------
//
// The default download locations used to be fixed, predictable names under
// os.tmpdir(). Any local process could pre-create them (or replace them with a
// symlink) before the service, and the first-use cleanup then unlinked every
// top-level entry - including files registered by another service instance.
// Instances now create an atomically unique mkdtemp() directory instead; these
// constants describe how such directories and their artifacts are recognized.

/** mkdtemp prefix for MAVLink FTP download directories. */
export const FTP_DOWNLOAD_DIR_PREFIX = 'openconfigurator-logs-'
/** mkdtemp prefix for ArduPilot DataFlash download directories. */
export const DATAFLASH_DOWNLOAD_DIR_PREFIX = 'openconfigurator-dataflash-logs-'

/**
 * Download artifact names are `<16 hex chars>.part|ulg|bin` (DOWNLOAD_ID_BYTES
 * is 8 -> 16 hex characters). Runtime cleanup must only ever unlink names
 * matching the instance's own format so co-located instances or unrelated
 * files in an explicitly configured directory are never touched.
 */
export const FTP_DOWNLOAD_FILE_PATTERN = /^[0-9a-f]{16}\.(?:part|ulg)$/
export const DATAFLASH_DOWNLOAD_FILE_PATTERN = /^[0-9a-f]{16}\.(?:part|bin)$/

/**
 * Instance directories left behind by a crashed server keep their downloads
 * until some later instance reclaims them. They are aged out by scanning the
 * shared parent for entries with our own prefix - deliberately separate from
 * the runtime download directory, which is never swept while in use. 24 h is
 * far longer than any restart cycle, so live sibling instances are never
 * removed, while crashed leftovers cannot accumulate indefinitely.
 */
export const STALE_INSTANCE_DIR_MAX_AGE_MS = 24 * 60 * 60 * 1000

/**
 * Remove age-expired instance directories carrying the given prefix from
 * `parent`. Symlinks and plain files are never followed or deleted (lstat
 * first), so a planted symlink at a predictable name cannot redirect the
 * removal. Returns the names that were removed.
 */
export async function removeStaleInstanceDirs(
  parent: string,
  prefix: string,
  maxAgeMs: number,
  now = Date.now(),
): Promise<string[]> {
  const removed: string[] = []
  const names = await fsp.readdir(parent).catch(() => [] as string[])
  for (const name of names) {
    if (!name.startsWith(prefix)) continue
    const candidate = path.join(parent, name)
    let stats: Stats
    try {
      stats = await fsp.lstat(candidate)
    } catch {
      continue // Raced with another sweeper; leave it alone.
    }
    if (!stats.isDirectory()) continue // Symlink or file: never follow/unlink.
    if (now - stats.mtimeMs < maxAgeMs) continue // Young enough to be live.
    await fsp.rm(candidate, { recursive: true, force: true }).catch(() => undefined)
    removed.push(name)
  }
  return removed
}

// -- OCSA-016: remote entry-name validation ---------------------------------

/**
 * Longest remote basename accepted from flight-controller directory listings.
 * Real FC log names stay far below this (and a single MAVLink FTP list record
 * must fit into the 239-byte payload anyway); the value matches the local
 * sanitized-filename cap in MavlinkFtp.sanitizeFileName().
 */
export const REMOTE_BASENAME_MAX_LENGTH = 100

/**
 * True when `name` is a single remote filesystem basename: non-empty, not a
 * relative segment, free of path separators and control characters, and within
 * REMOTE_BASENAME_MAX_LENGTH. Names failing this check coming from a listing
 * must be skipped (and reported), never joined into a device path.
 */
export function isSafeRemoteBasename(name: string): boolean {
  if (name.length === 0 || name.length > REMOTE_BASENAME_MAX_LENGTH) return false
  if (name === '.' || name === '..') return false
  if (name.includes('/') || name.includes('\\')) return false
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(name)) return false
  return true
}

/**
 * Mirrors the WS boundary's devicePath() contract (src/server/validation.ts):
 * absolute, bounded by FTP_MAX_PATH_BYTES, free of control characters and free
 * of `..` segments. Applied a second time after joining remote listing names
 * so a composed delete target can never escape the user-selected directory.
 */
export function isSafeDevicePath(devicePath: string): boolean {
  if (devicePath.length === 0 || devicePath.length > FTP_MAX_PATH_BYTES) return false
  if (!devicePath.startsWith('/')) return false
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(devicePath)) return false
  return !devicePath.split('/').some((segment) => segment === '..')
}

export class DownloadCapacityError extends Error {
  readonly code: 'download_too_large' | 'insufficient_disk_space'

  constructor(code: DownloadCapacityError['code'], message: string) {
    super(message)
    this.name = 'DownloadCapacityError'
    this.code = code
  }
}

/** Reject an advertised download before creating or extending its temp file. */
export async function assertDownloadCapacity(directory: string, sizeBytes: number): Promise<void> {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0 || sizeBytes > MAX_LOG_DOWNLOAD_BYTES) {
    throw new DownloadCapacityError(
      'download_too_large',
      `日志大小 ${sizeBytes} 字节超过 ${MAX_LOG_DOWNLOAD_BYTES} 字节上限`,
    )
  }

  const stats = await fsp.statfs(directory, { bigint: true })
  const availableBytes = stats.bavail * stats.bsize
  const requiredBytes = BigInt(sizeBytes + MIN_FREE_SPACE_AFTER_DOWNLOAD_BYTES)
  if (availableBytes < requiredBytes) {
    throw new DownloadCapacityError(
      'insufficient_disk_space',
      '磁盘可用空间不足，无法安全下载日志',
    )
  }
}
