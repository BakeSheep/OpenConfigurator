// ESC service: the single integration point between the local Worker and
// the ESC session/protocol stack. Owns the EscSessionManager, builds the
// mode-specific transport, runs discovery and emits RuntimeEvents.
// Runtime commands are routed here and emitted events return to the owning tab.
import {
  AM32_LAYOUT_SIZE,
  EscError,
  ESC_MAX_TARGETS,
  ESC_SESSION_SAFETY_CONFIRMATION,
  toEscError,
  type EscDeviceInfo,
  type EscJobTargetResult,
  type EscLogEntry,
  type EscSessionSnapshot,
  type EscSettingsValues,
} from '../../shared/esc'
import type { RuntimeCommand, RuntimeEvent } from '../../shared/types'
import type { BrowserConnectionManager } from '../connection/BrowserConnectionManager'
import type { MavlinkBridge } from '../mavlink/MavlinkBridge'
import { vehicleCapabilities, type VehicleIdentity } from '../../shared/vehicleProfiles'
import { ArduPilotRawTransport } from './ArduPilotRawTransport'
import type { EscByteTransport, EscTransportTarget } from './EscByteTransport'
import { detectEscs, FourWayClient, MspClient } from './EscDetector'
import { EscSessionManager } from './EscSessionManager'
import { Px4SerialControlTransport } from './Px4SerialControlTransport'
import { Am32SettingsService } from './Am32SettingsService'
import { escSafetyViolation, type EscSafetySnapshotProvider } from './EscSafetyContext'

export interface EscServiceOptions {
  connManager: BrowserConnectionManager
  bridge: MavlinkBridge
  emit: (message: RuntimeEvent) => void
  /** Send owner credentials without broadcasting them to non-owner consumers. */
  emitToClient?: (clientId: string, message: RuntimeEvent) => void
  /** Local-runtime-authoritative selected HEARTBEAT identity. */
  getVehicleIdentity?: () => VehicleIdentity | null
  /** Latest Worker-validated vehicle parameter, or null when not synchronized. */
  getParameterValue?: (id: string) => number | null
  /**
   * Local-runtime-authoritative armed/target/connection evidence for ESC safety
   * (OCSA-002). Re-validated at every operation boundary; a snapshot that is
   * not strictly disarmed and generation-stable refuses or terminates the
   * session. Omitted only by legacy test harnesses.
   */
  getSafetyContext?: EscSafetySnapshotProvider
  pinController: (ownerClientId: string, sessionId: string) => void
  releaseController: (sessionId: string) => void
  /** Reason string when the MAVLink link is busy (param sync/FTP/log), else null. */
  isLinkBusy?: () => string | null
  /** Test seam: override transport construction with fakes. */
  transportFactory?: (target: EscTransportTarget) => EscByteTransport
  logger?: Pick<Console, 'log' | 'warn' | 'error'>
  idleTimeoutMs?: number
  orphanGraceMs?: number
}

type EscClientMessage = Extract<RuntimeCommand, { type: `esc_${string}` }>

const DEFAULT_ESC_CHANNEL_COUNT = 4

export class EscService {
  private readonly devices = new Map<number, EscDeviceInfo>()
  private readonly rawSettings = new Map<number, Uint8Array>()
  private currentSessionId: string | null = null
  private readonly options: EscServiceOptions
  private readonly manager: EscSessionManager
  private currentTransport: EscByteTransport | null = null
  private readonly fourWayActive = new WeakSet<EscByteTransport>()

  constructor(options: EscServiceOptions) {
    this.options = options
    this.manager = new EscSessionManager({
      createTransport: (target) => this.createTransport(target),
      pinController: options.pinController,
      releaseController: options.releaseController,
      ...(options.getSafetyContext ? { getSafetyContext: options.getSafetyContext } : {}),
      beforeTransportClose: async (transport, reason, signal) => {
        if (!this.fourWayActive.has(transport)) return
        this.fourWayActive.delete(transport)
        if (reason === 'link_lost') return
        await new FourWayClient(transport).exit(signal)
      },
      logger: options.logger,
      ...(options.idleTimeoutMs !== undefined ? { idleTimeoutMs: options.idleTimeoutMs } : {}),
      ...(options.orphanGraceMs !== undefined ? { orphanGraceMs: options.orphanGraceMs } : {}),
    })
    this.manager.on('session', (snapshot: EscSessionSnapshot) => {
      if (snapshot.state === 'idle') {
        this.currentTransport = null
        this.currentSessionId = null
        this.devices.clear()
        this.rawSettings.clear()
      }
      this.options.emit({ type: 'esc_session', data: snapshot })
    })
  }

