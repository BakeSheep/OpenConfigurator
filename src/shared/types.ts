// MAVLink message types and shared interfaces between frontend and backend

import type { VehicleIdentity, AutopilotFamily, VehicleClass } from './vehicleProfiles'
import type {
  EscSessionSnapshot,
  EscDeviceInfo,
  EscSettingsSnapshot,
  EscJobProgressSnapshot,
  EscJobResult,
  EscLogEntry,
} from './esc/types'
import type { EscOperationError } from './esc/errors'

export type { VehicleIdentity, AutopilotFamily, VehicleClass }

export interface AttitudeData {
  roll: number
  pitch: number
  yaw: number
  rollspeed: number
  pitchspeed: number
  yawspeed: number
  time_boot_ms: number
}

export interface GpsData {
  fix_type: number
  lat: number
  lon: number
  alt: number
  /** Horizontal dilution of precision. null means MAVLink unknown (UINT16_MAX). */
  eph: number | null
  /** Vertical dilution of precision. null means MAVLink unknown (UINT16_MAX). */
  epv: number | null
  vel: number | null
  cog: number | null
  satellites_visible: number | null
}

export interface BatteryData {
  /** MAVLink battery instance; independent batteries are never combined. */
  id: number
  voltage: number | null
  /** Individual cell voltages in volts, including BATTERY_STATUS.voltages_ext. */
  cell_voltages: Array<number | null>
  current: number | null
  remaining: number | null
  consumed_mah: number | null
}

export interface SysStatusData {
  voltageBattery: number | null
  currentBattery: number | null
  batteryRemaining: number | null
  /** Autopilot mainloop load in percent (SYS_STATUS.load / 10). */
  cpuLoad: number
  sensorsPresent: number
  sensorsEnabled: number
  sensorsHealth: number
  /** Health of all sensors the autopilot currently reports as enabled. */
  sensorsHealthy: boolean | null
  /** null means the autopilot does not expose MAV_SYS_STATUS_PREARM_CHECK. */
  preflightCheck: boolean | null
  /** Enabled MAV_SYS_STATUS_SENSOR bits that the autopilot reports unhealthy. */
  unhealthySensorMask: number
  /** Human-readable names for unhealthy enabled systems (for example RC input). */
  unhealthySensors: string[]
}

export interface ImuData {
  /** Zero-based physical IMU instance (0 = IMU 1). */
  instance?: number
  /** RAW_IMU values are device counts; other variants are normalized SI/G units. */
  units?: 'raw' | 'normalized'
  xacc: number
  yacc: number
  zacc: number
  xgyro: number
  ygyro: number
  zgyro: number
  xmag: number
  ymag: number
  zmag: number
  temperature: number | null
}

export interface AutopilotVersionData {
  boardId: number
  boardName: string
  firmwareVersion: string
  firmwareLabel: string
  vendorId: number
  productId: number
  /** Autopilot family selected from HEARTBEAT identity, never inferred. */
  family: AutopilotFamily
  vehicleClass: VehicleClass
}

export interface BaroData {
  press_abs: number
  press_diff: number
  /**
   * Baro/die temperature in degC. null = not trusted/not available (e.g. the
   * HIGHRES_IMU fallback, where PX4 fills a 15 degC ISA placeholder).
   */
  temperature: number | null
  altitude: number | null
}

export interface OpticalFlowData {
  integration_time_us: number
  integrated_x_rad: number
  integrated_y_rad: number
  integrated_xgyro_rad: number
  integrated_ygyro_rad: number
  integrated_zgyro_rad: number
  temperature_c: number | null
  time_delta_distance_us: number
  distance_m: number | null
  /** @deprecated Use integrated_x_rad. */
  flow_x: number
  /** @deprecated Use integrated_y_rad. */
  flow_y: number
  /** @deprecated Historical alias; use integrated_xgyro_rad. */
  flow_comp_m_x: number
  /** @deprecated Historical alias; use integrated_ygyro_rad. */
  flow_comp_m_y: number
  quality: number
  /** @deprecated Use distance_m. */
  ground_distance: number | null
  sensor_id: number
}

export interface DistanceSensorData {
  current_distance: number
  min_distance: number
  max_distance: number
  signal_quality: number | null
  type: number
  id: number
  orientation: number
}

