// MAVLink message types and shared interfaces between the page and local Worker

import type { VehicleIdentity, AutopilotFamily, VehicleClass, CalibrationKind } from './vehicleProfiles'
import type { VehicleConfigFeature } from './vehicleSetupProfiles'
import type {
  EscSessionSnapshot,
  EscDeviceInfo,
  EscSettingsSnapshot,
  EscJobProgressSnapshot,
  EscJobResult,
  EscLogEntry,
  EscSessionSafetyConfirmation,
} from './esc/types'
import type { EscOperationError } from './esc/errors'

export type { VehicleIdentity, AutopilotFamily, VehicleClass, CalibrationKind, VehicleConfigFeature }

export type AirframeApplyPhase = 'validating' | 'writing' | 'rebooting' | 'reboot_required' | 'done' | 'failed'

export interface RadioCalibrationChannel {
  channel: number
  min: number
  max: number
  trim: number
  reversed: boolean
  function: 'roll' | 'pitch' | 'throttle' | 'yaw' | 'aux' | null
}

export type RadioCalibrationStep =
  | 'center_throttle_low'
  | 'throttle_high'
  | 'throttle_low'
  | 'yaw_right'
  | 'yaw_left'
  | 'roll_right'
  | 'roll_left'
  | 'pitch_up'
  | 'pitch_down'
  | 'aux_sweep'
  | 'review'

export interface RadioCalibrationSnapshot {
  sessionId: string
  seq: number
  ownerClientId: string | null
  recoverUntil: number | null
  phase: 'sampling' | 'review' | 'writing' | 'done' | 'failed' | 'cancelled'
  step: RadioCalibrationStep
  stepIndex: number
  stepCount: number
  detectedChannels: number
  channels: RadioCalibrationChannel[]
  mapped: Partial<Record<'roll' | 'pitch' | 'throttle' | 'yaw', number>>
  updatedAt: number
  failureCode?: string
  failureReason?: string
}

// -- Sensor calibration sessions ---------------------------------------------

export type CalibrationPhase =
  | 'starting'
  | 'running'
  | 'waiting_position'
  | 'awaiting_accept'
  | 'accepted'
  | 'done'
  | 'failed'
  | 'cancelled'

/**
 * How the terminal outcome was established. 'verified' requires independent
 * protocol evidence ([cal] terminal line, 42429 sentinel, MAG_CAL_REPORT);
 * 'ack_only' means the FC merely accepted the command and the physical result
 * was never independently observed - the UI must not claim verified success.
 */
export type CalibrationVerification = 'verified' | 'ack_only' | 'not_applicable'

/** ACCELCAL_VEHICLE_POS positions 1..6 (LEVEL/LEFT/RIGHT/NOSEDOWN/NOSEUP/BACK). */
export type AccelCalibrationPosition = 1 | 2 | 3 | 4 | 5 | 6

export type CalibrationSide = 'down' | 'up' | 'left' | 'right' | 'front' | 'back'
export type CalibrationSideState = 'hidden' | 'pending' | 'active' | 'done'

export interface CalibrationMagInstanceState {
  id: number
  pct: number
  /** MAVLink MAG_CAL_STATUS value. */
  status: number
  attempt: number
  report?: {
    status: number
    fitness: number
    ofs: [number, number, number]
    autosaved: boolean
  }
}

/**
 * Idempotent calibration session snapshot. seq is strictly increasing within
 * one sessionId; clients must drop snapshots whose (sessionId, seq) is not
 * newer than the last applied one.
 */
export interface CalibrationSnapshot {
  sessionId: string
  seq: number
  ownerClientId: string | null
  /** While set, the owner is disconnected and may reclaim until this time. */
  recoverUntil: number | null
  /** requestId of the original start_calibration message. */
  requestId: string
  family: 'px4' | 'ardupilot'
  kind: CalibrationKind
  phase: CalibrationPhase
  verification: CalibrationVerification
  progress: number | null
  updatedAt: number
  /** Unknown PX4 [cal] protocol version: side semantics disabled. */
  protocolDegraded?: boolean
  sides?: Record<CalibrationSide, CalibrationSideState>
  requestedPosition?: AccelCalibrationPosition | null
  /** MAG_CAL cal_mask of expected compass instances. */
  expectedMagMask?: number
  magInstances?: CalibrationMagInstanceState[]
  failureCode?: string
  failureReason?: string
  rebootRequired: boolean
  cancelSupported: boolean
}

// -- In-flight controller autotune sessions ----------------------------------

export type AutotunePhase =
  | 'starting'
  | 'tuning'
  | 'paused'
  | 'verifying'
  | 'applying'
  | 'awaiting_disarm'
  | 'completed'
  | 'testing'
  | 'save_pending'
  | 'saved'
  | 'discarded'
  | 'failed'
  | 'interrupted'

