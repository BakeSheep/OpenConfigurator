import { EventEmitter } from 'events'
import { performance } from 'node:perf_hooks'
import {
  common,
  minimal,
  standard,
  decode,
  MavlinkCodecSession,
  codecOptionsFromEnvironment,
  type MavlinkCodecSessionOptions,
  type MavlinkMessage,
} from './codec'
import type { MavLinkData } from 'node-mavlink'
import { ConnectionManager } from '../connection/ConnectionManager'
import type { SerialWritePriority } from '../connection/SerialConnection'
import { MAVLINK_COMMANDS, PX4_MODES } from '../../shared/constants'
import type { ServerMessage, ClientMessage, ManualControlData, RcChannelsData } from '../../shared/types'

const SERIAL_PARAM_STALL_TIMEOUT_MS = 1800
const BLUETOOTH_PARAM_STALL_TIMEOUT_MS = 3500
// While actively chasing individual gaps, continue to the next batch shortly
// after replies arrive instead of waiting a full stall window. Without this the
// tail crawls at one batch per stall window, because every received PARAM_VALUE
// resets the stall timer to its full length.
const SERIAL_PARAM_RECOVERY_INTERVAL_MS = 150
const BLUETOOTH_PARAM_RECOVERY_INTERVAL_MS = 300
const SERIAL_PARAM_RETRY_BATCH_SIZE = 32
const BLUETOOTH_PARAM_RETRY_BATCH_SIZE = 8
const PARAM_MAX_STALL_RETRIES = 12
const PARAM_MAX_COUNT = 8192
const PARAM_MAX_READ_REQUESTS = 4096
const SERIAL_PARAM_DEADLINE_MS = 60_000
const BLUETOOTH_PARAM_DEADLINE_MS = 120_000
const MAV_PROTOCOL_CAPABILITY_PARAM_ENCODE_BYTEWISE = 16n
const MAV_PROTOCOL_CAPABILITY_PARAM_ENCODE_C_CAST = 131072n
const MAV_PROTOCOL_CAPABILITY_MAVLINK2 = 8192n
const MAV_CMD_REQUEST_AUTOPILOT_CAPABILITIES = 520
const MAV_RESULT_ACCEPTED = 0
const MAV_RESULT_TEMPORARILY_REJECTED = 1
const MAV_RESULT_UNSUPPORTED = 3
const MAV_RESULT_IN_PROGRESS = 5
const COMMAND_ACK_PROGRESS_UNKNOWN = 0xff
const STATUSTEXT_TTL_MS = 10_000
const STATUSTEXT_MAX_ASSEMBLIES = 64
const STATUSTEXT_MAX_BYTES = 4096
const MAX_DISCOVERED_TARGETS = 32
const MAX_PENDING_PARAM_SETS = 64
const VERSION_MAX_ATTEMPTS = 3
const HIGH_RISK_COMMANDS = new Set([22, 183, 209, 310, 400])
const HANDLED_MESSAGE_IDS = new Set([
  1, 22, 24, 26, 27, 29, 30, 33, 36, 65, 74, 77, 105, 106, 116, 129,
  132, 147, 148, 230, 245, 253,
])
type ParamEncoding = 'bytewise' | 'c-cast'
type TelemetryProfile = 'normal' | 'parameter-sync'
type MessageIntervalSupport = 'unknown' | 'supported' | 'unsupported'

export interface MavlinkBridgeOptions {
  codec?: MavlinkCodecSessionOptions
  commandTimeoutMs?: number
  paramSetTimeoutMs?: number
  versionRetryMs?: number
}

interface DiscoveredTarget {
  systemId: number
  componentId: number
  autopilot: number
  lastHeartbeatAt: number
}

interface PendingCommand {
  requestId?: string
  command: number
  params: number[]
  attempt: number
  maxAttempts: number
  confirmation: number
  priority: SerialWritePriority
  deadlineAt: number
  timeout: ReturnType<typeof setTimeout> | null
}

interface PendingParamSet {
  requestId?: string
  id: string
  value: number
  paramType: number
  attempt: number
  timeout: ReturnType<typeof setTimeout> | null
  lastMismatch?: 'value_mismatch' | 'type_mismatch'
  lastAcceptedValue?: number
}

interface StatustextAssembly {
  severity: number
  chunks: Buffer[]
  byteLength: number
  nextSequence: number
  updatedAt: number
}

const MAV_SYS_STATUS_SENSOR_LABELS: Array<[number, string]> = [
  [0x00000001, '陀螺仪'],
  [0x00000002, '加速度计'],
  [0x00000004, '磁力计'],
  [0x00000008, '气压计'],
  [0x00000010, '差压计'],
  [0x00000020, 'GPS'],
  [0x00000040, '光流'],
  [0x00000080, '视觉定位'],
  [0x00000100, '测距仪'],
  [0x00000400, '角速度控制'],
  [0x00000800, '姿态控制'],
  [0x00001000, '偏航估计'],
  [0x00002000, '高度估计'],
  [0x00004000, '水平位置估计'],
  [0x00008000, '电机输出'],
  [0x00010000, 'RC 输入'],
  [0x00100000, '地理围栏'],
  [0x00200000, 'AHRS'],
  [0x00400000, '地形'],
  [0x01000000, '日志'],
  [0x02000000, '电池'],
  [0x04000000, '近距传感器'],
  [0x10000000, '飞行前检查'],
  [0x20000000, '避障'],
  [0x40000000, '推进系统'],
]

const BOARD_NAMES: Record<number, string> = {
  1139: 'MicoAir405',
  1150: 'MicoAir405v2',
  1161: 'MicoAir405Mini',
  1166: 'MicoAir743',
  1176: 'MicoAir743-AIO',
  1179: 'MicoAir743v2',
}

export class MavlinkBridge extends EventEmitter {
  private connManager: ConnectionManager
  private readonly options: Required<Omit<MavlinkBridgeOptions, 'codec'>> & { codec: MavlinkCodecSessionOptions }
  private codec: MavlinkCodecSession
  private linkStatsTimer: ReturnType<typeof setInterval> | null = null
  private lastRxBytes = 0
  private lastTxBytes = 0
  private lastCrcErrors = 0
  private lastLinkSampleAt = performance.now()
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null
  private requestedTelemetryStreams = false
  private messageIntervalSupport: MessageIntervalSupport = 'unknown'
  private messageIntervalFallbackTimer: ReturnType<typeof setTimeout> | null = null
  private paramExpectedCount = 0
  private paramIndices = new Set<number>()
  private paramDownloadActive = false
  private paramDownloadDeadlineAt = 0
  private paramReadRequests = 0
  // True once we stop waiting for PX4's initial stream and begin actively
  // requesting individual missing indices. Controls the reschedule cadence.
  private paramRecovering = false
  private paramRetryAttempt = 0
  private paramRetryCursor = 0
  private paramRetryTimer: ReturnType<typeof setTimeout> | null = null
  private paramEncoding: ParamEncoding = 'c-cast'
  private paramEncodingNegotiated = false
  private versionAttempt = 0
  private versionTimer: ReturnType<typeof setTimeout> | null = null
  private targetSysId: number | null = null
  private targetCompId: number | null = null
  private selectedHeartbeatReady = false
  private readonly discoveredTargets = new Map<string, DiscoveredTarget>()
  private statustextChunks = new Map<string, StatustextAssembly>()
  private telemetryProfile: TelemetryProfile | null = null
  private readonly pendingCommands = new Map<number, PendingCommand>()
  private readonly uncertainCommands = new Set<number>()
  private readonly commandQuarantineUntil = new Map<number, number>()
  private readonly pendingParamSets = new Map<string, PendingParamSet>()
  private pendingManualControl: ManualControlData | null = null
  private manualControlFlushHandle: ReturnType<typeof setImmediate> | null = null
  private destroyed = false

  private onData = (data: Buffer) => {
    this.codec.write(data)
  }

  private onCodecMessage = (msg: MavlinkMessage) => {
    try {
      this.handleMessage(msg)
    } catch (err) {
      console.error('[MAVLink] handler error for msgId', msg.msgId, err)
    }
  }

  private onStatusChange = (status: string) => {
    this.cancelProtocolOperations(false, 'connection_changed')
    if (status === 'connected') {
      // Transport-open is enough to parse bytes and send the GCS heartbeat.
      // Vehicle-ready is established only by a validated selected heartbeat.
      this.codec.reset()
      this.resetTargetState(true)
      this.startHeartbeat()
      this.startLinkStats()
    } else {
      this.resetTargetState(true)
      this.stopHeartbeat()
      this.stopLinkStats()
    }
  }

  constructor(connManager: ConnectionManager, options: MavlinkBridgeOptions = {}) {
    super()
    this.connManager = connManager
    this.options = {
      codec: { ...codecOptionsFromEnvironment(), ...options.codec },
      commandTimeoutMs: options.commandTimeoutMs ?? 1500,
      paramSetTimeoutMs: options.paramSetTimeoutMs ?? 1500,
      versionRetryMs: options.versionRetryMs ?? 1800,
    }
    this.codec = new MavlinkCodecSession(this.options.codec)
    this.codec.on('message', this.onCodecMessage)
    this.codec.on('parserError', (error) => {
      console.error('[MAVLink] parser error; session rebuilt', error)
    })
    this.connManager.on('data', this.onData)
    this.connManager.on('statusChange', this.onStatusChange)
  }

  private targetKey(systemId: number, componentId: number): string {
    return `${systemId}:${componentId}`
  }

  private rememberDiscoveredTarget(target: DiscoveredTarget): boolean {
    const key = this.targetKey(target.systemId, target.componentId)
    const existed = this.discoveredTargets.has(key)
    if (existed) this.discoveredTargets.delete(key)
    while (this.discoveredTargets.size >= MAX_DISCOVERED_TARGETS) {
      const oldestNonSelected = [...this.discoveredTargets.keys()].find((candidate) =>
        candidate !== this.targetKey(this.targetSysId ?? -1, this.targetCompId ?? -1)
      )
      if (!oldestNonSelected) break
      this.discoveredTargets.delete(oldestNonSelected)
    }
    this.discoveredTargets.set(key, target)
    return !existed
  }