export interface EkfStatusData {
  health_flags: number
  innovation_vel: number
  innovation_pos: number
  innovation_hgt: number
  innovation_mag: number
  /** null because the active standard dialect does not define this PX4 field. */
  gps_check_fail_flags: number | null
}

// Failsafe/safety state. 'unknown' is used when the state cannot be reliably
// determined from available MAVLink messages - a safety-critical field must
// never silently default to "safe".
export type SafetyState = 'unknown' | 'safe' | 'warning' | 'error'

export interface VehicleStatus {
  armed: boolean
  mode: string
  modeId: number
  failsafe: SafetyState
  systemStatus: number
  /** Identity of the selected vehicle as classified from its HEARTBEAT. */
  identity: VehicleIdentity
}

export interface ParamData {
  id: string
  value: number
  type: number
  param_count: number
  param_index: number
}

export interface ParamSetResultData {
  requestId?: string
  id: string
  requestedValue: number
  acceptedValue?: number
  accepted: boolean
  attempt: number
  reason?: string
}

/**
 * RC_CHANNELS as reported by the FC. A null channel means the receiver does
 * not provide it (beyond chancount, or UINT16_MAX per the MAVLink spec).
 */
export interface RcChannelsData {
  ch1: number | null
  ch2: number | null
  ch3: number | null
  ch4: number | null
  ch5: number | null
  ch6: number | null
  ch7: number | null
  ch8: number | null
  ch9?: number | null
  ch10?: number | null
  ch11?: number | null
  ch12?: number | null
  ch13?: number | null
  ch14?: number | null
  ch15?: number | null
  ch16?: number | null
  ch17?: number | null
  ch18?: number | null
  /** Receive signal strength 0-254; null = unknown (wire value 255). */
  rssi: number | null
}

export interface ManualControlData {
  /** Pitch command in the MAVLink MANUAL_CONTROL range [-1000, 1000]. */
  x: number
  /** Roll command in the MAVLink MANUAL_CONTROL range [-1000, 1000]. */
  y: number
  /** Throttle command in the MAVLink MANUAL_CONTROL range [0, 1000]. */
  z: number
  /** Yaw command in the MAVLink MANUAL_CONTROL range [-1000, 1000]. */
  r: number
  /** Optional gamepad button bitmask. */
  buttons?: number
}

export interface MotorOutputData {
  time_usec: number
  port: number
  /** Raw PWM output in microseconds; null means the channel was not present. */
  outputs: Array<number | null>
}

/**
 * One entry of a MAVLink FTP directory listing. The wire protocol reports
 * only name and size; directories carry no size at all.
 */
export interface FsEntry {
  name: string
  kind: 'file' | 'dir'
  sizeBytes: number | null
}

/**
 * One ArduPilot DataFlash log as reported by LOG_ENTRY. Logs are addressed
 * by numeric id (there is no filesystem path over the LOG_REQUEST_* protocol).
 */
export interface DataflashLogEntry {
  id: number
  /** LOG_ENTRY.time_utc (seconds since 1970) converted to ms; 0 means null. */
  timeUtcMs: number | null
  sizeBytes: number
}