export type AutotuneVerification =
  | 'not_applicable'
  | 'firmware_completed'
  | 'parameters_saved'

export interface AutotuneSnapshot {
  sessionId: string
  seq: number
  requestId: string
  ownerClientId: string | null
  recoverUntil: number | null
  family: 'px4' | 'ardupilot'
  phase: AutotunePhase
  verification: AutotuneVerification
  /** PX4 firmware progress. ArduPilot deliberately reports null. */
  progress: number | null
  axis: 'roll' | 'pitch' | 'yaw' | null
  initialModeId: number
  updatedAt: number
  cancelSupported: boolean
  /** Parameter values captured before the in-flight run. */
  baselineParameters: Record<string, number>
  failureCode?: string
  failureReason?: string
}

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

export interface VfrHudData {
  airspeed: number
  groundspeed: number
  alt: number
  climb: number
  heading: number
  throttle: number
}

export interface GlobalPositionData {
  lat: number
  lon: number
  alt: number
  relative_alt: number
  vx: number
  vy: number
  vz: number
  hdg: number | null
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
  source?: 'OPTICAL_FLOW' | 'OPTICAL_FLOW_RAD'
  integration_time_us: number
  integrated_x_rad: number
  integrated_y_rad: number
  /** Integrated sensor rotation in rad; null when the flow message reports NaN/unavailable. */
  integrated_xgyro_rad: number | null
  integrated_ygyro_rad: number | null
  integrated_zgyro_rad: number | null
  temperature_c: number | null
  time_delta_distance_us: number
  distance_m: number | null
  /** Native pixel displacement for OPTICAL_FLOW; compatibility alias for OPTICAL_FLOW_RAD. */
  flow_x: number
  /** Native pixel displacement for OPTICAL_FLOW; compatibility alias for OPTICAL_FLOW_RAD. */
  flow_y: number
  /** Compensated velocity for OPTICAL_FLOW; compatibility alias for OPTICAL_FLOW_RAD. */
  flow_comp_m_x: number | null
  /** Compensated velocity for OPTICAL_FLOW; compatibility alias for OPTICAL_FLOW_RAD. */
  flow_comp_m_y: number | null
  quality: number
  /** @deprecated Use distance_m. */
  ground_distance: number | null
  sensor_id: number
}

