// Profile-selected flight-log capabilities. PX4 uses ULog files browsable over
// MAVLink FTP; ArduPilot uses DataFlash logs downloaded over the LOG_REQUEST_*
// protocol. Unknown vehicles get nothing destructive or analyzable.
import type { VehicleIdentity } from '../../shared/types'
import { PX4_ULOG_LOG_DIRECTORY } from '../../shared/constants'

export interface LogSupport {
  format: 'ulog' | 'dataflash' | 'unknown'
  /** On-board log browsing (MAVFTP directories or the DataFlash log list). */
  browse: boolean
  /** In-app log analysis (.ulg / .bin) is available. */
  analyze: boolean
  /** Destructive on-board log deletion is allowed. */
  allowDelete: boolean
  /**
   * Deletion granularity: MAVFTP removes individual files; the DataFlash
   * LOG_ERASE command always wipes ALL logs on the FC.
   */
  deleteScope: 'per-file' | 'erase-all' | 'none'
  /** FC log directory to open, or null when there is no filesystem path. */
  logPath: string | null
}

export function logSupport(identity: VehicleIdentity | null): LogSupport {
  if (identity?.family === 'px4') {
    return {
      format: 'ulog',
      browse: true,
      analyze: true,
      allowDelete: true,
      deleteScope: 'per-file',
      logPath: PX4_ULOG_LOG_DIRECTORY,
    }
  }
  if (identity?.family === 'ardupilot') {
    // DataFlash logs are addressed by numeric id over LOG_REQUEST_*; there is
    // no filesystem path and deletion is an all-or-nothing LOG_ERASE.
    return {
      format: 'dataflash',
      browse: true,
      analyze: true,
      allowDelete: true,
      deleteScope: 'erase-all',
      logPath: null,
    }
  }
  return {
    format: 'unknown',
    browse: false,
    analyze: false,
    allowDelete: false,
    deleteScope: 'none',
    logPath: null,
  }
}