// WebSocket message types (server -> client)
export type ServerMessage =
  | {
      type: 'hello'
      data: {
        protocolVersion: number
        clientId: string
        /** Per-WebSocket secret used to authorize REST connect/disconnect while this client owns the lease. */
        restControlToken: string
        capabilities: string[]
        maxPayload: number
        controllerLeaseMs: number
      }
    }
  | {
      type: 'client_error'
      data: {
        code: string
        message: string
        requestId?: string
        retryable: boolean
        details?: Record<string, unknown>
      }
    }
  | {
      type: 'controller'
      data: {
        clientId: string | null
        expiresAt: number | null
        reason:
          | 'claimed'
          | 'renewed'
          | 'released'
          | 'expired'
          | 'disconnected'
          | 'connection_changed'
          | 'snapshot'
      }
    }
  | {
      type: 'param_sync'
      data: {
        generation: number
        status: 'started' | 'complete' | 'failed' | 'cancelled'
        ownerClientId: string
        reason?: string
      }
    }
  | { type: 'telemetry'; msgType: string; data: any }
  | { type: 'sensor'; msgType: string; data: any }
  | { type: 'param'; data: ParamData }
  | { type: 'param_batch'; generation?: number; data: ParamData[] }
  | { type: 'param_complete'; generation?: number; data: { count: number } }
  | {
      type: 'param_retry'
      generation?: number
      data: { attempt: number; missing: number; total: number }
    }
  | {
      type: 'param_failed'
      generation?: number
      data: { received: number; total: number; reason?: string }
    }
  | { type: 'status'; data: VehicleStatus }
  | {
      type: 'connection'
      data: {
        connected: boolean
        status?: ConnectionStatus
        transportOpen?: boolean
        vehicleReady?: boolean
        port?: string
        type?: string
        error?: {
          phase: 'connect' | 'runtime' | 'disconnect' | 'heartbeat' | 'reconnect'
          message: string
          code?: string
          timestamp: number
          retryable?: boolean
        }
        // Present while the backend is auto-reconnecting a dropped Bluetooth
        // link (status === 'reconnecting'). Lets the UI show retry progress
        // instead of a bare "disconnected".
        reconnect?: { attempt: number; maxAttempts: number; delayMs: number; lastError?: string }
        reconnectTerminalReason?: {
          code: string
          message: string
          attempt: number
          timestamp: number
        }
      }
    }
  | {
      type: 'command_ack'
      data: {
        command: number
        result: number
        requestId?: string
        progress?: number
        resultParam2?: number
        targetSystem?: number
        targetComponent?: number
        terminal?: boolean
        attempt?: number
        /** ACK was received outside an attributable transaction window. */
        stale?: boolean
      }
    }
  | {
      type: 'param_set_result'
      data: ParamSetResultData
    }
  | {
      type: 'motor_test_status'
      data: {
        requestId?: string
        instance: number
        action: 'start' | 'stop'
        /** MAV_CMD_ACTUATOR_TEST ACK has no actuator instance; dispatch is explicit but unconfirmed. */
        status: 'sent_unconfirmed'
        reason: string
      }
    }
  | {
      type: 'operation_error'
      generation?: number
      data: {
        requestId?: string
        operation: string
        code: string
        message: string
        retryable?: boolean
      }
    }
  | {
      type: 'target'
      data: {
        systemId: number | null
        componentId: number | null
        ready: boolean
        reason: 'discovered' | 'selected' | 'reset'
        /** Classified identity of the selected target; null until known. */
        identity: VehicleIdentity | null
        discovered?: Array<{
          systemId: number
          componentId: number
          autopilot: number
          type: number
        }>
      }
    }
  | { type: 'statustext'; data: { severity: number; text: string } }
  | { type: 'rc_channels'; data: RcChannelsData }
  | { type: 'ekf_status'; data: EkfStatusData }
  | { type: 'motor_outputs'; data: MotorOutputData }
  | { type: 'autopilot_version'; data: AutopilotVersionData }
  | {
      // MAVLink FTP directory listing result for the flight-log explorer.
      type: 'fs_list'
      data: { path: string; entries: FsEntry[] }
    }
  | {
      type: 'fs_download_progress'
      data: {
        path: string
        receivedBytes: number
        totalBytes: number
        rateBps: number
      }
    }
  | {
      type: 'fs_download_complete'
      data: {
        path: string
        /** Opaque id used by GET /api/logs/downloads/:downloadId. */
        downloadId: string
        sizeBytes: number
        fileName: string
      }
    }
  | { type: 'fs_delete_progress'; data: { done: number; total: number; current: string } }
  | { type: 'fs_delete_done'; data: { deleted: number } }
  | {
      type: 'fs_op_error'
      data: {
        requestId?: string
        operation: 'list' | 'download' | 'delete'
        code: string
        message: string
        retryable: boolean
      }
    }
  | {
      // ArduPilot DataFlash log list (LOG_REQUEST_LIST -> LOG_ENTRY result).
      type: 'log_list'
      data: { entries: DataflashLogEntry[] }
    }
  | {
      type: 'log_download_progress'
      data: {
        logId: number
        receivedBytes: number
        totalBytes: number
        rateBps: number
      }
    }
  | {
      type: 'log_download_complete'
      data: {
        logId: number
        /** Opaque id used by GET /api/logs/downloads/:downloadId. */
        downloadId: string
        sizeBytes: number
        fileName: string
      }
    }
  | { type: 'log_erase_done' }
  | {
      type: 'log_op_error'
      data: {
        requestId?: string
        operation: 'list' | 'download' | 'erase'
        code: string
        message: string
        retryable: boolean
      }
    }
  | {
      // Link-quality telemetry surfaced ~1 Hz. Bytes/sec throughput plus CRC
      // error rate stand in for the RSSI that a raw SPP COM port cannot expose.
      type: 'link_stats'
      data: {
        rxBps: number
        txBps: number
        crcErrors: number
        crcErrorsPerSec: number
        rxPackets?: number
        txPackets?: number
        rxSequenceLost?: number
        rxDuplicates?: number
        rxOutOfOrder?: number
        rejectedPackets?: number
        garbageBytes?: number
        protocolVersion?: 1 | 2
      }
    }
  // -- ESC configuration (see src/shared/esc) --------------------------------
  | { type: 'esc_session'; data: EscSessionSnapshot }
  | { type: 'esc_devices'; data: { sessionId: string; escs: EscDeviceInfo[] } }
  | { type: 'esc_settings'; data: EscSettingsSnapshot }
  | { type: 'esc_job_progress'; data: EscJobProgressSnapshot }
  | { type: 'esc_job_done'; data: EscJobResult }
  | { type: 'esc_op_error'; data: EscOperationError & { requestId?: string } }
  | { type: 'esc_log'; data: { sessionId: string; entries: EscLogEntry[] } }

