import type { RuntimeCommand, ConnectionConfig, ParamData, RuntimeEvent } from '../shared/types'
import { LOCAL_RUNTIME_OWNER_ID, type BrowserConnectionOptions } from '../shared/localRuntime'
import { BrowserConnectionManager } from './connection/BrowserConnectionManager'
import { EscService } from './esc/EscService'
import type { EscSafetySnapshot } from './esc/EscSafetyContext'
import { CalibrationSessionManager } from './mavlink/CalibrationSessionManager'
import { MavlinkBridge } from './mavlink/MavlinkBridge'
import { RadioCalibrationSessionManager } from './mavlink/RadioCalibrationSessionManager'
import { randomUUID, signingKey } from './platform/crypto'

const LOCAL_CLIENT_ID = LOCAL_RUNTIME_OWNER_ID
const PARAM_BATCH_INTERVAL_MS = 120
const MAX_PARAM_BATCH_ITEMS = 2048
const PARAM_SYNC_TIMEOUT_MS = 120_000

type Emit = (event: RuntimeEvent) => void

function requestIdOf(message: RuntimeCommand): string | undefined {
  return 'requestId' in message ? message.requestId : undefined
}

function isEscMessage(message: RuntimeCommand): message is Extract<RuntimeCommand, { type: `esc_${string}` }> {
  return message.type.startsWith('esc_')
}

function safetyExpectation(message: RuntimeCommand): { epoch: number; authorityId: string } | null {
  if (message.type === 'airframe_apply' || message.type === 'radio_calibration_start') {
    return { epoch: message.expectedSafetyEpoch, authorityId: message.expectedSafetyAuthorityId }
  }
  if (message.type === 'vehicle_config_set' && message.safetyConfirmation === 'reduce_failsafe_protection') {
    return { epoch: message.expectedSafetyEpoch ?? -1, authorityId: message.expectedSafetyAuthorityId ?? '' }
  }
  if (message.type === 'fs_delete' || message.type === 'log_erase' || message.type === 'esc_session_start' || message.type === 'reboot_vehicle') {
    return { epoch: message.expectedSafetyEpoch, authorityId: message.expectedSafetyAuthorityId }
  }
  if (message.type === 'command' && message.expectedSafetyEpoch !== undefined) {
    return { epoch: message.expectedSafetyEpoch, authorityId: message.expectedSafetyAuthorityId ?? '' }
  }
  if ((message.type === 'motor_test' || message.type === 'motor_test_batch') && message.expectedSafetyEpoch !== undefined) {
    return { epoch: message.expectedSafetyEpoch, authorityId: message.expectedSafetyAuthorityId ?? '' }
  }
  return null
}

function requiresReadyTarget(message: RuntimeCommand): boolean {
  return !(message.type === 'esc_session_start' && message.data.mode === 'direct')
}

function isEmergencyDisarm(message: RuntimeCommand): boolean {
  return message.type === 'command'
    && message.cmd === 'MAV_CMD_COMPONENT_ARM_DISARM'
    && (message.params[0] ?? 0) < 0.5
}

export class LocalRuntimeCoordinator {
  readonly connection: BrowserConnectionManager

  private readonly emit: Emit
  private bridge: MavlinkBridge | null = null
  private esc: EscService | null = null
  private calibration: CalibrationSessionManager | null = null
  private radio: RadioCalibrationSessionManager | null = null
  private safetyEpoch = 1
  private safetyAuthorityId = randomUUID()
  private lastTargetFingerprint = ''
  private escSafetySnapshot: Omit<EscSafetySnapshot, 'connectionKey'> = {
    armed: null,
    ready: false,
    fingerprint: 'unavailable',
    observedAt: 0,
    fcActivityObserved: false,
  }
  private parameterGeneration = 0
  private activeParameterGeneration: number | null = null
  private activeParameterRunId: number | undefined
  private paramTimeout: ReturnType<typeof setTimeout> | null = null
  private paramBatchTimer: ReturnType<typeof setTimeout> | null = null
  private pendingParams: ParamData[] = []

  constructor(options: {
    emit: Emit
    write: ConstructorParameters<typeof BrowserConnectionManager>[0]['write']
    cancelQueuedWrites: ConstructorParameters<typeof BrowserConnectionManager>[0]['cancelQueuedWrites']
  }) {
    this.emit = options.emit
    this.connection = new BrowserConnectionManager({
      write: options.write,
      cancelQueuedWrites: options.cancelQueuedWrites,
    })
    this.connection.on('statusChange', () => this.onConnectionChanged())
    this.connection.on('connectionStateDetail', () => this.onConnectionChanged())
    this.connection.on('vehicleReadyChange', (ready: boolean) => this.onVehicleReady(ready))
    this.connection.on('rawSessionChange', () => this.advanceSafety('safety_changed'))
    this.emitHello()
    this.emitConnection()
  }

