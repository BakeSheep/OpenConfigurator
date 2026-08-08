import { promises as fsp } from 'node:fs'

export const MAX_LOG_DOWNLOAD_BYTES = 512 * 1024 * 1024
const MIN_FREE_SPACE_AFTER_DOWNLOAD_BYTES = 64 * 1024 * 1024

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