export interface DistanceSensorData {
  source?: 'DISTANCE_SENSOR' | 'RANGEFINDER'
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

export interface MessageRateConfig {
  attitude: number
  position: number
  sensors: number
  rc: number
  status: number
  hud: number
  auxiliary: number
}

// Dedicated Worker events (local runtime -> page)
export type RuntimeEvent =
  | {
      type: 'hello'
      data: {
        protocolVersion: number
        capabilities: string[]
        /** Worker-authoritative boundary for safety confirmations. */
        safetyEpoch: number
        /** Unique per local runtime; prevents epoch reuse after reconnect. */
        safetyAuthorityId: string
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
      type: 'safety_authority'
      data: {
        /** Advances on target, readiness, transport and local authority changes. */
        safetyEpoch: number
        safetyAuthorityId: string
        reason:
          | 'connection_changed'
          | 'safety_changed'
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
  // MAVLink-derived payloads cross an untrusted JSON boundary. Consumers
  // must validate data against msgType before writing it into application state.
  | { type: 'telemetry'; msgType: string; data: unknown }
  | { type: 'sensor'; msgType: string; data: unknown }
  | { type: 'message_rates'; data: MessageRateConfig }
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
        /** Same authoritative epoch carried by controller snapshots. */
        safetyEpoch: number
        safetyAuthorityId: string
        /** True while the serial link is exclusively borrowed by an ESC raw session. */
        rawSessionActive?: boolean
        port?: string
        type?: string
        baudRate?: number
        error?: {
          phase: 'connect' | 'runtime' | 'disconnect' | 'heartbeat' | 'reconnect'
          message: string
          code?: string
          timestamp: number
          retryable?: boolean
        }
        // Present while the tab-local transport is auto-reconnecting Bluetooth
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
      type: 'vehicle_config_set_result'
      data: {
        requestId: string
        feature: VehicleConfigFeature
        id: string
        accepted: boolean
        acceptedValue?: number
        reason?: string
      }
    }
  | {
      type: 'airframe_apply_status'
      data: {
        requestId: string
        phase: AirframeApplyPhase
        completed: number
        total: number
        currentId?: string
        reason?: string
        rollbackFailures?: string[]
      }
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
        /** Added by the local runtime boundary; bridge-local events may omit it. */
        safetyEpoch?: number
        safetyAuthorityId?: string
        reason: 'discovered' | 'selected' | 'reset'
        /** Unique stable targets are automatic; ambiguous links require an explicit choice. */
        selectionSource?: 'automatic' | 'explicit' | null
        conflict?: {
          reason: 'multiple_stable_targets' | 'same_system_identity_conflict'
          candidates: Array<{
            systemId: number
            componentId: number
            autopilot: number
            type: number
          }>
        } | null
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
  | { type: 'shell_output'; data: { text: string } }
  | { type: 'shell_status'; data: { active: boolean; reason?: string } }
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
        /** Opaque id of a temporary browser-local artifact. */
        artifactId: string
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
        /** Opaque id of a temporary browser-local artifact. */
        artifactId: string
        sizeBytes: number
        /** Size reported by LOG_ENTRY before any short end marker adjusted it. */
        advertisedSizeBytes: number
        sizeAdjusted: boolean
        /** LOG_REQUEST_DATA provides no checksum or authenticated digest. */
        integrity: 'unverified'
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
  | { type: 'esc_session_started'; data: { sessionId: string } }
  | { type: 'esc_devices'; data: { sessionId: string; escs: EscDeviceInfo[] } }
  | { type: 'esc_settings'; data: EscSettingsSnapshot }
  | { type: 'esc_job_progress'; data: EscJobProgressSnapshot }
  | { type: 'esc_job_done'; data: EscJobResult }
  | { type: 'esc_op_error'; data: EscOperationError & { requestId?: string } }
  | { type: 'esc_log'; data: { sessionId: string; entries: EscLogEntry[] } }
  // -- Sensor calibration sessions -------------------------------------------
  | { type: 'calibration_update'; data: CalibrationSnapshot }
  | {
      type: 'calibration_session_started'
      data: { sessionId: string; requestId: string }
    }
  | { type: 'autotune_update'; data: AutotuneSnapshot }
  | {
      type: 'autotune_session_started'
      data: { sessionId: string; requestId: string; recoveryToken: string }
    }
  | { type: 'radio_calibration_snapshot'; data: RadioCalibrationSnapshot }
  | {
      type: 'radio_calibration_started'
      data: { sessionId: string; requestId: string }
    }

// Dedicated Worker commands (page -> local runtime)
export type RuntimeCommand =
  | {
      type: 'command'
      requestId?: string
      cmd: string
      params: number[]
      safetyConfirmation?: 'arm' | 'disarm' | 'takeoff'
      /** Required for arming; disarming deliberately remains immediate. */
      expectedSafetyEpoch?: number
      expectedSafetyAuthorityId?: string
    }
  | {
      type: 'param_set'
      requestId?: string
      data: { id: string; value: number; paramType: number }
      /** Required for safety-sensitive parameters (CBRK_*, arming, failsafe, output mapping). */
      safetyConfirmation?: 'sensitive_param'
      expectedSafetyEpoch?: number
      expectedSafetyAuthorityId?: string
    }
  | {
      type: 'vehicle_config_set'
      requestId: string
      feature: VehicleConfigFeature
      data: { id: string; value: number }
      safetyConfirmation?: 'reduce_failsafe_protection'
      expectedSafetyEpoch?: number
      expectedSafetyAuthorityId?: string
    }
  | {
      type: 'airframe_apply'
      requestId: string
      data:
        | { family: 'px4'; autostartId: number }
        | { family: 'ardupilot'; frameClass: number; frameType: number }
      safetyConfirmation: 'apply_airframe'
      expectedSafetyEpoch: number
      expectedSafetyAuthorityId: string
    }
  | {
      type: 'radio_calibration_start'
      requestId: string
      data: { transmitterMode: 1 | 2 | 3 | 4 }
      expectedSafetyEpoch: number
      expectedSafetyAuthorityId: string
    }
  | { type: 'radio_calibration_advance'; requestId: string; data: { sessionId: string } }
  | { type: 'radio_calibration_cancel'; requestId: string; data: { sessionId: string } }
  | { type: 'param_request_list'; requestId?: string }
  | { type: 'message_rates_set'; requestId?: string; data: MessageRateConfig }
  | { type: 'shell_open'; requestId?: string }
  | { type: 'shell_write'; requestId?: string; data: { text: string } }
  | { type: 'shell_close'; requestId?: string }
  | {
      type: 'reboot_vehicle'
      requestId: string
      safetyConfirmation: 'reboot_flight_controller'
      expectedSafetyEpoch: number
      expectedSafetyAuthorityId: string
    }
  | { type: 'manual_control'; requestId?: string; data: ManualControlData }
  | {
      // Semantic mode change: the browser sends only the profile mode id and
      // the Worker encodes stack-specific MAV_CMD_DO_SET_MODE parameters.
      type: 'set_flight_mode'
      requestId?: string
      data: { modeId: number }
    }
  | {
      // Semantic calibration: the browser names the kind and the Worker maps
      // it to stack-specific MAV_CMD_PREFLIGHT_CALIBRATION parameters after
      // capability + armed checks.
      type: 'start_calibration'
      requestId: string
      data: { kind: CalibrationKind }
    }
  | {
      // Owner-only interaction with the active calibration session. cancel
      // is the safety exit; confirm_position answers an ArduPilot 42429
      // position request; accept_mag accepts a successful compass report.
      type: 'calibration_action'
      requestId: string
      data:
        | { sessionId: string; action: 'cancel' }
        | { sessionId: string; action: 'confirm_position'; position: AccelCalibrationPosition }
        | { sessionId: string; action: 'accept_mag' }
    }
  | {
      // Reattach a disconnected owner to its running calibration session.
      type: 'calibration_reclaim'
      requestId: string
      data: { sessionId: string; recoveryToken: string }
    }
  | {
      type: 'autotune_start'
      requestId: string
      safetyConfirmation: 'autotune_in_flight'
      expectedSafetyEpoch: number
      expectedSafetyAuthorityId: string
    }
  | {
      type: 'autotune_action'
      requestId: string
      data: {
        sessionId: string
        action: 'abort' | 'test_gains' | 'restore_gains'
      }
    }
  | {
      type: 'autotune_reclaim'
      requestId: string
      data: { sessionId: string; recoveryToken: string }
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
      expectedSafetyEpoch?: number
      expectedSafetyAuthorityId?: string
    }
  | {
      /** One runtime operation that fans out to multiple 1-based motor instances. */
      type: 'motor_test_batch'
      requestId?: string
      data: {
        instances: number[]
        throttle: number
        duration: number
        propsRemoved?: boolean
      }
      expectedSafetyEpoch?: number
      expectedSafetyAuthorityId?: string
    }
  | {
      type: 'select_target'
      requestId?: string
      data: { systemId: number; componentId: number }
    }
  | { type: 'fs_list'; requestId?: string; data: { path: string } }
  | { type: 'fs_download'; requestId?: string; data: { path: string } }
  | { type: 'fs_download_cancel'; requestId?: string }
  | {
      type: 'fs_delete'
      requestId?: string
      data: { entries: Array<{ path: string; kind: 'file' | 'dir' }> }
      safetyConfirmation: 'delete_files'
      expectedSafetyEpoch: number
      expectedSafetyAuthorityId: string
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
      expectedSafetyEpoch: number
      expectedSafetyAuthorityId: string
    }
  // -- ESC configuration -----------------------------------------------------
  | {
      type: 'esc_session_start'
      requestId?: string
      safetyConfirmation: EscSessionSafetyConfirmation
      expectedSafetyEpoch: number
      expectedSafetyAuthorityId: string
      data:
        | { mode: 'ardupilot_passthrough' }
        | { mode: 'px4_serial_control'; channels: number[] }
        | { mode: 'direct' }
    }
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

/**
 * Physical link technology behind a browser-authorized port descriptor. BLE
 * GATT remains reserved for a future adapter and cannot masquerade as SPP.
 */
export type ConnectionTransport = 'serial' | 'bluetooth-spp' | 'bluetooth-ble'

export type DeviceAvailability = 'available' | 'paired' | 'offline' | 'unknown'

export interface PortInfo {
  path: string
  manufacturer?: string
  friendlyName?: string
  bluetoothAddress?: string
  bluetoothChannel?: number
  bluetoothServiceClassId?: string
  recommended?: boolean
  productId?: string
  vendorId?: string
  pnpId?: string
  // Opaque browser-local identifier for a granted port. It is only a UI key;
  // the browser remains responsible for the actual port permission.
  deviceId?: string
  transport?: ConnectionTransport
  // Stable device path on Linux (/dev/serial/by-id/...); survives renumbering.
  stablePath?: string
  // Operator-facing label (friendly name or manufacturer + serial suffix).
  displayName?: string
  serialNumber?: string
  usbLocationId?: string
  // Browser-authorized Bluetooth ports may still be unavailable until the
  // device is powered and the browser reopens the grant.
  availability?: DeviceAvailability
  // Kept for compatibility with saved presets from older releases.
  requiresDeepResolution?: boolean
}

export interface ConnectionConfig {
  type: 'serial' | 'bluetooth'
  port: string
  baudRate: number
  // Optional identifiers from the Web Serial chooser, used only to label and
  // re-identify a grant inside this browser profile.
  vendorId?: string
  productId?: string
  bluetoothAddress?: string
  bluetoothServiceClassId?: string
  bluetoothChannel?: number
  // Optional identity fields retained by a saved preset. The browser picker
  // remains the authority when a saved identity cannot be re-matched.
  deviceId?: string
  transport?: ConnectionTransport
  stablePath?: string
  serialNumber?: string
}

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error'