  open(
    config: ConnectionConfig,
    options: Pick<BrowserConnectionOptions, 'protocol' | 'signing'>,
  ): void {
    this.destroyServices()
    this.safetyAuthorityId = randomUUID()
    this.safetyEpoch = 1
    this.lastTargetFingerprint = ''
    this.escSafetySnapshot = {
      armed: null,
      ready: false,
      fingerprint: 'unavailable',
      observedAt: 0,
      fcActivityObserved: false,
    }
    const codec = {
      protocol: options.protocol,
      ...(options.signing ? {
        signing: {
          key: signingKey(options.signing.secret),
          linkId: options.signing.linkId,
          requireSigned: options.signing.requireSigned,
          allowStaleFirstPacket: options.signing.allowStaleFirstPacket,
        },
      } : {}),
    }
    const bridge = new MavlinkBridge(this.connection, { codec })
    bridge.setSafetyEpochProvider(() => ({
      epoch: this.safetyEpoch,
      authorityId: this.safetyAuthorityId,
    }))
    this.bridge = bridge

    let radio!: RadioCalibrationSessionManager
    const esc = new EscService({
      connManager: this.connection,
      bridge,
      emit: this.emit,
      emitToClient: (_clientId, event) => this.emit(event),
      getVehicleIdentity: () => bridge.vehicleIdentity,
      getParameterValue: (id) => bridge.getParameterValue(id),
      getSafetyContext: () => ({
        ...this.escSafetySnapshot,
        connectionKey: JSON.stringify([this.connection.status, this.connection.transportOpen]),
      }),
      pinController: () => undefined,
      releaseController: () => undefined,
      isLinkBusy: () => this.activeParameterGeneration !== null
        ? 'parameter_sync'
        : this.calibration?.blocksMavlinkMutations()
          ? 'sensor_calibration'
          : radio?.blocksMavlinkMutations()
            ? 'radio_calibration'
            : null,
    })
    this.esc = esc
    const calibration = new CalibrationSessionManager({
      createSession: (request) => bridge.createCalibrationSession(request),
      broadcast: this.emit,
      emitToClient: (_clientId, event) => this.emit(event),
      pinController: () => undefined,
      releaseController: () => undefined,
      onTerminalSuccess: () => this.beginParameterSync(),
      isLinkBusy: () => this.activeParameterGeneration !== null
        ? 'parameter_sync'
        : esc.blocksMavlinkMutations()
          ? 'esc_session'
          : radio?.blocksMavlinkMutations()
            ? 'radio_calibration'
            : null,
    })
    this.calibration = calibration
    radio = new RadioCalibrationSessionManager({
      broadcast: this.emit,
      emitToClient: (_clientId, event) => this.emit(event),
      pinController: () => undefined,
      releaseController: () => undefined,
      notifyCalibration: (active) => bridge.notifyRadioCalibration(active),
      getVehicleContext: () => bridge.getVehicleMutationSafetyContext(),
      applyCalibration: (requestId, channels, mapped, fingerprint, completion) =>
        bridge.applyRadioCalibration(requestId, channels, mapped, fingerprint, completion),
      isLinkBusy: () => this.activeParameterGeneration !== null
        ? 'parameter_sync'
        : esc.blocksMavlinkMutations()
          ? 'esc_session'
          : calibration.blocksMavlinkMutations()
            ? 'sensor_calibration'
            : null,
    })
    this.radio = radio
    bridge.on('message', (event: RuntimeEvent & { paramRunId?: number }) => this.onBridgeEvent(event))
    this.connection.attach(config)
    this.emitHello()
    this.emitSafetyAuthority('connection_changed')
  }

  receive(data: Uint8Array): void {
    this.connection.receive(data)
  }

  close(reason = 'disconnected'): void {
    this.destroyServices()
    const expected = reason === 'disconnected' || reason === 'user_disconnect' || reason === 'runtime_shutdown'
    this.connection.detach(reason, expected ? undefined : reason)
    this.advanceSafety('connection_changed')
  }

  async readArtifact(artifactId: string, consume: boolean): Promise<{ fileName: string; data: Uint8Array }> {
    if (!this.bridge) throw new Error('飞控运行时未启动')
    return this.bridge.readLocalArtifact(artifactId, consume)
  }

