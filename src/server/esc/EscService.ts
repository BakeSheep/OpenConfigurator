// ESC service: the single integration point between the WebSocket layer and
// the ESC session/protocol stack. Owns the EscSessionManager, builds the
// mode-specific transport, runs discovery and emits ServerMessages. index.ts
// routes esc_* client messages here and forwards emitted events to clients.
import {
  EscError,
  ESC_MAX_TARGETS,
  toEscError,
  type EscDeviceInfo,
  type EscLogEntry,
  type EscSessionSnapshot,
} from '../../shared/esc'
import type { ClientMessage, ServerMessage } from '../../shared/types'
import type { ConnectionManager } from '../connection/ConnectionManager'
import type { MavlinkBridge } from '../mavlink/MavlinkBridge'
import { ArduPilotRawTransport } from './ArduPilotRawTransport'
import { DirectSerialTransport } from './DirectSerialTransport'
import type { EscByteTransport, EscTransportTarget } from './EscByteTransport'
import { detectEscs, FourWayClient, MspClient } from './EscDetector'
import { EscSessionManager } from './EscSessionManager'
import { Px4SerialControlTransport } from './Px4SerialControlTransport'

export interface EscServiceOptions {
  connManager: ConnectionManager
  bridge: MavlinkBridge
  emit: (message: ServerMessage) => void
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

type EscClientMessage = Extract<ClientMessage, { type: `esc_${string}` }>

const DEFAULT_ESC_CHANNEL_COUNT = 4

export class EscService {
  private readonly options: EscServiceOptions
  private readonly manager: EscSessionManager
  private currentTransport: EscByteTransport | null = null

  constructor(options: EscServiceOptions) {
    this.options = options
    this.manager = new EscSessionManager({
      createTransport: (target) => this.createTransport(target),
      pinController: options.pinController,
      releaseController: options.releaseController,
      logger: options.logger,
      ...(options.idleTimeoutMs !== undefined ? { idleTimeoutMs: options.idleTimeoutMs } : {}),
      ...(options.orphanGraceMs !== undefined ? { orphanGraceMs: options.orphanGraceMs } : {}),
    })
    this.manager.on('session', (snapshot: EscSessionSnapshot) => {
      if (snapshot.state === 'idle') this.currentTransport = null
      this.options.emit({ type: 'esc_session', data: snapshot })
    })
  }

  /** True while any ESC session exists: release_control must be refused. */
  blocksControllerRelease(): boolean {
    return this.manager.blocksControllerRelease()
  }

  /** True while a non-direct session holds the MAVLink link. */
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

  private createTransport(target: EscTransportTarget): EscByteTransport {
    if (this.options.transportFactory) {
      const transport = this.options.transportFactory(target)
      this.currentTransport = transport
      return transport
    }
    let transport: EscByteTransport
    switch (target.mode) {
      case 'ardupilot_passthrough':
        transport = new ArduPilotRawTransport({
          connManager: this.options.connManager,
          bridge: this.options.bridge,
          ...(this.options.isLinkBusy ? { checkBusy: this.options.isLinkBusy } : {}),
        })
        break
      case 'px4_serial_control':
        transport = new Px4SerialControlTransport({ bridge: this.options.bridge })
        break
      case 'direct':
        transport = new DirectSerialTransport({
          getBusyMavlinkPort: () =>
            this.options.connManager.status === 'connected'
              ? this.options.connManager.config?.port ?? null
              : null,
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
  async handleClientMessage(clientId: string, message: EscClientMessage): Promise<void> {
    try {
      switch (message.type) {
        case 'esc_session_start':
          await this.handleStart(clientId, message)
          break
        case 'esc_session_reclaim':
          await this.manager.reclaim(clientId, message.data.sessionId, message.data.recoveryToken)
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
        case 'esc_settings_write':
        case 'esc_flash_start':
        case 'esc_flash_cancel':
        case 'esc_flash_decide':
        case 'esc_melody_write':
          // These land in later milestones (settings read/write, flashing,
          // melody). Ownership is still enforced so the surface is safe.
          this.manager.assertOwner(clientId, message.data.sessionId)
          this.manager.noteActivity(clientId)
          throw new EscError('not_supported', '该 ESC 操作将在后续里程碑提供')
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
    const target: EscTransportTarget =
      message.data.mode === 'ardupilot_passthrough'
        ? { mode: 'ardupilot_passthrough' }
        : message.data.mode === 'px4_serial_control'
          ? { mode: 'px4_serial_control', channels: message.data.channels }
          : { mode: 'direct', port: message.data.port, baudRate: 19200 }

    const { sessionId } = await this.manager.start(clientId, target)
    this.log(sessionId, 'info', `ESC 会话已建立（${message.data.mode}）`)
    // Auto-scan immediately after entering the session.
    await this.runScan(clientId, sessionId, message.requestId)
  }

  private async runScan(clientId: string, sessionId: string, requestId?: string): Promise<void> {
    const transport = this.currentTransport
    if (!transport) throw new EscError('invalid_state', 'ESC 传输不可用')
    try {
      const escs = await this.manager.runExclusiveJob(clientId, 'scan', async ({ signal }) => {
        return this.scan(transport, signal)
      })
      this.options.emit({ type: 'esc_devices', data: { sessionId, escs } })
      this.log(sessionId, 'info', `发现 ${escs.length} 个电调`)
    } catch (error) {
      const escError = toEscError(error)
      this.emitOpError('esc_devices_scan', escError, requestId)
      this.log(sessionId, 'error', `扫描失败：${escError.message}`)
    }
  }

  /**
   * Discover ESCs on an open transport. ArduPilot enters BLHeli passthrough
   * (MSP -> 4-way) and probes each channel. PX4/direct use the AM32 bootloader
   * which is not yet implemented, so they report not_supported for now.
   */
  private async scan(transport: EscByteTransport, signal: AbortSignal): Promise<EscDeviceInfo[]> {
    if (transport.kind !== 'ardupilot_raw') {
      throw new EscError('not_supported', 'AM32 bootloader 检测将在后续里程碑提供')
    }
    const msp = new MspClient(transport)
    const reported = await msp.setPassthrough(signal)
    const channelCount = Math.min(
      ESC_MAX_TARGETS,
      reported && reported > 0 ? reported : DEFAULT_ESC_CHANNEL_COUNT,
    )
    const fourWay = new FourWayClient(transport)
    return detectEscs(fourWay, channelCount, signal)
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
