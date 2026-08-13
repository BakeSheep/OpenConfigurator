import { promises as fsp } from 'node:fs'
import path from 'node:path'

/**
 * Sanitize error messages sent to clients so host absolute paths
 * (such as temporary directories, user home folders, or system paths)
 * are not leaked to external callers.
 */
export function sanitizeErrorMessage(message: string, downloadDir?: string): string {
  if (!message || typeof message !== 'string') return ''
  let sanitized = message
  if (downloadDir) {
    const resolvedDir = path.resolve(downloadDir)
    sanitized = sanitized.split(resolvedDir).join('<download_dir>')
    sanitized = sanitized.split(downloadDir).join('<download_dir>')
  }
  // Windows absolute paths with drive letter (e.g. C:\foo\bar or C:/foo/bar)
  sanitized = sanitized.replace(/[a-zA-Z]:[\\/][^\s:,;"')]+/g, '<path>')
  // Windows UNC paths (e.g. \\server\share\...)
  sanitized = sanitized.replace(/\\\\[^\s:,;"')]+/g, '<path>')
  // Host POSIX absolute paths starting with standard root folders
  sanitized = sanitized.replace(/\/(?:tmp|var|home|Users|etc|usr|private|opt)[^\s:,;"')\\]*/g, '<path>')
  return sanitized
}

/**
 * Sweep the download directory and clean up stale .part files older than maxAgeMs (default: 1 hour)
 * with strict directory containment verification.
 */
export async function cleanupStaleTempFiles(
  directory: string,
  maxAgeMs = 3600_000,
): Promise<void> {
  const resolvedDir = path.resolve(directory)
  await fsp.mkdir(resolvedDir, { recursive: true })
  const entries = await fsp.readdir(resolvedDir, { withFileTypes: true }).catch(() => [])
  const now = Date.now()
  await Promise.allSettled(
    entries.map(async (entry) => {
      if (!entry.isFile()) return
      const fullPath = path.resolve(resolvedDir, entry.name)
      // Strict directory containment check
      if (!fullPath.startsWith(resolvedDir + path.sep)) return
      if (entry.name.endsWith('.part')) {
        const stat = await fsp.stat(fullPath).catch(() => null)
        if (stat && now - stat.mtimeMs >= maxAgeMs) {
          await fsp.unlink(fullPath).catch(() => undefined)
        }
      }
    }),
  )
}
