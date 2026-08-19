import { EventEmitter } from 'events'
import { performance } from 'node:perf_hooks'
import {
  common,
  minimal,
  standard,
  ardupilotmega,
  decode,
  MavlinkCodecSession,
  codecOptionsFromEnvironment,
  type MavlinkCodecSessionOptions,
  type MavlinkMessage,
} from './codec'
import type { MavLinkData } from 'node-mavlink'
import { ConnectionManager } from '../connection/ConnectionManager'
import type {
  SerialWritePriority,
  SerialWriteQueueTag,
} from '../connection/SerialConnection'
import { MavlinkFtp, type FtpDownloadRecord } from './MavlinkFtp'
import {
  MavlinkLogTransfer,
  type LogTransferRequest,
} from './MavlinkLogTransfer'
import {
  FTP_MESSAGE_ID,
  DEFAULT_MESSAGE_RATES,
  MESSAGE_RATE_GROUP_IDS,
  LOG_DATA_MESSAGE_ID,
  LOG_ENTRY_MESSAGE_ID,
  MAVLINK_COMMANDS,
  PX4_SHELL_SERIAL_CONTROL_DEVICE,
  SERIAL_CONTROL_FLAGS,
  SERIAL_CONTROL_MAX_DATA,
} from '../../shared/constants'
import {
  buildVehicleIdentity,
  decodeFlightMode,
  encodeModeCommand,
  formatFirmwareLabel,
  vehicleCapabilities,
  supportsCalibrationKind,
  type CalibrationKind,
  type VehicleIdentity,
} from '../../shared/vehicleProfiles'
import type { ServerMessage, ClientMessage, ManualControlData, MessageRateConfig, RcChannelsData, RadioCalibrationChannel } from '../../shared/types'
import {
  isAllowedVehicleConfigParameter,
  isSafetyReduction,
  validateVehicleConfigValue,
} from '../../shared/vehicleSetupProfiles'
import { getPx4AirframeInfo, isSupportedArduCopterFrame } from '../../shared/airframes'
import { parameterEnumOptions, parameterEnumValuesMatch } from '../../shared/parameterEnumMetadata'
import { CalibrationSession } from './CalibrationSession'
import type { CalibrationStartRequest } from './CalibrationSessionManager'

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
const PARAM_VALUE_CACHE_MAX_ENTRIES = PARAM_MAX_COUNT
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
// A SERIAL_CONTROL write has no ACK. Treat the shell as connected only after
// the selected flight controller returns bytes from DEV_SHELL.
const SHELL_PROBE_TIMEOUT_MS = 2_500
// SET_MESSAGE_INTERVAL requests are fire-and-forget; on a lossy link a single
// dropped frame must not silently degrade the whole session to the legacy
// stream path, so the batch is re-sent a bounded number of times.
const MESSAGE_INTERVAL_MAX_SEND_ATTEMPTS = 3
// Read-only sensor peripherals commonly publish under their own component ID
// while sharing the selected autopilot's system ID. Keep every mutation and
// protocol transaction scoped to the exact selected component, but admit this
// narrow telemetry allow-list from sibling components in the same system.
const SENSOR_COMPONENT_MESSAGE_IDS = new Set([100, 106, 132, 173])
// An ATTITUDE time_boot_ms regression larger than this margin means the FC
// rebooted (its SET_MESSAGE_INTERVAL configuration is gone).
const FC_REBOOT_DETECTION_MARGIN_MS = 10_000
const motorTestStartQueueTag = (instance: number): SerialWriteQueueTag =>
  `motor-test-start:${instance}`
const ALL_MOTOR_TEST_INSTANCES = Object.freeze(
  Array.from({ length: 12 }, (_, index) => index + 1),
)
const HIGH_RISK_COMMANDS = new Set([22, 183, 209, 246, 310, 400])
const HANDLED_MESSAGE_IDS = new Set([
  1, 22, 24, 26, 27, 29, 30, 33, 36, 65, 74, 76, 77, 100, 105, 106, 110, 116, 118,
  120, 126, 129, 132, 147, 148, 173, 191, 192, 230, 245, 253,
])
type ParamEncoding = 'bytewise' | 'c-cast'
type TelemetryProfile = 'normal' | 'parameter-sync'
type MessageIntervalSupport = 'unknown' | 'supported' | 'unsupported'
type MessageRateGroup = keyof MessageRateConfig
const MESSAGE_RATE_GROUP_BY_ID = new Map<number, MessageRateGroup>(
  (Object.entries(MESSAGE_RATE_GROUP_IDS) as Array<[MessageRateGroup, readonly number[]]>)
    .flatMap(([group, ids]) => ids.map((id) => [id, group] as const)),
)

export interface MavlinkBridgeOptions {
  codec?: MavlinkCodecSessionOptions
  commandTimeoutMs?: number
  paramSetTimeoutMs?: number
  versionRetryMs?: number
}

export interface MavlinkBridgeClientResult {
  vehicleRebootQueued: boolean
}

interface DiscoveredTarget {
  systemId: number
  componentId: number
  autopilot: number
  /** Raw MAV_TYPE from the discovery heartbeat. */
  type: number
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
  completion?: (accepted: boolean, acceptedValue?: number, reason?: string) => void
}

export interface VehicleMutationSafetyContext {
  fingerprint: string
  ready: boolean
  armed: boolean | null
}