  async prepareDisconnect(): Promise<void> {
    if (!this.bridge || !this.connection.transportOpen) return
    this.bridge.handleRuntimeCommand({ type: 'shell_close', requestId: 'disconnect-shell-close' })
    if (this.connection.vehicleReady) {
      this.bridge.handleRuntimeCommand({
        type: 'motor_test_batch',
        requestId: 'disconnect-motor-stop',
        data: { instances: Array.from({ length: 12 }, (_, index) => index + 1), throttle: 0, duration: 0 },
      })
      this.bridge.handleRuntimeCommand({
        type: 'manual_control',
        requestId: 'disconnect-manual-release',
        data: { x: 0, y: 0, z: 0, r: 0, buttons: 0 },
      })
    }
    this.calibration?.destroy()
    this.radio?.destroy()
    await this.esc?.destroy()
    // Bound the final drain without depending on an ACK as physical proof.
    await new Promise<void>((resolve) => setTimeout(resolve, 120))
  }

  handleCommand(message: RuntimeCommand): boolean {
    const bridge = this.bridge
    const esc = this.esc
    const calibration = this.calibration
    const radio = this.radio
    if (!bridge || !esc || !calibration || !radio) {
      this.clientError('runtime_unavailable', '本地飞控运行时尚未连接', requestIdOf(message), true)
      return false
    }
    const expected = safetyExpectation(message)
    if (expected && (expected.epoch !== this.safetyEpoch || expected.authorityId !== this.safetyAuthorityId)) {
      this.clientError('stale_safety_confirmation', '连接、目标或安全状态已改变，请重新确认', requestIdOf(message))
      return false
    }
    if (isEscMessage(message)) {
      if (message.type === 'esc_session_start' && (calibration.blocksMavlinkMutations() || radio.blocksMavlinkMutations())) {
        this.clientError('calibration_session_active', '校准会话进行中，暂不能启动 ESC 会话', requestIdOf(message), true)
        return false
      }
      if (requiresReadyTarget(message) && !this.ready()) {
        this.clientError('target_not_ready', '飞控传输或已选目标尚未就绪', requestIdOf(message), true)
        return false
      }
      void esc.handleRuntimeCommand(LOCAL_CLIENT_ID, message)
      return true
    }
    if (esc.blocksMavlinkMutations()) {
      this.clientError('esc_session_active', 'ESC 会话进行中，暂不能执行该操作', requestIdOf(message), true)
      return false
    }
    if (calibration.blocksMavlinkMutations() && message.type !== 'calibration_action' && message.type !== 'start_calibration') {
      if (!isEmergencyDisarm(message) && message.type !== 'reboot_vehicle') {
        this.clientError('calibration_session_active', '校准会话进行中，暂不能执行该操作', requestIdOf(message), true)
        return false
      }
      if (isEmergencyDisarm(message)) calibration.notifyEmergencyDisarm()
    }
    if (radio.blocksMavlinkMutations()
      && message.type !== 'radio_calibration_start'
      && message.type !== 'radio_calibration_advance'
      && message.type !== 'radio_calibration_cancel') {
      if (!isEmergencyDisarm(message) && message.type !== 'reboot_vehicle') {
        this.clientError('radio_calibration_active', '遥控器校准进行中，暂不能执行该操作', requestIdOf(message), true)
        return false
      }
    }
    if (requiresReadyTarget(message) && !this.ready()) {
      this.clientError('target_not_ready', '飞控传输或已选目标尚未就绪', requestIdOf(message), true)
      return false
    }
    if (message.type === 'param_request_list') this.beginParameterSync()
    if (message.type === 'start_calibration') {
      calibration.requestStart(LOCAL_CLIENT_ID, message)
      return true
    }
    if (message.type === 'calibration_action') {
      calibration.handleAction(LOCAL_CLIENT_ID, message)
      return true
    }
    if (message.type === 'radio_calibration_start') {
      if (!bridge.validateRadioCalibrationStart(message.requestId)) return false
      radio.requestStart(LOCAL_CLIENT_ID, message)
      return true
    }
    if (message.type === 'radio_calibration_advance') {
      radio.advance(LOCAL_CLIENT_ID, message)
      return true
    }
    if (message.type === 'radio_calibration_cancel') {
      radio.cancel(LOCAL_CLIENT_ID, message)
      return true
    }
    try {
      const result = bridge.handleRuntimeCommand(message)
      if (message.type === 'param_request_list') this.activeParameterRunId = bridge.currentParamRunId
      if (message.type === 'reboot_vehicle' && result.vehicleRebootQueued) {
        this.connection.expectVehicleReboot()
        calibration.notifyVehicleReboot()
      }
      return true
    } catch (error) {
      if (message.type === 'param_request_list') this.finishParameterSync('failed', 'bridge_exception')
      this.clientError('operation_failed', error instanceof Error ? error.message : String(error), requestIdOf(message))
      return false
    }
  }

