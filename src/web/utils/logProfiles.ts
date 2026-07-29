// Profile-selected flight-log capabilities. PX4 uses ULog files browsable over
// MAVLink FTP; ArduPilot uses DataFlash logs downloaded over the LOG_REQUEST_*
// protocol (not implemented in this milestone). Unknown vehicles get nothing
// destructive or analyzable.
import type { VehicleIdentity } from '../../shared/types'
import { PX4_ULOG_LOG_DIRECTORY } from '../../shared/constants'

export interface LogSupport {
  format: 'ulog' | 'dataflash' | 'unknown'
  /** MAVFTP directory browsing of on-board logs is available. */
  browse: boolean
  /** In-app log analysis (.ulg) is available. */
  analyze: boolean
  /** Destructive on-board log deletion is allowed. */
  allowDelete: boolean
  /** FC log directory to open, or null when browsing is unsupported. */
  logPath: string | null
}

export function logSupport(identity: VehicleIdentity | null): LogSupport {
  if (identity?.family === 'px4') {
    return {
      format: 'ulog',
      browse: true,
      analyze: true,
      allowDelete: true,
      logPath: PX4_ULOG_LOG_DIRECTORY,
    }
  }
  if (identity?.family === 'ardupilot') {
    // DataFlash download/analysis is a later milestone; expose no MAVFTP
    // browsing (there is no ULog directory) and no destructive actions.
    return {
      format: 'dataflash',
      browse: false,
      analyze: false,
      allowDelete: false,
      logPath: null,
    }
  }
  return {
    format: 'unknown',
    browse: false,
    analyze: false,
    allowDelete: false,
    logPath: null,
  }
}