// WebSocket message types (client -> server)
export type ClientMessage =
  | {
      type: 'command'
      requestId?: string
      cmd: string
      params: number[]
      safetyConfirmation?: 'arm' | 'disarm' | 'takeoff'
    }
  | { type: 'param_set'; requestId?: string; data: { id: string; value: number; paramType: number } }
  | { type: 'param_request_list'; requestId?: string }
  | { type: 'manual_control'; requestId?: string; data: ManualControlData }
  | {
      // Semantic mode change: the browser sends only the profile mode id and
      // the server encodes stack-specific MAV_CMD_DO_SET_MODE parameters.
      type: 'set_flight_mode'
      requestId?: string
      data: { modeId: number }
    }
  | {
      // Semantic calibration: the browser names the kind and the server maps
      // it to stack-specific MAV_CMD_PREFLIGHT_CALIBRATION parameters after
      // capability + armed checks.
      type: 'start_calibration'
      requestId: string
      data: { kind: 'accel' | 'gyro' | 'mag' | 'baro' }
    }
  | {
      type: 'motor_test'
      requestId?: string
      data: {
        instance: number
        throttle: number
        duration: number
        propsRemoved?: boolean
      }
    }
  | {
      type: 'select_target'
      requestId?: string
      data: { systemId: number; componentId: number }
    }
  | { type: 'release_control'; requestId?: string }
  | { type: 'fs_list'; requestId?: string; data: { path: string } }
  | { type: 'fs_download'; requestId?: string; data: { path: string } }
  | { type: 'fs_download_cancel'; requestId?: string }
  | {
      type: 'fs_delete'
      requestId?: string
      data: { entries: Array<{ path: string; kind: 'file' | 'dir' }> }
      safetyConfirmation: 'delete_files'
    }
  | { type: 'log_list'; requestId?: string }
  | { type: 'log_download'; requestId?: string; data: { logId: number } }
  | { type: 'log_download_cancel'; requestId?: string }
  | {
      // LOG_ERASE wipes ALL DataFlash logs on the FC (there is no per-log
      // delete), hence its own explicit safety confirmation literal.
      type: 'log_erase'
      requestId?: string
      safetyConfirmation: 'erase_all_logs'
    }
  // -- ESC configuration (see src/shared/esc) --------------------------------
  | { type: 'esc_session'; data: EscSessionSnapshot }
  | { type: 'esc_devices'; data: { sessionId: string; escs: EscDeviceInfo[] } }
  | { type: 'esc_settings'; data: EscSettingsSnapshot }
  | { type: 'esc_job_progress'; data: EscJobProgressSnapshot }
  | { type: 'esc_job_done'; data: EscJobResult }
  | { type: 'esc_op_error'; data: EscOperationError & { requestId?: string } }
  | { type: 'esc_log'; data: { sessionId: string; entries: EscLogEntry[] } }