  destroy(): void {
    this.destroyServices()
    this.connection.detach('runtime_shutdown')
  }

  private ready(): boolean {
    return this.connection.status === 'connected'
      && this.connection.transportOpen
      && this.connection.vehicleReady
  }

  private onBridgeEvent(event: RuntimeEvent & { paramRunId?: number }): void {
    if (event.type === 'rc_channels') this.radio?.handleRcChannels(event.data)
    if (event.type === 'status') {
      if (event.data.armed) {
        this.radio?.handleVehicleSafetyBoundary('vehicle_armed')
        this.esc?.handleVehicleSafetyBoundary('vehicle_armed')
      }
      const context = this.bridge?.getVehicleMutationSafetyContext()
      if (context) {
        this.escSafetySnapshot = {
          ...context,
          observedAt: Date.now(),
          fcActivityObserved: true,
        }
      }
    }
    if (event.type === 'target') {
      // Raw ArduPilot passthrough deliberately resets the bridge target after
      // MAVLink is paused. Preserve the last live heartbeat evidence so the
      // session can validate it until the bounded snapshot TTL expires.
      if (!this.bridge?.isProtocolPaused) {
        const context = this.bridge?.getVehicleMutationSafetyContext()
        if (context) {
          this.escSafetySnapshot = {
            ...context,
            observedAt: this.escSafetySnapshot.observedAt,
            fcActivityObserved: this.escSafetySnapshot.fcActivityObserved || context.ready,
          }
        }
      }
      const fingerprint = JSON.stringify([event.data.systemId, event.data.componentId, event.data.ready, event.data.identity])
      if (fingerprint !== this.lastTargetFingerprint) {
        this.lastTargetFingerprint = fingerprint
        this.radio?.handleVehicleSafetyBoundary('target_or_identity_changed')
        this.advanceSafety('safety_changed')
      }
      this.emit({
        ...event,
        data: { ...event.data, safetyEpoch: this.safetyEpoch, safetyAuthorityId: this.safetyAuthorityId },
      })
      return
    }
    const parameterEvent = event.type === 'param' || event.type === 'param_complete'
      || event.type === 'param_failed' || event.type === 'param_retry'
    if (parameterEvent && event.paramRunId !== undefined && this.activeParameterRunId !== undefined
      && event.paramRunId !== this.activeParameterRunId) return
    if (event.type === 'param' && event.paramRunId !== undefined) {
      this.pendingParams.push(event.data)
      if (this.pendingParams.length >= MAX_PARAM_BATCH_ITEMS) this.flushParams()
      else if (!this.paramBatchTimer) this.paramBatchTimer = setTimeout(() => this.flushParams(), PARAM_BATCH_INTERVAL_MS)
      return
    }
    if (event.type === 'param_complete' || event.type === 'param_failed' || event.type === 'param_retry') this.flushParams()
    const generation = (event.type === 'param_complete' || event.type === 'param_failed' || event.type === 'param_retry')
      ? this.activeParameterGeneration ?? undefined
      : undefined
    const { paramRunId: _ignored, ...clean } = event as RuntimeEvent & { paramRunId?: number }
    this.emit({ ...clean, ...(generation === undefined ? {} : { generation }) } as RuntimeEvent)
    if (event.type === 'param_complete') this.finishParameterSync('complete')
    else if (event.type === 'param_failed') this.finishParameterSync('failed')
  }

  private beginParameterSync(): void {
    if (this.activeParameterGeneration !== null) {
      this.bridge?.cancelParameterDownload()
      this.finishParameterSync('cancelled', 'superseded')
    }
    this.activeParameterGeneration = ++this.parameterGeneration
    this.activeParameterRunId = undefined
    this.emit({ type: 'param_sync', data: { generation: this.activeParameterGeneration, status: 'started', ownerClientId: LOCAL_CLIENT_ID } })
    this.paramTimeout = setTimeout(() => {
      this.bridge?.cancelParameterDownload()
      this.finishParameterSync('cancelled', 'timeout')
    }, PARAM_SYNC_TIMEOUT_MS)
  }