  private isSelectedSource(msg: Pick<MavlinkMessage, 'sysId' | 'compId'>): boolean {
    return this.targetSysId !== null
      && this.targetCompId !== null
      && msg.sysId === this.targetSysId
      && msg.compId === this.targetCompId
  }

  private hasReadyTarget(): boolean {
    const managerReady = (this.connManager as ConnectionManager & {
      vehicleReady?: boolean
    }).vehicleReady
    return this.targetSysId !== null
      && this.targetCompId !== null
      && this.selectedHeartbeatReady
      && managerReady !== false
  }

  private emitTarget(reason: 'discovered' | 'selected' | 'reset'): void {
    this.emit('message', {
      type: 'target',
      data: {
        systemId: this.targetSysId,
        componentId: this.targetCompId,
        ready: this.hasReadyTarget(),
        reason,
        discovered: [...this.discoveredTargets.values()].map((target) => ({
          systemId: target.systemId,
          componentId: target.componentId,
          autopilot: target.autopilot,
        })),
      },
    } as ServerMessage)
  }

  private emitOperationError(
    operation: string,
    code: string,
    message: string,
    requestId?: string,
    retryable = false,
  ): void {
    this.emit('message', {
      type: 'operation_error',
      data: { requestId, operation, code, message, retryable },
    } as ServerMessage)
  }

  private requireReadyTarget(operation: string, requestId?: string): boolean {
    if (this.hasReadyTarget()) return true
    this.emitOperationError(
      operation,
      'target_not_ready',
      '尚未收到已选飞控的有效心跳',
      requestId,
      true,
    )
    return false
  }

  private writeMessage(
    message: MavLinkData,
    priority: SerialWritePriority = 'normal',
  ): boolean {
    try {
      const result = this.connManager.write(
        this.codec.serialize(message),
        priority,
      ) as boolean | void
      return result !== false
    } catch (error) {
      console.error('[MAVLink] outbound serialization/write failed', error)
      return false
    }
  }

  private resetTargetState(clearDiscovery: boolean): void {
    this.targetSysId = null
    this.targetCompId = null
    this.selectedHeartbeatReady = false
    if (clearDiscovery) this.discoveredTargets.clear()
    this.resetSelectedProtocolState()
    this.emitTarget('reset')
  }

  private resetSelectedProtocolState(): void {
    this.requestedTelemetryStreams = false
    this.telemetryProfile = null
    this.messageIntervalSupport = 'unknown'
    if (this.messageIntervalFallbackTimer) {
      clearTimeout(this.messageIntervalFallbackTimer)
      this.messageIntervalFallbackTimer = null
    }
    this.paramEncoding = 'c-cast'
    this.paramEncodingNegotiated = false
    this.versionAttempt = 0
    if (this.versionTimer) {
      clearTimeout(this.versionTimer)
      this.versionTimer = null
    }
    this.statustextChunks.clear()
    this.pendingManualControl = null
    if (this.manualControlFlushHandle) {
      clearImmediate(this.manualControlFlushHandle)
      this.manualControlFlushHandle = null
    }
  }

  private cancelProtocolOperations(restoreTelemetry: boolean, reason: string): void {
    this.cancelParamDownload(restoreTelemetry, reason)
    for (const pending of this.pendingCommands.values()) {
      if (pending.timeout) clearTimeout(pending.timeout)
      this.emitOperationError(
        'command',
        reason,
        '命令事务因连接或目标变化而取消',
        pending.requestId,
        true,
      )
    }
    this.pendingCommands.clear()
    this.uncertainCommands.clear()
    this.commandQuarantineUntil.clear()
    for (const pending of this.pendingParamSets.values()) {
      if (pending.timeout) clearTimeout(pending.timeout)
      this.emit('message', {
        type: 'param_set_result',
        data: {
          requestId: pending.requestId,
          id: pending.id,
          requestedValue: pending.value,
          accepted: false,
          attempt: pending.attempt,
          reason,
        },
      } as ServerMessage)
    }
    this.pendingParamSets.clear()
  }

  private selectTarget(systemId: number, componentId: number, requestId?: string): void {
    const discovered = this.discoveredTargets.get(this.targetKey(systemId, componentId))
    if (!discovered) {
      this.emitOperationError(
        'select_target',
        'target_not_discovered',
        `未发现飞控 ${systemId}:${componentId}`,
        requestId,
      )
      return
    }
    if (this.targetSysId === systemId && this.targetCompId === componentId) {
      this.emitTarget('selected')
      return
    }
    this.cancelProtocolOperations(false, 'target_switched')
    this.targetSysId = systemId
    this.targetCompId = componentId
    this.selectedHeartbeatReady = false
    this.resetSelectedProtocolState()
    this.emitTarget('selected')
  }

  private startHeartbeat() {
    this.stopHeartbeat()
    this.sendHeartbeat()
    this.heartbeatInterval = setInterval(() => {
      this.sendHeartbeat()
    }, 1000)
  }