// WebSocket message types (client -> server)
export type ClientMessage =
  | {
      type: 'command'
      requestId?: string
      cmd: string
      params: number[]
      safetyConfirmation?: 'arm' | 'disarm' | 'takeoff'
    }
  | { type: 'param_set'; requestId?: string; data: { id: string; value: number; paramType: number } }
  | { type: 'param_request_list'; requestId?: string }
  | { type: 'manual_control'; requestId?: string; data: ManualControlData }
  | {
      // Semantic mode change: the browser sends only the profile mode id and
      // the server encodes stack-specific MAV_CMD_DO_SET_MODE parameters.
      type: 'set_flight_mode'
      requestId?: string
      data: { modeId: number }
    }
  | {
      // Semantic calibration: the browser names the kind and the server maps
      // it to stack-specific MAV_CMD_PREFLIGHT_CALIBRATION parameters after
      // capability + armed checks.
      type: 'start_calibration'
      requestId: string
      data: { kind: 'accel' | 'gyro' | 'mag' | 'baro' }
    }
  | {
      type: 'motor_test'
      requestId?: string
      data: {
        instance: number
        throttle: number
        duration: number
        propsRemoved?: boolean
      }
    }
  | {
      type: 'select_target'
      requestId?: string
      data: { systemId: number; componentId: number }
    }
  | { type: 'release_control'; requestId?: string }
  | { type: 'fs_list'; requestId?: string; data: { path: string } }
  | { type: 'fs_download'; requestId?: string; data: { path: string } }
  | { type: 'fs_download_cancel'; requestId?: string }
  | {
      type: 'fs_delete'
      requestId?: string
      data: { entries: Array<{ path: string; kind: 'file' | 'dir' }> }
      safetyConfirmation: 'delete_files'
    }
  // -- ESC configuration -----------------------------------------------------
  | {
      type: 'esc_session_start'
      requestId?: string
      data:
        | { mode: 'ardupilot_passthrough' }
        | { mode: 'px4_serial_control'; channels: number[] }
        | { mode: 'direct'; port: string; baudRate?: 19200 }
    }
  | { type: 'esc_session_reclaim'; requestId?: string; data: { sessionId: string; recoveryToken: string } }
  | { type: 'esc_session_exit'; requestId?: string; data: { sessionId: string } }
  | { type: 'esc_devices_scan'; requestId?: string; data: { sessionId: string } }
  | {
      type: 'esc_settings_read'
      requestId?: string
      data: { sessionId: string; targets: number[] | 'all' }
    }
  | {
      type: 'esc_settings_write'
      requestId?: string
      data: { sessionId: string; targets: number[]; values: Record<string, number> }
    }
  | {
      type: 'esc_flash_start'
      requestId?: string
      data: { sessionId: string; targets: number[]; assetId: string; safetyConfirmation: 'flash_esc_props_removed' }
    }
  | { type: 'esc_flash_cancel'; requestId?: string; data: { sessionId: string; jobId: string } }
  | {
      type: 'esc_flash_decide'
      requestId?: string
      data: { sessionId: string; jobId: string; decision: 'retry_current' | 'skip_current' | 'exit' }
    }
  | { type: 'esc_melody_write'; requestId?: string; data: { sessionId: string; targets: number[]; rtttl: string } }

export interface PortInfo {
  path: string
  manufacturer?: string
  friendlyName?: string
  bluetoothAddress?: string
  recommended?: boolean
  productId?: string
  vendorId?: string
  pnpId?: string
}

export interface ConnectionConfig {
  type: 'serial' | 'bluetooth'
  port: string
  baudRate: number
  // Optional identifiers from the Web Serial chooser - used to match the
  // browser-selected device back to a Windows SPP COM port on the backend.
  vendorId?: string
  productId?: string
  bluetoothAddress?: string
  bluetoothServiceClassId?: string
}

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error'