  /** True while any ESC session exists: release_control must be refused. */
  blocksControllerRelease(): boolean {
    return this.manager.blocksControllerRelease()
  }

  /** True while any ESC session requires flight-command isolation. */
  blocksMavlinkMutations(): boolean {
    return this.manager.blocksMavlinkMutations()
  }

  /** Whether an esc_session_start requires a ready MAVLink target. */
  static startRequiresReadyTarget(message: EscClientMessage): boolean {
    return message.type === 'esc_session_start' && message.data.mode !== 'direct'
  }

  private get logger(): Pick<Console, 'log' | 'warn' | 'error'> {
    return this.options.logger ?? console
  }

  /**
   * Latest safety violation for the live session, evaluated against the
   * baseline bound at start (entry rules while the transport is still
   * opening). Null when allowed or when no provider is configured.
   */
  private transportSafetyViolation(): EscError | null {
    const provider = this.options.getSafetyContext
    if (!provider) return null
    const mode = this.manager.snapshot().mode
    if (!mode) return null
    const baseline = this.manager.safetyBaseline()
    return escSafetyViolation({ snapshot: provider(), baseline, mode, now: Date.now() })
  }

  private createTransport(target: EscTransportTarget): EscByteTransport {
    if (this.options.transportFactory) {
      const transport = this.options.transportFactory(target)
      this.currentTransport = transport
      return transport
    }
    // Per-transaction boundary: transports re-check the latest snapshot so a
    // violation aborts the session even between service-level job boundaries.
    const checkSafety = (): EscError | null => this.transportSafetyViolation()
    let transport: EscByteTransport
    switch (target.mode) {
      case 'ardupilot_passthrough':
        transport = new ArduPilotRawTransport({
          connManager: this.options.connManager,
          bridge: this.options.bridge,
          ...(this.options.isLinkBusy ? { checkBusy: this.options.isLinkBusy } : {}),
          checkSafety,
        })
        break
      case 'px4_serial_control':
        transport = new Px4SerialControlTransport({ bridge: this.options.bridge, checkSafety })
        break
      case 'direct':
        transport = new ArduPilotRawTransport({
          connManager: this.options.connManager,
          bridge: this.options.bridge,
          targetMode: 'direct',
          ...(this.options.isLinkBusy ? { checkBusy: this.options.isLinkBusy } : {}),
          checkSafety,
        })
        break
    }
    this.currentTransport = transport
    return transport
  }

  private log(sessionId: string, level: EscLogEntry['level'], text: string): void {
    this.options.emit({
      type: 'esc_log',
      data: { sessionId, entries: [{ level, text, timestamp: Date.now() }] },
    })
  }

  private emitOpError(operation: string, error: EscError, requestId?: string): void {
    this.options.emit({
      type: 'esc_op_error',
      data: { ...error.toOperationError(operation), ...(requestId ? { requestId } : {}) },
    })
  }

  /** Route an already-validated esc_* client message. */
  async handleRuntimeCommand(clientId: string, message: EscClientMessage): Promise<void> {
    try {
      switch (message.type) {
        case 'esc_session_start':
          await this.handleStart(clientId, message)
          break
        case 'esc_session_exit':
          await this.manager.exit(clientId, message.data.sessionId)
          break
        case 'esc_devices_scan':
          this.manager.assertOwner(clientId, message.data.sessionId)
          this.manager.noteActivity(clientId)
          await this.runScan(clientId, message.data.sessionId, message.requestId)
          break
        case 'esc_settings_read':
          this.manager.assertOwner(clientId, message.data.sessionId)
          this.manager.noteActivity(clientId)
          await this.runSettingsRead(clientId, message.data.sessionId, message.data.targets)
          break
        case 'esc_settings_write':
          this.manager.assertSettingsWriteAllowed(clientId, message.data.sessionId)
          this.manager.noteActivity(clientId)
          await this.runSettingsWrite(clientId, message.data.sessionId, message.data.targets, message.data.values)
          break
      }
    } catch (error) {
      const escError = toEscError(error)
      this.emitOpError(message.type, escError, message.requestId)
    }
  }