  private finishParameterSync(status: 'complete' | 'failed' | 'cancelled', reason?: string): void {
    if (this.activeParameterGeneration === null) return
    this.flushParams()
    if (this.paramTimeout) clearTimeout(this.paramTimeout)
    const generation = this.activeParameterGeneration
    this.paramTimeout = null
    this.activeParameterGeneration = null
    this.activeParameterRunId = undefined
    this.emit({ type: 'param_sync', data: { generation, status, ownerClientId: LOCAL_CLIENT_ID, ...(reason ? { reason } : {}) } })
  }

  private flushParams(): void {
    if (this.paramBatchTimer) clearTimeout(this.paramBatchTimer)
    this.paramBatchTimer = null
    if (!this.pendingParams.length) return
    const data = this.pendingParams
    this.pendingParams = []
    this.emit({ type: 'param_batch', generation: this.activeParameterGeneration ?? undefined, data })
  }

  private onConnectionChanged(): void {
    this.esc?.handleMavlinkStatus(this.connection.status)
    if (this.connection.status !== 'connected') {
      this.calibration?.handleLinkDown()
      this.radio?.handleLinkDown()
      if (this.activeParameterGeneration !== null) this.finishParameterSync('cancelled', `connection_${this.connection.status}`)
    }
    this.advanceSafety('connection_changed', false)
    this.emitConnection()
  }

  private onVehicleReady(ready: boolean): void {
    if (ready) this.escSafetySnapshot.fcActivityObserved = true
    if (!this.bridge?.isProtocolPaused) {
      const context = this.bridge?.getVehicleMutationSafetyContext()
      if (context) this.escSafetySnapshot = { ...this.escSafetySnapshot, ...context }
    }
    if (!ready && !this.connection.rawSessionActive) {
      this.radio?.handleVehicleSafetyBoundary('vehicle_not_ready')
      if (this.activeParameterGeneration !== null) this.finishParameterSync('cancelled', 'vehicle_not_ready')
    }
    this.advanceSafety('safety_changed', false)
    this.emitConnection()
  }

  private advanceSafety(reason: Extract<RuntimeEvent, { type: 'safety_authority' }>['data']['reason'], emit = true): void {
    this.safetyEpoch += 1
    this.bridge?.invalidateAirframeTransaction(reason)
    if (emit) this.emitSafetyAuthority(reason)
  }

  private emitHello(): void {
    this.emit({
      type: 'hello',
      data: {
        protocolVersion: 3,
        capabilities: ['web-serial', 'local-worker', 'opfs-artifacts'],
        safetyEpoch: this.safetyEpoch,
        safetyAuthorityId: this.safetyAuthorityId,
      },
    })
  }

  private emitSafetyAuthority(reason: Extract<RuntimeEvent, { type: 'safety_authority' }>['data']['reason']): void {
    this.emit({ type: 'safety_authority', data: { safetyEpoch: this.safetyEpoch, safetyAuthorityId: this.safetyAuthorityId, reason } })
  }

  private emitConnection(): void {
    const config = this.connection.config
    this.emit({
      type: 'connection',
      data: {
        connected: this.connection.transportOpen,
        status: this.connection.status,
        transportOpen: this.connection.transportOpen,
        vehicleReady: this.connection.vehicleReady,
        rawSessionActive: this.connection.rawSessionActive,
        safetyEpoch: this.safetyEpoch,
        safetyAuthorityId: this.safetyAuthorityId,
        ...(config ? { port: config.port, type: config.type, baudRate: config.baudRate } : {}),
        ...(this.connection.lastError ? { error: this.connection.lastError } : {}),
      },
    })
  }

  private clientError(code: string, message: string, requestId?: string, retryable = false): void {
    this.emit({ type: 'client_error', data: { code, message, ...(requestId ? { requestId } : {}), retryable } })
  }

  private destroyServices(): void {
    if (this.paramTimeout) clearTimeout(this.paramTimeout)
    if (this.paramBatchTimer) clearTimeout(this.paramBatchTimer)
    this.paramTimeout = null
    this.paramBatchTimer = null
    this.pendingParams = []
    this.activeParameterGeneration = null
    this.activeParameterRunId = undefined
    this.calibration?.destroy()
    this.radio?.destroy()
    void this.esc?.destroy()
    this.bridge?.destroy()
    this.calibration = null
    this.radio = null
    this.esc = null
    this.bridge = null
  }
}