  private stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval)
      this.heartbeatInterval = null
    }
  }

  private startLinkStats() {
    this.stopLinkStats()
    this.lastCrcErrors = 0
    this.lastRxBytes = this.connManager.bytesReceived
    this.lastTxBytes = this.connManager.bytesSent
    this.lastLinkSampleAt = performance.now()
    this.linkStatsTimer = setInterval(() => {
      const sampledAt = performance.now()
      const elapsedSeconds = Math.max(0.001, (sampledAt - this.lastLinkSampleAt) / 1000)
      const rx = this.connManager.bytesReceived
      const tx = this.connManager.bytesSent
      const codecStats = this.codec.stats
      const crc = codecStats.crcErrors
      const rxBps = Math.max(0, rx - this.lastRxBytes) / elapsedSeconds
      const txBps = Math.max(0, tx - this.lastTxBytes) / elapsedSeconds
      const crcErrorsPerSec = Math.max(0, crc - this.lastCrcErrors) / elapsedSeconds
      this.lastRxBytes = rx
      this.lastTxBytes = tx
      this.lastCrcErrors = crc
      this.lastLinkSampleAt = sampledAt
      this.emit('message', {
        type: 'link_stats',
        data: {
          rxBps,
          txBps,
          crcErrors: crc,
          crcErrorsPerSec,
          rxPackets: codecStats.rxPackets,
          txPackets: codecStats.txPackets,
          rxSequenceLost: codecStats.rxSequenceLost,
          rxDuplicates: codecStats.rxDuplicates,
          rxOutOfOrder: codecStats.rxOutOfOrder,
          rejectedPackets: codecStats.rejectedPackets,
          garbageBytes: codecStats.garbageBytes,
          protocolVersion: codecStats.protocol,
        },
      } as ServerMessage)
    }, 1000)
  }

  private stopLinkStats() {
    if (this.linkStatsTimer) {
      clearInterval(this.linkStatsTimer)
      this.linkStatsTimer = null
    }
  }

  private sendHeartbeat() {
    // HEARTBEAT as a GCS: type=GCS(6), autopilot=INVALID(8),
    // base_mode=CUSTOM_MODE_ENABLED(1), system_status=ACTIVE(4). A healthy,
    // valid GCS heartbeat makes PX4 enable capability negotiation (a zero
    // status can make PX4 treat the GCS as faulty and withhold capabilities).
    const hb = new minimal.Heartbeat()
    hb.customMode = 0
    hb.type = 6
    hb.autopilot = 8
    hb.baseMode = 1
    hb.systemStatus = 4
    hb.mavlinkVersion = 3
    this.writeMessage(hb, 'high')
  }

  private handleMessage(msg: MavlinkMessage) {
    // Discovery is the only cross-source operation. Once selected, every
    // other protocol service is scoped to the exact system/component pair.
    if (msg.msgId === 0) {
      this.handleHeartbeat(msg)
      return
    }
    if (!this.isSelectedSource(msg)) return
    // The codec has already validated framing, CRC and (when configured)
    // signatures. Every such frame from the selected autopilot is proof that
    // the link is alive, even when SkyLab has no handler for that message id.
    this.connManager.notifyAutopilotActivity()
    if (!HANDLED_MESSAGE_IDS.has(msg.msgId)) return

    switch (msg.msgId) {
      case 1: // SYS_STATUS
        this.handleSysStatus(msg)
        break
      case 24: // GPS_RAW_INT
        this.handleGps(msg)
        break
      case 26: // SCALED_IMU
        this.handleScaledImu(msg)
        break
      case 27: // RAW_IMU
        this.handleRawImu(msg)
        break
      case 105: // HIGHRES_IMU
        this.handleHighresImu(msg)
        break
      case 116: // SCALED_IMU2
      case 129: // SCALED_IMU3
        this.handleScaledImu(msg)
        break
      case 29: // SCALED_PRESSURE
        this.handleScaledPressure(msg)
        break
      case 30: // ATTITUDE
        this.handleAttitude(msg)
        break
      case 33: // GLOBAL_POSITION_INT
        this.handleGlobalPosition(msg)
        break
      case 36: // SERVO_OUTPUT_RAW
        this.handleServoOutputRaw(msg)
        break
      case 65: // RC_CHANNELS
        this.handleRcChannels(msg)
        break
      case 74: // VFR_HUD
        this.handleVfrHud(msg)
        break
      case 77: // COMMAND_ACK
        this.handleCommandAck(msg)
        break
      case 106: // OPTICAL_FLOW_RAD
        this.handleOpticalFlow(msg)
        break
      case 132: // DISTANCE_SENSOR
        this.handleDistanceSensor(msg)
        break
      case 147: // BATTERY_STATUS
        this.handleBattery(msg)
        break
      case 148: // AUTOPILOT_VERSION
        this.handleAutopilotVersion(msg)
        break
      case 230: // ESTIMATOR_STATUS
        this.handleEstimatorStatus(msg)
        break
      case 245: // EXTENDED_SYS_STATE
        this.handleExtendedSysState(msg)
        break
      case 22: // PARAM_VALUE
        this.handleParamValue(msg)
        break
      case 253: // STATUSTEXT
        this.handleStatustext(msg)
        break
    }
  }

  private handleHeartbeat(msg: MavlinkMessage) {
    const hb = decode<minimal.Heartbeat>(0, msg.payload)
    // Ignore heartbeats from non-autopilot components (autopilot=INVALID(8)),
    // e.g. a companion computer, camera, or gimbal sharing the MAVLink system.
    if (!hb || hb.autopilot === 8) return
    if (msg.sysId <= 0 || msg.sysId >= 255 || msg.compId <= 0) return
    const newlyDiscovered = this.rememberDiscoveredTarget({
      systemId: msg.sysId,
      componentId: msg.compId,
      autopilot: hb.autopilot,
      lastHeartbeatAt: performance.now(),
    })
    if (this.targetSysId === null) {
      this.targetSysId = msg.sysId
      this.targetCompId = msg.compId
      this.resetSelectedProtocolState()
      this.emitTarget('discovered')
    } else if (newlyDiscovered && !this.isSelectedSource(msg)) {
      this.emitTarget('discovered')
    }
    if (!this.isSelectedSource(msg)) return

    const becameReady = !this.selectedHeartbeatReady
    this.selectedHeartbeatReady = true
    this.connManager.notifyAutopilotHeartbeat()
    if (becameReady) this.emitTarget('selected')
    // Use the autopilot class only as an early compatibility fallback. The
    // authoritative encoding is negotiated from AUTOPILOT_VERSION capabilities.
    if (!this.paramEncodingNegotiated) {
      this.paramEncoding = hb.autopilot === 12 ? 'bytewise' : 'c-cast'
    }
    if (this.versionAttempt === 0) this.requestAutopilotVersion()

    const armed = (hb.baseMode & 0x80) !== 0
    const mode = this.getMode(hb.customMode)
    this.emit('message', {
      type: 'status',
      data: {
        armed,
        mode: mode.name,
        modeId: mode.id,
        // PX4 reports failsafe via STATUSTEXT / SYS_STATUS sensor flags rather
        // than a dedicated HEARTBEAT bit, so it cannot be reliably derived
        // here. Report 'unknown' instead of a misleading hardcoded false - a
        // safety-critical field must never silently claim "no failsafe".
        failsafe: 'unknown',
        systemStatus: hb.systemStatus,
      },
    } as ServerMessage)

    // Ask PX4 for the streams used by the live UI once the first autopilot
    // heartbeat proves the MAVLink link is ready. Some PX4 profiles publish
    // HIGHRES_IMU instead of SCALED_IMU by default, so support and request
    // both. The bridge normalizes either format into the shared ImuData shape.
    if (!this.requestedTelemetryStreams) {
      this.requestedTelemetryStreams = true
      this.applyTelemetryProfile('normal')
    }
  }

  private handleServoOutputRaw(msg: MavlinkMessage) {
    if (msg.payload.length < 21) return
    const d = decode<common.ServoOutputRaw>(36, msg.payload)
    if (!d) return
    const servoValues = [
      d.servo1Raw, d.servo2Raw, d.servo3Raw, d.servo4Raw,
      d.servo5Raw, d.servo6Raw, d.servo7Raw, d.servo8Raw,
      d.servo9Raw, d.servo10Raw, d.servo11Raw, d.servo12Raw,
      d.servo13Raw, d.servo14Raw, d.servo15Raw, d.servo16Raw,
    ]
    // A servo output is only "present" if its bytes were actually transmitted.
    // Trailing absent channels stay null (not 0), keyed off the frame's true
    // length, so the UI does not draw motors the vehicle never reported.
    const outputs: Array<number | null> = servoValues.map((value, i) => {
      const offset = i < 8 ? 4 + i * 2 : 21 + (i - 8) * 2
      return offset + 2 <= msg.payload.length ? value : null
    })
    while (outputs.length > 4 && outputs[outputs.length - 1] == null) outputs.pop()
    this.emit('message', {
      type: 'motor_outputs',
      data: {
        time_usec: d.timeUsec,
        port: d.port,
        outputs,
      },
    } as ServerMessage)
  }

  private handleSysStatus(msg: MavlinkMessage) {
    const d = decode<common.SysStatus>(1, msg.payload)
    if (!d) return
    // These are bitmask fields; node-mavlink types them as the sensor enum, so
    // widen to number for the bitwise/comparison logic below.
    const sensorsPresent: number = d.onboardControlSensorsPresent
    const sensorsEnabled: number = d.onboardControlSensorsEnabled
    const sensorsHealth: number = d.onboardControlSensorsHealth
    const voltageBattery = d.voltageBattery === 0xffff ? null : d.voltageBattery / 1000
    const currentBattery = d.currentBattery === -1 ? null : d.currentBattery / 100
    // battery_remaining is at wire offset 30. The previous hand-rolled parser
    // read offset 18 (drop_rate_comm) - a latent bug fixed by this migration.
    const batteryRemaining = d.batteryRemaining === -1 ? null : d.batteryRemaining
    const prearmCheckMask = 0x10000000
    const supportsPreflightCheck = (sensorsPresent & prearmCheckMask) !== 0
    const unhealthySensorMask = (sensorsEnabled & ~sensorsHealth) >>> 0
    const unhealthySensors = MAV_SYS_STATUS_SENSOR_LABELS
      .filter(([mask]) => (unhealthySensorMask & mask) !== 0)
      .map(([, label]) => label)
    const knownMask = MAV_SYS_STATUS_SENSOR_LABELS.reduce((mask, [sensorMask]) => (mask | sensorMask) >>> 0, 0)
    const unknownMask = (unhealthySensorMask & ~knownMask) >>> 0
    if (unknownMask !== 0) unhealthySensors.push(`未知系统 0x${unknownMask.toString(16).padStart(8, '0')}`)
    this.emit('message', {
      type: 'telemetry',
      msgType: 'SYS_STATUS',
      data: {
        voltageBattery,
        currentBattery,
        batteryRemaining,
        sensorsPresent,
        sensorsEnabled,
        sensorsHealth,
        unhealthySensorMask,
        unhealthySensors,
        sensorsHealthy: sensorsEnabled !== 0
          ? unhealthySensorMask === 0
          : null,
        preflightCheck: supportsPreflightCheck
          ? (sensorsHealth & prearmCheckMask) !== 0
          : null,
      },
    } as ServerMessage)
  }

  private handleGps(msg: MavlinkMessage) {
    const d = decode<common.GpsRawInt>(24, msg.payload)
    if (!d) return
    const data = {
      fix_type: d.fixType,
      lat: d.lat / 1e7,
      lon: d.lon / 1e7,
      alt: d.alt / 1000,
      eph: d.eph === 0xffff ? null : d.eph / 100,
      epv: d.epv === 0xffff ? null : d.epv / 100,
      vel: d.vel === 0xffff ? null : d.vel / 100,
      cog: d.cog === 0xffff ? null : d.cog / 100,
      satellites_visible: d.satellitesVisible === 0xff ? null : d.satellitesVisible,
    }
    this.emit('message', { type: 'telemetry', msgType: 'GPS_RAW_INT', data } as ServerMessage)
  }

  private handleScaledImu(msg: MavlinkMessage) {
    const d = decode<common.ScaledImu>(msg.msgId, msg.payload)
    if (!d) return
    const data = {
      instance: msg.msgId === 116 ? 1 : msg.msgId === 129 ? 2 : 0,
      units: 'normalized' as const,
      xacc: d.xacc / 1000,
      yacc: d.yacc / 1000,
      zacc: d.zacc / 1000,
      xgyro: d.xgyro / 1000,
      ygyro: d.ygyro / 1000,
      zgyro: d.zgyro / 1000,
      xmag: d.xmag,
      ymag: d.ymag,
      zmag: d.zmag,
      temperature: d.temperature === 0 ? null : d.temperature / 100,
    }
    this.emit('message', { type: 'sensor', msgType: msg.msgId === 116 ? 'SCALED_IMU2' : msg.msgId === 129 ? 'SCALED_IMU3' : 'SCALED_IMU', data } as ServerMessage)
  }

  private handleHighresImu(msg: MavlinkMessage) {
    const d = decode<common.HighresImu>(105, msg.payload)
    if (!d) return
    const standardGravity = 9.80665
    const data = {
      instance: d.id,
      units: 'normalized' as const,
      // Keep the frontend's existing units: acceleration in g, angular speed
      // in rad/s, and magnetic field in milligauss.
      xacc: d.xacc / standardGravity,
      yacc: d.yacc / standardGravity,
      zacc: d.zacc / standardGravity,
      xgyro: d.xgyro,
      ygyro: d.ygyro,
      zgyro: d.zgyro,
      xmag: d.xmag * 1000,
      ymag: d.ymag * 1000,
      zmag: d.zmag * 1000,
      temperature: Number.isFinite(d.temperature) ? d.temperature : null,
    }
    this.emit('message', { type: 'sensor', msgType: 'HIGHRES_IMU', data } as ServerMessage)
  }

  private handleRawImu(msg: MavlinkMessage) {
    const d = decode<common.RawImu>(27, msg.payload)
    if (!d) return
    const data = {
      instance: d.id,
      units: 'raw' as const,
      xacc: d.xacc,
      yacc: d.yacc,
      zacc: d.zacc,
      xgyro: d.xgyro,
      ygyro: d.ygyro,
      zgyro: d.zgyro,
      xmag: d.xmag,
      ymag: d.ymag,
      zmag: d.zmag,
      temperature: d.temperature === 0 ? null : d.temperature / 100,
    }
    this.emit('message', { type: 'sensor', msgType: 'RAW_IMU', data } as ServerMessage)
  }

  private handleScaledPressure(msg: MavlinkMessage) {
    const d = decode<common.ScaledPressure>(29, msg.payload)
    if (!d) return
    const altitude = Number.isFinite(d.pressAbs) && d.pressAbs > 0
      ? 44330 * (1 - Math.pow(d.pressAbs / 1013.25, 0.1903))
      : null
    const data = {
      press_abs: d.pressAbs,
      press_diff: d.pressDiff,
      temperature: d.temperature / 100,
      altitude: altitude !== null && Number.isFinite(altitude) ? altitude : null,
    }
    this.emit('message', { type: 'sensor', msgType: 'SCALED_PRESSURE', data } as ServerMessage)
  }

  private handleAttitude(msg: MavlinkMessage) {
    const d = decode<common.Attitude>(30, msg.payload)
    if (!d) return
    const data = {
      time_boot_ms: d.timeBootMs,
      roll: d.roll,
      pitch: d.pitch,
      yaw: d.yaw,
      rollspeed: d.rollspeed,
      pitchspeed: d.pitchspeed,
      yawspeed: d.yawspeed,
    }
    this.emit('message', { type: 'telemetry', msgType: 'ATTITUDE', data } as ServerMessage)
  }

  private handleGlobalPosition(msg: MavlinkMessage) {
    const d = decode<common.GlobalPositionInt>(33, msg.payload)
    if (!d) return
    const data = {
      lat: d.lat / 1e7,
      lon: d.lon / 1e7,
      alt: d.alt / 1000,
      relative_alt: d.relativeAlt / 1000,
      vx: d.vx / 100,
      vy: d.vy / 100,
      vz: d.vz / 100,
      hdg: d.hdg === 0xffff ? null : d.hdg / 100,
    }
    this.emit('message', { type: 'telemetry', msgType: 'GLOBAL_POSITION_INT', data } as ServerMessage)
  }

  private handleRcChannels(msg: MavlinkMessage) {
    const d = decode<common.RcChannels>(65, msg.payload)
    if (!d) return
    // node-mavlink decodes the size-grouped wire layout (18 uint16 channels
    // after time_boot_ms, then chancount/rssi), removing the manual offset
    // arithmetic that previously shifted channels when it was done wrong.
    const data = {
      ch1: d.chan1Raw, ch2: d.chan2Raw, ch3: d.chan3Raw, ch4: d.chan4Raw,
      ch5: d.chan5Raw, ch6: d.chan6Raw, ch7: d.chan7Raw, ch8: d.chan8Raw,
      ch9: d.chan9Raw, ch10: d.chan10Raw, ch11: d.chan11Raw, ch12: d.chan12Raw,
      ch13: d.chan13Raw, ch14: d.chan14Raw, ch15: d.chan15Raw, ch16: d.chan16Raw,
      ch17: d.chan17Raw, ch18: d.chan18Raw,
    } as RcChannelsData
    this.emit('message', { type: 'rc_channels', data } as ServerMessage)
  }

  private handleVfrHud(msg: MavlinkMessage) {
    const d = decode<common.VfrHud>(74, msg.payload)
    if (!d) return
    const finite = (value: number) => Number.isFinite(value) ? value : null
    const data = {
      airspeed: finite(d.airspeed),
      groundspeed: finite(d.groundspeed),
      alt: finite(d.alt),
      climb: finite(d.climb),
      heading: d.heading,
      throttle: d.throttle,
    }
    this.emit('message', { type: 'telemetry', msgType: 'VFR_HUD', data } as ServerMessage)
  }

  private handleCommandAck(msg: MavlinkMessage) {
    const d = decode<common.CommandAck>(77, msg.payload)
    if (!d) return
    if (
      msg.payload.length >= 9
      && (
        (d.targetSystem !== 0 && d.targetSystem !== 255)
        || (
          msg.payload.length >= 10
          && d.targetComponent !== 0
          && d.targetComponent !== 190
        )
      )
    ) return
    if (d.command === (MAVLINK_COMMANDS as Record<string, number>).MAV_CMD_SET_MESSAGE_INTERVAL) {
      if (d.result === MAV_RESULT_ACCEPTED) {
        // A terminal ACCEPTED is the only positive capability signal.
        // Keep a previous terminal failure sticky for this target session: the
        // several interval requests share one command id and cannot otherwise
        // be correlated to individual message ids.
        if (this.messageIntervalSupport !== 'unsupported') {
          this.messageIntervalSupport = 'supported'
          if (this.messageIntervalFallbackTimer) {
            clearTimeout(this.messageIntervalFallbackTimer)
            this.messageIntervalFallbackTimer = null
          }
        }
      } else if (
        d.result !== MAV_RESULT_IN_PROGRESS
        && d.result !== MAV_RESULT_TEMPORARILY_REJECTED
      ) {
        // DENIED / UNSUPPORTED / FAILED / CANCELLED (and any future terminal
        // failure) must restore the broadly-supported legacy stream request.
        this.useLegacyTelemetryStreams()
      }
    }

    const commandId = d.command as number
    const pending = this.pendingCommands.get(commandId)
    const orphanedTransaction = !pending && (
      this.uncertainCommands.has(commandId)
      || this.isCommandQuarantined(commandId)
    )
    const progress = msg.payload.length >= 4 && d.progress !== COMMAND_ACK_PROGRESS_UNKNOWN
      ? d.progress
      : undefined
    const willRetry = Boolean(
      pending
      && d.result === MAV_RESULT_TEMPORARILY_REJECTED
      && pending.attempt < pending.maxAttempts,
    )
    const data = {
      command: d.command,
      result: d.result,
      requestId: pending?.requestId,
      progress,
      resultParam2: msg.payload.length >= 8 ? d.resultParam2 : undefined,
      targetSystem: msg.payload.length >= 9 ? d.targetSystem : undefined,
      targetComponent: msg.payload.length >= 10 ? d.targetComponent : undefined,
      terminal: d.result !== MAV_RESULT_IN_PROGRESS && !willRetry,
      attempt: pending?.attempt,
      stale: orphanedTransaction,
    }
    this.emit('message', { type: 'command_ack', data } as ServerMessage)

    if (!pending) {
      if (orphanedTransaction && d.result !== MAV_RESULT_IN_PROGRESS) {
        this.uncertainCommands.delete(commandId)
        this.quarantineCommand(commandId)
      }
      return
    }
    if (pending.timeout) clearTimeout(pending.timeout)
    if (d.result === MAV_RESULT_IN_PROGRESS) {
      this.scheduleCommandTimeout(pending, this.commandTimeoutForLink() * 4)
      return
    }
    if (
      d.result === MAV_RESULT_TEMPORARILY_REJECTED
      && pending.attempt < pending.maxAttempts
    ) {
      pending.confirmation = Math.min(255, pending.confirmation + 1)
      this.transmitPendingCommand(pending)
      return
    }
    this.finishPendingCommand(pending.command, true)
  }

  private handleOpticalFlow(msg: MavlinkMessage) {
    const d = decode<common.OpticalFlowRad>(106, msg.payload)
    if (!d) return
    const distance = Number.isFinite(d.distance) && d.distance >= 0 ? d.distance : null
    const data = {
      sensor_id: d.sensorId,
      integration_time_us: d.integrationTimeUs,
      integrated_x_rad: d.integratedX,
      integrated_y_rad: d.integratedY,
      integrated_xgyro_rad: d.integratedXgyro,
      integrated_ygyro_rad: d.integratedYgyro,
      integrated_zgyro_rad: d.integratedZgyro,
      temperature_c: d.temperature / 100,
      time_delta_distance_us: d.timeDeltaDistanceUs,
      distance_m: distance,
      // Deprecated compatibility aliases. These retain their historical
      // values while callers migrate to the correctly named fields above.
      flow_x: d.integratedX,
      flow_y: d.integratedY,
      flow_comp_m_x: d.integratedXgyro,
      flow_comp_m_y: d.integratedYgyro,
      quality: d.quality,
      ground_distance: distance,
    }
    this.emit('message', { type: 'sensor', msgType: 'OPTICAL_FLOW_RAD', data } as ServerMessage)
  }

  private handleDistanceSensor(msg: MavlinkMessage) {
    const d = decode<common.DistanceSensor>(132, msg.payload)
    if (!d) return
    const data = {
      min_distance: d.minDistance,
      max_distance: d.maxDistance,
      current_distance: d.currentDistance,
      type: d.type,
      id: d.id,
      orientation: d.orientation,
      signal_quality: msg.payload.length > 38 && d.signalQuality !== 0
        ? d.signalQuality
        : null,
    }
    this.emit('message', { type: 'sensor', msgType: 'DISTANCE_SENSOR', data } as ServerMessage)
  }

  private handleBattery(msg: MavlinkMessage) {
    const d = decode<common.BatteryStatus>(147, msg.payload)
    if (!d) return
    const baseCellVoltages = (d.voltages ?? []).map((voltage) =>
      voltage === 0xffff ? null : voltage / 1000
    )
    const extendedCellVoltages = (d.voltagesExt ?? []).map((voltage, index) => {
      // MAVLink 2 trims trailing zero bytes, including the high byte of a
      // uint16. Presence therefore starts at the field offset, not only after
      // both bytes were transmitted.
      const transmitted = 41 + index * 2 < msg.payload.length
      return transmitted && voltage !== 0 ? voltage / 1000 : null
    })
    const cellVoltages = [...baseCellVoltages, ...extendedCellVoltages]
    const knownVoltages = cellVoltages.filter((voltage): voltage is number => voltage !== null)
    const data = {
      id: d.id,
      voltage: knownVoltages.length > 0
        ? knownVoltages.reduce((sum, voltage) => sum + voltage, 0)
        : null,
      cell_voltages: cellVoltages,
      current: d.currentBattery === -1 ? null : d.currentBattery / 100,
      consumed_mah: d.currentConsumed === -1 ? null : d.currentConsumed,
      remaining: d.batteryRemaining === -1 ? null : d.batteryRemaining,
    }
    this.emit('message', { type: 'telemetry', msgType: 'BATTERY_STATUS', data } as ServerMessage)
  }

  private handleEstimatorStatus(msg: MavlinkMessage) {
    const d = decode<common.EstimatorStatus>(230, msg.payload)
    if (!d) return
    // Field names preserved from the previous implementation. gps_check_fail is
    // a PX4-specific trailer past the standard 42-byte message, so it is still
    // read from the raw payload when present.
    const data = {
      health_flags: d.flags,
      innovation_vel: d.velRatio,
      innovation_pos: d.posHorizRatio,
      innovation_hgt: d.posVertRatio,
      innovation_mag: d.magRatio,
      gps_check_fail_flags: null,
    }
    this.emit('message', { type: 'ekf_status', data } as ServerMessage)
  }

  private handleExtendedSysState(msg: MavlinkMessage) {
    const d = decode<common.ExtendedSysState>(245, msg.payload)
    if (!d) return
    this.emit('message', {
      type: 'telemetry',
      msgType: 'EXTENDED_SYS_STATE',
      data: {
        vtol_state: d.vtolState,
        landed_state: d.landedState,
      },
    } as ServerMessage)
  }

  private handleParamValue(msg: MavlinkMessage) {
    // PARAM_VALUE has no extension fields, so a valid frame must carry its
    // complete 25-byte payload. Reject malformed values before they can
    // complete a write transaction or poison the parameter cache.
    if (msg.payload.length < 25) return
    const payload = msg.payload
    const paramType = payload[24]
    if (![1, 2, 3, 4, 5, 6, 9].includes(paramType)) return
    const value = this.decodeParamValue(payload, paramType)
    if (!Number.isFinite(value)) return
    const paramCount = payload.readUInt16LE(4)
    const paramIndex = payload.readUInt16LE(6)
    const idBytes = payload.subarray(8, 24)
    const nulIndex = idBytes.indexOf(0)
    const actualIdBytes = idBytes.subarray(0, nulIndex >= 0 ? nulIndex : idBytes.length)
    if (
      actualIdBytes.length === 0
      || [...actualIdBytes].some((byte) => byte < 0x20 || byte > 0x7e)
    ) return
    const id = actualIdBytes.toString('ascii')

    this.emit('message', {
      type: 'param',
      data: { id, value, type: paramType, param_count: paramCount, param_index: paramIndex },
    } as ServerMessage)

    const pendingSet = this.pendingParamSets.get(id)
    if (pendingSet) {
      const sameType = pendingSet.paramType === paramType
      const accepted = sameType && this.paramValuesEqual(
        pendingSet.value,
        value,
        pendingSet.paramType,
      )
      if (accepted) {
        if (pendingSet.timeout) clearTimeout(pendingSet.timeout)
        this.pendingParamSets.delete(id)
        this.emitParamSetResult(pendingSet, true, value)
      } else {
        // A list download or periodic parameter broadcast can race a PARAM_SET
        // echo. Remember the mismatch for diagnostics, but keep waiting for the
        // accepted echo instead of failing the transaction prematurely.
        pendingSet.lastMismatch = sameType ? 'value_mismatch' : 'type_mismatch'
        pendingSet.lastAcceptedValue = value
      }
    }

    if (!this.paramDownloadActive) return

    // The first valid count belongs to this list transaction and is
    // authoritative. Chasing later outliers can leave the UI permanently
    // waiting for an index that does not exist in this download.
    if (
      this.paramExpectedCount === 0
      && paramCount > 0
      && paramCount < 0xffff
      && paramIndex >= 0
      && paramIndex < paramCount
    ) {
      if (paramCount > PARAM_MAX_COUNT) {
        this.failParamDownload('parameter_count_exceeds_limit')
        return
      }
      this.paramExpectedCount = paramCount
    }
    if (this.paramExpectedCount > 0 && paramIndex < this.paramExpectedCount) {
      const previousSize = this.paramIndices.size
      this.paramIndices.add(paramIndex)
      if (this.paramIndices.size > previousSize) {
        // Any new index proves the link is making progress and resets the stall
        // backoff. During PX4's initial burst, wait a full quiet window before
        // stepping in (do not interrupt the stream). Once we are actively
        // recovering gaps, continue promptly so the tail does not crawl at one
        // batch per stall window.
        this.paramRetryAttempt = 0
        this.scheduleParamRetry(this.paramRecovering)
      }
    }

    if (this.paramExpectedCount > 0 && this.paramIndices.size >= this.paramExpectedCount) {
      this.completeParamDownload()
    }
  }

  private handleStatustext(msg: MavlinkMessage) {
    this.pruneStatustextAssemblies()
    const payload = msg.payload.length >= 54
      ? msg.payload
      : Buffer.concat([msg.payload, Buffer.alloc(54 - msg.payload.length)])
    const severity = payload[0]
    const rawText = payload.subarray(1, 51)
    const terminatorIndex = rawText.indexOf(0)
    const textBytes = Buffer.from(rawText.subarray(
      0,
      terminatorIndex >= 0 ? terminatorIndex : rawText.length,
    ))
    const id = msg.payload.length >= 52 ? payload.readUInt16LE(51) : 0
    const chunkSequence = msg.payload.length >= 54 ? payload[53] : 0
    const chunkComplete = terminatorIndex >= 0 || rawText.length < 50

    if (id === 0) {
      this.emitStatustext(severity, textBytes)
      return
    }

    const key = `${msg.sysId}:${msg.compId}:${id}`
    if (chunkSequence === 0) {
      if (chunkComplete) {
        this.emitStatustext(severity, textBytes)
      } else {
        if (this.statustextChunks.size >= STATUSTEXT_MAX_ASSEMBLIES) {
          const oldest = [...this.statustextChunks.entries()]
            .sort((a, b) => a[1].updatedAt - b[1].updatedAt)[0]?.[0]
          if (oldest) this.statustextChunks.delete(oldest)
        }
        this.statustextChunks.set(key, {
          severity,
          chunks: [textBytes],
          byteLength: textBytes.length,
          nextSequence: 1,
          updatedAt: performance.now(),
        })
      }
      return
    }

    const pending = this.statustextChunks.get(key)
    if (!pending || pending.nextSequence !== chunkSequence) {
      this.statustextChunks.delete(key)
      return
    }

    if (pending.byteLength + textBytes.length > STATUSTEXT_MAX_BYTES) {
      this.statustextChunks.delete(key)
      return
    }
    pending.chunks.push(textBytes)
    pending.byteLength += textBytes.length
    pending.nextSequence++
    pending.updatedAt = performance.now()
    if (chunkComplete) {
      this.statustextChunks.delete(key)
      this.emitStatustext(pending.severity, Buffer.concat(pending.chunks, pending.byteLength))
    }
  }

  private paramValuesEqual(expected: number, actual: number, paramType: number): boolean {
    if (paramType !== 9) return expected === actual
    const tolerance = Math.max(1e-6, Math.abs(expected) * 1e-6)
    return Math.abs(expected - actual) <= tolerance
  }

  private emitStatustext(severity: number, bytes: Buffer): void {
    if (bytes.length === 0) return
    this.emit('message', {
      type: 'statustext',
      data: { severity, text: bytes.toString('utf8') },
    } as ServerMessage)
  }

  private pruneStatustextAssemblies(): void {
    const cutoff = performance.now() - STATUSTEXT_TTL_MS
    for (const [key, pending] of this.statustextChunks) {
      if (pending.updatedAt < cutoff) this.statustextChunks.delete(key)
    }
  }

  /** Cancel an active list download and restore the normal telemetry profile. */
  cancelParameterDownload(): void {
    if (this.destroyed) return
    this.cancelParamDownload(true)
  }

  // Send commands from frontend
  handleClientMessage(msg: ClientMessage) {
    switch (msg.type) {
      case 'command':
        if (this.requireReadyTarget('command', msg.requestId)) {
          this.sendCommand(
            msg.cmd,
            msg.params,
            msg.requestId,
            msg.safetyConfirmation,
          )
        }
        break
      case 'param_set':
        if (this.requireReadyTarget('param_set', msg.requestId)) {
          this.sendParamSet(msg.data.id, msg.data.value, msg.data.paramType, msg.requestId)
        }
        break
      case 'param_request_list':
        if (this.requireReadyTarget('param_request_list', msg.requestId)) {
          this.sendParamRequestList()
        }
        break
      case 'manual_control':
        if (this.requireReadyTarget('manual_control', msg.requestId)) {
          this.sendManualControl(msg.data)
        }
        break
      case 'motor_test':
        if (this.requireReadyTarget('motor_test', msg.requestId)) {
          this.sendMotorTest(
            msg.data.instance,
            msg.data.throttle,
            msg.data.duration,
            msg.requestId,
            msg.data.propsRemoved,
          )
        }
        break
      case 'select_target':
        this.selectTarget(msg.data.systemId, msg.data.componentId, msg.requestId)
        break
      case 'release_control':
        // Consumed by the WebSocket controller-lease boundary.
        break
    }
  }

  private sendCommand(
    cmd: string,
    params: number[],
    requestId?: string,
    safetyConfirmation?: 'arm' | 'disarm' | 'takeoff',
  ) {
    const cmdId = (MAVLINK_COMMANDS as Record<string, number>)[cmd]
    if (cmdId === undefined) {
      this.emitOperationError('command', 'unsupported_command', `不支持命令 ${cmd}`, requestId)
      return
    }
    if (params.some((value) => !Number.isFinite(value))) {
      this.emitOperationError('command', 'invalid_params', '命令参数必须是有限数值', requestId)
      return
    }
    const requiredConfirmation =
      cmd === 'MAV_CMD_NAV_TAKEOFF'
        ? 'takeoff'
        : cmd === 'MAV_CMD_COMPONENT_ARM_DISARM'
          ? ((params[0] ?? 0) >= 0.5 ? 'arm' : 'disarm')
          : null
    if (requiredConfirmation && safetyConfirmation !== requiredConfirmation) {
      this.emitOperationError(
        'command',
        'safety_confirmation_required',
        `命令需要 ${requiredConfirmation} 安全确认`,
        requestId,
      )
      return
    }

    // ACK contains only the command id, so an emergency disarm cannot be
    // safely correlated when an ARM_DISARM transaction is already pending or
    // settling. Deliver the safety action immediately, cancel correlation for
    // the older request, and quarantine later ACKs instead of mislabeling one.
    const emergencyDisarm = cmd === 'MAV_CMD_COMPONENT_ARM_DISARM'
      && (params[0] ?? 0) < 0.5
    if (
      emergencyDisarm
      && (
        this.pendingCommands.has(cmdId)
        || this.uncertainCommands.has(cmdId)
        || this.isCommandQuarantined(cmdId)
      )
    ) {
      const superseded = this.pendingCommands.get(cmdId)
      if (superseded?.timeout) clearTimeout(superseded.timeout)
      if (superseded) {
        this.pendingCommands.delete(cmdId)
        this.emitOperationError(
          'command',
          'superseded_by_disarm',
          '未完成的解锁/上锁事务已被紧急上锁命令取代',
          superseded.requestId,
        )
      }
      this.uncertainCommands.add(cmdId)
      this.commandQuarantineUntil.delete(cmdId)
      if (!this.writeMessage(this.buildCommand(cmdId, params.slice(0, 7)), 'critical')) {
        this.emitOperationError(
          'command',
          'write_rejected',
          '连接发送队列拒绝紧急上锁命令',
          requestId,
          true,
        )
      }
      return
    }
    const pending: PendingCommand = {
      requestId,
      command: cmdId,
      params: params.slice(0, 7),
      attempt: 0,
      maxAttempts: HIGH_RISK_COMMANDS.has(cmdId) ? 1 : 2,
      confirmation: 0,
      priority: emergencyDisarm ? 'critical' : 'high',
      deadlineAt: 0,
      timeout: null,
    }
    this.enqueuePendingCommand(pending)
  }

  private buildCommand(commandId: number, params: number[], confirmation = 0): common.CommandLong {
    const command = new common.CommandLong()
    command._param1 = params[0] ?? 0
    command._param2 = params[1] ?? 0
    command._param3 = params[2] ?? 0
    command._param4 = params[3] ?? 0
    command._param5 = params[4] ?? 0
    command._param6 = params[5] ?? 0
    command._param7 = params[6] ?? 0
    command.command = commandId
    command.targetSystem = this.targetSysId ?? 0
    command.targetComponent = this.targetCompId ?? 0
    command.confirmation = confirmation
    return command
  }

  private transmitPendingCommand(pending: PendingCommand): void {
    if (pending.deadlineAt === 0) {
      pending.deadlineAt = performance.now() + this.commandDeadlineForLink()
    }
    pending.attempt++
    const accepted = this.writeMessage(
      this.buildCommand(pending.command, pending.params, pending.confirmation),
      pending.priority,
    )
    if (!accepted) {
      this.finishPendingCommand(pending.command, false)
      this.emitOperationError(
        'command',
        'write_rejected',
        '连接发送队列拒绝命令',
        pending.requestId,
        true,
      )
      return
    }
    this.scheduleCommandTimeout(pending, this.commandTimeoutForLink())
  }

  private scheduleCommandTimeout(pending: PendingCommand, requestedDelayMs: number): void {
    if (pending.timeout) clearTimeout(pending.timeout)
    const remainingMs = pending.deadlineAt - performance.now()
    if (remainingMs <= 0) {
      pending.timeout = null
      this.handleCommandTimeout(pending.command)
      return
    }
    pending.timeout = setTimeout(
      () => this.handleCommandTimeout(pending.command),
      Math.min(requestedDelayMs, remainingMs),
    )
  }

  private enqueuePendingCommand(pending: PendingCommand): void {
    const current = this.pendingCommands.get(pending.command)
    if (current) {
      this.emitOperationError(
        'command',
        'command_busy',
        `命令 ${pending.command} 已有未完成事务；ACK 不含事务 ID，已拒绝并发请求`,
        pending.requestId,
        true,
      )
      return
    }
    if (this.uncertainCommands.has(pending.command)) {
      this.emitOperationError(
        'command',
        'command_result_uncertain',
        `命令 ${pending.command} 的旧事务已超时且可能仍有迟到 ACK；请重新连接后再试`,
        pending.requestId,
        true,
      )
      return
    }
    if (this.isCommandQuarantined(pending.command)) {
      this.emitOperationError(
        'command',
        'command_settling',
        `命令 ${pending.command} 正在等待迟到/重复 ACK 排空`,
        pending.requestId,
        true,
      )
      return
    }
    this.pendingCommands.set(pending.command, pending)
    this.transmitPendingCommand(pending)
  }

  private finishPendingCommand(commandId: number, quarantine: boolean): void {
    this.pendingCommands.delete(commandId)
    if (quarantine) this.quarantineCommand(commandId)
  }

  private quarantineCommand(commandId: number): void {
    this.commandQuarantineUntil.set(
      commandId,
      performance.now() + this.commandTimeoutForLink(),
    )
  }

  private isCommandQuarantined(commandId: number): boolean {
    const deadline = this.commandQuarantineUntil.get(commandId)
    if (deadline === undefined) return false
    if (performance.now() < deadline) return true
    this.commandQuarantineUntil.delete(commandId)
    return false
  }

  private handleCommandTimeout(commandId: number): void {
    const pending = this.pendingCommands.get(commandId)
    if (!pending) return
    pending.timeout = null
    if (
      performance.now() < pending.deadlineAt
      && pending.attempt < pending.maxAttempts
    ) {
      pending.confirmation = Math.min(255, pending.confirmation + 1)
      this.transmitPendingCommand(pending)
      return
    }
    this.pendingCommands.delete(commandId)
    this.commandQuarantineUntil.delete(commandId)
    this.uncertainCommands.add(commandId)
    this.emitOperationError(
      'command',
      'command_timeout',
      `命令 ${commandId} 等待 ACK 超时`,
      pending.requestId,
      true,
    )
  }

  private commandTimeoutForLink(): number {
    return this.connManager.config?.type === 'bluetooth'
      ? this.options.commandTimeoutMs * 2
      : this.options.commandTimeoutMs
  }

  private commandDeadlineForLink(): number {
    // Progress ACKs may legitimately take longer than a normal ACK, especially
    // over Bluetooth, but they must never reserve a command id indefinitely.
    return this.options.commandTimeoutMs * (
      this.connManager.config?.type === 'bluetooth' ? 12 : 8
    )
  }

  private sendInternalCommand(commandId: number, params: number[]): void {
    this.writeMessage(this.buildCommand(commandId, params))
  }

  private sendParamSet(id: string, value: number, paramType: number, requestId?: string) {
    const validationError = this.validateParamSet(id, value, paramType)
    if (validationError) {
      this.emitOperationError('param_set', 'invalid_param', validationError, requestId)
      return
    }
    if (this.pendingParamSets.has(id)) {
      this.emitOperationError(
        'param_set',
        'param_busy',
        `参数 ${id} 已有未完成写入`,
        requestId,
        true,
      )
      return
    }
    if (this.pendingParamSets.size >= MAX_PENDING_PARAM_SETS) {
      this.emitOperationError(
        'param_set',
        'param_queue_full',
        '等待参数回显的事务已达上限',
        requestId,
        true,
      )
      return
    }
    const pending: PendingParamSet = {
      requestId,
      id,
      value,
      paramType,
      attempt: 0,
      timeout: null,
    }
    this.pendingParamSets.set(id, pending)
    this.transmitPendingParamSet(pending)
  }

  private validateParamSet(id: string, value: number, paramType: number): string | null {
    if (!/^[\x20-\x7e]{1,16}$/.test(id) || Buffer.byteLength(id, 'ascii') > 16) {
      return '参数 ID 必须是 1–16 字节可打印 ASCII'
    }
    if (!Number.isFinite(value)) return '参数值必须是有限数值'
    const ranges: Record<number, [number, number]> = {
      1: [0, 0xff],
      2: [-0x80, 0x7f],
      3: [0, 0xffff],
      4: [-0x8000, 0x7fff],
      5: [0, 0xffffffff],
      6: [-0x80000000, 0x7fffffff],
    }
    if (paramType === 9) return null
    const range = ranges[paramType]
    if (!range) return `不支持 MAV_PARAM_TYPE ${paramType}`
    if (!Number.isInteger(value) || value < range[0] || value > range[1]) {
      return `参数值超出 MAV_PARAM_TYPE ${paramType} 范围`
    }
    if (this.paramEncoding === 'c-cast' && Math.fround(value) !== value) {
      return `参数值 ${value} 无法由 C-cast PARAM_VALUE 的 float32 精确表示`
    }
    return null
  }

  private transmitPendingParamSet(pending: PendingParamSet): void {
    const valueBuf = Buffer.alloc(4)
    this.writeParamValue(valueBuf, pending.value, pending.paramType)
    const paramSet = new common.ParamSet()
    paramSet.paramValue = valueBuf.readFloatLE(0)
    paramSet.targetSystem = this.targetSysId ?? 0
    paramSet.targetComponent = this.targetCompId ?? 0
    paramSet.paramId = pending.id
    paramSet.paramType = pending.paramType
    pending.attempt++
    if (!this.writeMessage(paramSet)) {
      this.pendingParamSets.delete(pending.id)
      this.emitParamSetResult(pending, false, undefined, 'write_rejected')
      return
    }
    if (pending.timeout) clearTimeout(pending.timeout)
    const timeout = this.connManager.config?.type === 'bluetooth'
      ? this.options.paramSetTimeoutMs * 2
      : this.options.paramSetTimeoutMs
    pending.timeout = setTimeout(() => this.handleParamSetTimeout(pending.id), timeout)
  }

  private handleParamSetTimeout(id: string): void {
    const pending = this.pendingParamSets.get(id)
    if (!pending) return
    pending.timeout = null
    if (pending.attempt < 3) {
      this.transmitPendingParamSet(pending)
      return
    }
    this.pendingParamSets.delete(id)
    this.emitParamSetResult(
      pending,
      false,
      pending.lastAcceptedValue,
      pending.lastMismatch ?? 'timeout',
    )
  }

  private emitParamSetResult(
    pending: PendingParamSet,
    accepted: boolean,
    acceptedValue?: number,
    reason?: string,
  ): void {
    this.emit('message', {
      type: 'param_set_result',
      data: {
        requestId: pending.requestId,
        id: pending.id,
        requestedValue: pending.value,
        acceptedValue,
        accepted,
        attempt: pending.attempt,
        reason,
      },
    } as ServerMessage)
  }

  private sendParamRequestList() {
    // Server-side generation ownership may intentionally replace an expired
    // download. Keep this local reset silent so the cancellation cannot be
    // misattributed to the newly-created generation.
    this.cancelParamDownload(false)
    this.paramExpectedCount = 0
    this.paramIndices.clear()
    this.paramDownloadActive = true
    this.paramRecovering = false
    this.paramRetryAttempt = 0
    this.paramRetryCursor = 0
    this.paramReadRequests = 0
    this.paramDownloadDeadlineAt = performance.now() + (
      this.connManager.config?.type === 'bluetooth'
        ? BLUETOOTH_PARAM_DEADLINE_MS
        : SERIAL_PARAM_DEADLINE_MS
    )
    this.applyTelemetryProfile('parameter-sync')
    this.writeParamRequestList()
    this.scheduleParamRetry()
  }

  private handleAutopilotVersion(msg: MavlinkMessage) {
    if (msg.payload.length < 8) return

    const d = decode<standard.AutopilotVersion>(148, msg.payload)
    if (!d) return
    if (this.versionTimer) {
      clearTimeout(this.versionTimer)
      this.versionTimer = null
    }
    this.versionAttempt = VERSION_MAX_ATTEMPTS
    // capabilities is a uint64 bitmask (bigint at runtime); node-mavlink types
    // it as an enum, so cast to bigint for the capability bit tests below.
    const capabilities = d.capabilities as unknown as bigint
    if ((capabilities & MAV_PROTOCOL_CAPABILITY_MAVLINK2) !== 0n) {
      this.codec.confirmMavlink2()
    }
    if ((capabilities & MAV_PROTOCOL_CAPABILITY_PARAM_ENCODE_BYTEWISE) !== 0n) {
      this.paramEncoding = 'bytewise'
      this.paramEncodingNegotiated = true
    } else if ((capabilities & MAV_PROTOCOL_CAPABILITY_PARAM_ENCODE_C_CAST) !== 0n) {
      this.paramEncoding = 'c-cast'
      this.paramEncodingNegotiated = true
    }

    // MAVLink 2 trims trailing zero bytes. Identity fields begin well before
    // the 78-byte maximum payload, so requiring custom-version/uid2 bytes
    // would discard normal valid responses.
    if (msg.payload.length <= 16) return
    const flightSwVersion = d.flightSwVersion
    const major = (flightSwVersion >>> 24) & 0xff
    const minor = (flightSwVersion >>> 16) & 0xff
    const patch = (flightSwVersion >>> 8) & 0xff
    const boardVersion = d.boardVersion
    const upperBoardId = boardVersion >>> 16
    const lowerBoardId = boardVersion & 0xffff
    const boardId = BOARD_NAMES[upperBoardId] ? upperBoardId : BOARD_NAMES[lowerBoardId] ? lowerBoardId : upperBoardId || lowerBoardId
    const firmwareVersion = `${major}.${minor}.${patch}`
    this.emit('message', {
      type: 'autopilot_version',
      data: {
        boardId,
        boardName: BOARD_NAMES[boardId] ?? (boardId ? `Board ${boardId}` : 'PX4 Flight Controller'),
        firmwareVersion,
        firmwareLabel: `PX4 v${firmwareVersion}`,
        // vendor/product are at wire offsets 32/34. The previous parser read
        // 56/58 (inside os_custom_version) - a latent bug fixed by node-mavlink.
        vendorId: d.vendorId,
        productId: d.productId,
      },
    } as ServerMessage)
  }

  private requestAutopilotVersion(): void {
    if (!this.selectedHeartbeatReady || this.versionAttempt >= VERSION_MAX_ATTEMPTS) return
    this.versionAttempt++
    if (this.versionAttempt < VERSION_MAX_ATTEMPTS) {
      const requestMessage = (MAVLINK_COMMANDS as Record<string, number>).MAV_CMD_REQUEST_MESSAGE
      if (requestMessage !== undefined) {
        this.sendInternalCommand(requestMessage, [148, 0, 0, 0, 0, 0, 0])
      }
    } else {
      this.sendInternalCommand(
        MAV_CMD_REQUEST_AUTOPILOT_CAPABILITIES,
        [1, 0, 0, 0, 0, 0, 0],
      )
    }
    if (this.versionTimer) clearTimeout(this.versionTimer)
    this.versionTimer = setTimeout(() => {
      this.versionTimer = null
      this.requestAutopilotVersion()
    }, this.options.versionRetryMs)
  }

  private writeParamRequestList() {
    // PARAM_REQUEST_LIST (msg #21)
    const request = new common.ParamRequestList()
    request.targetSystem = this.targetSysId ?? 0
    request.targetComponent = this.targetCompId ?? 0
    this.writeMessage(request)
  }

  private decodeParamValue(payload: Buffer, paramType: number) {
    if (this.paramEncoding === 'c-cast') return payload.readFloatLE(0)

    switch (paramType) {
      case 1: return payload.readUInt8(0)       // MAV_PARAM_TYPE_UINT8
      case 2: return payload.readInt8(0)        // MAV_PARAM_TYPE_INT8
      case 3: return payload.readUInt16LE(0)    // MAV_PARAM_TYPE_UINT16
      case 4: return payload.readInt16LE(0)     // MAV_PARAM_TYPE_INT16
      case 5: return payload.readUInt32LE(0)    // MAV_PARAM_TYPE_UINT32
      case 6: return payload.readInt32LE(0)     // MAV_PARAM_TYPE_INT32
      case 9: return payload.readFloatLE(0)     // MAV_PARAM_TYPE_REAL32
      default: return payload.readFloatLE(0)
    }
  }

  private writeParamValue(payload: Buffer, value: number, paramType: number) {
    if (this.paramEncoding === 'c-cast' || paramType === 9) {
      payload.writeFloatLE(value, 0)
      return
    }

    const integer = Math.trunc(value)
    switch (paramType) {
      case 1:
        payload.writeUInt8(Math.min(0xff, Math.max(0, integer)), 0)
        break
      case 2:
        payload.writeInt8(Math.min(0x7f, Math.max(-0x80, integer)), 0)
        break
      case 3:
        payload.writeUInt16LE(Math.min(0xffff, Math.max(0, integer)), 0)
        break
      case 4:
        payload.writeInt16LE(Math.min(0x7fff, Math.max(-0x8000, integer)), 0)
        break
      case 5:
        payload.writeUInt32LE(Math.min(0xffffffff, Math.max(0, integer)), 0)
        break
      case 6:
        payload.writeInt32LE(Math.min(0x7fffffff, Math.max(-0x80000000, integer)), 0)
        break
      default:
        payload.writeFloatLE(value, 0)
        break
    }
  }

  private sendParamRequestRead(index: number) {
    // PARAM_REQUEST_READ (msg #20): an empty param_id with a non-negative
    // param_index asks PX4 to retransmit that exact missing list entry.
    const request = new common.ParamRequestRead()
    request.paramIndex = index
    request.targetSystem = this.targetSysId ?? 0
    request.targetComponent = this.targetCompId ?? 0
    request.paramId = ''
    if (this.writeMessage(request)) this.paramReadRequests++
  }

  private scheduleParamRetry(recovery = false) {
    if (!this.paramDownloadActive) return
    if (this.paramRetryTimer) clearTimeout(this.paramRetryTimer)
    const bluetooth = this.connManager.config?.type === 'bluetooth'
    const timeout = recovery
      ? (bluetooth ? BLUETOOTH_PARAM_RECOVERY_INTERVAL_MS : SERIAL_PARAM_RECOVERY_INTERVAL_MS)
      : (bluetooth ? BLUETOOTH_PARAM_STALL_TIMEOUT_MS : SERIAL_PARAM_STALL_TIMEOUT_MS)
    this.paramRetryTimer = setTimeout(() => this.retryMissingParams(), timeout)
  }

  private retryMissingParams() {
    this.paramRetryTimer = null
    if (!this.paramDownloadActive) return

    if (
      performance.now() >= this.paramDownloadDeadlineAt
      || this.paramReadRequests >= PARAM_MAX_READ_REQUESTS
    ) {
      this.failParamDownload(
        performance.now() >= this.paramDownloadDeadlineAt
          ? 'deadline_exceeded'
          : 'request_budget_exhausted',
      )
      return
    }

    if (this.paramRetryAttempt >= PARAM_MAX_STALL_RETRIES) {
      this.failParamDownload('retry_limit_exceeded')
      return
    }

    this.paramRetryAttempt += 1
    if (this.paramExpectedCount === 0) {
      // No PARAM_VALUE arrived at all: repeat the list request rather than
      // guessing indices before PX4 has reported the parameter count.
      this.writeParamRequestList()
      this.emit('message', {
        type: 'param_retry',
        data: { attempt: this.paramRetryAttempt, missing: 0, total: 0 },
      } as ServerMessage)
    } else {
      const missing: number[] = []
      for (let index = 0; index < this.paramExpectedCount; index += 1) {
        if (!this.paramIndices.has(index)) missing.push(index)
      }

      if (missing.length === 0) {
        this.completeParamDownload()
        return
      }

      // We are now actively chasing individual gaps; a received reply should
      // trigger prompt continuation (short interval) rather than a full stall
      // wait. The full-window schedule below remains as the no-reply fallback.
      this.paramRecovering = true
      const batchSize = this.connManager.config?.type === 'bluetooth'
        ? BLUETOOTH_PARAM_RETRY_BATCH_SIZE
        : SERIAL_PARAM_RETRY_BATCH_SIZE
      const requestCount = Math.min(batchSize, missing.length)
      for (let offset = 0; offset < requestCount; offset += 1) {
        const missingIndex = (this.paramRetryCursor + offset) % missing.length
        this.sendParamRequestRead(missing[missingIndex])
      }
      // Rotate through all gaps instead of repeatedly hammering the first
      // permanently missing index and starving later recoverable entries.
      this.paramRetryCursor = (this.paramRetryCursor + requestCount) % missing.length
      this.emit('message', {
        type: 'param_retry',
        data: {
          attempt: this.paramRetryAttempt,
          missing: missing.length,
          total: this.paramExpectedCount,
        },
      } as ServerMessage)
    }
    this.scheduleParamRetry()
  }

  private completeParamDownload() {
    this.paramDownloadActive = false
    this.paramRecovering = false
    this.paramDownloadDeadlineAt = 0
    this.paramReadRequests = 0
    if (this.paramRetryTimer) {
      clearTimeout(this.paramRetryTimer)
      this.paramRetryTimer = null
    }
    this.emit('message', {
      type: 'param_complete',
      data: { count: this.paramExpectedCount },
    } as ServerMessage)
    this.applyTelemetryProfile('normal')
  }

  private failParamDownload(reason = 'unknown') {
    this.paramDownloadActive = false
    this.paramRecovering = false
    this.paramDownloadDeadlineAt = 0
    this.paramReadRequests = 0
    if (this.paramRetryTimer) {
      clearTimeout(this.paramRetryTimer)
      this.paramRetryTimer = null
    }
    this.emit('message', {
      type: 'param_failed',
      data: { received: this.paramIndices.size, total: this.paramExpectedCount, reason },
    } as ServerMessage)
    this.applyTelemetryProfile('normal')
  }

  private cancelParamDownload(restoreTelemetry = true, reason?: string) {
    const wasActive = this.paramDownloadActive
    this.paramDownloadActive = false
    this.paramRecovering = false
    this.paramDownloadDeadlineAt = 0
    this.paramReadRequests = 0
    if (this.paramRetryTimer) {
      clearTimeout(this.paramRetryTimer)
      this.paramRetryTimer = null
    }
    if (wasActive && reason) {
      this.emit('message', {
        type: 'param_failed',
        data: {
          received: this.paramIndices.size,
          total: this.paramExpectedCount,
          reason,
        },
      } as ServerMessage)
    }
    if (restoreTelemetry) this.applyTelemetryProfile('normal')
  }

  private applyTelemetryProfile(profile: TelemetryProfile) {
    if (this.telemetryProfile === profile || this.connManager.status !== 'connected') return
    this.telemetryProfile = profile
    const intervalUs = profile === 'parameter-sync' ? 500_000 : 50_000
    const servoIntervalUs = profile === 'parameter-sync' ? 500_000 : 100_000
    const setIntervalCommand =
      (MAVLINK_COMMANDS as Record<string, number>).MAV_CMD_SET_MESSAGE_INTERVAL
    if (setIntervalCommand === undefined || this.messageIntervalSupport === 'unsupported') {
      this.useLegacyTelemetryStreams()
      return
    }
    this.sendInternalCommand(
      setIntervalCommand,
      [36, servoIntervalUs, 0, 0, 0, 0, 0],
    )
    for (const messageId of [26, 105, 116, 129]) {
      this.sendInternalCommand(
        setIntervalCommand,
        [messageId, intervalUs, 0, 0, 0, 0, 0],
      )
    }
    if (this.messageIntervalSupport === 'unknown') {
      if (this.messageIntervalFallbackTimer) clearTimeout(this.messageIntervalFallbackTimer)
      this.messageIntervalFallbackTimer = setTimeout(() => {
        this.messageIntervalFallbackTimer = null
        if (this.messageIntervalSupport === 'unknown') this.useLegacyTelemetryStreams()
      }, this.commandTimeoutForLink() * 2)
    }
  }

  private useLegacyTelemetryStreams(): void {
    if (this.targetSysId === null || this.targetCompId === null) return
    this.messageIntervalSupport = 'unsupported'
    if (this.messageIntervalFallbackTimer) {
      clearTimeout(this.messageIntervalFallbackTimer)
      this.messageIntervalFallbackTimer = null
    }
    const rate = this.telemetryProfile === 'parameter-sync' ? 2 : 10
    // MAV_DATA_STREAM_RAW_SENSORS / EXTENDED_STATUS / RC_CHANNELS /
    // POSITION / EXTRA1 / EXTRA2 / EXTRA3.
    for (const streamId of [1, 2, 3, 6, 10, 11, 12]) {
      const request = new common.RequestDataStream()
      request.targetSystem = this.targetSysId
      request.targetComponent = this.targetCompId
      request.reqStreamId = streamId
      request.reqMessageRate = rate
      request.startStop = 1
      this.writeMessage(request)
    }
  }

  private sendManualControl(data: ManualControlData) {
    // MANUAL_CONTROL (msg #69) is PX4's MAVLink joystick input path used by
    // COM_RC_IN_MODE=1. RC_CHANNELS_OVERRIDE feeds the simulated receiver
    // pipeline instead and does not satisfy MAVLink-only manual-control health.
    if (this.destroyed) return
    this.pendingManualControl = data
    if (this.manualControlFlushHandle) return
    this.manualControlFlushHandle = setImmediate(() => {
      this.manualControlFlushHandle = null
      const latest = this.pendingManualControl
      this.pendingManualControl = null
      if (this.destroyed || !latest || !this.hasReadyTarget()) return
      const control = new common.ManualControl()
      control.x = Math.max(-1000, Math.min(1000, Math.round(latest.x)))
      control.y = Math.max(-1000, Math.min(1000, Math.round(latest.y)))
      control.z = Math.max(0, Math.min(1000, Math.round(latest.z)))
      control.r = Math.max(-1000, Math.min(1000, Math.round(latest.r)))
      control.buttons = (latest.buttons ?? 0) & 0xffff
      control.target = this.targetSysId ?? 0
      this.writeMessage(control)
    })
  }

  private sendMotorTest(
    instance: number,
    throttle: number,
    duration: number,
    requestId?: string,
    propsRemoved?: boolean,
  ) {
    // PX4 handles individual motor testing through MAV_CMD_ACTUATOR_TEST.
    // Values >= 1000 in param5 are PX4-internal actuator functions with the
    // 1000 transport offset. Motors 1..12 are functions 101..112, so an
    // external GCS must send 1101..1112. This works across PX4 versions and
    // avoids confusing the internal function ID with MAVLink's enum values.
    if (
      !Number.isInteger(instance)
      || instance < 1
      || instance > 12
      || !Number.isFinite(throttle)
      || throttle < 0
      || throttle > 100
      || !Number.isFinite(duration)
      || duration < 0
      || duration > 30
      || (throttle > 0 && duration <= 0)
      || (throttle === 0 && duration !== 0)
    ) {
      this.emitOperationError(
        'motor_test',
        'invalid_motor_test',
        '电机测试参数超出安全范围',
        requestId,
      )
      return
    }
    const outputFunction = 1100 + instance
    const shouldRelease = duration <= 0 || throttle <= 0
    if (!shouldRelease && propsRemoved !== true) {
      this.emitOperationError(
        'motor_test',
        'props_confirmation_required',
        '电机测试前必须确认已拆除桨叶',
        requestId,
      )
      return
    }
    const value = shouldRelease ? Number.NaN : Math.max(0, Math.min(1, throttle / 100))
    const timeout = shouldRelease ? 0 : Math.max(0, duration)
    const commandId = (MAVLINK_COMMANDS as Record<string, number>).MAV_CMD_ACTUATOR_TEST
    if (commandId === undefined) {
      this.emitOperationError('motor_test', 'unsupported_command', '缺少电机测试命令', requestId)
      return
    }
    // Multiple motors share command id 310, while COMMAND_ACK exposes no
    // actuator instance or request id. Send these safety-validated operations
    // immediately and leave their ACKs intentionally uncorrelated; serializing
    // them as request transactions would misattribute delayed ACKs and delay
    // stop-all delivery. A request-scoped sent_unconfirmed status below makes
    // this protocol limitation explicit instead of implying ACK confirmation.
    if (!this.writeMessage(
      this.buildCommand(
        commandId,
        [value, timeout, 0, 0, outputFunction, 0, 0],
      ),
      shouldRelease ? 'critical' : 'high',
    )) {
      this.emitOperationError(
        'motor_test',
        'write_rejected',
        '连接发送队列拒绝电机测试命令',
        requestId,
        true,
      )
      return
    }
    this.emit('message', {
      type: 'motor_test_status',
      data: {
        requestId,
        instance,
        action: shouldRelease ? 'stop' : 'start',
        status: 'sent_unconfirmed',
        reason: 'MAV_CMD_ACTUATOR_TEST ACK 不包含电机实例，命令已发送但无法安全关联确认',
      },
    } as ServerMessage)
  }

  // PX4 custom_mode layout: reserved[0..15], main_mode[16..23],
  // sub_mode[24..31]. Auto modes share main_mode=4 and differ by sub-mode.
  private getMode(customMode: number): { id: number; name: string } {
    const mainMode = customMode > 0xffff ? (customMode >>> 16) & 0xff : customMode
    const subMode = customMode > 0xffff ? (customMode >>> 24) & 0xff : 0
    const exact = Object.values(PX4_MODES).find((mode) =>
      mode.mainMode === mainMode && mode.subMode === subMode
    )
    const mainOnly = Object.values(PX4_MODES).find((mode) =>
      mode.mainMode === mainMode && mode.subMode === 0
    )
    const mode = exact ?? mainOnly
    return mode ?? { id: customMode, name: `Mode ${mainMode}${subMode ? `.${subMode}` : ''}` }
  }

  destroy() {
    this.destroyed = true
    if (this.manualControlFlushHandle) {
      clearImmediate(this.manualControlFlushHandle)
      this.manualControlFlushHandle = null
    }
    this.pendingManualControl = null
    this.cancelProtocolOperations(false, 'bridge_destroyed')
    this.stopHeartbeat()
    this.stopLinkStats()
    if (this.versionTimer) clearTimeout(this.versionTimer)
    if (this.messageIntervalFallbackTimer) clearTimeout(this.messageIntervalFallbackTimer)
    this.codec.destroy()
    this.connManager.off('data', this.onData)
    this.connManager.off('statusChange', this.onStatusChange)
  }
}