  private async handleStart(
    clientId: string,
    message: Extract<EscClientMessage, { type: 'esc_session_start' }>,
  ): Promise<void> {
    if (message.safetyConfirmation !== ESC_SESSION_SAFETY_CONFIRMATION) {
      throw new EscError(
        'precondition_failed',
        '进入 ESC 配置前必须确认已拆除螺旋桨且供电持续稳定',
      )
    }
    const identity = this.options.getVehicleIdentity?.() ?? null
    const family = identity?.family ?? 'unknown'
    if (message.data.mode === 'direct') {
      const connection = this.options.connManager.config
      if (this.options.connManager.status !== 'connected' || connection?.type !== 'serial') {
        throw new EscError('precondition_failed', 'USB 直通需要复用一个已打开的串口连接')
      }
      if (connection.baudRate !== 19200) {
        throw new EscError('precondition_failed', 'USB 直通连接必须使用 19200 波特率')
      }
    }
    if (
      message.data.mode === 'ardupilot_passthrough'
      && (family !== 'ardupilot' || !vehicleCapabilities(identity).writeOperations)
    ) {
      throw new EscError('unsupported_vehicle_profile', '仅已适配写操作的 ArduCopter 可使用 ArduPilot ESC 直通')
    }
    if (message.data.mode === 'px4_serial_control' && family !== 'px4') {
      throw new EscError('unsupported_vehicle_profile', '仅 PX4 飞控可使用 SERIAL_CONTROL ESC 直通')
    }
    if (message.data.mode === 'ardupilot_passthrough') {
      const auto = this.options.getParameterValue?.('SERVO_BLH_AUTO') ?? null
      const mask = this.options.getParameterValue?.('SERVO_BLH_MASK') ?? null
      if (auto !== 1 && !(mask !== null && mask > 0)) {
        throw new EscError('precondition_failed', '必须先启用 SERVO_BLH_AUTO 或 SERVO_BLH_MASK 并重启飞控')
      }
      const pwmType = this.options.getParameterValue?.('MOT_PWM_TYPE') ?? null
      if (pwmType === null || pwmType < 4 || pwmType > 7) {
        throw new EscError('precondition_failed', 'ArduPilot ESC 直通要求 MOT_PWM_TYPE 使用 DShot150/300/600/1200')
      }
    }
    if (
      message.data.mode === 'px4_serial_control'
      && this.options.getParameterValue?.('PASSTHRU_EN') !== 1
    ) {
      throw new EscError('precondition_failed', '必须先设置 PASSTHRU_EN=1 并重启 PX4')
    }

    const target: EscTransportTarget =
      message.data.mode === 'ardupilot_passthrough'
        ? { mode: 'ardupilot_passthrough' }
        : message.data.mode === 'px4_serial_control'
          ? { mode: 'px4_serial_control', channels: message.data.channels }
          : { mode: 'direct', port: this.options.connManager.config!.port, baudRate: 19200 }

    const { sessionId } = await this.manager.start(clientId, target, true)
    this.currentSessionId = sessionId
    this.options.emitToClient?.(clientId, {
      type: 'esc_session_started',
      data: { sessionId },
    })
    this.log(sessionId, 'info', `ESC 会话已建立（${message.data.mode}）`)
    // Auto-scan immediately after entering the session.
    await this.runScan(clientId, sessionId, message.requestId)
  }

  private async runScan(clientId: string, sessionId: string, requestId?: string): Promise<void> {
    const transport = this.currentTransport
    if (!transport) throw new EscError('invalid_state', 'ESC 传输不可用')
    try {
      const escs = await this.manager.runExclusiveJob(clientId, 'scan', async ({ signal }) => {
        const detected = await this.scan(transport, signal, (index, error) => {
          this.log(
            sessionId,
            'warn',
            `电调 #${index + 1} 探测失败：[${error.code}] ${error.message}`,
          )
        })
        this.devices.clear()
        this.rawSettings.clear()
        const settingsService = new Am32SettingsService(new FourWayClient(transport))
        for (let position = 0; position < detected.length; position++) {
          const device = detected[position]
          if (device.firmwareKind !== 'am32') {
            this.devices.set(device.index, device)
            continue
          }
          // Target boundary: re-validate before the next ESC is addressed.
          this.manager.assertSafetyCurrent(clientId, sessionId)
          try {
            const result = await settingsService.read(sessionId, device.index, signal)
            detected[position] = result.device
            this.devices.set(device.index, result.device)
            this.rawSettings.set(device.index, result.raw)
            this.options.emit({ type: 'esc_settings', data: result.snapshot })
          } catch (error) {
            const escError = toEscError(error)
            this.devices.set(device.index, device)
            this.log(sessionId, 'warn', `电调 #${device.index + 1} 参数读取失败：${escError.message}`)
          }
        }
        return detected
      })
      this.options.emit({ type: 'esc_devices', data: { sessionId, escs } })
      const responding = escs.filter((esc) => esc.interfaceMode !== null).length
      this.log(
        sessionId,
        responding > 0 ? 'info' : 'warn',
        `扫描完成：${escs.length} 个通道，${responding} 个 ESC 响应`,
      )
    } catch (error) {
      const escError = toEscError(error)
      this.emitOpError('esc_devices_scan', escError, requestId)
      this.log(sessionId, 'error', `扫描失败：${escError.message}`)
    }
  }