interface ActiveAirframeTransaction {
  requestId: string
  fingerprint: string
  total: number
  confirmed: string[]
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
  private messageIntervalAttempts = 0
  private messageIntervalFallbackTimer: ReturnType<typeof setTimeout> | null = null
  private paramExpectedCount = 0
  private paramIndices = new Set<number>()
  private paramDownloadActive = false
  // Monotonic id for each parameter download run. Stamped onto param lifecycle
  // events so the server can drop late events from a superseded/cancelled run.
  private paramRunId = 0
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
  // AUTOPILOT_VERSION is a one-shot handshake message; cache the last emitted
  // snapshot so WS clients that (re)connect later can still receive it.
  private lastAutopilotVersionMessage: ServerMessage | null = null
  private targetSysId: number | null = null
  private targetCompId: number | null = null
  private selectedHeartbeatReady = false
  // Classified from the selected target's HEARTBEAT (autopilot + type).
  // Cleared with the selected protocol state so a reconnected or switched
  // vehicle can never inherit a previous vehicle's profile.
  private selectedIdentity: VehicleIdentity | null = null
  // Last armed flag from the selected heartbeat; null until known. Used to
  // refuse bench-only operations (motor test, calibration) while armed.
  private lastArmedState: boolean | null = null
  private readonly discoveredTargets = new Map<string, DiscoveredTarget>()
  private statustextChunks = new Map<string, StatustextAssembly>()
  private telemetryProfile: TelemetryProfile | null = null
  private messageRates: MessageRateConfig = { ...DEFAULT_MESSAGE_RATES }
  /** Components actually observed emitting each configurable message id. */
  private readonly observedMessageComponents = new Map<number, Set<number>>()
  private lastAttitudeBootMs: number | null = null
  private readonly pendingCommands = new Map<number, PendingCommand>()
  private readonly uncertainCommands = new Set<number>()
  private readonly commandQuarantineUntil = new Map<number, number>()
  private readonly pendingParamSets = new Map<string, PendingParamSet>()
  private readonly parameterValues = new Map<string, number>()
  private readonly parameterTypes = new Map<string, number>()
  private parameterCacheLimitWarned = false
  private vehicleSafetyGeneration = 0
  private activeAirframeTransaction: ActiveAirframeTransaction | null = null
  private pendingManualControl: ManualControlData | null = null
  private manualControlFlushHandle: ReturnType<typeof setImmediate> | null = null
  // Active calibration session, if any. Owned lifecycle-wise by the server's
  // CalibrationSessionManager; the bridge feeds it protocol inputs (parsed
  // [cal] text, command ACKs, ACCELCAL_VEHICLE_POS and MAG_CAL_* messages)
  // and clears the reference when the session reaches a terminal snapshot.
  private activeCalibration: CalibrationSession | null = null
  private readonly ftp: MavlinkFtp
  private readonly logTransfer: MavlinkLogTransfer
  private destroyed = false
  // Temporary consumers for SERIAL_CONTROL (#126) replies, used by the PX4
  // ESC transport. MAVLink is NOT paused in this mode.
  private readonly serialControlListeners = new Set<(message: common.SerialControl) => void>()
  // PX4 NuttX shell tunneled through SERIAL_CONTROL_DEV_SHELL. Only one
  // controller-owned session may be active; normal MAVLink receive continues.
  private shellActive = false
  private shellPending = false
  private shellProbeTimer: ReturnType<typeof setTimeout> | null = null
  // True while an ESC session has borrowed the link (ADR-003/005). The GCS
  // heartbeat and data intake are detached so MAVLink frames cannot pollute
  // the raw ESC byte stream.
  private protocolPaused = false

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
    this.advanceVehicleSafetyGeneration()
    this.cancelProtocolOperations(false, 'connection_changed')
    if (status === 'connected') {
      // A raw ESC session keeps the link 'connected' while borrowing it; do
      // not re-arm MAVLink underneath the ESC protocol.
      if (this.protocolPaused) {
        this.resetTargetState(true)
        return
      }
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

  /** Server-authoritative identity of the selected HEARTBEAT target. */
  get vehicleIdentity(): VehicleIdentity | null {
    return this.selectedIdentity
  }

  /** Latest validated PARAM_VALUE for the selected target. */
  getParameterValue(id: string): number | null {
    return this.parameterValues.get(id) ?? null
  }

  /** MAV_PARAM_TYPE from the latest validated PARAM_VALUE for this target. */
  getParameterType(id: string): number | null {
    return this.parameterTypes.get(id) ?? null
  }

  private cacheParameterValue(id: string, value: number): boolean {
    if (!this.parameterValues.has(id) && this.parameterValues.size >= PARAM_VALUE_CACHE_MAX_ENTRIES) {
      if (!this.parameterCacheLimitWarned) {
        this.parameterCacheLimitWarned = true
        console.warn(`[MAVLink] parameter cache reached ${PARAM_VALUE_CACHE_MAX_ENTRIES} entries; dropping new ids`)
      }
      return false
    }
    this.parameterValues.set(id, value)
    return true
  }

  /** Last known armed flag of the selected autopilot; null until known. */
  get armedState(): boolean | null {
    return this.lastArmedState
  }

  /** Target-bound context used by long-running server-side setup transactions. */
  getVehicleMutationSafetyContext(): VehicleMutationSafetyContext {
    return {
      fingerprint: this.vehicleMutationFingerprint(),
      ready: this.hasReadyTarget(),
      armed: this.lastArmedState,
    }
  }

  /** A controller/authority boundary invalidates an in-flight airframe apply. */
  invalidateAirframeTransaction(reason: string): void {
    this.abortAirframeTransaction(`safety_context_changed_no_rollback:${reason}`)
  }

  /** True while an ESC session has paused the MAVLink protocol. */
  get isProtocolPaused(): boolean {
    return this.protocolPaused
  }

  /**
   * Suspend MAVLink protocol handling so an ESC session can borrow the link
   * (ADR-003). Cancels in-flight protocol operations, stops the GCS heartbeat
   * and link-stats timers, and detaches the byte intake so nothing writes to
   * or parses the raw ESC stream. Idempotent.
   */
  pauseProtocol(reason: string): void {
    if (this.protocolPaused) return
    this.protocolPaused = true
    this.cancelProtocolOperations(false, reason)
    this.stopHeartbeat()
    this.stopLinkStats()
    this.connManager.off('data', this.onData)
    this.resetTargetState(true)
  }

  /**
   * Resume MAVLink after an ESC session ends. Rebuilds the codec session and
   * re-attaches the byte intake, but deliberately does NOT fabricate a
   * connected/status event or raise vehicleReady: the existing false→true
   * readiness edge from the next validated autopilot heartbeat is what makes
   * the frontend re-download parameters (ADR-005). Idempotent.
   */
  resumeProtocol(): void {
    if (!this.protocolPaused) return
    this.protocolPaused = false
    this.codec.reset()
    this.resetTargetState(true)
    this.connManager.on('data', this.onData)
    if (this.connManager.status === 'connected') {
      this.startHeartbeat()
      this.startLinkStats()
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
    this.ftp = new MavlinkFtp({
      sendFtpPayload: (payload) => this.sendFtpPayload(payload),
      emitMessage: (message) => this.emit('message', message),
      linkIsBluetooth: () => this.connManager.config?.type === 'bluetooth',
    })
    this.logTransfer = new MavlinkLogTransfer({
      sendLogRequest: (request) => this.sendLogRequest(request),
      emitMessage: (message) => this.emit('message', message),
      linkIsBluetooth: () => this.connManager.config?.type === 'bluetooth',
    })
    this.connManager.on('data', this.onData)
    this.connManager.on('statusChange', this.onStatusChange)
  }

  private targetKey(systemId: number, componentId: number): string {
    return `${systemId}:${componentId}`
  }

  private vehicleMutationFingerprint(): string {
    return JSON.stringify([
      this.vehicleSafetyGeneration,
      this.targetSysId,
      this.targetCompId,
      this.selectedIdentity?.autopilotId ?? null,
      this.selectedIdentity?.vehicleTypeId ?? null,
    ])
  }

  private advanceVehicleSafetyGeneration(): void {
    this.vehicleSafetyGeneration += 1
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
    this.emit('message', this.buildTargetMessage(reason))
  }

  private buildTargetMessage(reason: 'discovered' | 'selected' | 'reset'):
    Extract<ServerMessage, { type: 'target' }> {
    return {
      type: 'target',
      data: {
        systemId: this.targetSysId,
        componentId: this.targetCompId,
        ready: this.hasReadyTarget(),
        reason,
        identity: this.selectedIdentity,
        discovered: [...this.discoveredTargets.values()].map((target) => ({
          systemId: target.systemId,
          componentId: target.componentId,
          autopilot: target.autopilot,
          type: target.type,
        })),
      },
    }
  }

  /**
   * Return the current target state without emitting it. The WebSocket
   * boundary uses this when a client joins after the target was discovered;
   * without the replay, that client can see vehicleReady=true but never learn
   * the target IDs needed to request parameters.
   */
  getTargetMessage(): Extract<ServerMessage, { type: 'target' }> {
    const reason: 'discovered' | 'selected' | 'reset' = this.targetSysId === null
      ? 'reset'
      : this.hasReadyTarget()
        ? 'selected'
        : 'discovered'
    return this.buildTargetMessage(reason)
  }

  private emitOperationError(
    operation: string,
    code: string,
    message: string,
    requestId?: string,
    retryable = false,
  ): void {
    const belongsToParamRun = this.paramDownloadActive
      && (operation === 'param_request_list' || operation === 'parameter_download' || operation === 'param_sync')
    this.emit('message', {
      type: 'operation_error',
      data: { requestId, operation, code, message, retryable },
      ...(belongsToParamRun ? { paramRunId: this.paramRunId } : {}),
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

  private isSelectedSensorComponentSource(msg: Pick<MavlinkMessage, 'msgId' | 'sysId'>): boolean {
    return this.targetSysId !== null
      && msg.sysId === this.targetSysId
      && SENSOR_COMPONENT_MESSAGE_IDS.has(msg.msgId)
  }

  private effectiveMessageRate(group: MessageRateGroup): number {
    const requestedHz = this.messageRates[group]
    return this.telemetryProfile === 'parameter-sync' ? Math.min(requestedHz, 2) : requestedHz
  }

  private sendMessageIntervalRequest(
    messageId: number,
    group: MessageRateGroup,
    targetComponent: number,
  ): void {
    const setIntervalCommand =
      (MAVLINK_COMMANDS as Record<string, number>).MAV_CMD_SET_MESSAGE_INTERVAL
    if (setIntervalCommand === undefined || this.messageIntervalSupport === 'unsupported') return
    const intervalUs = Math.round(1_000_000 / this.effectiveMessageRate(group))
    this.sendInternalCommand(
      setIntervalCommand,
      [messageId, intervalUs, 0, 0, 0, 0, 0],
      targetComponent,
    )
  }

  private observeMessageComponent(msg: Pick<MavlinkMessage, 'msgId' | 'compId'>): void {
    const group = MESSAGE_RATE_GROUP_BY_ID.get(msg.msgId)
    if (!group) return
    let components = this.observedMessageComponents.get(msg.msgId)
    if (!components) {
      components = new Set<number>()
      this.observedMessageComponents.set(msg.msgId, components)
    }
    if (components.has(msg.compId)) return
    components.add(msg.compId)
    // A routed sensor can retain its own component id. Targeting only the
    // autopilot component then produces an accepted ACK without changing the
    // real emitter. Send the same interval request directly to a newly seen
    // sibling component once; unsupported components simply ignore it.
    if (
      msg.compId !== this.targetCompId
      && this.telemetryProfile !== null
      && this.connManager.status === 'connected'
    ) {
      this.sendMessageIntervalRequest(msg.msgId, group, msg.compId)
    }
  }

  private vehicleWriteCapabilityError(): string | null {
    return vehicleCapabilities(this.selectedIdentity).writeOperations
      ? null
      : '当前飞控类型为只读配置，尚未开放写操作'
  }

  private requireWritableVehicle(operation: string, requestId?: string): boolean {
    const message = this.vehicleWriteCapabilityError()
    if (!message) return true
    this.emitOperationError(
      operation,
      'unsupported_vehicle_profile',
      message,
      requestId,
    )
    return false
  }

  private requireWritableFilesystem(requestId?: string): boolean {
    const message = this.vehicleWriteCapabilityError()
    if (!message) return true
    this.emitFsOpError(
      'delete',
      'unsupported_vehicle_profile',
      message,
      requestId,
    )
    return false
  }

  private requireWritableLogs(requestId?: string): boolean {
    const message = this.vehicleWriteCapabilityError()
    if (!message) return true
    this.emitLogOpError(
      'erase',
      'unsupported_vehicle_profile',
      message,
      requestId,
    )
    return false
  }

  /**
   * Capability gate for client-issued MAVLink commands. Returns the blocking
   * explanation, or null when the selected profile supports the command.
   * Computed from HEARTBEAT identity only - never from parameters.
   */
  private commandCapabilityError(cmd: string): string | null {
    const caps = vehicleCapabilities(this.selectedIdentity)
    const writeError = this.vehicleWriteCapabilityError()
    if (writeError) return writeError
    switch (cmd) {
      case 'MAV_CMD_COMPONENT_ARM_DISARM':
        return caps.arm ? null : '当前飞控类型尚未适配解锁/上锁操作'
      case 'MAV_CMD_NAV_TAKEOFF':
        return caps.guidedTakeoff ? null : '当前飞控类型尚未适配引导起飞'
      case 'MAV_CMD_NAV_LAND':
      case 'MAV_CMD_NAV_RETURN_TO_LAUNCH':
      case 'MAV_CMD_DO_SET_MODE':
        return caps.setMode ? null : '当前飞控类型尚未适配模式/导航命令'
      case 'MAV_CMD_PREFLIGHT_CALIBRATION':
        return caps.calibrate ? null : '当前飞控类型尚未适配校准流程'
      default:
        return null
    }
  }

  private writeMessage(
    message: MavLinkData,
    priority: SerialWritePriority = 'normal',
    queueTag?: SerialWriteQueueTag,
  ): boolean {
    try {
      const result = this.connManager.write(
        this.codec.serialize(message),
        priority,
        queueTag,
      ) as boolean | void
      return result !== false
    } catch (error) {
      console.error('[MAVLink] outbound serialization/write failed', error)
      return false
    }
  }

  private cancelQueuedMotorTestStarts(instances: Iterable<number>): void {
    for (const instance of instances) {
      this.connManager.cancelQueuedWrites(motorTestStartQueueTag(instance))
    }
  }

  private resetTargetState(clearDiscovery: boolean): void {
    this.advanceVehicleSafetyGeneration()
    this.abortAirframeTransaction('safety_context_changed_no_rollback:target_reset')
    this.cancelQueuedMotorTestStarts(ALL_MOTOR_TEST_INSTANCES)
    // A target switch/reset invalidates any calibration session bound to the
    // previous selected autopilot; terminate it once and drop the reference.
    if (this.activeCalibration) {
      const session = this.activeCalibration
      this.activeCalibration = null
      session.terminate('target_reset', '已选飞控目标已变更或复位，校准会话终止')
    }
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
    this.selectedIdentity = null
    this.parameterValues.clear()
    this.parameterTypes.clear()
    this.parameterCacheLimitWarned = false
    this.lastArmedState = null
    this.messageIntervalSupport = 'unknown'
    this.messageIntervalAttempts = 0
    this.lastAttitudeBootMs = null
    this.observedMessageComponents.clear()
    if (this.messageIntervalFallbackTimer) {
      clearTimeout(this.messageIntervalFallbackTimer)
      this.messageIntervalFallbackTimer = null
    }
    this.paramEncoding = 'c-cast'
    this.paramEncodingNegotiated = false
    this.versionAttempt = 0
    this.lastAutopilotVersionMessage = null
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
    // Mark the airframe transaction terminal before PARAM_SET completions are
    // failed below. Otherwise a completion callback could start a rollback on
    // a target/authority that has just become unsafe.
    this.abortAirframeTransaction(`safety_context_changed_no_rollback:${reason}`)
    if (this.shellActive || this.shellPending) {
      if (this.shellProbeTimer) clearTimeout(this.shellProbeTimer)
      this.shellProbeTimer = null
      this.shellActive = false
      this.shellPending = false
      this.emit('message', { type: 'shell_status', data: { active: false, reason } } as ServerMessage)
    }
    this.cancelParamDownload(restoreTelemetry, reason)
    this.ftp.cancelAll(reason)
    this.logTransfer.cancelAll(reason)
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
      pending.completion?.(false, undefined, reason)
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
    // Invalidate transaction fingerprints before pending callbacks are
    // completed by cancelProtocolOperations(). No rollback may be sent while
    // a target switch is already in progress.
    this.advanceVehicleSafetyGeneration()
    this.cancelQueuedMotorTestStarts(ALL_MOTOR_TEST_INSTANCES)
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
    // Discovery is the only broadly cross-source operation. Once selected,
    // commands and state stay scoped to the exact system/component pair; only
    // the sensor telemetry allow-list may arrive from sibling components in
    // the same MAVLink system.
    if (msg.msgId === 0) {
      this.handleHeartbeat(msg)
      return
    }
    if (!this.isSelectedSource(msg) && !this.isSelectedSensorComponentSource(msg)) return
    // The codec has already validated framing, CRC and (when configured)
    // signatures. Every such frame from the selected autopilot is proof that
    // the link is alive, even when OpenConfigurator has no handler for that message id.
    this.connManager.notifyAutopilotActivity()
    this.observeMessageComponent(msg)
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
      case 76: // COMMAND_LONG (FC -> GCS; used by ACCELCAL_VEHICLE_POS)
        this.handleInboundCommandLong(msg)
        break
      case 77: // COMMAND_ACK
        this.handleCommandAck(msg)
        break
      case 100: // OPTICAL_FLOW (legacy/non-integrating sensors)
        this.handleOpticalFlowLegacy(msg)
        break
      case 106: // OPTICAL_FLOW_RAD
        this.handleOpticalFlow(msg)
        break
      case 132: // DISTANCE_SENSOR
        this.handleDistanceSensor(msg)
        break
      case 173: // RANGEFINDER (ardupilotmega legacy fallback)
        this.handleRangefinder(msg)
        break
      case 110: // FILE_TRANSFER_PROTOCOL
        this.handleFileTransferProtocol(msg)
        break
      case 118: // LOG_ENTRY
        this.handleLogEntry(msg)
        break
      case 120: // LOG_DATA
        this.handleLogData(msg)
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
      case 191: // MAG_CAL_PROGRESS (ardupilotmega)
        this.handleMagCalProgress(msg)
        break
      case 192: // MAG_CAL_REPORT
        this.handleMagCalReport(msg)
        break
      case 126: // SERIAL_CONTROL (PX4 ESC passthrough)
        this.handleSerialControl(msg)
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
      type: hb.type,
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

    // Preserve both HEARTBEAT identity fields for every selected heartbeat so
    // the profile survives firmware reboots that change type/autopilot.
    const identity = buildVehicleIdentity(hb.autopilot, hb.type)
    const identityChanged = this.selectedIdentity === null
      || this.selectedIdentity.autopilotId !== identity.autopilotId
      || this.selectedIdentity.vehicleTypeId !== identity.vehicleTypeId
    const armed = (hb.baseMode & 0x80) !== 0
    const becameArmed = armed && this.lastArmedState !== true
    if (identityChanged || becameArmed) {
      this.cancelQueuedMotorTestStarts(ALL_MOTOR_TEST_INSTANCES)
    }
    if (identityChanged) {
      this.advanceVehicleSafetyGeneration()
      this.abortAirframeTransaction('safety_context_changed_no_rollback:identity_changed')
    }
    if (becameArmed) {
      this.abortAirframeTransaction('safety_context_changed_no_rollback:vehicle_armed')
      // Arming may come from another GCS. Calibration is a disarmed-only
      // workflow, so terminate immediately before any later owner action can
      // send a position confirmation or compass-accept command.
      this.activeCalibration?.terminate(
        'vehicle_armed',
        '检测到飞行器已解锁，校准会话已终止',
      )
    }
    this.selectedIdentity = identity
    this.connManager.notifyAutopilotHeartbeat()
    if (!this.connManager.vehicleReady) {
      // During a deliberate reboot the connection manager rejects the final
      // stale heartbeat for readiness. Do not let that frame re-arm telemetry
      // setup that the rebooting flight controller is about to discard.
      this.selectedHeartbeatReady = false
      return
    }
    const becameReady = !this.selectedHeartbeatReady
    this.selectedHeartbeatReady = true
    if (becameReady && this.requestedTelemetryStreams) {
      // USB serial can remain open across an FC reboot. In that case there is
      // no statusChange event to reset the protocol, but the FC has forgotten
      // every SET_MESSAGE_INTERVAL request. Re-arm stream negotiation on the
      // first accepted post-reboot heartbeat.
      this.requestedTelemetryStreams = false
      this.telemetryProfile = null
      this.messageIntervalSupport = 'unknown'
      this.messageIntervalAttempts = 0
      this.lastAttitudeBootMs = null
      if (this.messageIntervalFallbackTimer) {
        clearTimeout(this.messageIntervalFallbackTimer)
        this.messageIntervalFallbackTimer = null
      }
    }
    if (becameReady || identityChanged) this.emitTarget('selected')
    // Use the autopilot class only as an early compatibility fallback. The
    // authoritative encoding is negotiated from AUTOPILOT_VERSION capabilities.
    if (!this.paramEncodingNegotiated) {
      this.paramEncoding = hb.autopilot === 12 ? 'bytewise' : 'c-cast'
    }
    if (this.versionAttempt === 0) this.requestAutopilotVersion()

    this.lastArmedState = armed
    const mode = decodeFlightMode(identity.family, identity.vehicleClass, hb.customMode)
    this.emit('message', {
      type: 'status',
      data: {
        armed,
        mode: mode.name,
        modeId: mode.id,
        // Neither PX4 nor ArduPilot exposes a dedicated HEARTBEAT failsafe
        // bit; both report failsafe via STATUSTEXT / SYS_STATUS sensor flags,
        // so it cannot be reliably derived here. Report 'unknown' instead of
        // a misleading hardcoded false - a safety-critical field must never
        // silently claim "no failsafe".
        failsafe: 'unknown',
        systemStatus: hb.systemStatus,
        identity,
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
    const d = decode<common.ServoOutputRaw>(36, msg.payload)
    if (!d) return
    const servoValues = [
      d.servo1Raw, d.servo2Raw, d.servo3Raw, d.servo4Raw,
      d.servo5Raw, d.servo6Raw, d.servo7Raw, d.servo8Raw,
      d.servo9Raw, d.servo10Raw, d.servo11Raw, d.servo12Raw,
      d.servo13Raw, d.servo14Raw, d.servo15Raw, d.servo16Raw,
    ]
    // MAVLink v2 zero-trims trailing payload bytes, so the wire length cannot
    // be used as a presence test: a quad with servo5..16 = 0 and port = 0
    // arrives as a 12-byte frame and decode() pads the rest back to zero.
    // A raw value of 0 means "output not driven" (PX4 uses 0 for unassigned
    // outputs; real PWM is never 0 us), so map 0 to null for the UI.
    const outputs: Array<number | null> = servoValues.map((value) =>
      value === 0 ? null : value,
    )
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
    // 0xffff is the documented "unknown" sentinel. ArduPilot without a battery
    // monitor reports exactly 0 mV instead, which must not render as a healthy
    // 0.0 V. Treat both as "no valid voltage source".
    const voltageBattery = (d.voltageBattery === 0xffff || d.voltageBattery === 0)
      ? null
      : d.voltageBattery / 1000
    const currentBattery = d.currentBattery === -1 ? null : d.currentBattery / 100
    // battery_remaining is at wire offset 30. The previous hand-rolled parser
    // read offset 18 (drop_rate_comm) - a latent bug fixed by this migration.
    // Without a valid voltage source the remaining percentage is not
    // trustworthy, so suppress it rather than imply a healthy pack.
    const batteryRemaining = (d.batteryRemaining === -1 || voltageBattery === null)
      ? null
      : d.batteryRemaining
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
        // load is in 0.1% units per the MAVLink spec (1000 = 100%).
        cpuLoad: d.load / 10,
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
    // HIGHRES_IMU_UPDATED_FLAGS bit 12 (0x1000) = temperature. PX4 fills the
    // temperature field with a placeholder (15 degC ISA) when no die
    // temperature is available, so only trust it when the bit is set.
    const temperatureUpdated = (Number(d.fieldsUpdated) & 0x1000) !== 0
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
      temperature: temperatureUpdated && Number.isFinite(d.temperature) ? d.temperature : null,
    }
    this.emit('message', { type: 'sensor', msgType: 'HIGHRES_IMU', data } as ServerMessage)

    // HIGHRES_IMU also carries the barometer sample (abs_pressure in hPa).
    // PX4 profiles that publish HIGHRES_IMU do not necessarily stream
    // SCALED_PRESSURE, so surface the baro data from here as well; the
    // frontend treats it like a SCALED_PRESSURE update (last writer wins).
    const absPressureUpdated = (Number(d.fieldsUpdated) & 0x200) !== 0
    if (absPressureUpdated && Number.isFinite(d.absPressure) && d.absPressure > 0) {
      const diffPressureUpdated = (Number(d.fieldsUpdated) & 0x400) !== 0
      // Same ISA formula as handleScaledPressure so altitude readings stay
      // consistent no matter which message delivered the pressure sample.
      const altitude = 44330 * (1 - Math.pow(d.absPressure / 1013.25, 0.1903))
      this.emit('message', {
        type: 'sensor',
        msgType: 'HIGHRES_IMU_PRESSURE',
        data: {
          press_abs: d.absPressure,
          press_diff: diffPressureUpdated && Number.isFinite(d.diffPressure) ? d.diffPressure : 0,
          // Never trust HIGHRES_IMU temperature for the baro card: PX4 fills
          // a 15 degC ISA placeholder and the fields_updated bit is not
          // reliable across versions. SCALED_PRESSURE carries the real one.
          temperature: null,
          altitude: Number.isFinite(altitude) ? altitude : null,
        },
      } as ServerMessage)
    }
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
    // A large time_boot_ms regression means the FC rebooted mid-session and
    // lost every SET_MESSAGE_INTERVAL configuration. Re-request the active
    // telemetry profile so the streams recover without a manual reconnect.
    if (
      this.lastAttitudeBootMs !== null
      && d.timeBootMs < this.lastAttitudeBootMs - FC_REBOOT_DETECTION_MARGIN_MS
    ) {
      const profile: TelemetryProfile =
        this.paramDownloadActive ? 'parameter-sync' : 'normal'
      this.telemetryProfile = null
      this.applyTelemetryProfile(profile)
    }
    this.lastAttitudeBootMs = d.timeBootMs
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
    // Channels beyond chancount are UINT16_MAX per the MAVLink spec (PX4
    // fills them exactly that way); forward those as null so the UI hides
    // unused channels instead of rendering 65535 us bars.
    const values = [
      d.chan1Raw, d.chan2Raw, d.chan3Raw, d.chan4Raw, d.chan5Raw, d.chan6Raw,
      d.chan7Raw, d.chan8Raw, d.chan9Raw, d.chan10Raw, d.chan11Raw, d.chan12Raw,
      d.chan13Raw, d.chan14Raw, d.chan15Raw, d.chan16Raw, d.chan17Raw, d.chan18Raw,
    ]
    const channel = (index: number): number | null => {
      const value = values[index]
      if (value === 0xffff) return null
      if (d.chancount > 0 && index >= d.chancount) return null
      return value
    }
    const data: RcChannelsData = {
      ch1: channel(0), ch2: channel(1), ch3: channel(2), ch4: channel(3),
      ch5: channel(4), ch6: channel(5), ch7: channel(6), ch8: channel(7),
      ch9: channel(8), ch10: channel(9), ch11: channel(10), ch12: channel(11),
      ch13: channel(12), ch14: channel(13), ch15: channel(14), ch16: channel(15),
      ch17: channel(16), ch18: channel(17),
      // RSSI 255 = unknown per spec.
      rssi: d.rssi === 255 ? null : d.rssi,
    }
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
    // MAVLink v2 zero-trims trailing payload bytes: a short v2 frame means
    // the remaining extension bytes are zero (decode() already padded them),
    // not absent. Only v1 frames genuinely lack the extension fields, so
    // length-gating applies to them alone. Filter by the configured GCS
    // identity (not literal 255/190) so custom gcs ids keep receiving ACKs.
    const hasExtensions = msg.version !== 1
    if (
      (hasExtensions || msg.payload.length >= 9)
      && (
        (d.targetSystem !== 0 && d.targetSystem !== this.codec.gcsSystemId)
        || (
          (hasExtensions || msg.payload.length >= 10)
          && d.targetComponent !== 0
          && d.targetComponent !== this.codec.gcsComponentId
        )
      )
    ) return
    // Let an active calibration session observe the ACK first (its start and
    // follow-up commands bypass pendingCommands, so the generic transaction
    // logic below would otherwise treat them as orphaned). The session only
    // reacts to its own command id.
    this.activeCalibration?.handleCommandAck(d.command as number, d.result)
    if (d.command === (MAVLINK_COMMANDS as Record<string, number>).MAV_CMD_SET_MESSAGE_INTERVAL) {
      if (d.result === MAV_RESULT_ACCEPTED) {
        // Requests for different message ids share one command id. Some ids
        // may be unavailable on a given airframe, so any accepted request is
        // sufficient proof that SET_MESSAGE_INTERVAL itself is supported.
        this.messageIntervalSupport = 'supported'
        if (this.messageIntervalFallbackTimer) {
          clearTimeout(this.messageIntervalFallbackTimer)
          this.messageIntervalFallbackTimer = null
        }
      }
      // A failure may describe only the requested message id, not support for
      // the command itself. With no accepted ACK the bounded retry timer below
      // still falls back to REQUEST_DATA_STREAM.
    }

    const commandId = d.command as number
    const pending = this.pendingCommands.get(commandId)
    const orphanedTransaction = !pending && (
      this.uncertainCommands.has(commandId)
      || this.isCommandQuarantined(commandId)
    )
    const progress = (hasExtensions || msg.payload.length >= 4)
      && d.progress !== COMMAND_ACK_PROGRESS_UNKNOWN
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
      resultParam2: hasExtensions || msg.payload.length >= 8 ? d.resultParam2 : undefined,
      targetSystem: hasExtensions || msg.payload.length >= 9 ? d.targetSystem : undefined,
      targetComponent: hasExtensions || msg.payload.length >= 10 ? d.targetComponent : undefined,
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
    // MAVLink permits NaN for unavailable OPTICAL_FLOW_RAD gyro integrals.
    // Normalize them before crossing the JSON boundary instead of relying on
    // JSON.stringify(NaN) implicitly turning them into null.
    const integratedXgyro = Number.isFinite(d.integratedXgyro) ? d.integratedXgyro : null
    const integratedYgyro = Number.isFinite(d.integratedYgyro) ? d.integratedYgyro : null
    const integratedZgyro = Number.isFinite(d.integratedZgyro) ? d.integratedZgyro : null
    const data = {
      source: 'OPTICAL_FLOW_RAD' as const,
      sensor_id: d.sensorId,
      integration_time_us: d.integrationTimeUs,
      integrated_x_rad: d.integratedX,
      integrated_y_rad: d.integratedY,
      integrated_xgyro_rad: integratedXgyro,
      integrated_ygyro_rad: integratedYgyro,
      integrated_zgyro_rad: integratedZgyro,
      // OPTICAL_FLOW_RAD temperature is cdegC with 0 = no temperature sensor
      // (same convention as SCALED_IMU), so map 0 to null.
      temperature_c: d.temperature === 0 ? null : d.temperature / 100,
      time_delta_distance_us: d.timeDeltaDistanceUs,
      distance_m: distance,
      // Deprecated compatibility aliases. These retain their historical
      // values while callers migrate to the correctly named fields above.
      flow_x: d.integratedX,
      flow_y: d.integratedY,
      flow_comp_m_x: integratedXgyro,
      flow_comp_m_y: integratedYgyro,
      quality: d.quality,
      ground_distance: distance,
    }
    this.emit('message', { type: 'sensor', msgType: 'OPTICAL_FLOW_RAD', data } as ServerMessage)
  }

  private handleOpticalFlowLegacy(msg: MavlinkMessage) {
    const d = decode<common.OpticalFlow>(100, msg.payload)
    if (!d) return
    const distance = Number.isFinite(d.groundDistance) && d.groundDistance >= 0
      ? d.groundDistance
      : null
    const data = {
      source: 'OPTICAL_FLOW' as const,
      sensor_id: d.sensorId,
      // OPTICAL_FLOW reports pixel displacement and compensated velocity, not
      // integrated radians. Keep the RAD-only fields neutral while preserving
      // the native values in the compatibility fields used by the UI.
      integration_time_us: 0,
      integrated_x_rad: 0,
      integrated_y_rad: 0,
      integrated_xgyro_rad: 0,
      integrated_ygyro_rad: 0,
      integrated_zgyro_rad: 0,
      temperature_c: null,
      time_delta_distance_us: 0,
      distance_m: distance,
      flow_x: d.flowX,
      flow_y: d.flowY,
      flow_comp_m_x: d.flowCompMX,
      flow_comp_m_y: d.flowCompMY,
      quality: d.quality,
      ground_distance: distance,
    }
    this.emit('message', { type: 'sensor', msgType: 'OPTICAL_FLOW', data } as ServerMessage)
  }

  private handleFileTransferProtocol(msg: MavlinkMessage) {
    const d = decode<common.FileTransferProtocol>(FTP_MESSAGE_ID, msg.payload)
    if (!d) return
    // Only consume replies addressed to this GCS (or broadcast).
    if (d.targetSystem !== 0 && d.targetSystem !== this.codec.gcsSystemId) return
    this.ftp.handleFtpPayload(Buffer.from(d.payload as unknown as number[]))
  }

  private sendFtpPayload(payload: Buffer): boolean {
    const message = new common.FileTransferProtocol()
    message.targetNetwork = 0
    message.targetSystem = this.targetSysId ?? 0
    message.targetComponent = this.targetCompId ?? 0
    // The wire field is a fixed 251-byte array; MAVLink v2 zero-trims the
    // trailing padding on serialization.
    const padded = Buffer.alloc(251)
    payload.copy(padded, 0)
    message.payload = Array.from(padded) as unknown as typeof message.payload
    return this.writeMessage(message)
  }

  /** Resolve a completed FTP or DataFlash download for the REST file endpoint. */
  getFtpDownload(downloadId: string): FtpDownloadRecord | null {
    return this.ftp.getDownload(downloadId) ?? this.logTransfer.getDownload(downloadId)
  }

  private handleLogEntry(msg: MavlinkMessage) {
    const d = decode<common.LogEntry>(LOG_ENTRY_MESSAGE_ID, msg.payload)
    if (!d) return
    this.logTransfer.handleLogEntry({
      id: d.id,
      numLogs: d.numLogs,
      lastLogNum: d.lastLogNum,
      timeUtc: d.timeUtc,
      size: d.size,
    })
  }

  private handleLogData(msg: MavlinkMessage) {
    const d = decode<common.LogData>(LOG_DATA_MESSAGE_ID, msg.payload)
    if (!d) return
    this.logTransfer.handleLogData({
      id: d.id,
      ofs: d.ofs,
      count: d.count,
      data: Buffer.from(d.data as unknown as number[]),
    })
  }

  /** Map a log-transfer request descriptor onto the wire message classes. */
  private sendLogRequest(request: LogTransferRequest): boolean {
    const targetSystem = this.targetSysId ?? 0
    const targetComponent = this.targetCompId ?? 0
    switch (request.kind) {
      case 'list': {
        const message = new common.LogRequestList()
        message.targetSystem = targetSystem
        message.targetComponent = targetComponent
        message.start = request.start
        message.end = request.end
        return this.writeMessage(message)
      }
      case 'data': {
        const message = new common.LogRequestData()
        message.targetSystem = targetSystem
        message.targetComponent = targetComponent
        message.id = request.logId
        message.ofs = request.ofs
        message.count = request.count
        return this.writeMessage(message)
      }
      case 'erase': {
        const message = new common.LogErase()
        message.targetSystem = targetSystem
        message.targetComponent = targetComponent
        return this.writeMessage(message)
      }
      case 'end': {
        const message = new common.LogRequestEnd()
        message.targetSystem = targetSystem
        message.targetComponent = targetComponent
        return this.writeMessage(message)
      }
    }
  }

  private emitLogOpError(
    operation: 'list' | 'download' | 'erase',
    code: string,
    message: string,
    requestId?: string,
    retryable = false,
  ): void {
    this.emit('message', {
      type: 'log_op_error',
      data: { ...(requestId ? { requestId } : {}), operation, code, message, retryable },
    } as ServerMessage)
  }

  /**
   * DataFlash log transfers must not share the link with a full parameter
   * sync or an FTP transfer, and are only meaningful on vehicles whose
   * profile reports the DataFlash log format (i.e. ArduPilot).
   */
  private requireLogTransferAvailable(
    operation: 'list' | 'download' | 'erase',
    requestId?: string,
  ): boolean {
    if (vehicleCapabilities(this.selectedIdentity).logFormat !== 'dataflash') {
      this.emitLogOpError(
        operation,
        'unsupported_log_transport',
        '当前飞控类型不使用 DataFlash 日志传输协议',
        requestId,
      )
      return false
    }
    if (this.paramDownloadActive) {
      this.emitLogOpError(
        operation,
        'param_sync_active',
        '参数同步进行中，请稍后再执行日志操作',
        requestId,
        true,
      )
      return false
    }
    if (this.ftp.busy) {
      this.emitLogOpError(
        operation,
        'ftp_busy',
        '文件传输进行中，无法同时执行日志操作',
        requestId,
        true,
      )
      return false
    }
    return true
  }

  /**
   * Register a temporary SERIAL_CONTROL reply consumer for the PX4 ESC
   * transport. Returns an unsubscribe function. MAVLink is not paused; the
   * transport filters replies by device itself.
   */
  onSerialControl(listener: (message: common.SerialControl) => void): () => void {
    this.serialControlListeners.add(listener)
    return () => this.serialControlListeners.delete(listener)
  }

  /** Send a SERIAL_CONTROL (#126) message to the selected autopilot. */
  sendSerialControl(fields: {
    device: number
    flags: number
    timeout: number
    baudrate: number
    count: number
    data: Uint8Array
  }): boolean {
    const message = new common.SerialControl()
    message.targetSystem = this.targetSysId ?? 0
    message.targetComponent = this.targetCompId ?? 0
    message.device = fields.device as unknown as typeof message.device
    message.flags = fields.flags as unknown as typeof message.flags
    message.timeout = fields.timeout
    message.baudrate = fields.baudrate
    message.count = fields.count
    // The wire field is a fixed 70-byte array; MAVLink v2 zero-trims padding.
    const padded = Buffer.alloc(70)
    Buffer.from(fields.data).copy(padded, 0)
    message.data = Array.from(padded) as unknown as typeof message.data
    return this.writeMessage(message)
  }

  private handleSerialControl(msg: MavlinkMessage): void {
    if (this.serialControlListeners.size === 0 && !this.shellActive && !this.shellPending) return
    if (!this.isSelectedSource(msg)) return
    const decoded = decode<common.SerialControl>(126, msg.payload)
    if (!decoded) return
    if (
      (this.shellActive || this.shellPending)
      && Number(decoded.device) === PX4_SHELL_SERIAL_CONTROL_DEVICE
      && decoded.count > 0
    ) {
      if (this.shellPending) {
        this.shellPending = false
        this.shellActive = true
        if (this.shellProbeTimer) clearTimeout(this.shellProbeTimer)
        this.shellProbeTimer = null
        this.emitShellStatus(true)
      }
      const bytes = Buffer.from(decoded.data as unknown as number[]).subarray(0, decoded.count)
      this.emit('message', {
        type: 'shell_output',
        data: { text: bytes.toString('utf8') },
      } as ServerMessage)
    }
    for (const listener of [...this.serialControlListeners]) {
      try {
        listener(decoded)
      } catch (error) {
        console.error('[MAVLink] SERIAL_CONTROL listener threw:', error)
      }
    }
  }

  private emitShellStatus(active: boolean, reason?: string): void {
    this.emit('message', {
      type: 'shell_status',
      data: { active, ...(reason ? { reason } : {}) },
    } as ServerMessage)
  }

  private openShell(requestId?: string): void {
    if (this.shellActive) {
      this.emitShellStatus(true)
      return
    }
    if (this.shellPending) {
      this.emitShellStatus(false, 'probing')
      return
    }
    if (vehicleCapabilities(this.selectedIdentity).mavlinkShell !== 'px4-nsh') {
      this.emitOperationError('shell', 'unsupported_vehicle_profile', '当前固件未提供已验证的 MAVLink 交互 Shell', requestId)
      this.emitShellStatus(false, 'unsupported_vehicle_profile')
      return
    }
    if (this.lastArmedState !== false) {
      this.emitOperationError(
        'shell',
        this.lastArmedState === true ? 'vehicle_armed' : 'arming_state_unknown',
        this.lastArmedState === true ? '飞行器已解锁，拒绝打开终端' : '飞行器解锁状态未知，拒绝打开终端',
        requestId,
      )
      this.emitShellStatus(false, 'unsafe_arming_state')
      return
    }
    if (this.paramDownloadActive || this.ftp.busy || this.logTransfer.busy) {
      this.emitOperationError('shell', 'transfer_busy', '参数或日志传输进行中，暂不能打开终端', requestId, true)
      this.emitShellStatus(false, 'transfer_busy')
      return
    }
    this.shellPending = true
    this.emitShellStatus(false, 'probing')
    if (!this.sendShellPayload('\r')) {
      this.shellPending = false
      this.emitOperationError('shell', 'write_failed', '终端探测数据未能写入飞控', requestId, true)
      this.emitShellStatus(false, 'write_failed')
      return
    }
    this.shellProbeTimer = setTimeout(() => {
      this.shellProbeTimer = null
      if (!this.shellPending || this.destroyed) return
      this.shellPending = false
      this.sendSerialControl({
        device: PX4_SHELL_SERIAL_CONTROL_DEVICE,
        flags: 0,
        timeout: 0,
        baudrate: 0,
        count: 0,
        data: new Uint8Array(),
      })
      this.emitOperationError(
        'shell',
        'shell_probe_timeout',
        '飞控未响应 MAVLink Shell；当前板卡或固件可能未编译该功能',
        requestId,
        true,
      )
      this.emitShellStatus(false, 'shell_probe_timeout')
    }, SHELL_PROBE_TIMEOUT_MS)
  }

  private sendShellPayload(text: string): boolean {
    const bytes = Buffer.from(text, 'utf8')
    for (let offset = 0; offset < bytes.length; offset += SERIAL_CONTROL_MAX_DATA) {
      const chunk = bytes.subarray(offset, offset + SERIAL_CONTROL_MAX_DATA)
      const sent = this.sendSerialControl({
        device: PX4_SHELL_SERIAL_CONTROL_DEVICE,
        flags: SERIAL_CONTROL_FLAGS.Respond | SERIAL_CONTROL_FLAGS.Exclusive | SERIAL_CONTROL_FLAGS.Multi,
        timeout: 0,
        baudrate: 0,
        count: chunk.length,
        data: chunk,
      })
      if (!sent) return false
    }
    return true
  }

  private writeShell(text: string, requestId?: string): void {
    if (!this.shellActive) {
      const message = this.shellPending ? '正在确认飞控 Shell 能力' : 'PX4 终端尚未打开'
      this.emitOperationError('shell', 'shell_not_open', message, requestId, true)
      return
    }
    if (!this.sendShellPayload(text)) {
      this.emitOperationError('shell', 'write_failed', '终端数据未能写入飞控', requestId, true)
    }
  }

  private closeShell(reason = 'closed'): void {
    if (!this.shellActive && !this.shellPending) {
      this.emitShellStatus(false, reason)
      return
    }
    if (this.shellProbeTimer) clearTimeout(this.shellProbeTimer)
    this.shellProbeTimer = null
    this.sendSerialControl({
      device: PX4_SHELL_SERIAL_CONTROL_DEVICE,
      flags: 0,
      timeout: 0,
      baudrate: 0,
      count: 0,
      data: new Uint8Array(),
    })
    this.shellActive = false
    this.shellPending = false
    this.emitShellStatus(false, reason)
  }

  private emitFsOpError(
    operation: 'list' | 'download' | 'delete',
    code: string,
    message: string,
    requestId?: string,
    retryable = false,
  ): void {
    this.emit('message', {
      type: 'fs_op_error',
      data: { ...(requestId ? { requestId } : {}), operation, code, message, retryable },
    } as ServerMessage)
  }

  /** FTP transfers, DataFlash transfers and full parameter sync must not share the link. */
  private requireFtpAvailable(
    operation: 'list' | 'download' | 'delete',
    requestId?: string,
  ): boolean {
    if (this.logTransfer.busy) {
      this.emitFsOpError(
        operation,
        'log_transfer_busy',
        'DataFlash 日志传输进行中，请稍后再执行文件操作',
        requestId,
        true,
      )
      return false
    }
    if (!this.paramDownloadActive) return true
    this.emitFsOpError(
      operation,
      'param_sync_active',
      '参数同步进行中，请稍后再执行文件操作',
      requestId,
      true,
    )
    return false
  }

  private handleDistanceSensor(msg: MavlinkMessage) {
    const d = decode<common.DistanceSensor>(132, msg.payload)
    if (!d) return
    const data = {
      source: 'DISTANCE_SENSOR' as const,
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

  private handleRangefinder(msg: MavlinkMessage) {
    const d = decode<ardupilotmega.RangeFinder>(173, msg.payload)
    if (!d || !Number.isFinite(d.distance) || d.distance < 0) return
    // RANGEFINDER exposes only distance in metres. Normalize to the existing
    // centimetre-based DistanceSensorData shape without inventing limits or
    // signal quality; zero limits mean unspecified and are handled by the UI.
    const currentDistance = Math.round(d.distance * 100)
    const data = {
      source: 'RANGEFINDER' as const,
      min_distance: 0,
      max_distance: 0,
      current_distance: currentDistance,
      type: 0,
      id: 0,
      orientation: 25,
      signal_quality: null,
    }
    this.emit('message', { type: 'sensor', msgType: 'RANGEFINDER', data } as ServerMessage)
  }

  private handleBattery(msg: MavlinkMessage) {
    const d = decode<common.BatteryStatus>(147, msg.payload)
    if (!d) return
    // 0xffff = unknown/not populated; 0xfffe = cell present but the voltage
    // exceeds the field range (would otherwise read as a bogus 65.534 V).
    const baseCellVoltages = (d.voltages ?? []).map((voltage) =>
      voltage === 0 || voltage >= 0xfffe ? null : voltage / 1000
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
    this.cacheParameterValue(id, value)
    this.parameterTypes.set(id, paramType)

    this.emit('message', {
      type: 'param',
      data: { id, value, type: paramType, param_count: paramCount, param_index: paramIndex },
      ...(this.paramDownloadActive ? { paramRunId: this.paramRunId } : {}),
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
    const text = bytes.toString('utf8')
    this.emit('message', {
      type: 'statustext',
      data: { severity, text },
    } as ServerMessage)
    // The full reassembled line is also fed to any active calibration session;
    // the PX4 [cal] protocol lives entirely in STATUSTEXT. statustext
    // broadcasting is unchanged so MessagesPage stays compatible.
    this.activeCalibration?.handleStatustext(text)
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

  /** Current parameter download run id, read by the server to tag generations. */
  get currentParamRunId(): number {
    return this.paramRunId
  }

  // Send commands from frontend
  handleClientMessage(msg: ClientMessage): MavlinkBridgeClientResult {
    let vehicleRebootQueued = false
    const isShellMessage = msg.type === 'shell_open' || msg.type === 'shell_write' || msg.type === 'shell_close'
    if ((this.shellActive || this.shellPending) && !isShellMessage) {
      this.emitOperationError(msg.type, 'shell_active', 'PX4 终端会话进行中，请先关闭终端', 'requestId' in msg ? msg.requestId : undefined, true)
      return { vehicleRebootQueued }
    }
    switch (msg.type) {
      case 'command': {
        if (this.requireReadyTarget('command', msg.requestId)) {
          // Capability gate: safety-critical commands are rejected before
          // serialization when the selected profile does not support them.
          const capabilityError = this.commandCapabilityError(msg.cmd)
          if (capabilityError) {
            this.emitOperationError(
              'command',
              'unsupported_vehicle_profile',
              capabilityError,
              msg.requestId,
            )
            break
          }
          this.sendCommand(
            msg.cmd,
            msg.params,
            msg.requestId,
            msg.safetyConfirmation,
          )
        }
        break
      }
      case 'set_flight_mode': {
        if (this.requireReadyTarget('set_flight_mode', msg.requestId)) {
          if (!vehicleCapabilities(this.selectedIdentity).setMode) {
            this.emitOperationError(
              'set_flight_mode',
              'unsupported_vehicle_profile',
              '当前飞控类型尚未适配模式切换',
              msg.requestId,
            )
            break
          }
          // Stack-specific encoding happens here, after the vehicle profile is
          // known; unknown/unimplemented profiles are rejected before any
          // bytes are written to the serial link.
          const encoded = encodeModeCommand(this.selectedIdentity, msg.data.modeId)
          if (!encoded.ok) {
            this.emitOperationError('set_flight_mode', encoded.code, encoded.message, msg.requestId)
            break
          }
          this.sendCommand('MAV_CMD_DO_SET_MODE', encoded.params, msg.requestId)
        }
        break
      }
      case 'start_calibration':
        // Calibration is owned by the server's CalibrationSessionManager, which
        // calls createCalibrationSession() directly; start_calibration never
        // reaches the bridge through this path.
        this.emitOperationError(
          'start_calibration',
          'unsupported_operation',
          '校准请求必须经由校准会话管理器发起',
          msg.requestId,
        )
        break
      case 'param_set':
        if (
          this.requireReadyTarget('param_set', msg.requestId)
          && this.requireWritableVehicle('param_set', msg.requestId)
        ) {
          this.sendParamSet(msg.data.id, msg.data.value, msg.data.paramType, msg.requestId)
        }
        break
      case 'reboot_vehicle':
        if (!this.requireReadyTarget('reboot_vehicle', msg.requestId)) break
        if (!this.requireWritableVehicle('reboot_vehicle', msg.requestId)) break
        if (this.lastArmedState !== false) {
          this.emitOperationError(
            'reboot_vehicle',
            this.lastArmedState === true ? 'armed' : 'arming_state_unknown',
            this.lastArmedState === true ? '飞控已解锁，拒绝重启' : '飞控解锁状态未知，拒绝重启',
            msg.requestId,
          )
          break
        }
        vehicleRebootQueued = this.sendCommand(
          'MAV_CMD_PREFLIGHT_REBOOT_SHUTDOWN',
          [1, 0, 0, 0, 0, 0, 0],
          msg.requestId,
        )
        if (vehicleRebootQueued) {
          // The connection manager is notified by the server immediately after
          // this handler returns. Invalidate bridge readiness now so recovery
          // does not depend on receiving a final pre-reboot heartbeat.
          this.selectedHeartbeatReady = false
        }
        break
      case 'param_request_list':
        if (this.requireReadyTarget('param_request_list', msg.requestId)) {
          if (this.ftp.busy || this.logTransfer.busy) {
            // A running FTP/log transfer would be starved by the parameter
            // burst (and vice versa); reject instead of silently degrading both.
            this.emitOperationError(
              'param_request_list',
              'ftp_busy',
              '文件传输进行中，无法同时下载参数',
              msg.requestId,
              true,
            )
          } else {
            this.sendParamRequestList()
          }
        }
        break
      case 'manual_control':
        if (
          this.requireReadyTarget('manual_control', msg.requestId)
          && this.requireWritableVehicle('manual_control', msg.requestId)
        ) {
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
      case 'message_rates_set':
        if (
          this.requireReadyTarget('message_rates_set', msg.requestId)
          && this.requireWritableVehicle('message_rates_set', msg.requestId)
        ) {
          this.messageRates = { ...msg.data }
          this.messageIntervalAttempts = 0
          this.sendTelemetryIntervalRequests()
          this.emit('message', this.getMessageRatesMessage())
        }
        break
      case 'vehicle_config_set':
        this.setVehicleConfiguration(msg)
        break
      case 'airframe_apply':
        this.applyAirframe(msg)
        break
      case 'radio_calibration_start':
      case 'radio_calibration_advance':
      case 'radio_calibration_cancel':
      case 'radio_calibration_reclaim':
        // Radio calibration is owned by the WebSocket-level session manager,
        // just like sensor calibration. Reaching this boundary is a routing bug.
        this.emitOperationError(msg.type, 'unsupported_operation', '遥控器校准请求必须经由会话管理器发起', msg.requestId)
        break
      case 'shell_open':
        if (this.requireReadyTarget('shell', msg.requestId)) this.openShell(msg.requestId)
        break
      case 'shell_write':
        if (this.requireReadyTarget('shell', msg.requestId)) this.writeShell(msg.data.text, msg.requestId)
        break
      case 'shell_close':
        this.closeShell('closed')
        break
      case 'motor_test_batch':
        if (this.requireReadyTarget('motor_test_batch', msg.requestId)) {
          this.sendMotorTestBatch(
            msg.data.instances,
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
      case 'fs_list':
        if (
          this.requireReadyTarget('fs_list', msg.requestId)
          && this.requireFtpAvailable('list', msg.requestId)
        ) {
          this.ftp.startList(msg.data.path, msg.requestId)
        }
        break
      case 'fs_download':
        if (
          this.requireReadyTarget('fs_download', msg.requestId)
          && this.requireFtpAvailable('download', msg.requestId)
        ) {
          this.ftp.startDownload(msg.data.path, msg.requestId)
        }
        break
      case 'fs_download_cancel':
        this.ftp.cancelDownload(msg.requestId)
        break
      case 'fs_delete':
        // The type carries the literal confirmation, but this boundary is also
        // exercised directly in tests - keep the runtime guard.
        if ((msg as { safetyConfirmation?: string }).safetyConfirmation !== 'delete_files') {
          this.emitFsOpError(
            'delete',
            'safety_confirmation_required',
            '删除飞控文件需要 delete_files 安全确认',
            msg.requestId,
          )
        } else if (
          this.requireReadyTarget('fs_delete', msg.requestId)
          && this.requireWritableFilesystem(msg.requestId)
          && this.requireFtpAvailable('delete', msg.requestId)
        ) {
          this.ftp.startDelete(msg.data.entries, msg.requestId)
        }
        break
      case 'log_list':
        if (
          this.requireReadyTarget('log_list', msg.requestId)
          && this.requireLogTransferAvailable('list', msg.requestId)
        ) {
          this.logTransfer.startList(msg.requestId)
        }
        break
      case 'log_download':
        if (
          this.requireReadyTarget('log_download', msg.requestId)
          && this.requireLogTransferAvailable('download', msg.requestId)
        ) {
          this.logTransfer.startDownload(msg.data.logId, msg.requestId)
        }
        break
      case 'log_download_cancel':
        this.logTransfer.cancelDownload(msg.requestId)
        break
      case 'log_erase':
        // LOG_ERASE wipes ALL logs on the FC; the runtime guard backs up the
        // type-level literal for direct (test/raw WS) callers.
        if ((msg as { safetyConfirmation?: string }).safetyConfirmation !== 'erase_all_logs') {
          this.emitLogOpError(
            'erase',
            'safety_confirmation_required',
            '擦除全部日志需要 erase_all_logs 安全确认',
            msg.requestId,
          )
        } else if (
          this.requireReadyTarget('log_erase', msg.requestId)
          && this.requireWritableLogs(msg.requestId)
          && this.requireLogTransferAvailable('erase', msg.requestId)
        ) {
          this.logTransfer.startErase(msg.requestId)
        }
        break
    }
    return { vehicleRebootQueued }
  }

  private sendCommand(
    cmd: string,
    params: number[],
    requestId?: string,
    safetyConfirmation?: 'arm' | 'disarm' | 'takeoff',
  ): boolean {
    const cmdId = (MAVLINK_COMMANDS as Record<string, number>)[cmd]
    if (cmdId === undefined) {
      this.emitOperationError('command', 'unsupported_command', `不支持命令 ${cmd}`, requestId)
      return false
    }
    if (params.some((value) => !Number.isFinite(value))) {
      this.emitOperationError('command', 'invalid_params', '命令参数必须是有限数值', requestId)
      return false
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
      return false
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
      const accepted = this.writeMessage(
        this.buildCommand(cmdId, params.slice(0, 7)),
        'critical',
      )
      if (!accepted) {
        this.emitOperationError(
          'command',
          'write_rejected',
          '连接发送队列拒绝紧急上锁命令',
          requestId,
          true,
        )
      }
      return accepted
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
    return this.enqueuePendingCommand(pending)
  }

  private buildCommand(
    commandId: number,
    params: number[],
    confirmation = 0,
    targetComponent = this.targetCompId ?? 0,
  ): common.CommandLong {
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
    command.targetComponent = targetComponent
    command.confirmation = confirmation
    return command
  }

  private transmitPendingCommand(pending: PendingCommand): boolean {
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
      return false
    }
    this.scheduleCommandTimeout(pending, this.commandTimeoutForLink())
    return true
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

  private enqueuePendingCommand(pending: PendingCommand): boolean {
    const current = this.pendingCommands.get(pending.command)
    if (current) {
      this.emitOperationError(
        'command',
        'command_busy',
        `命令 ${pending.command} 已有未完成事务；ACK 不含事务 ID，已拒绝并发请求`,
        pending.requestId,
        true,
      )
      return false
    }
    if (this.uncertainCommands.has(pending.command)) {
      this.emitOperationError(
        'command',
        'command_result_uncertain',
        `命令 ${pending.command} 的旧事务已超时且可能仍有迟到 ACK；请重新连接后再试`,
        pending.requestId,
        true,
      )
      return false
    }
    if (this.isCommandQuarantined(pending.command)) {
      this.emitOperationError(
        'command',
        'command_settling',
        `命令 ${pending.command} 正在等待迟到/重复 ACK 排空`,
        pending.requestId,
        true,
      )
      return false
    }
    this.pendingCommands.set(pending.command, pending)
    return this.transmitPendingCommand(pending)
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

  private emitVehicleConfigResult(
    requestId: string,
    feature: Extract<ClientMessage, { type: 'vehicle_config_set' }>['feature'],
    id: string,
    accepted: boolean,
    acceptedValue?: number,
    reason?: string,
  ): void {
    this.emit('message', {
      type: 'vehicle_config_set_result',
      data: { requestId, feature, id, accepted, acceptedValue, reason },
    } as ServerMessage)
  }

  /** Bridge-side profile/arming gate before a WebSocket radio session is created. */
  validateRadioCalibrationStart(requestId: string): boolean {
    if (!this.requireReadyTarget('radio_calibration_start', requestId)) return false
    if (!this.requireWritableVehicle('radio_calibration_start', requestId)) return false
    if (!vehicleCapabilities(this.selectedIdentity).radioCalibration) {
      this.emitOperationError(
        'radio_calibration_start',
        'unsupported_vehicle_profile',
        '当前飞控类型不支持遥控器校准写入',
        requestId,
      )
      return false
    }
    if (this.lastArmedState !== false) {
      this.emitOperationError(
        'radio_calibration_start',
        this.lastArmedState === true ? 'armed' : 'arming_state_unknown',
        this.lastArmedState === true ? '飞控已解锁，不能校准遥控器' : '尚未确认飞控上锁状态',
        requestId,
      )
      return false
    }
    return true
  }

  /** Notify the FC that GCS-side RC calibration is entering/leaving sampling. */
  notifyRadioCalibration(active: boolean): void {
    if (!this.selectedHeartbeatReady) return
    this.sendInternalCommand(MAVLINK_COMMANDS.MAV_CMD_PREFLIGHT_CALIBRATION, [0, 0, 0, active ? 1 : 0, 0, 0, 0])
  }

  /**
   * Commit a completed GCS-side radio calibration as one verified transaction.
   * The browser never supplies parameter names or types.
   */
  applyRadioCalibration(
    requestId: string,
    channels: RadioCalibrationChannel[],
    mapped: Partial<Record<'roll' | 'pitch' | 'throttle' | 'yaw', number>>,
    expectedVehicleFingerprint: string,
    completion: (accepted: boolean, reason?: string, rollbackFailures?: string[]) => void,
  ): void {
    const contextIsSafe = (): boolean => {
      const context = this.getVehicleMutationSafetyContext()
      return context.fingerprint === expectedVehicleFingerprint
        && context.ready
        && context.armed === false
        && vehicleCapabilities(this.selectedIdentity).radioCalibration
    }
    if (!contextIsSafe()) {
      completion(false, 'unsupported_vehicle_profile')
      return
    }
    if (!mapped.roll || !mapped.pitch || !mapped.throttle || !mapped.yaw) {
      completion(false, 'primary_mapping_incomplete')
      return
    }
    if (this.selectedIdentity?.family === 'ardupilot') {
      const throttle = channels.find((channel) => channel.function === 'throttle')
      if (throttle?.reversed) {
        completion(false, 'arducopter_reversed_throttle')
        return
      }
    }

    const entries: Array<{ id: string; value: number }> = []
    for (const channel of channels) {
      for (const [suffix, value] of [['MIN', channel.min], ['MAX', channel.max], ['TRIM', channel.trim]] as const) {
        const id = `RC${channel.channel}_${suffix}`
        if (this.parameterValues.has(id)) entries.push({ id, value })
      }
      if (this.selectedIdentity?.family === 'px4') {
        const id = `RC${channel.channel}_REV`
        if (this.parameterValues.has(id)) entries.push({ id, value: channel.reversed ? -1 : 1 })
      } else {
        const modern = `RC${channel.channel}_REVERSED`
        const legacy = `RC${channel.channel}_REV`
        const effectiveReverse = channel.function === 'pitch' ? !channel.reversed : channel.reversed
        if (this.parameterValues.has(modern)) entries.push({ id: modern, value: effectiveReverse ? 1 : 0 })
        else if (this.parameterValues.has(legacy)) entries.push({ id: legacy, value: effectiveReverse ? -1 : 1 })
      }
    }
    const mappingNames = this.selectedIdentity?.family === 'px4'
      ? { roll: 'RC_MAP_ROLL', pitch: 'RC_MAP_PITCH', throttle: 'RC_MAP_THROTTLE', yaw: 'RC_MAP_YAW' }
      : { roll: 'RCMAP_ROLL', pitch: 'RCMAP_PITCH', throttle: 'RCMAP_THROTTLE', yaw: 'RCMAP_YAW' }
    for (const key of ['roll', 'pitch', 'throttle', 'yaw'] as const) {
      const id = mappingNames[key]
      if (!this.parameterValues.has(id)) {
        completion(false, `parameter_missing:${id}`)
        return
      }
      entries.push({ id, value: mapped[key]! })
    }
    if (this.selectedIdentity?.family === 'px4' && this.parameterValues.has('RC_CHAN_CNT')) {
      entries.push({ id: 'RC_CHAN_CNT', value: Math.max(...channels.map((channel) => channel.channel)) })
    }
    if (entries.length === 0 || entries.some(({ id }) => !this.parameterTypes.has(id))) {
      completion(false, 'parameter_missing')
      return
    }

    const previous = new Map(entries.map(({ id }) => [id, this.parameterValues.get(id)!]))
    const confirmed: string[] = []
    const rollbackFailures: string[] = []
    const rollback = (index: number, reason: string): void => {
      if (!contextIsSafe()) {
        completion(false, `safety_context_changed_no_rollback:${reason}`, rollbackFailures)
        return
      }
      if (index < 0) {
        completion(false, reason, rollbackFailures)
        return
      }
      const id = confirmed[index]
      this.sendParamSet(id, previous.get(id)!, this.parameterTypes.get(id)!, `${requestId}-rc-rollback-${index}`, (accepted) => {
        if (!accepted) rollbackFailures.push(id)
        rollback(index - 1, reason)
      })
    }
    const writeNext = (index: number): void => {
      if (!contextIsSafe()) {
        completion(false, 'safety_context_changed_no_rollback')
        return
      }
      if (index >= entries.length) {
        completion(true)
        return
      }
      const entry = entries[index]
      this.sendParamSet(entry.id, entry.value, this.parameterTypes.get(entry.id)!, `${requestId}-rc-${index}`, (accepted, _value, reason) => {
        if (!contextIsSafe()) {
          completion(false, 'safety_context_changed_no_rollback')
          return
        }
        if (!accepted) {
          rollback(confirmed.length - 1, reason ?? 'write_failed')
          return
        }
        confirmed.push(entry.id)
        writeNext(index + 1)
      })
    }
    writeNext(0)
  }

  private setVehicleConfiguration(msg: Extract<ClientMessage, { type: 'vehicle_config_set' }>): void {
    if (!this.requireReadyTarget(msg.type, msg.requestId) || !this.requireWritableVehicle(msg.type, msg.requestId)) return
    const caps = vehicleCapabilities(this.selectedIdentity)
    const capability = msg.feature === 'flight_modes'
      ? caps.flightModeConfig
      : msg.feature === 'power' ? caps.powerConfig : caps.safetyConfig
    if (!capability || !isAllowedVehicleConfigParameter(this.selectedIdentity, msg.feature, msg.data.id)) {
      this.emitVehicleConfigResult(msg.requestId, msg.feature, msg.data.id, false, undefined, 'unsupported_vehicle_profile')
      return
    }
    if (this.lastArmedState !== false) {
      this.emitVehicleConfigResult(
        msg.requestId,
        msg.feature,
        msg.data.id,
        false,
        undefined,
        this.lastArmedState === true ? 'armed' : 'arming_state_unknown',
      )
      return
    }
    const oldValue = this.parameterValues.get(msg.data.id)
    const paramType = this.parameterTypes.get(msg.data.id)
    if (oldValue === undefined || paramType === undefined) {
      this.emitVehicleConfigResult(msg.requestId, msg.feature, msg.data.id, false, undefined, 'parameter_missing')
      return
    }
    const parameterView = new Map([...this.parameterValues].map(([id, value]) => [id, { value }]))
    const validationError = validateVehicleConfigValue(
      this.selectedIdentity,
      msg.feature,
      msg.data.id,
      msg.data.value,
      parameterView,
    )
    if (validationError) {
      this.emitVehicleConfigResult(msg.requestId, msg.feature, msg.data.id, false, oldValue, validationError)
      return
    }
    const enumOptions = parameterEnumOptions(msg.data.id, this.selectedIdentity)
    if (enumOptions?.length && !enumOptions.some((option) => parameterEnumValuesMatch(option.value, msg.data.value))) {
      this.emitVehicleConfigResult(msg.requestId, msg.feature, msg.data.id, false, oldValue, 'unknown_enum_value')
      return
    }
    if (
      msg.feature === 'safety'
      && isSafetyReduction(msg.data.id, oldValue, msg.data.value)
      && msg.safetyConfirmation !== 'reduce_failsafe_protection'
    ) {
      this.emitVehicleConfigResult(msg.requestId, msg.feature, msg.data.id, false, oldValue, 'safety_confirmation_required')
      return
    }
    this.sendParamSet(msg.data.id, msg.data.value, paramType, msg.requestId, (accepted, acceptedValue, reason) => {
      this.emitVehicleConfigResult(msg.requestId, msg.feature, msg.data.id, accepted, acceptedValue, reason)
    })
  }

  private emitAirframeStatus(
    requestId: string,
    phase: Extract<ServerMessage, { type: 'airframe_apply_status' }>['data']['phase'],
    completed: number,
    total: number,
    currentId?: string,
    reason?: string,
    rollbackFailures?: string[],
  ): void {
    this.emit('message', {
      type: 'airframe_apply_status',
      data: { requestId, phase, completed, total, currentId, reason, rollbackFailures },
    } as ServerMessage)
  }

  private airframeContextIsSafe(transaction: ActiveAirframeTransaction): boolean {
    const context = this.getVehicleMutationSafetyContext()
    return this.activeAirframeTransaction === transaction
      && context.fingerprint === transaction.fingerprint
      && context.ready
      && context.armed === false
  }

  private abortAirframeTransaction(reason: string): void {
    const transaction = this.activeAirframeTransaction
    if (!transaction) return
    this.activeAirframeTransaction = null
    this.emitAirframeStatus(
      transaction.requestId,
      'failed',
      transaction.confirmed.length,
      transaction.total,
      undefined,
      reason,
    )
  }

  private applyAirframe(msg: Extract<ClientMessage, { type: 'airframe_apply' }>): void {
    const total = 2
    if (!this.requireReadyTarget(msg.type, msg.requestId) || !this.requireWritableVehicle(msg.type, msg.requestId)) return
    if (!vehicleCapabilities(this.selectedIdentity).airframeSelection) {
      this.emitAirframeStatus(msg.requestId, 'failed', 0, total, undefined, 'unsupported_vehicle_profile')
      return
    }
    if (this.lastArmedState !== false) {
      this.emitAirframeStatus(msg.requestId, 'failed', 0, total, undefined, this.lastArmedState === true ? 'armed' : 'arming_state_unknown')
      return
    }
    if (this.activeAirframeTransaction) {
      this.emitAirframeStatus(msg.requestId, 'failed', 0, total, undefined, 'airframe_transaction_busy')
      return
    }
    if (msg.data.family !== this.selectedIdentity?.family) {
      this.emitAirframeStatus(msg.requestId, 'failed', 0, total, undefined, 'airframe_family_mismatch')
      return
    }

    const entries = msg.data.family === 'px4'
      ? [
          { id: 'SYS_AUTOSTART', value: msg.data.autostartId },
          { id: 'SYS_AUTOCONFIG', value: 1 },
        ]
      : [
          { id: 'FRAME_CLASS', value: msg.data.frameClass },
          { id: 'FRAME_TYPE', value: msg.data.frameType },
        ]
    if (msg.data.family === 'px4' && !getPx4AirframeInfo(msg.data.autostartId)) {
      this.emitAirframeStatus(msg.requestId, 'failed', 0, total, undefined, 'unknown_airframe')
      return
    }
    if (msg.data.family === 'ardupilot' && !isSupportedArduCopterFrame(msg.data.frameClass, msg.data.frameType)) {
      this.emitAirframeStatus(msg.requestId, 'failed', 0, total, undefined, 'unsupported_airframe_combination')
      return
    }
    if (entries.some(({ id }) => !this.parameterValues.has(id) || !this.parameterTypes.has(id))) {
      this.emitAirframeStatus(msg.requestId, 'failed', 0, total, undefined, 'parameter_missing')
      return
    }

    const previous = new Map(entries.map(({ id }) => [id, this.parameterValues.get(id)!]))
    const transaction: ActiveAirframeTransaction = {
      requestId: msg.requestId,
      fingerprint: this.getVehicleMutationSafetyContext().fingerprint,
      total,
      confirmed: [],
    }
    this.activeAirframeTransaction = transaction
    this.emitAirframeStatus(msg.requestId, 'validating', 0, total)

    const finishFailure = (reason: string): void => {
      if (!this.airframeContextIsSafe(transaction)) {
        this.abortAirframeTransaction(`safety_context_changed_no_rollback:${reason}`)
        return
      }
      const rollbackFailures: string[] = []
      const rollback = (index: number): void => {
        if (!this.airframeContextIsSafe(transaction)) {
          this.abortAirframeTransaction(`safety_context_changed_no_rollback:${reason}`)
          return
        }
        if (index < 0) {
          this.activeAirframeTransaction = null
          this.emitAirframeStatus(
            msg.requestId,
            'failed',
            transaction.confirmed.length,
            total,
            undefined,
            reason,
            rollbackFailures,
          )
          return
        }
        const id = transaction.confirmed[index]
        this.sendParamSet(id, previous.get(id)!, this.parameterTypes.get(id)!, `${msg.requestId}-rollback-${index}`, (accepted) => {
          if (!this.airframeContextIsSafe(transaction)) {
            this.abortAirframeTransaction(`safety_context_changed_no_rollback:${reason}`)
            return
          }
          if (!accepted) rollbackFailures.push(id)
          rollback(index - 1)
        })
      }
      rollback(transaction.confirmed.length - 1)
    }

    const writeNext = (index: number): void => {
      if (!this.airframeContextIsSafe(transaction)) {
        this.abortAirframeTransaction('safety_context_changed_no_rollback')
        return
      }
      if (index >= entries.length) {
        if (msg.data.family === 'ardupilot') {
          this.activeAirframeTransaction = null
          this.emitAirframeStatus(msg.requestId, 'reboot_required', total, total)
          return
        }
        // Re-read the target and armed state at the final irreversible edge.
        // Do not announce reboot recovery until the command is actually queued.
        if (!this.airframeContextIsSafe(transaction)) {
          this.abortAirframeTransaction('safety_context_changed_no_reboot')
          return
        }
        const queued = this.sendCommand('MAV_CMD_PREFLIGHT_REBOOT_SHUTDOWN', [1, 0, 0, 0, 0, 0, 0], msg.requestId)
        this.activeAirframeTransaction = null
        if (!queued) {
          this.emitAirframeStatus(msg.requestId, 'failed', total, total, undefined, 'reboot_write_rejected')
        } else {
          this.selectedHeartbeatReady = false
          this.emitAirframeStatus(msg.requestId, 'rebooting', total, total)
        }
        return
      }
      const entry = entries[index]
      this.emitAirframeStatus(msg.requestId, 'writing', index, total, entry.id)
      this.sendParamSet(entry.id, entry.value, this.parameterTypes.get(entry.id)!, `${msg.requestId}-${entry.id}`, (accepted, _value, reason) => {
        if (!this.airframeContextIsSafe(transaction)) {
          this.abortAirframeTransaction('safety_context_changed_no_rollback')
          return
        }
        if (!accepted) {
          finishFailure(reason ?? 'write_failed')
          return
        }
        transaction.confirmed.push(entry.id)
        writeNext(index + 1)
      })
    }
    writeNext(0)
  }

  private sendInternalCommand(commandId: number, params: number[], targetComponent?: number): void {
    this.writeMessage(this.buildCommand(commandId, params, 0, targetComponent))
  }

  private sendParamSet(
    id: string,
    value: number,
    paramType: number,
    requestId?: string,
    completion?: (accepted: boolean, acceptedValue?: number, reason?: string) => void,
  ): boolean {
    const validationError = this.validateParamSet(id, value, paramType)
    if (validationError) {
      this.emitOperationError('param_set', 'invalid_param', validationError, requestId)
      completion?.(false, undefined, validationError)
      return false
    }
    if (this.pendingParamSets.has(id)) {
      this.emitOperationError(
        'param_set',
        'param_busy',
        `参数 ${id} 已有未完成写入`,
        requestId,
        true,
      )
      completion?.(false, undefined, 'param_busy')
      return false
    }
    if (this.pendingParamSets.size >= MAX_PENDING_PARAM_SETS) {
      this.emitOperationError(
        'param_set',
        'param_queue_full',
        '等待参数回显的事务已达上限',
        requestId,
        true,
      )
      completion?.(false, undefined, 'param_queue_full')
      return false
    }
    const pending: PendingParamSet = {
      requestId,
      id,
      value,
      paramType,
      attempt: 0,
      timeout: null,
      completion,
    }
    this.pendingParamSets.set(id, pending)
    this.transmitPendingParamSet(pending)
    return true
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
    pending.completion?.(accepted, acceptedValue, reason)
  }

  private sendParamRequestList() {
    // Server-side generation ownership may intentionally replace an expired
    // download. Keep this local reset silent so the cancellation cannot be
    // misattributed to the newly-created generation.
    this.cancelParamDownload(false)
    this.paramRunId += 1
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
    // No raw-length precondition here: MAVLink v2 zero-trims trailing bytes,
    // and decode() pads the frame back, so even a heavily trimmed frame
    // yields spec-correct (zero) values for the untransmitted fields.
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
    // The firmware label follows the HEARTBEAT-classified family; the version
    // message itself carries no stack identity and must not assume PX4.
    const family = this.selectedIdentity?.family ?? 'unknown'
    const vehicleClass = this.selectedIdentity?.vehicleClass ?? 'unknown'
    const versionMessage = {
      type: 'autopilot_version',
      data: {
        boardId,
        boardName: BOARD_NAMES[boardId] ?? (boardId ? `Board ${boardId}` : 'Flight Controller'),
        firmwareVersion,
        firmwareLabel: formatFirmwareLabel(family, firmwareVersion),
        // vendor/product are at wire offsets 32/34. The previous parser read
        // 56/58 (inside os_custom_version) - a latent bug fixed by node-mavlink.
        vendorId: d.vendorId,
        productId: d.productId,
        family,
        vehicleClass,
      },
    } as ServerMessage
    this.lastAutopilotVersionMessage = versionMessage
    this.emit('message', versionMessage)
  }

  /**
   * Last emitted autopilot_version snapshot for replay to late-joining WS
   * clients (the FC only answers the version request once per link).
   */
  getAutopilotVersionMessage(): ServerMessage | null {
    return this.lastAutopilotVersionMessage
  }

  getMessageRatesMessage(): Extract<ServerMessage, { type: 'message_rates' }> {
    return { type: 'message_rates', data: { ...this.messageRates } }
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
        paramRunId: this.paramRunId,
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
        paramRunId: this.paramRunId,
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
      paramRunId: this.paramRunId,
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
      paramRunId: this.paramRunId,
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
        paramRunId: this.paramRunId,
      } as ServerMessage)
    }
    if (restoreTelemetry) this.applyTelemetryProfile('normal')
  }

  private applyTelemetryProfile(profile: TelemetryProfile) {
    if (this.telemetryProfile === profile || this.connManager.status !== 'connected') return
    this.telemetryProfile = profile
    this.messageIntervalAttempts = 0
    this.sendTelemetryIntervalRequests()
  }

  private sendTelemetryIntervalRequests(): void {
    const profile = this.telemetryProfile
    if (this.destroyed || profile === null || this.connManager.status !== 'connected') return
    this.messageIntervalAttempts += 1
    const setIntervalCommand =
      (MAVLINK_COMMANDS as Record<string, number>).MAV_CMD_SET_MESSAGE_INTERVAL
    if (setIntervalCommand === undefined || this.messageIntervalSupport === 'unsupported') {
      this.useLegacyTelemetryStreams()
      return
    }
    for (const [group, messageIds] of Object.entries(MESSAGE_RATE_GROUP_IDS) as Array<
      [MessageRateGroup, readonly number[]]
    >) {
      for (const messageId of messageIds) {
        const targetComponents = new Set<number>([
          this.targetCompId ?? 0,
          ...(this.observedMessageComponents.get(messageId) ?? []),
        ])
        for (const targetComponent of targetComponents) {
          this.sendMessageIntervalRequest(messageId, group, targetComponent)
        }
      }
    }
    if (this.messageIntervalSupport === 'unknown') {
      if (this.messageIntervalFallbackTimer) clearTimeout(this.messageIntervalFallbackTimer)
      this.messageIntervalFallbackTimer = setTimeout(() => {
        this.messageIntervalFallbackTimer = null
        if (this.messageIntervalSupport !== 'unknown') return
        // Still no accepted ACK. Retry the whole batch before concluding the
        // command is unsupported - the legacy REQUEST_DATA_STREAM fallback is
        // ignored by modern PX4, so a premature (sticky) downgrade would lose
        // every explicitly requested stream for the rest of the session.
        if (this.messageIntervalAttempts < MESSAGE_INTERVAL_MAX_SEND_ATTEMPTS) {
          this.sendTelemetryIntervalRequests()
        } else {
          this.useLegacyTelemetryStreams()
        }
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
    const configured: Array<[number, MessageRateGroup]> = [
      [1, 'sensors'], [2, 'status'], [3, 'rc'], [6, 'position'],
      [10, 'attitude'], [11, 'hud'], [12, 'auxiliary'],
    ]
    for (const [streamId, group] of configured) {
      const requestedHz = this.messageRates[group]
      const rate = this.telemetryProfile === 'parameter-sync' ? Math.min(requestedHz, 2) : requestedHz
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

  // Semantic calibration: map a supported kind to stack-specific
  // MAV_CMD_PREFLIGHT_CALIBRATION parameters. Only documented, testable flows
  // are implemented; kinds needing multi-step position acknowledgement (e.g.
  // ArduPilot mag) are rejected until modeled as explicit follow-up messages.
  // The request-scoped state on the client advances from COMMAND_ACK and
  // STATUSTEXT - never from a timer here.
  // Create (but do not start) a calibration session after bridge-side gates:
  // ready target, recognized identity, capability, per-kind support and
  // armed=false. Returns null after emitting an operation_error on rejection.
  // The server's CalibrationSessionManager owns the returned session's
  // lifecycle and ownership; the bridge only feeds it protocol inputs.
  createCalibrationSession(request: CalibrationStartRequest): CalibrationSession | null {
    if (!this.hasReadyTarget()) {
      this.emitOperationError(
        'start_calibration', 'target_not_ready',
        '尚未收到已选飞控的有效心跳', request.requestId, true,
      )
      return null
    }
    const identity = this.selectedIdentity
    const family = identity?.family
    if (!identity || (family !== 'px4' && family !== 'ardupilot')
      || !vehicleCapabilities(identity).calibrate) {
      this.emitOperationError(
        'start_calibration', 'unsupported_vehicle_profile',
        '当前飞控类型尚未适配校准流程', request.requestId,
      )
      return null
    }
    if (!supportsCalibrationKind(identity, request.kind)) {
      this.emitOperationError(
        'start_calibration', 'unsupported_calibration_kind',
        '当前飞控暂不支持该校准类型', request.requestId,
      )
      return null
    }
    if (this.lastArmedState === true) {
      this.emitOperationError(
        'start_calibration', 'vehicle_armed',
        '飞行器已解锁，禁止校准', request.requestId,
      )
      return null
    }
    // PX4 mag: the number of required orientations is driven by CAL_MAG_SIDES
    // (default all six sides) so the wizard hides sides the FC will not ask for.
    const magSides = family === 'px4' && request.kind === 'mag'
      ? this.readMagSides()
      : undefined
    const session = new CalibrationSession({
      sessionId: request.sessionId,
      requestId: request.requestId,
      family,
      kind: request.kind,
      ...(magSides !== undefined ? { magSides } : {}),
      // Single-send, no pendingCommands: retransmitting a calibration start
      // would restart the calibration on the FC.
      sendCommand: (commandId, params) =>
        this.writeMessage(this.buildCommand(commandId, params.slice(0, 7)), 'high'),
      emitSnapshot: (snapshot) => {
        request.emitSnapshot(snapshot)
        if (
          this.activeCalibration === session
          && (snapshot.phase === 'done' || snapshot.phase === 'failed'
            || snapshot.phase === 'cancelled' || snapshot.phase === 'accepted')
        ) {
          this.activeCalibration = null
        }
      },
    })
    this.activeCalibration = session
    return session
  }

  /** Read CAL_MAG_SIDES bitmask (default 63 = all six sides). */
  private readMagSides(): number {
    const value = this.parameterValues.get('CAL_MAG_SIDES')
    return value !== undefined && Number.isFinite(value)
      ? (value & 0b111111) || 0b111111
      : 0b111111
  }

  // FC -> GCS COMMAND_LONG. The only inbound COMMAND_LONG this GCS acts on is
  // ACCELCAL_VEHICLE_POS (42429) during ArduPilot six-position accel
  // calibration; forward its param1 to the active session.
  private handleInboundCommandLong(msg: MavlinkMessage) {
    if (!this.activeCalibration) return
    const d = decode<common.CommandLong>(76, msg.payload)
    if (!d || (d.command as number) !== MAVLINK_COMMANDS.MAV_CMD_ACCELCAL_VEHICLE_POS) return
    // Only accept a request addressed to this GCS (or broadcast 0).
    if (
      (d.targetSystem !== 0 && d.targetSystem !== this.codec.gcsSystemId)
      || (d.targetComponent !== 0 && d.targetComponent !== this.codec.gcsComponentId)
    ) return
    this.activeCalibration.handlePositionRequest(d._param1)
  }

  private handleMagCalProgress(msg: MavlinkMessage) {
    if (!this.activeCalibration) return
    const d = decode<ardupilotmega.MagCalProgress>(191, msg.payload)
    if (!d) return
    this.activeCalibration.handleMagProgress({
      compassId: d.compassId,
      calMask: d.calMask,
      calStatus: d.calStatus,
      attempt: d.attempt,
      completionPct: d.completionPct,
    })
  }

  private handleMagCalReport(msg: MavlinkMessage) {
    if (!this.activeCalibration) return
    const d = decode<common.MagCalReport>(192, msg.payload)
    if (!d) return
    this.activeCalibration.handleMagReport({
      compassId: d.compassId,
      calMask: d.calMask,
      calStatus: d.calStatus,
      autosaved: d.autosaved,
      fitness: d.fitness,
      ofs: [d.ofsX, d.ofsY, d.ofsZ],
    })
  }

  private sendMotorTest(
    instance: number,
    throttle: number,
    duration: number,
    requestId?: string,
    propsRemoved?: boolean,
    queuePrepared = false,
  ) {
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
    const shouldRelease = duration <= 0 || throttle <= 0
    const queueTag = motorTestStartQueueTag(instance)
    // Every valid update invalidates this instance's older queued start before
    // capability/props/armed gates. A rejected update therefore cannot leave
    // a stale start waiting to escape after backpressure clears.
    if (!queuePrepared) this.connManager.cancelQueuedWrites(queueTag)

    // Unknown or unimplemented profiles never receive a motor-test command.
    const motorTestKind = vehicleCapabilities(this.selectedIdentity).motorTest
    if (motorTestKind === 'none') {
      this.emitOperationError(
        'motor_test',
        'unsupported_motor_test',
        '当前飞控类型尚未适配电机测试',
        requestId,
      )
      return
    }
    if (!shouldRelease && propsRemoved !== true) {
      this.emitOperationError(
        'motor_test',
        'props_confirmation_required',
        '电机测试前必须确认已拆除桨叶',
        requestId,
      )
      return
    }
    // Spinning a motor on an armed vehicle is never a bench test. Stop
    // commands stay allowed regardless of the armed state.
    if (!shouldRelease && this.lastArmedState === true) {
      this.emitOperationError(
        'motor_test',
        'vehicle_armed',
        '飞行器已解锁，禁止启动电机测试',
        requestId,
      )
      return
    }
    if (motorTestKind === 'motor-test') {
      // ArduPilot: MAV_CMD_DO_MOTOR_TEST (209) with a 1-based motor instance,
      // MOTOR_TEST_THROTTLE_PERCENT (0) as throttle type, percent throttle and
      // a bounded timeout in seconds. Stop = throttle 0 / timeout 0.
      const commandId = (MAVLINK_COMMANDS as Record<string, number>).MAV_CMD_DO_MOTOR_TEST
      if (commandId === undefined) {
        this.emitOperationError('motor_test', 'unsupported_command', '缺少电机测试命令', requestId)
        return
      }
      const throttlePercent = shouldRelease ? 0 : Math.max(0, Math.min(100, throttle))
      const timeoutSeconds = shouldRelease ? 0 : Math.max(0, Math.min(30, duration))
      if (!this.writeMessage(
        this.buildCommand(
          commandId,
          [instance, 0, throttlePercent, timeoutSeconds, 0, 0, 0],
        ),
        shouldRelease ? 'critical' : 'high',
        shouldRelease ? undefined : queueTag,
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
          reason: 'MAV_CMD_DO_MOTOR_TEST ACK 不包含电机实例，命令已发送但无法安全关联确认',
        },
      } as ServerMessage)
      return
    }

    // PX4 handles individual motor testing through MAV_CMD_ACTUATOR_TEST.
    // Values >= 1000 in param5 are PX4-internal actuator functions with the
    // 1000 transport offset. Motors 1..12 are functions 101..112, so an
    // external GCS must send 1101..1112. This works across PX4 versions and
    // avoids confusing the internal function ID with MAVLink's enum values.
    const outputFunction = 1100 + instance
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
      shouldRelease ? undefined : queueTag,
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

  private sendMotorTestBatch(
    instances: number[],
    throttle: number,
    duration: number,
    requestId?: string,
    propsRemoved?: boolean,
  ): void {
    if (
      !Array.isArray(instances)
      || instances.length < 1
      || instances.length > 12
      || instances.some((instance) =>
        !Number.isInteger(instance) || instance < 1 || instance > 12)
      || new Set(instances).size !== instances.length
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
        'motor_test_batch',
        'invalid_motor_test',
        '批量电机测试参数超出安全范围',
        requestId,
      )
      return
    }
    const shouldRelease = duration <= 0 || throttle <= 0
    // Batch updates clear every addressed instance before later safety gates,
    // matching the single-instance stale-start rule.
    this.cancelQueuedMotorTestStarts(instances)
    const motorTestKind = vehicleCapabilities(this.selectedIdentity).motorTest
    if (motorTestKind === 'none') {
      this.emitOperationError(
        'motor_test_batch',
        'unsupported_motor_test',
        '当前飞控类型尚未适配电机测试',
        requestId,
      )
      return
    }
    if (!shouldRelease && propsRemoved !== true) {
      this.emitOperationError(
        'motor_test_batch',
        'props_confirmation_required',
        '电机测试前必须确认已拆除桨叶',
        requestId,
      )
      return
    }
    if (!shouldRelease && this.lastArmedState === true) {
      this.emitOperationError(
        'motor_test_batch',
        'vehicle_armed',
        '飞行器已解锁，禁止启动电机测试',
        requestId,
      )
      return
    }
    // Validation is completed for the entire batch before the first command
    // is serialized, preventing malformed direct callers from causing a
    // partial fan-out. Each underlying MAVLink command remains 1-based.
    for (const instance of instances) {
      this.sendMotorTest(instance, throttle, duration, requestId, propsRemoved, true)
    }
  }

  destroy() {
    this.destroyed = true
    if (this.activeCalibration) {
      const session = this.activeCalibration
      this.activeCalibration = null
      session.terminate('bridge_destroyed', '服务正在关闭，校准会话终止')
    }
    if (this.manualControlFlushHandle) {
      clearImmediate(this.manualControlFlushHandle)
      this.manualControlFlushHandle = null
    }
    this.pendingManualControl = null
    this.cancelProtocolOperations(false, 'bridge_destroyed')
    this.ftp.destroy()
    this.logTransfer.destroy()
    this.stopHeartbeat()
    this.stopLinkStats()
    if (this.versionTimer) clearTimeout(this.versionTimer)
    if (this.messageIntervalFallbackTimer) clearTimeout(this.messageIntervalFallbackTimer)
    this.codec.destroy()
    this.connManager.off('data', this.onData)
    this.connManager.off('statusChange', this.onStatusChange)
  }
}
