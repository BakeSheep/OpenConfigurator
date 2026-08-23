import type { ConnectionErrorCode } from '../../shared/types'

/**
 * Stable classification of native serial-open failures (connection
 * compatibility plan §4.4 / §Phase 5). The UI maps these codes instead of
 * matching driver error strings, and permission errors additionally surface
 * the owning uid/gid so the operator knows which group to join.
 */

export interface SerialOwnership {
  uid: number
  gid: number
}

export interface SerialOpenErrorOptions {
  platform?: NodeJS.Platform
  ownership?: SerialOwnership | null
}

const isCoded = (error: unknown, code: string): boolean =>
  (error as NodeJS.ErrnoException | null)?.code === code

export function classifySerialOpenError(
  path: string,
  error: unknown,
  options: SerialOpenErrorOptions = {},
): Error & { code?: ConnectionErrorCode } {
  const platform = options.platform ?? process.platform
  const classified = error as Error & { code?: string }
  const errno = (error as NodeJS.ErrnoException | null)?.code

  if (isCoded(error, 'EACCES') || isCoded(error, 'EPERM')) {
    const owner = options.ownership
      ? `（属主 uid=${options.ownership.uid}，组 gid=${options.ownership.gid}）`
      : ''
    const groupHint = platform === 'linux'
      ? '请将当前用户加入串口设备所属组（常见为 dialout 或 uucp）并重新登录。'
      : '请以有权限访问该设备的用户运行，或检查设备占用。'
    const result = new Error(
      `无权限打开串口 ${path}${owner}。${groupHint}`,
    ) as Error & { code?: ConnectionErrorCode }
    result.code = 'SERIAL_PERMISSION_DENIED'
    return result
  }

  // Our own open-timeout error must be recognized before the win32 message
  // heuristic below: its hint text contains “被占用”, which would otherwise
  // re-classify the timeout as SERIAL_BUSY on Windows.
  if (classified && /打开串口.*超时/.test(classified.message ?? '')) {
    const result = new Error(classified.message) as Error & { code?: ConnectionErrorCode }
    result.code = 'SERIAL_OPEN_TIMEOUT'
    return result
  }

  if (
    isCoded(error, 'EBUSY')
    || isCoded(error, 'ERROR_ACCESS_DENIED')
    || (platform === 'win32' && errno === undefined && /busy|in use|被占用/i.test(String(error)))
  ) {
    const result = new Error(
      `串口 ${path} 已被其他程序占用。请关闭 QGC、串口终端或本软件的其他实例后重试。`,
    ) as Error & { code?: ConnectionErrorCode }
    result.code = 'SERIAL_BUSY'
    return result
  }

  if (isCoded(error, 'ENOENT') || isCoded(error, 'ENOTDIR') || isCoded(error, 'ENXIO')) {
    const result = new Error(
      `串口 ${path} 不存在或已被拔出。请重新扫描并选择设备。`,
    ) as Error & { code?: ConnectionErrorCode }
    result.code = 'SERIAL_NOT_FOUND'
    return result
  }

  if (classified instanceof Error) {
    return classified as Error & { code?: ConnectionErrorCode }
  }
  return new Error(String(error))
}

/** Read device ownership for the permission-denied hint; null when unknown. */
export async function readSerialOwnership(path: string): Promise<SerialOwnership | null> {
  try {
    const { stat } = await import('node:fs/promises')
    const stats = await stat(path)
    return { uid: stats.uid, gid: stats.gid }
  } catch {
    return null
  }
}