  private async runSettingsRead(
    clientId: string,
    sessionId: string,
    targets: number[] | 'all',
  ): Promise<void> {
    const transport = this.requireSettingsTransport(sessionId)
    const selected = targets === 'all'
      ? [...this.devices.values()].filter((device) => device.firmwareKind === 'am32').map((device) => device.index)
      : targets
    if (selected.length === 0) {
      throw new EscError('precondition_failed', '没有可读取的 AM32 电调')
    }

    const completed = await this.manager.runExclusiveJob(clientId, 'settings_read', async ({ jobId, signal }) => {
      const service = new Am32SettingsService(new FourWayClient(transport))
      const perTarget: EscJobTargetResult[] = []
      for (let ordinal = 0; ordinal < selected.length; ordinal++) {
        const escIndex = selected[ordinal]
        // Target boundary: re-validate before the next ESC is addressed.
        this.manager.assertSafetyCurrent(clientId, sessionId)
        this.options.emit({
          type: 'esc_job_progress',
          data: {
            sessionId,
            jobId,
            kind: 'settings_read',
            escIndex,
            phase: 'read',
            bytesDone: 0,
            bytesTotal: AM32_LAYOUT_SIZE,
            currentTargetOrdinal: ordinal + 1,
            targetCount: selected.length,
            message: `正在读取 ESC #${escIndex + 1}`,
          },
        })
        try {
          const result = await service.read(sessionId, escIndex, signal)
          this.devices.set(escIndex, result.device)
          this.rawSettings.set(escIndex, result.raw)
          this.options.emit({ type: 'esc_settings', data: result.snapshot })
          perTarget.push({ escIndex, ok: true })
        } catch (error) {
          const escError = toEscError(error)
          perTarget.push({ escIndex, ok: false, error: escError.toOperationError('esc_settings_read') })
        }
        this.options.emit({
          type: 'esc_job_progress',
          data: {
            sessionId,
            jobId,
            kind: 'settings_read',
            escIndex,
            phase: 'done',
            bytesDone: AM32_LAYOUT_SIZE,
            bytesTotal: AM32_LAYOUT_SIZE,
            currentTargetOrdinal: ordinal + 1,
            targetCount: selected.length,
          },
        })
      }
      return { jobId, perTarget }
    })
    this.emitDevices(sessionId)
    this.options.emit({
      type: 'esc_job_done',
      data: {
        sessionId,
        jobId: completed.jobId,
        kind: 'settings_read',
        ok: completed.perTarget.every((result) => result.ok),
        perTarget: completed.perTarget,
      },
    })
  }

  private async runSettingsWrite(
    clientId: string,
    sessionId: string,
    targets: number[],
    values: EscSettingsValues,
  ): Promise<void> {
    const transport = this.requireSettingsTransport(sessionId)
    const completed = await this.manager.runExclusiveJob(clientId, 'settings_write', async ({ jobId, signal }) => {
      const service = new Am32SettingsService(new FourWayClient(transport))
      const perTarget: EscJobTargetResult[] = []
      for (let ordinal = 0; ordinal < targets.length; ordinal++) {
        // One EEPROM write/readback is the atomic safety unit. If the owner
        // disconnects while it is in flight, let that target finish safely,
        // but never enter the next target with an orphaned acknowledgement.
        this.manager.assertSettingsWriteAllowed(clientId, sessionId)
        // Target boundary: an armed/target/connection change must stop the
        // batch before the next ESC is addressed (unlike an owner loss, this
        // also aborts the in-flight target through the session signal).
        this.manager.assertSafetyCurrent(clientId, sessionId)
        const escIndex = targets[ordinal]
        this.options.emit({
          type: 'esc_job_progress',
          data: {
            sessionId,
            jobId,
            kind: 'settings_write',
            escIndex,
            phase: 'write',
            bytesDone: 0,
            bytesTotal: AM32_LAYOUT_SIZE,
            currentTargetOrdinal: ordinal + 1,
            targetCount: targets.length,
            message: `正在写入 ESC #${escIndex + 1}`,
          },
        })
        try {
          const device = this.devices.get(escIndex)
          const raw = this.rawSettings.get(escIndex)
          if (!device || !raw) {
            throw new EscError('precondition_failed', `请先读取 ESC #${escIndex + 1} 的参数`, { escIndex })
          }
          const result = await service.write(sessionId, device, raw, values, signal)
          this.devices.set(escIndex, result.device)
          this.rawSettings.set(escIndex, result.raw)
          this.options.emit({ type: 'esc_settings', data: result.snapshot })
          perTarget.push({ escIndex, ok: true })
        } catch (error) {
          const escError = toEscError(error)
          perTarget.push({ escIndex, ok: false, error: escError.toOperationError('esc_settings_write') })
        }
        this.options.emit({
          type: 'esc_job_progress',
          data: {
            sessionId,
            jobId,
            kind: 'settings_write',
            escIndex,
            phase: 'verify',
            bytesDone: AM32_LAYOUT_SIZE,
            bytesTotal: AM32_LAYOUT_SIZE,
            currentTargetOrdinal: ordinal + 1,
            targetCount: targets.length,
          },
        })
      }
      return { jobId, perTarget }
    })
    this.emitDevices(sessionId)
    this.options.emit({
      type: 'esc_job_done',
      data: {
        sessionId,
        jobId: completed.jobId,
        kind: 'settings_write',
        ok: completed.perTarget.every((result) => result.ok),
        perTarget: completed.perTarget,
      },
    })
    this.log(
      sessionId,
      completed.perTarget.every((result) => result.ok) ? 'info' : 'warn',
      completed.perTarget.every((result) => result.ok)
        ? `已保存 ${completed.perTarget.length} 个 ESC 的参数并通过读回校验`
        : '部分 ESC 参数写入失败，请查看操作记录',
    )
  }

  private requireSettingsTransport(sessionId: string): EscByteTransport {
    if (this.currentSessionId !== sessionId || !this.currentTransport) {
      throw new EscError('invalid_state', 'ESC 参数会话已失效')
    }
    if (this.currentTransport.kind !== 'ardupilot_raw') {
      throw new EscError('not_supported', '当前连接方式尚未支持 AM32 参数读写')
    }
    return this.currentTransport
  }

  private emitDevices(sessionId: string): void {
    const escs = [...this.devices.values()].sort((left, right) => left.index - right.index)
    this.options.emit({ type: 'esc_devices', data: { sessionId, escs } })
  }

  /**
   * Discover ESCs on an open transport. ArduPilot enters BLHeli passthrough
   * (MSP -> 4-way) and probes each channel. PX4/direct use the AM32 bootloader
   * which is not yet implemented, so they report not_supported for now.
   */
  private async scan(
    transport: EscByteTransport,
    signal: AbortSignal,
    onProbeError?: (index: number, error: EscError) => void,
  ): Promise<EscDeviceInfo[]> {
    if (transport.kind !== 'ardupilot_raw') {
      throw new EscError('not_supported', 'AM32 bootloader 检测将在后续里程碑提供')
    }
    const msp = new MspClient(transport)
    // Confirm that ArduPilot's alternative-protocol handler has taken over
    // before sending the state-changing passthrough command.
    await msp.apiVersion(signal)
    const reported = await msp.setPassthrough(signal)
    // The FC is now in its blocking 4-way loop. Orderly teardown must send
    // InterfaceExit before the raw link is returned to MAVLink.
    this.fourWayActive.add(transport)
    const channelCount = Math.min(
      ESC_MAX_TARGETS,
      reported && reported > 0 ? reported : DEFAULT_ESC_CHANNEL_COUNT,
    )
    const fourWay = new FourWayClient(transport)
    return detectEscs(fourWay, channelCount, signal, onProbeError)
  }

  handleMavlinkStatus(status: string): void {
    if (status !== 'connected' && this.manager.snapshot().mode === 'px4_serial_control') {
      this.manager.handleExternalLinkLost()
    }
  }

  /**
   * Push-based safety boundary (the Worker observed an armed heartbeat or a
   * target reset). Terminates the active session and releases the borrowed
   * link; a no-op when no session is live.
   */
  handleVehicleSafetyBoundary(reason: string): void {
    this.manager.handleVehicleSafetyBoundary(reason)
  }

  handleClientDisconnected(clientId: string): void {
    this.manager.handleClientDisconnected(clientId)
  }

  snapshot(): EscSessionSnapshot {
    return this.manager.snapshot()
  }

  async destroy(): Promise<void> {
    await this.manager.destroy()
  }
}
