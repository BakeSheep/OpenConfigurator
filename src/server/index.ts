import { randomUUID, timingSafeEqual } from 'node:crypto'
import { EventEmitter } from 'node:events'
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
} from 'node:http'
import type { Socket } from 'node:net'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import cors from 'cors'
import express, {
  type NextFunction,
  type Request,
  type Response,
} from 'express'
import {
  WebSocket,
  WebSocketServer,
  type RawData,
} from 'ws'
import type {
  ClientMessage,
  ConnectionConfig,
  ConnectionStatus,
  ParamData,
  PortInfo,
  ServerMessage,
} from '../shared/types'
import type { VehicleIdentity } from '../shared/vehicleProfiles'
import { ConnectionManager } from './connection/ConnectionManager'
import { MavlinkBridge } from './mavlink/MavlinkBridge'
import {
  CalibrationSessionManager,
  type CalibrationSessionHandle,
  type CalibrationStartRequest,
} from './mavlink/CalibrationSessionManager'
import { EscService } from './esc/EscService'
import {
  InputValidationError,
  isAllowedOrigin,
  isLoopbackAddress,
  parseClientMessage,
  parseConnectionConfig,
  parseServerConfig,
  type BoundaryClientMessage,
  type ServerConfig,
} from './validation'
import { MessageRateLimiter } from './messageRateLimiter'

const modulePath = fileURLToPath(import.meta.url)
const moduleDir = path.dirname(modulePath)
const distPath = path.resolve(moduleDir, '../../dist')

const PROTOCOL_VERSION = 2
const JSON_BODY_LIMIT = '16kb'
const MAX_BUFFERED_AMOUNT = 512 * 1024
const PARAM_BATCH_INTERVAL_MS = 120
const MAX_PARAM_BATCH_ITEMS = 2048
const PARAM_SYNC_TIMEOUT_MS = 120_000
const CONTROLLER_LEASE_MS = 30_000
const WS_HEARTBEAT_INTERVAL_MS = 15_000
const RATE_LIMIT_CAPACITY = 80
const RATE_LIMIT_REFILL_PER_SECOND = 40
const MAX_RATE_LIMIT_VIOLATIONS = 3
const HTTP_INSPECTION_RATE_WINDOW_MS = 10_000
const HTTP_INSPECTION_RATE_MAX = 10
const HTTP_INSPECTION_RATE_MAX_KEYS = 256
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000

type ConnectionErrorDetail = {
  phase: 'connect' | 'runtime' | 'disconnect' | 'heartbeat' | 'reconnect'
  message: string
  code?: string
  timestamp: number
  retryable?: boolean
}

export interface ConnectionManagerBoundary extends EventEmitter {
  readonly status: ConnectionStatus
  readonly config: ConnectionConfig | null
  readonly reconnect: {
    attempt: number
    maxAttempts: number
    delayMs: number
    lastError?: string
  } | null
  readonly reconnectTerminalReason?: {
    code: string
    message: string
    attempt: number
    timestamp: number
  } | null
  readonly transportOpen?: boolean
  readonly vehicleReady?: boolean
  readonly rawSessionActive?: boolean
  expectVehicleReboot?(): boolean
  readonly lastError?: ConnectionErrorDetail | null
  scanPorts(): Promise<{ serial: PortInfo[]; bluetooth: PortInfo[] }>
  connect(config: ConnectionConfig): Promise<void>
  disconnect(): Promise<void>
}

export interface MavlinkBridgeBoundary extends EventEmitter {
  handleClientMessage(message: ClientMessage): { vehicleRebootQueued: boolean }
  cancelParameterDownload?(): void
  readonly currentParamRunId?: number
  /** Cached one-shot autopilot_version message for late-joining WS clients. */
  getAutopilotVersionMessage?(): ServerMessage | null
  getMessageRatesMessage?(): Extract<ServerMessage, { type: 'message_rates' }>
  readonly vehicleIdentity?: VehicleIdentity | null
  getParameterValue?(id: string): number | null
  /**
   * Create (but not start) a calibration session after bridge-side gates
   * (identity, capability, armed). Returns null after emitting its own
   * operation_error when the request is rejected.
   */
  createCalibrationSession?(request: CalibrationStartRequest): CalibrationSessionHandle | null
  getFtpDownload?(downloadId: string): {
    filePath: string
    fileName: string
    sizeBytes: number
  } | null
  destroy(): void | Promise<void>
}

export interface BackendServices {
  connManager: ConnectionManagerBoundary
  mavlinkBridge: MavlinkBridgeBoundary
}

export interface CreateAppOptions {
  config?: ServerConfig
  services?: Partial<BackendServices>
  /** Override the built web asset directory (used by packaged desktop builds). */
  staticDir?: string
  heartbeatIntervalMs?: number
  controllerLeaseMs?: number
  parameterSyncTimeoutMs?: number
  shutdownTimeoutMs?: number
  logger?: Pick<Console, 'log' | 'warn' | 'error'>
}

export interface StartServerOptions extends CreateAppOptions {
  installSignalHandlers?: boolean
}

type LocalServerMessage = Extract<
  ServerMessage,
  { type: 'hello' | 'client_error' | 'controller' | 'param_sync' | 'connection' }
>

type WireMessage = ServerMessage

type ClientContext = {
  id: string
  restControlToken: string
  isAlive: boolean
  tokens: number
  lastRefill: number
  rateLimitViolations: number
}

type ControllerLease = {
  clientId: string
  expiresAt: number
}

type ParamSyncState = {
  generation: number
  ownerClientId: string
  startedAt: number
  // Bridge-side download run id captured when the request was accepted; late
  // lifecycle events from an older cancelled run are dropped by comparing it.
  runId?: number
}

class HttpBoundaryError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'HttpBoundaryError'
    this.status = status
    this.code = code
  }
}

type DownloadErrorResponse = Pick<Response, 'headersSent' | 'status' | 'json'>

/**
 * Complete response.download's callback contract. Once headers are on the
 * wire, Express must receive the error so its final handler can close the
 * partial response instead of leaving the client waiting indefinitely.
 */
export function handleDownloadError(
  error: Error | undefined,
  response: DownloadErrorResponse,
  next: NextFunction,
): void {
  if (!error) return
  if (response.headersSent) {
    next(error)
    return
  }
  response.status(404).json({
    success: false,
    error: { code: 'download_not_found', message: '下载文件不存在或已过期' },
  })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function normalizeConnectionError(error: unknown): ConnectionErrorDetail {
  if (typeof error === 'object' && error !== null && typeof (error as { message?: unknown }).message === 'string') {
    const candidate = error as {
      phase?: unknown
      message: string
      code?: unknown
      timestamp?: unknown
      retryable?: unknown
    }
    return {
      phase: candidate.phase === 'connect'
        || candidate.phase === 'disconnect'
        || candidate.phase === 'heartbeat'
        || candidate.phase === 'reconnect'
        || candidate.phase === 'runtime'
        ? candidate.phase
        : 'runtime',
      message: candidate.message,
      ...(typeof candidate.code === 'string' ? { code: candidate.code } : {}),
      timestamp: typeof candidate.timestamp === 'number' && Number.isFinite(candidate.timestamp)
        ? candidate.timestamp
        : Date.now(),
      ...(typeof candidate.retryable === 'boolean' ? { retryable: candidate.retryable } : {}),
    }
  }
  return { phase: 'runtime', message: String(error), timestamp: Date.now() }
}

function isRetryableConnectionError(detail: ConnectionErrorDetail): boolean {
  if (detail.retryable !== undefined) return detail.retryable
  return detail.phase === 'heartbeat'
    || detail.phase === 'reconnect'
    || /^(?:EAGAIN|EBUSY|ECONNRESET|ETIMEDOUT|EIO)$/.test(detail.code ?? '')
}

function isMutatingMessage(message: BoundaryClientMessage): boolean {
  return message.type === 'command'
    || message.type === 'reboot_vehicle'
    || message.type === 'set_flight_mode'
    || message.type === 'start_calibration'
    // calibration_action mutates the active calibration session; reclaim is
    // deliberately NOT here: like esc_session_reclaim it transfers ownership
    // to a new client and must not be blocked by the old owner's pinned lease.
    || message.type === 'calibration_action'
    || message.type === 'param_set'
    || message.type === 'param_request_list'
    || message.type === 'message_rates_set'
    || message.type === 'shell_open'
    || message.type === 'shell_write'
    || message.type === 'shell_close'
    || message.type === 'manual_control'
    || message.type === 'motor_test'
    || message.type === 'motor_test_batch'
    || message.type === 'select_target'
    || message.type === 'fs_download'
    || message.type === 'fs_download_cancel'
    || message.type === 'fs_delete'
    || message.type === 'log_download'
    || message.type === 'log_download_cancel'
    || message.type === 'log_erase'
}

function requiresReadyTarget(message: BoundaryClientMessage): boolean {
  return message.type !== 'release_control'
}

type EscBoundaryMessage = Extract<BoundaryClientMessage, { type: `esc_${string}` }>

function isEscClientMessage(message: BoundaryClientMessage): message is EscBoundaryMessage {
  return message.type.startsWith('esc_')
}

function messageRequestId(message: BoundaryClientMessage): string | undefined {
  return 'requestId' in message ? message.requestId : undefined
}

type SafetyExpectation = { epoch: number; authorityId: string }

function safetyExpectation(message: BoundaryClientMessage): SafetyExpectation | null {
  if (
    message.type === 'fs_delete'
    || message.type === 'log_erase'
    || message.type === 'esc_session_start'
    || message.type === 'reboot_vehicle'
  ) return {
    epoch: message.expectedSafetyEpoch,
    authorityId: message.expectedSafetyAuthorityId,
  }
  if (message.type === 'command') {
    const isArm = message.cmd === 'MAV_CMD_COMPONENT_ARM_DISARM'
      && (message.params[0] ?? 0) >= 0.5
    const isTakeoff = message.cmd === 'MAV_CMD_NAV_TAKEOFF'
    return isArm || isTakeoff
      ? {
          epoch: message.expectedSafetyEpoch ?? -1,
          authorityId: message.expectedSafetyAuthorityId ?? '',
        }
      : null
  }
  if (
    (message.type === 'motor_test' || message.type === 'motor_test_batch')
    && message.data.throttle > 0
  ) return {
    epoch: message.expectedSafetyEpoch ?? -1,
    authorityId: message.expectedSafetyAuthorityId ?? '',
  }
  return null
}

function isParameterOperationError(message: unknown): boolean {
  if (typeof message !== 'object' || message === null) return false
  const candidate = message as {
    type?: unknown
    data?: { operation?: unknown }
  }
  if (candidate.type !== 'operation_error') return false
  return candidate.data?.operation === 'param_request_list'
    || candidate.data?.operation === 'parameter_download'
    || candidate.data?.operation === 'param_sync'
}

function tokenMatches(candidate: string | undefined, expected: string | null): boolean {
  if (!candidate || !expected) return false
  const candidateBuffer = Buffer.from(candidate)
  const expectedBuffer = Buffer.from(expected)
  return candidateBuffer.length === expectedBuffer.length
    && timingSafeEqual(candidateBuffer, expectedBuffer)
}

function bearerToken(header: string | string[] | undefined): string | undefined {
  if (Array.isArray(header)) return undefined
  const match = header?.match(/^Bearer ([\x21-\x7e]+)$/)
  return match?.[1]
}

function wsToken(request: IncomingMessage): string | undefined {
  const authorization = bearerToken(request.headers.authorization)
  if (authorization) return authorization
  try {
    return new URL(request.url ?? '/', 'http://localhost').searchParams.get('token') ?? undefined
  } catch {
    return undefined
  }
}

function upgradeResponse(socket: Socket, status: number, reason: string): void {
  if (!socket.writable) {
    socket.destroy()
    return
  }
  const body = JSON.stringify({ success: false, error: reason })
  const label = status === 401
    ? 'Unauthorized'
    : status === 403
      ? 'Forbidden'
      : status === 503
        ? 'Service Unavailable'
        : 'Bad Request'
  socket.end(
    `HTTP/1.1 ${status} ${label}\r\n`
      + 'Connection: close\r\n'
      + 'Content-Type: application/json; charset=utf-8\r\n'
      + `Content-Length: ${Buffer.byteLength(body)}\r\n`
      + '\r\n'
      + body,
  )
}

function closeHttpServer(server: HttpServer): Promise<void> {
  if (!server.listening) return Promise.resolve()
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error)
      else resolve()
    })
    server.closeIdleConnections?.()
  })
}

function closeWebSocketServer(wss: WebSocketServer): Promise<void> {
  return new Promise((resolve) => {
    wss.close(() => resolve())
  })
}

export interface ShutdownResult {
  timedOut: boolean
}

export interface BackendRuntime {
  app: express.Express
  server: HttpServer
  wss: WebSocketServer
  config: ServerConfig
  services: BackendServices
  shutdown(reason?: string): Promise<ShutdownResult>
  addShutdownCleanup(cleanup: () => void): void
}

export function createApp(options: CreateAppOptions = {}): BackendRuntime {
  const config = options.config
    ? parseServerConfig({}, options.config)
    : parseServerConfig()
  const logger = options.logger ?? console
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? WS_HEARTBEAT_INTERVAL_MS
  const controllerLeaseMs = options.controllerLeaseMs ?? CONTROLLER_LEASE_MS
  const parameterSyncTimeoutMs = options.parameterSyncTimeoutMs ?? PARAM_SYNC_TIMEOUT_MS
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS
  const staticDir = options.staticDir ?? distPath

  const connManager = options.services?.connManager ?? new ConnectionManager()
  const mavlinkBridge = options.services?.mavlinkBridge
    ?? new MavlinkBridge(connManager as ConnectionManager)
  const services: BackendServices = { connManager, mavlinkBridge }

  const app = express()
  app.disable('x-powered-by')
  const server = createServer(app)
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: config.wsMaxPayload,
    perMessageDeflate: false,
  })

  const clientContexts = new Map<WebSocket, ClientContext>()
  const shutdownCleanups = new Set<() => void>()
  let controllerLease: ControllerLease | null = null
  // Monotonic server authority boundary. Human safety acknowledgements are
  // valid only for the exact epoch observed when they were completed.
  let safetyEpoch = 1
  const safetyAuthorityId = randomUUID()
  let lastTargetSafetyFingerprint = JSON.stringify([null, null, false, null])
  let lastConnectionSafetyFingerprint = JSON.stringify([
    connManager.transportOpen ?? connManager.status === 'connected',
    connManager.vehicleReady ?? false,
    connManager.rawSessionActive === true,
  ])
  // ESC session lease pin (ADR-004): while set, the lease belongs to the
  // session owner and cannot expire or be taken over.
  let escControllerPin: { clientId: string; sessionId: string } | null = null
  // Calibration session lease pin: same semantics as the ESC pin. The two
  // are mutually exclusive because ESC sessions and calibration sessions
  // refuse to start while the other is active.
  let calControllerPin: { clientId: string; sessionId: string } | null = null
  let parameterSync: ParamSyncState | null = null
  let parameterSyncTimer: ReturnType<typeof setTimeout> | null = null
  let nextParameterGeneration = 0
  let pendingParams: ParamData[] = []
  let paramBatchTimer: ReturnType<typeof setTimeout> | null = null
  let lastConnectionError: ConnectionErrorDetail | null = null
  let shuttingDown = false
  let shutdownPromise: Promise<ShutdownResult> | null = null
  const connectionInspectionRates = new Map<string, { count: number; resetAt: number }>()

  function limitConnectionInspection(request: Request, _response: Response, next: NextFunction): void {
    const now = Date.now()
    const key = request.socket.remoteAddress ?? 'unknown'
    let rate = connectionInspectionRates.get(key)
    if (!rate || rate.resetAt <= now) {
      rate = { count: 0, resetAt: now + HTTP_INSPECTION_RATE_WINDOW_MS }
      connectionInspectionRates.set(key, rate)
    }
    rate.count += 1
    if (rate.count > HTTP_INSPECTION_RATE_MAX) {
      next(new HttpBoundaryError(429, 'rate_limited', '连接扫描请求过于频繁'))
      return
    }

    if (connectionInspectionRates.size > HTTP_INSPECTION_RATE_MAX_KEYS) {
      for (const [candidateKey, candidate] of connectionInspectionRates) {
        if (candidate.resetAt <= now) connectionInspectionRates.delete(candidateKey)
      }
      while (connectionInspectionRates.size > HTTP_INSPECTION_RATE_MAX_KEYS) {
        const oldestKey = connectionInspectionRates.keys().next().value
        if (oldestKey === undefined) break
        connectionInspectionRates.delete(oldestKey)
      }
    }
    next()
  }

  function connectionMessage(): LocalServerMessage {
    const manager = connManager as ConnectionManagerBoundary
    const status = manager.status
    const transportOpen = manager.transportOpen ?? status === 'connected'
    const vehicleReady = manager.vehicleReady ?? transportOpen
    const managerError = manager.lastError
      ? normalizeConnectionError(manager.lastError)
      : lastConnectionError
    return {
      type: 'connection',
      data: {
        connected: transportOpen,
        status,
        transportOpen,
        vehicleReady,
        safetyEpoch,
        safetyAuthorityId,
        rawSessionActive: manager.rawSessionActive === true,
        ...(manager.config?.port ? { port: manager.config.port } : {}),
        ...(manager.config?.type ? { type: manager.config.type } : {}),
        ...(manager.config?.baudRate ? { baudRate: manager.config.baudRate } : {}),
        ...(status === 'reconnecting' && manager.reconnect
          ? { reconnect: manager.reconnect }
          : {}),
        ...(manager.reconnectTerminalReason
          ? { reconnectTerminalReason: manager.reconnectTerminalReason }
          : {}),
        ...(managerError ? { error: managerError } : {}),
      },
    }
  }

  function serializeMessage(data: WireMessage): string | null {
    try {
      return JSON.stringify(data)
    } catch (error) {
      logger.error('[WS] Unable to serialize server message:', error)
      return null
    }
  }

  function safeSendSerialized(ws: WebSocket, serialized: string): boolean {
    if (ws.readyState !== WebSocket.OPEN) return false
    if (ws.bufferedAmount >= MAX_BUFFERED_AMOUNT) {
      logger.warn(`[WS] Terminating slow client: bufferedAmount=${ws.bufferedAmount}`)
      ws.terminate()
      return false
    }

    try {
      ws.send(serialized, (error) => {
        if (!error) return
        logger.warn('[WS] Send failed:', error.message)
        ws.terminate()
      })
      return true
    } catch (error) {
      logger.warn('[WS] Send threw:', errorMessage(error))
      ws.terminate()
      return false
    }
  }

  function safeSend(ws: WebSocket, data: WireMessage): boolean {
    const serialized = serializeMessage(data)
    return serialized === null ? false : safeSendSerialized(ws, serialized)
  }

  function broadcast(data: WireMessage): void {
    const serialized = serializeMessage(data)
    if (serialized === null) return
    for (const client of wss.clients) safeSendSerialized(client, serialized)
  }

  function sendToClientId(clientId: string, data: WireMessage): void {
    for (const [client, context] of clientContexts) {
      if (context.id === clientId) {
        safeSend(client, data)
        return
      }
    }
  }

  function sendClientError(
    ws: WebSocket,
    code: string,
    message: string,
    requestId?: string,
    retryable = false,
    details?: Record<string, unknown>,
  ): void {
    safeSend(ws, {
      type: 'client_error',
      data: {
        code,
        message,
        ...(requestId ? { requestId } : {}),
        retryable,
        ...(details ? { details } : {}),
      },
    })
  }

  function controllerMessage(
    reason: Extract<LocalServerMessage, { type: 'controller' }>['data']['reason'],
  ): LocalServerMessage {
    return {
      type: 'controller',
      data: {
        clientId: controllerLease?.clientId ?? null,
        expiresAt: controllerLease?.expiresAt ?? null,
        safetyEpoch,
        safetyAuthorityId,
        reason,
      },
    }
  }

  function advanceSafetyEpoch(): void {
    safetyEpoch += 1
  }

  function broadcastSafetyBoundary(
    reason: Extract<LocalServerMessage, { type: 'controller' }>['data']['reason'] = 'safety_changed',
  ): void {
    advanceSafetyEpoch()
    broadcast(controllerMessage(reason))
  }

  function syncConnectionSafetyBoundary(): void {
    const fingerprint = JSON.stringify([
      connManager.transportOpen ?? connManager.status === 'connected',
      connManager.vehicleReady ?? false,
      connManager.rawSessionActive === true,
    ])
    if (fingerprint === lastConnectionSafetyFingerprint) return
    lastConnectionSafetyFingerprint = fingerprint
    broadcastSafetyBoundary()
  }

  function expireController(now = Date.now()): void {
    // While an ESC or calibration session pins the lease, it never expires
    // and stays with the session owner; it is released via the session
    // lifecycle.
    const pin = escControllerPin ?? calControllerPin
    if (pin) {
      if (controllerLease?.clientId === pin.clientId) {
        controllerLease.expiresAt = now + controllerLeaseMs
      }
      return
    }
    if (!controllerLease || controllerLease.expiresAt > now) return
    controllerLease = null
    broadcastSafetyBoundary('expired')
  }

  /**
   * Pin the controller lease to the ESC session owner. Called by the ESC
   * session manager on start/reclaim; while pinned no other client can take
   * or expire the lease (wired in the ESC service integration task).
   */
  function pinControllerToEscSession(ownerClientId: string, sessionId: string): void {
    escControllerPin = { clientId: ownerClientId, sessionId }
    const now = Date.now()
    if (!controllerLease || controllerLease.clientId !== ownerClientId) {
      controllerLease = { clientId: ownerClientId, expiresAt: now + controllerLeaseMs }
      broadcastSafetyBoundary('claimed')
    } else {
      controllerLease.expiresAt = now + controllerLeaseMs
    }
  }

  /** Drop the ESC pin when its session ends; normal expiry resumes. */
  function releaseEscSessionController(sessionId: string): void {
    if (escControllerPin?.sessionId !== sessionId) return
    escControllerPin = null
    expireController()
  }

  /** Pin the controller lease to the calibration session owner. */
  function pinControllerToCalibrationSession(ownerClientId: string, sessionId: string): void {
    calControllerPin = { clientId: ownerClientId, sessionId }
    const now = Date.now()
    if (!controllerLease || controllerLease.clientId !== ownerClientId) {
      controllerLease = { clientId: ownerClientId, expiresAt: now + controllerLeaseMs }
      broadcastSafetyBoundary('claimed')
    } else {
      controllerLease.expiresAt = now + controllerLeaseMs
    }
  }

  /** Drop the calibration pin when its session ends; normal expiry resumes. */
  function releaseCalibrationSessionController(sessionId: string): void {
    if (calControllerPin?.sessionId !== sessionId) return
    calControllerPin = null
    expireController()
  }

  function ensureController(ws: WebSocket, context: ClientContext, requestId?: string): boolean {
    const now = Date.now()
    expireController(now)
    if (escControllerPin && escControllerPin.clientId !== context.id) {
      sendClientError(
        ws,
        'controller_conflict',
        'ESC 会话所有者当前持有飞控控制权',
        requestId,
        true,
        { expiresAt: controllerLease?.expiresAt ?? null },
      )
      return false
    }
    if (calControllerPin && calControllerPin.clientId !== context.id) {
      sendClientError(
        ws,
        'controller_conflict',
        '校准会话所有者当前持有飞控控制权',
        requestId,
        true,
        { expiresAt: controllerLease?.expiresAt ?? null },
      )
      return false
    }
    if (!controllerLease) {
      controllerLease = { clientId: context.id, expiresAt: now + controllerLeaseMs }
      broadcastSafetyBoundary('claimed')
      return true
    }
    if (controllerLease.clientId !== context.id) {
      sendClientError(
        ws,
        'controller_conflict',
        '另一个客户端当前持有飞控控制权',
        requestId,
        true,
        { expiresAt: controllerLease.expiresAt },
      )
      return false
    }
    controllerLease.expiresAt = now + controllerLeaseMs
    return true
  }

  /**
   * Evaluate expiry before comparison so an acknowledgement from a lease that
   * has just expired cannot be reused by the automatic claim path below.
   */
  function ensureCurrentSafetyEpoch(
    ws: WebSocket,
    context: ClientContext,
    message: BoundaryClientMessage,
    requestId?: string,
  ): boolean {
    const expected = safetyExpectation(message)
    if (expected === null) return true
    expireController()
    if (expected.authorityId === safetyAuthorityId && expected.epoch === safetyEpoch) return true
    sendClientError(
      ws,
      'stale_safety_epoch',
      '安全确认已因目标、连接状态或控制权变化而失效，请重新确认',
      requestId,
      false,
      {
        expectedSafetyEpoch: expected.epoch,
        currentSafetyEpoch: safetyEpoch,
        expectedSafetyAuthorityId: expected.authorityId,
        currentSafetyAuthorityId: safetyAuthorityId,
        clientId: context.id,
      },
    )
    return false
  }

  function ensureControllerForMessage(
    ws: WebSocket,
    context: ClientContext,
    message: BoundaryClientMessage,
    requestId?: string,
  ): boolean {
    if (!ensureCurrentSafetyEpoch(ws, context, message, requestId)) return false
    const expected = safetyExpectation(message)
    const beforeEpoch = safetyEpoch
    const beforeOwner = controllerLease?.clientId ?? null
    if (!ensureController(ws, context, requestId)) return false
    if (expected === null) return true
    const unchanged = safetyEpoch === beforeEpoch
    const atomicInitialClaim = beforeOwner === null
      && controllerLease?.clientId === context.id
      && safetyEpoch === beforeEpoch + 1
    if (
      expected.authorityId === safetyAuthorityId
      && expected.epoch === beforeEpoch
      && (unchanged || atomicInitialClaim)
    ) return true
    sendClientError(
      ws,
      'stale_safety_epoch',
      '安全确认在控制权检查期间失效，请重新确认',
      requestId,
      false,
      { expectedSafetyEpoch: expected.epoch, currentSafetyEpoch: safetyEpoch },
    )
    return false
  }

  function releaseController(context: ClientContext, reason: 'released' | 'disconnected'): boolean {
    expireController()
    if (controllerLease?.clientId !== context.id) return false
    // The lease of an ESC/calibration session owner survives WS disconnects
    // so an orphaned session can be reclaimed; the session lifecycle
    // releases it.
    if (escControllerPin?.clientId === context.id || calControllerPin?.clientId === context.id) {
      if (reason === 'disconnected') broadcastSafetyBoundary('disconnected')
      return false
    }
    controllerLease = null
    broadcastSafetyBoundary(reason)
    return true
  }

  function requireRestConnectionControl(request: Request): void {
    expireController()
    if (!controllerLease) return

    const owner = [...clientContexts.values()]
      .find((context) => context.id === controllerLease?.clientId)
    const candidate = typeof request.headers['x-skylab-control-token'] === 'string'
      ? request.headers['x-skylab-control-token']
      : undefined
    if (!owner || !tokenMatches(candidate, owner.restControlToken)) {
      throw new HttpBoundaryError(
        409,
        'controller_conflict',
        '当前连接操作需要控制者授权',
      )
    }
  }

  function consumeRateLimit(context: ClientContext, cost: number): boolean {
    const now = performance.now()
    const elapsedSeconds = Math.max(0, now - context.lastRefill) / 1000
    context.tokens = Math.min(
      RATE_LIMIT_CAPACITY,
      context.tokens + elapsedSeconds * RATE_LIMIT_REFILL_PER_SECOND,
    )
    context.lastRefill = now
    if (context.tokens < cost) return false
    context.tokens -= cost
    context.rateLimitViolations = 0
    return true
  }

  function clearParamBatch(): void {
    pendingParams = []
    if (paramBatchTimer) clearTimeout(paramBatchTimer)
    paramBatchTimer = null
  }

  function cancelBridgeParameterDownload(reason: string): void {
    try {
      mavlinkBridge.cancelParameterDownload?.()
    } catch (error) {
      logger.warn(`[MAVLink] Parameter download cancellation failed (${reason}):`, error)
    }
  }

  function flushParamBatch(): void {
    if (paramBatchTimer) {
      clearTimeout(paramBatchTimer)
      paramBatchTimer = null
    }
    if (pendingParams.length === 0) return
    const batch = pendingParams
    pendingParams = []
    broadcast({
      type: 'param_batch',
      data: batch,
      ...(parameterSync ? { generation: parameterSync.generation } : {}),
    })
  }

  function finishParameterSync(
    status: 'complete' | 'failed' | 'cancelled',
    reason?: string,
  ): void {
    if (!parameterSync) return
    if (parameterSyncTimer) {
      clearTimeout(parameterSyncTimer)
      parameterSyncTimer = null
    }
    const completed = parameterSync
    broadcast({
      type: 'param_sync',
      data: {
        generation: completed.generation,
        status,
        ownerClientId: completed.ownerClientId,
        ...(reason ? { reason } : {}),
      },
    })
    parameterSync = null
  }

  function beginParameterSync(ws: WebSocket, context: ClientContext, requestId?: string): boolean {
    const now = Date.now()
    if (parameterSync && now - parameterSync.startedAt < parameterSyncTimeoutMs) {
      sendClientError(
        ws,
        'param_sync_conflict',
        '参数下载已在进行中',
        requestId,
        true,
        {
          generation: parameterSync.generation,
          ownerClientId: parameterSync.ownerClientId,
        },
      )
      return false
    }
    if (parameterSync) {
      cancelBridgeParameterDownload('expired')
      finishParameterSync('cancelled', 'expired')
    }
    if (!ensureController(ws, context, requestId)) return false

    clearParamBatch()
    parameterSync = {
      generation: ++nextParameterGeneration,
      ownerClientId: context.id,
      startedAt: now,
    }
    const generation = parameterSync.generation
    parameterSyncTimer = setTimeout(() => {
      if (parameterSync?.generation !== generation) return
      cancelBridgeParameterDownload('timeout')
      clearParamBatch()
      finishParameterSync('cancelled', 'timeout')
    }, parameterSyncTimeoutMs)
    parameterSyncTimer.unref?.()
    broadcast({
      type: 'param_sync',
      data: {
        generation: parameterSync.generation,
        status: 'started',
        ownerClientId: context.id,
      },
    })
    return true
  }

  /**
   * Server-initiated one-shot parameter refresh after a successful calibration.
   * Runs as the session owner and reuses the exact param-sync pipeline used by
   * a client param_request_list, so batching, generation and timeout behave
   * identically. No-op when the owner has disconnected or a sync is active.
   */
  function beginPostCalibrationParameterSync(ownerClientId: string | null): void {
    if (!ownerClientId) return
    if (parameterSync) return
    const entry = [...clientContexts.entries()].find(([, ctx]) => ctx.id === ownerClientId)
    if (!entry) {
      logger.log('[Calibration] post-cal parameter refresh skipped: owner disconnected')
      return
    }
    const [ws, context] = entry
    if (!beginParameterSync(ws, context)) return
    try {
      mavlinkBridge.handleClientMessage({ type: 'param_request_list' } as ClientMessage)
      recordCurrentParamRunId()
    } catch (error) {
      clearParamBatch()
      finishParameterSync('failed', 'bridge_exception')
      logger.error('[Calibration] post-cal parameter refresh failed:', error)
    }
  }

  /** Attach the bridge's current download run id to the active sync, if any. */
  function recordCurrentParamRunId(): void {
    if (parameterSync) parameterSync.runId = mavlinkBridge.currentParamRunId
  }

  const messageRateLimiter = new MessageRateLimiter()

  const onBridgeMessage = (rawMessage: unknown): void => {
    if (typeof rawMessage !== 'object' || rawMessage === null) {
      logger.warn('[MAVLink] Ignoring non-object bridge message')
      return
    }
    const message = rawMessage as ServerMessage & {
      type: string
      data?: unknown
      generation?: number
      paramRunId?: number
    }

    if (message.type === 'message_rates') {
      messageRateLimiter.setRates(message.data)
    } else if (!messageRateLimiter.shouldForward(message)) {
      return
    }

    if (message.type === 'target') {
      const targetMessage = message as Extract<ServerMessage, { type: 'target' }>
      const fingerprint = JSON.stringify([
        targetMessage.data.systemId,
        targetMessage.data.componentId,
        targetMessage.data.ready,
        targetMessage.data.identity,
      ])
      if (fingerprint !== lastTargetSafetyFingerprint) {
        lastTargetSafetyFingerprint = fingerprint
        broadcastSafetyBoundary()
      }
      broadcast({
        ...targetMessage,
        data: { ...targetMessage.data, safetyEpoch, safetyAuthorityId },
      })
      return
    }

    const runId = message.paramRunId
    const belongsToParameterRun = message.type === 'param'
      || message.type === 'param_complete'
      || message.type === 'param_failed'
      || message.type === 'param_retry'
      || isParameterOperationError(message)
    if (belongsToParameterRun && runId !== undefined) {
      if (!parameterSync) {
        logger.warn(`[MAVLink] Dropping parameter event after sync ended (run ${runId})`)
        return
      }
      if (parameterSync.runId !== undefined && runId !== parameterSync.runId) {
        logger.warn(`[MAVLink] Dropping stale parameter event (run ${runId})`)
        return
      }
    }

    if (message.type === 'param') {
      const data = message.data as ParamData
      if (runId === undefined) {
        broadcast({ type: 'param', data })
        return
      }
      pendingParams.push(data)
      if (pendingParams.length >= MAX_PARAM_BATCH_ITEMS) {
        flushParamBatch()
      } else if (!paramBatchTimer) {
        paramBatchTimer = setTimeout(flushParamBatch, PARAM_BATCH_INTERVAL_MS)
        paramBatchTimer.unref?.()
      }
      return
    }

    if (
      message.type === 'param_complete'
      || message.type === 'param_failed'
      || message.type === 'param_retry'
    ) {
      flushParamBatch()
    }

    const carriesParameterGeneration = message.type === 'param_complete'
      || message.type === 'param_failed'
      || message.type === 'param_retry'
      || isParameterOperationError(message)
    const generation = carriesParameterGeneration
      ? parameterSync?.generation
      : undefined
    const { paramRunId: _strippedRunId, ...messageFields } =
      message as unknown as Record<string, unknown>
    const wireMessage = {
      ...messageFields,
      ...(generation === undefined ? {} : { generation }),
    } as ServerMessage
    broadcast(wireMessage)

    if (message.type === 'param_complete') finishParameterSync('complete')
    else if (message.type === 'param_failed') finishParameterSync('failed')
    else if (isParameterOperationError(message)) {
      clearParamBatch()
      finishParameterSync('failed', 'bridge_rejected')
    }
  }

  const onStatusChange = (status: ConnectionStatus): void => {
    if (status !== 'connected') messageRateLimiter.reset()
    escService.handleMavlinkStatus(status)
    if (status === 'connecting' || status === 'connected') {
      lastConnectionError = null
    }
    if (status !== 'connected') {
      // Terminate first so the session releases its lease pin before the
      // generic lease reset below.
      calibrationManager.handleLinkDown()
      if (controllerLease) {
        controllerLease = null
        broadcastSafetyBoundary('connection_changed')
      }
      if (parameterSync) {
        cancelBridgeParameterDownload(`connection_${status}`)
        finishParameterSync('cancelled', `connection_${status}`)
      }
      clearParamBatch()
    }
    syncConnectionSafetyBoundary()
    broadcast(connectionMessage())
  }

  const onConnectionStateDetail = (): void => {
    syncConnectionSafetyBoundary()
    broadcast(connectionMessage())
  }

  const onVehicleReadyChange = (ready: boolean): void => {
    // A deliberate FC reboot may leave USB open, so statusChange never fires.
    // Still cancel the old parameter generation: it belongs to the pre-reboot
    // process and would otherwise block the automatic refresh after recovery.
    // Raw ESC passthrough intentionally lowers readiness without losing its
    // vehicle session, so preserve its isolated state.
    if (!ready && connManager.rawSessionActive !== true && parameterSync) {
      cancelBridgeParameterDownload('vehicle_not_ready')
      clearParamBatch()
      finishParameterSync('cancelled', 'vehicle_not_ready')
    }
    syncConnectionSafetyBoundary()
    broadcast(connectionMessage())
  }

  const onConnectionError = (error: unknown): void => {
    lastConnectionError = normalizeConnectionError(error)
    logger.error('[Connection] runtime error:', lastConnectionError.message)
    broadcast(connectionMessage())
  }

  const onErrorDetailChange = (detail: ConnectionErrorDetail | null): void => {
    lastConnectionError = detail ? normalizeConnectionError(detail) : null
    broadcast(connectionMessage())
  }

  const escService = new EscService({
    connManager: connManager as ConnectionManager,
    bridge: mavlinkBridge as unknown as MavlinkBridge,
    emit: (message) => broadcast(message),
    emitToClient: (clientId, message) => sendToClientId(clientId, message),
    getVehicleIdentity: () => mavlinkBridge.vehicleIdentity ?? null,
    getParameterValue: (id) => mavlinkBridge.getParameterValue?.(id) ?? null,
    pinController: pinControllerToEscSession,
    releaseController: releaseEscSessionController,
    isLinkBusy: () => (parameterSync ? 'parameter_sync' : null),
    logger,
  })

  const calibrationManager = new CalibrationSessionManager({
    createSession: (request) => {
      // The real bridge gains createCalibrationSession in the bridge wiring
      // task; injected fakes may omit it, hence the boundary-typed access.
      const factory = (mavlinkBridge as MavlinkBridgeBoundary).createCalibrationSession
      if (!factory) {
        sendToClientId(request.ownerClientId, {
          type: 'operation_error',
          data: {
            requestId: request.requestId,
            operation: 'start_calibration',
            code: 'unsupported_operation',
            message: '当前后端不支持校准会话',
            retryable: false,
          },
        })
        return null
      }
      return factory.call(mavlinkBridge, request)
    },
    broadcast: (message) => broadcast(message),
    emitToClient: (clientId, message) => sendToClientId(clientId, message),
    pinController: pinControllerToCalibrationSession,
    releaseController: releaseCalibrationSessionController,
    onTerminalSuccess: (_sessionId, ownerClientId) =>
      beginPostCalibrationParameterSync(ownerClientId),
    isLinkBusy: () => (
      parameterSync
        ? 'parameter_sync'
        : escService.blocksMavlinkMutations()
          ? 'esc_session'
          : null
    ),
    logger,
  })

  mavlinkBridge.on('message', onBridgeMessage)
  connManager.on('statusChange', onStatusChange)
  connManager.on('connectionError', onConnectionError)
  connManager.on('transportChange', onConnectionStateDetail)
  connManager.on('vehicleReadyChange', onVehicleReadyChange)
  connManager.on('rawSessionChange', onConnectionStateDetail)
  connManager.on('errorDetailChange', onErrorDetailChange)

  app.use((request, response, next) => {
    response.set({
      'Content-Security-Policy': "frame-ancestors 'none'; base-uri 'self'; object-src 'none'",
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
    })
    if (request.path === '/api' || request.path.startsWith('/api/')) {
      response.set('Cache-Control', 'no-store')
    }
    next()
  })

  // Non-browser clients (curl, scripts) do not send an Origin header. A remote
  // request that carries a valid access token is therefore trusted even
  // without an Origin, so token-authenticated automation is not locked out by
  // the browser-oriented Origin guard below.
  const hasValidRemoteToken = (request: Request | IncomingMessage): boolean => {
    if (!config.remoteEnabled) return false
    const headers = 'headers' in request ? request.headers : undefined
    const candidate = bearerToken(headers?.authorization)
      ?? (typeof headers?.['x-skylab-token'] === 'string'
        ? headers['x-skylab-token'] as string
        : undefined)
    return tokenMatches(candidate, config.authToken)
  }

  app.use((request, _response, next) => {
    const origin = request.get('origin')
    if (origin) {
      if (!isAllowedOrigin(origin, config)) {
        next(new HttpBoundaryError(403, 'origin_forbidden', '请求 Origin 不在允许列表中'))
        return
      }
    } else if (!isLoopbackAddress(request.socket.remoteAddress) && !hasValidRemoteToken(request)) {
      next(new HttpBoundaryError(403, 'origin_required', '非本机请求必须提供允许的 Origin 或有效访问令牌'))
      return
    }
    next()
  })

  app.use(cors({
    origin(origin, callback) {
      callback(null, origin ? isAllowedOrigin(origin, config) : false)
    },
    methods: ['GET', 'HEAD', 'POST', 'OPTIONS'],
    allowedHeaders: [
      'Authorization',
      'Content-Type',
      'X-SkyLab-Token',
      'X-SkyLab-Control-Token',
    ],
    maxAge: 600,
  }))

  app.use('/api', (request, _response, next) => {
    if (!config.remoteEnabled) {
      next()
      return
    }
    const candidate = bearerToken(request.headers.authorization)
      ?? (typeof request.headers['x-skylab-token'] === 'string'
        ? request.headers['x-skylab-token']
        : undefined)
    if (!tokenMatches(candidate, config.authToken)) {
      next(new HttpBoundaryError(401, 'unauthorized', '缺少或无效的访问令牌'))
      return
    }
    next()
  })

  app.use(express.json({ limit: JSON_BODY_LIMIT, strict: true }))

  app.get('/api/connections/scan', limitConnectionInspection, async (_request, response, next) => {
    try {
      const ports = await connManager.scanPorts()
      response.json({ success: true, data: ports })
    } catch (error) {
      next(error)
    }
  })

  app.get('/api/connections/debug-ports', limitConnectionInspection, async (_request, response, next) => {
    try {
      if (!config.allowDevOrigin) {
        throw new HttpBoundaryError(404, 'debug_disabled', '调试端点未启用')
      }
      const { SerialPort } = await import('serialport')
      const ports = await SerialPort.list()
      response.json({
        success: true,
        data: ports.map((port) => ({
          path: port.path,
          manufacturer: port.manufacturer,
          vendorId: port.vendorId,
          productId: port.productId,
          pnpId: port.pnpId,
        })),
      })
    } catch (error) {
      next(error)
    }
  })

  app.post('/api/connections/connect', async (request, response, next) => {
    try {
      if (shuttingDown) throw new HttpBoundaryError(503, 'shutting_down', '服务正在关闭')
      requireRestConnectionControl(request)
      const connectionConfig = parseConnectionConfig(request.body)
      logger.log('[API] connect request:', {
        type: connectionConfig.type,
        port: connectionConfig.port,
        baudRate: connectionConfig.baudRate,
      })
      await connManager.connect(connectionConfig)
      response.json({ success: true })
    } catch (error) {
      next(error)
    }
  })

  app.post('/api/connections/disconnect', async (request, response, next) => {
    try {
      if (shuttingDown) throw new HttpBoundaryError(503, 'shutting_down', '服务正在关闭')
      requireRestConnectionControl(request)
      await connManager.disconnect()
      response.json({ success: true })
    } catch (error) {
      next(error)
    }
  })

  app.get('/api/connections/status', (_request, response) => {
    response.json({
      success: true,
      data: connectionMessage().data,
    })
  })

  app.get('/api/logs/downloads/:downloadId', (request, response, next) => {
    const { downloadId } = request.params
    // Download ids are 8 random bytes hex-encoded by the FTP client; anything
    // else (including path metacharacters) is rejected before touching disk.
    const download = /^[0-9a-f]{16}$/.test(downloadId)
      ? mavlinkBridge.getFtpDownload?.(downloadId) ?? null
      : null
    if (!download) {
      response.status(404).json({
        success: false,
        error: { code: 'download_not_found', message: '下载文件不存在或已过期' },
      })
      return
    }
    response.download(download.filePath, download.fileName, (error) => {
      handleDownloadError(error, response, next)
    })
  })

  app.use('/api', (_request, response) => {
    response.status(404).json({
      success: false,
      error: { code: 'api_not_found', message: 'API 路径不存在' },
    })
  })

  app.use(express.static(staticDir))

  app.get('/{*splat}', (request, response, next) => {
    if (!request.accepts('html')) {
      response.status(404).json({
        success: false,
        error: { code: 'not_found', message: '资源不存在' },
      })
      return
    }
    response.sendFile(path.join(staticDir, 'index.html'), (error) => {
      if (error) next(error)
    })
  })

  app.use((
    error: unknown,
    _request: Request,
    response: Response,
    next: NextFunction,
  ) => {
    if (response.headersSent) {
      next(error)
      return
    }
    if (error instanceof HttpBoundaryError) {
      response.status(error.status).json({
        success: false,
        error: { code: error.code, message: error.message },
      })
      return
    }
    if (error instanceof InputValidationError) {
      response.status(400).json({
        success: false,
        error: {
          code: error.code,
          message: error.message,
          ...(error.path ? { path: error.path } : {}),
        },
      })
      return
    }
    const bodyError = error as {
      type?: string
      status?: number
      body?: unknown
    }
    if (bodyError?.type === 'entity.too.large') {
      response.status(413).json({
        success: false,
        error: { code: 'payload_too_large', message: 'JSON 请求体过大' },
      })
      return
    }
    if (error instanceof SyntaxError && 'body' in bodyError) {
      response.status(400).json({
        success: false,
        error: { code: 'invalid_json', message: 'JSON 请求体格式无效' },
      })
      return
    }

    const detail = normalizeConnectionError(error)
    logger.error('[API] request failed:', detail.message)
    const status = Number.isInteger(bodyError?.status)
      && bodyError.status! >= 400
      && bodyError.status! <= 599
      ? bodyError.status!
      : 500
    response.status(status).json({
      success: false,
      error: {
        code: config.remoteEnabled ? 'internal_error' : (detail.code ?? 'internal_error'),
        message: config.remoteEnabled
          ? (status >= 500 ? '服务器内部错误' : '请求处理失败')
          : (detail.message || '服务器内部错误'),
        retryable: isRetryableConnectionError(detail),
      },
    })
  })

  function handleClientMessage(
    ws: WebSocket,
    context: ClientContext,
    raw: RawData,
    isBinary: boolean,
  ): void {
    if (isBinary) {
      sendClientError(ws, 'binary_not_supported', '仅支持 UTF-8 JSON 文本消息')
      ws.close(1003, 'binary messages are not supported')
      return
    }
    if (!consumeRateLimit(context, 1)) {
      context.rateLimitViolations += 1
      sendClientError(ws, 'rate_limited', '消息发送过快', undefined, true)
      if (context.rateLimitViolations >= MAX_RATE_LIMIT_VIOLATIONS) {
        ws.terminate()
      }
      return
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw.toString())
    } catch {
      sendClientError(ws, 'invalid_json', '消息不是有效的 JSON')
      return
    }

    let message: BoundaryClientMessage
    try {
      message = parseClientMessage(parsed)
    } catch (error) {
      if (error instanceof InputValidationError) {
        const rawRequestId = typeof parsed === 'object'
          && parsed !== null
          && typeof (parsed as { requestId?: unknown }).requestId === 'string'
          ? (parsed as { requestId: string }).requestId.slice(0, 64)
          : undefined
        sendClientError(ws, error.code, error.message, rawRequestId, false, {
          ...(error.path ? { path: error.path } : {}),
        })
        return
      }
      logger.error('[WS] Message validation failed:', error)
      sendClientError(ws, 'invalid_message', '消息校验失败')
      return
    }

    const requestId = messageRequestId(message)
    if (message.type === 'release_control') {
      if (escService.blocksControllerRelease()) {
        sendClientError(ws, 'esc_session_active', 'ESC 会话进行中，暂不能释放控制权', requestId)
        return
      }
      if (calibrationManager.blocksControllerRelease()) {
        sendClientError(ws, 'calibration_session_active', '校准会话进行中，暂不能释放控制权', requestId)
        return
      }
      if (!releaseController(context, 'released')) {
        sendClientError(ws, 'not_controller', '当前客户端未持有控制权', requestId)
      }
      return
    }

    // A persisted safety acknowledgement is checked before any readiness,
    // capability, session, or automatic-claim gate. This makes an expired
    // lease/target boundary observable and guarantees that a stale request
    // cannot acquire or renew controller authority as a side effect.
    if (
      safetyExpectation(message) !== null
      && !ensureCurrentSafetyEpoch(ws, context, message, requestId)
    ) return

    // ESC messages are routed to the ESC service before the generic
    // ready-target gate: direct-mode sessions have no MAVLink target, and
    // subsequent commands are governed by the session's own ownership state.
    if (isEscClientMessage(message)) {
      if (message.type === 'esc_session_start' && calibrationManager.blocksMavlinkMutations()) {
        sendClientError(ws, 'calibration_session_active', '校准会话进行中，暂不能启动 ESC 会话', requestId, true)
        return
      }
      if (message.type === 'esc_session_start' && EscService.startRequiresReadyTarget(message)) {
        if (
          connManager.status !== 'connected'
          || connManager.transportOpen === false
          || connManager.vehicleReady === false
        ) {
          sendClientError(ws, 'target_not_ready', '飞控传输或已选目标尚未就绪', requestId, true)
          return
        }
      }
      // Reclaim transfers ownership to a new client, so it cannot require the
      // lease (which is pinned to the disconnected owner). Every other ESC
      // command requires the caller to hold the controller lease.
      if (message.type !== 'esc_session_reclaim' && !ensureControllerForMessage(ws, context, message, requestId)) {
        return
      }
      void escService.handleClientMessage(context.id, message)
      return
    }

    // Any ESC session isolates flight-control mutations; refuse operations that
    // would collide with it (motor test, param writes, FTP, etc.).
    if (escService.blocksMavlinkMutations() && isMutatingMessage(message)) {
      sendClientError(ws, 'esc_session_active', 'ESC 直通会话进行中，暂不能执行该操作', requestId, true)
      return
    }

    // An active calibration session isolates every other MAVLink mutation.
    // calibration_action targets the session itself and start_calibration is
    // deduplicated by the manager; the only generic passthrough is an
    // emergency disarm and a controller-owned vehicle reboot. Both also mark
    // the calibration as interrupted so no stale session survives the exit.
    if (
      calibrationManager.blocksMavlinkMutations()
      && isMutatingMessage(message)
      && message.type !== 'calibration_action'
      && message.type !== 'start_calibration'
    ) {
      const emergencyDisarm = message.type === 'command'
        && message.cmd === 'MAV_CMD_COMPONENT_ARM_DISARM'
        && (message.params[0] ?? 0) < 0.5
      const vehicleReboot = message.type === 'reboot_vehicle'
      if (!emergencyDisarm && !vehicleReboot) {
        sendClientError(ws, 'calibration_session_active', '校准会话进行中，暂不能执行该操作', requestId, true)
        return
      }
      if (emergencyDisarm) calibrationManager.notifyEmergencyDisarm()
    }

    if (
      requiresReadyTarget(message)
      && (
        connManager.status !== 'connected'
        || connManager.transportOpen === false
        || connManager.vehicleReady === false
      )
    ) {
      sendClientError(
        ws,
        'target_not_ready',
        '飞控传输或已选目标尚未就绪',
        requestId,
        true,
      )
      return
    }

    // Ownership transfer entry point: validated token replaces the lease
    // gate, mirroring esc_session_reclaim.
    if (message.type === 'calibration_reclaim') {
      calibrationManager.reclaim(context.id, message.data, message.requestId)
      return
    }

    if (message.type === 'param_request_list') {
      // Report an in-flight parameter generation before controller ownership:
      // observers need the more actionable generation conflict and must not be
      // able to extend or steal a lease while a download is active.
      if (!beginParameterSync(ws, context, requestId)) return
    } else if (isMutatingMessage(message) && !ensureControllerForMessage(ws, context, message, requestId)) {
      return
    }

    // Calibration session messages route to the manager, never the bridge.
    if (message.type === 'start_calibration') {
      // A successful calibration starts a best-effort parameter refresh. A
      // deliberate next calibration from the same controller takes priority;
      // otherwise the refresh rejects the new request and leaves the previous
      // result on screen, which looks like the old calibration restarted.
      if (parameterSync?.ownerClientId === context.id) {
        cancelBridgeParameterDownload('superseded_by_calibration')
        clearParamBatch()
        finishParameterSync('cancelled', 'superseded_by_calibration')
      }
      calibrationManager.requestStart(context.id, message)
      return
    }
    if (message.type === 'calibration_action') {
      calibrationManager.handleAction(context.id, message)
      return
    }

    try {
      const bridgeResult = mavlinkBridge.handleClientMessage(message as ClientMessage)
      if (message.type === 'reboot_vehicle' && bridgeResult.vehicleRebootQueued) {
        connManager.expectVehicleReboot?.()
        calibrationManager.notifyVehicleReboot()
      }
      // Record which bridge download run belongs to this generation. If the
      // bridge rejected the request synchronously the sync is already
      // finished (parameterSync === null) and nothing is recorded.
      if (message.type === 'param_request_list' && parameterSync) {
        parameterSync.runId = mavlinkBridge.currentParamRunId
      }
    } catch (error) {
      if (message.type === 'param_request_list') {
        clearParamBatch()
        finishParameterSync('failed', 'bridge_exception')
      }
      logger.error('[WS] Client message handling failed:', error)
      sendClientError(ws, 'operation_failed', errorMessage(error), requestId, false)
    }
  }

  wss.on('connection', (ws, request) => {
    const context: ClientContext = {
      id: randomUUID(),
      restControlToken: randomUUID(),
      isAlive: true,
      tokens: RATE_LIMIT_CAPACITY,
      lastRefill: performance.now(),
      rateLimitViolations: 0,
    }
    clientContexts.set(ws, context)
    logger.log(`[WS] Client connected (${context.id})`)

    ws.on('error', (error) => {
      logger.warn(`[WS] Client error (${context.id}):`, error.message)
    })
    ws.on('pong', () => {
      context.isAlive = true
    })
    ws.on('message', (raw, isBinary) => {
      handleClientMessage(ws, context, raw, isBinary)
    })
    ws.on('close', () => {
      clientContexts.delete(ws)
      escService.handleClientDisconnected(context.id)
      calibrationManager.handleClientDisconnected(context.id)
      releaseController(context, 'disconnected')
      if (parameterSync?.ownerClientId === context.id) {
        cancelBridgeParameterDownload('owner_disconnected')
        clearParamBatch()
        finishParameterSync('cancelled', 'owner_disconnected')
      }
      logger.log(`[WS] Client disconnected (${context.id})`)
    })

    safeSend(ws, {
      type: 'hello',
      data: {
        protocolVersion: PROTOCOL_VERSION,
        clientId: context.id,
        restControlToken: context.restControlToken,
        capabilities: [
          'runtime-validation',
          'controller-lease',
          'safety-epoch',
          'parameter-generation',
          'connection-readiness',
          'structured-errors',
          'rest-control-token',
          'esc-configurator',
          'calibration-session',
        ],
        maxPayload: config.wsMaxPayload,
        controllerLeaseMs,
        safetyEpoch,
        safetyAuthorityId,
      },
    })
    safeSend(ws, connectionMessage())
    safeSend(ws, controllerMessage('snapshot'))
    // Replay one-shot state for late-joining or reconnected clients.
    const versionSnapshot = mavlinkBridge.getAutopilotVersionMessage?.() ?? null
    if (versionSnapshot) safeSend(ws, versionSnapshot)
    const messageRatesSnapshot = mavlinkBridge.getMessageRatesMessage?.() ?? null
    if (messageRatesSnapshot) safeSend(ws, messageRatesSnapshot)
    safeSend(ws, { type: 'esc_session', data: escService.snapshot() })
    // Replay the active or recently finished calibration session so page
    // remounts and late joiners can render the wizard state.
    calibrationManager.replayTo((message) => safeSend(ws, message))
    if (parameterSync) {
      safeSend(ws, {
        type: 'param_sync',
        data: {
          generation: parameterSync.generation,
          status: 'started',
          ownerClientId: parameterSync.ownerClientId,
        },
      })
    }

    // Access only non-sensitive request metadata. Never log the URL because
    // remote-mode browser clients can authenticate with ?token=.
    void request
  })

  wss.on('error', (error) => {
    logger.error('[WS] Server error:', error)
  })

  const onUpgrade = (request: IncomingMessage, socket: Socket, head: Buffer): void => {
    if (shuttingDown) {
      upgradeResponse(socket, 503, '服务正在关闭')
      return
    }

    let pathname: string
    try {
      pathname = new URL(request.url ?? '/', 'http://localhost').pathname
    } catch {
      upgradeResponse(socket, 400, '无效的 WebSocket URL')
      return
    }
    if (pathname !== '/ws') {
      upgradeResponse(socket, 400, 'WebSocket 路径不存在')
      return
    }

    const origin = request.headers.origin
    if (origin) {
      if (!isAllowedOrigin(origin, config)) {
        upgradeResponse(socket, 403, 'Origin 不在允许列表中')
        return
      }
    } else if (!isLoopbackAddress(request.socket.remoteAddress)) {
      // Mirror the HTTP boundary: non-browser WS clients carry no Origin but
      // may authenticate with the remote token (verified again right below).
      if (!(config.remoteEnabled && tokenMatches(wsToken(request), config.authToken))) {
        upgradeResponse(socket, 403, '非本机 WebSocket 请求必须提供 Origin 或有效访问令牌')
        return
      }
    }

    if (config.remoteEnabled && !tokenMatches(wsToken(request), config.authToken)) {
      upgradeResponse(socket, 401, '缺少或无效的访问令牌')
      return
    }
    if (wss.clients.size >= config.wsMaxClients) {
      upgradeResponse(socket, 503, 'WebSocket 客户端数量已达上限')
      return
    }

    try {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request)
      })
    } catch (error) {
      logger.warn('[WS] Upgrade failed:', errorMessage(error))
      socket.destroy()
    }
  }

  server.on('upgrade', onUpgrade)
  server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') {
      logger.error(`[Server] ${config.host}:${config.port} 已被占用`)
    } else {
      logger.error('[Server] HTTP server error:', error)
    }
  })

  const heartbeatTimer = setInterval(() => {
    expireController()
    for (const [ws, context] of clientContexts) {
      if (!context.isAlive) {
        logger.warn(`[WS] Terminating unresponsive client (${context.id})`)
        ws.terminate()
        continue
      }
      context.isAlive = false
      try {
        ws.ping()
      } catch (error) {
        logger.warn(`[WS] Ping failed (${context.id}):`, errorMessage(error))
        ws.terminate()
      }
    }
  }, heartbeatIntervalMs)
  heartbeatTimer.unref?.()

  function addShutdownCleanup(cleanup: () => void): void {
    shutdownCleanups.add(cleanup)
  }

  async function shutdown(reason = 'requested'): Promise<ShutdownResult> {
    if (shutdownPromise) return shutdownPromise
    shuttingDown = true
    shutdownPromise = (async () => {
      logger.log(`[Server] Shutting down (${reason})`)
      clearInterval(heartbeatTimer)
      cancelBridgeParameterDownload('server_shutdown')
      clearParamBatch()
      finishParameterSync('cancelled', 'server_shutdown')
      controllerLease = null
      server.off('upgrade', onUpgrade)

      const closeServerPromise = closeHttpServer(server)
      for (const client of wss.clients) client.terminate()
      const closeWsPromise = closeWebSocketServer(wss)

      const cleanupWork = Promise.allSettled([
        Promise.resolve().then(() => calibrationManager.destroy()).catch((error) => {
          logger.error('[Server] Calibration manager cleanup failed:', error)
        }),
        Promise.resolve().then(() => escService.destroy()).catch((error) => {
          logger.error('[Server] ESC service cleanup failed:', error)
        }),
        Promise.resolve().then(() => mavlinkBridge.destroy()).catch((error) => {
          logger.error('[Server] MAVLink bridge cleanup failed:', error)
        }),
        Promise.resolve().then(() => connManager.disconnect()).catch((error) => {
          logger.error('[Server] Connection cleanup failed:', error)
        }),
        closeWsPromise,
        closeServerPromise,
      ]).then(() => 'complete' as const)

      let timeout: ReturnType<typeof setTimeout> | null = null
      const deadline = new Promise<'timeout'>((resolve) => {
        timeout = setTimeout(() => {
          logger.error(`[Server] Shutdown exceeded ${shutdownTimeoutMs}ms; forcing network handles closed`)
          server.closeAllConnections?.()
          for (const client of wss.clients) client.terminate()
          resolve('timeout')
        }, shutdownTimeoutMs)
      })
      const outcome = await Promise.race([cleanupWork, deadline])
      const timedOut = outcome === 'timeout'
      if (!timedOut && timeout) clearTimeout(timeout)

      mavlinkBridge.off('message', onBridgeMessage)
      connManager.off('statusChange', onStatusChange)
      connManager.off('connectionError', onConnectionError)
      connManager.off('transportChange', onConnectionStateDetail)
      connManager.off('vehicleReadyChange', onVehicleReadyChange)
      connManager.off('rawSessionChange', onConnectionStateDetail)
      connManager.off('errorDetailChange', onErrorDetailChange)
      for (const cleanup of shutdownCleanups) {
        try {
          cleanup()
        } catch (error) {
          logger.warn('[Server] Shutdown cleanup hook failed:', error)
        }
      }
      shutdownCleanups.clear()
      logger.log(timedOut ? '[Server] Shutdown deadline reached' : '[Server] Shutdown complete')
      return { timedOut }
    })()
    return shutdownPromise
  }

  return {
    app,
    server,
    wss,
    config,
    services,
    shutdown,
    addShutdownCleanup,
  }
}

function displayHost(host: string): string {
  return host.includes(':') ? `[${host}]` : host
}

export async function startServer(options: StartServerOptions = {}): Promise<BackendRuntime> {
  const config = options.config
    ? parseServerConfig({}, options.config)
    : parseServerConfig()
  const logger = options.logger ?? console
  const runtime = createApp({ ...options, config })

  try {
    await new Promise<void>((resolve, reject) => {
      const onListenError = (error: Error) => {
        runtime.server.off('listening', onListening)
        reject(error)
      }
      const onListening = () => {
        runtime.server.off('error', onListenError)
        resolve()
      }
      runtime.server.once('error', onListenError)
      runtime.server.once('listening', onListening)
      runtime.server.listen(config.port, config.host)
    })
  } catch (error) {
    await runtime.shutdown('listen_failed')
    throw error
  }

  const address = runtime.server.address()
  const actualPort = typeof address === 'object' && address ? address.port : config.port
  // Port 0 asks the OS for an ephemeral port. Origin validation runs against
  // the runtime config, so publish the assigned port before accepting browser
  // subresource and WebSocket requests from that same loopback origin.
  runtime.config.port = actualPort
  const host = displayHost(config.host)
  logger.log(`[Server] OpenConfigurator running at http://${host}:${actualPort}`)
  logger.log(`[Server] WebSocket at ws://${host}:${actualPort}/ws`)

  if (options.installSignalHandlers) {
    let signalReceived = false
    const signalHandler = (signal: NodeJS.Signals) => {
      if (signalReceived) return
      signalReceived = true
      const forcedExitTimer = setTimeout(() => {
        console.error('[Server] Forced exit after shutdown deadline')
        process.exit(1)
      }, (options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS) + 250)
      forcedExitTimer.unref()
      void runtime.shutdown(signal).then((result) => {
        if (!result.timedOut) {
          clearTimeout(forcedExitTimer)
          process.exitCode = 0
        }
      })
    }
    const onSigint = () => signalHandler('SIGINT')
    const onSigterm = () => signalHandler('SIGTERM')
    process.once('SIGINT', onSigint)
    process.once('SIGTERM', onSigterm)
    runtime.addShutdownCleanup(() => {
      process.off('SIGINT', onSigint)
      process.off('SIGTERM', onSigterm)
    })
  }

  return runtime
}

function isDirectExecution(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  const resolvedEntry = path.resolve(entry)
  const resolvedModule = path.resolve(modulePath)
  return process.platform === 'win32'
    ? resolvedEntry.toLowerCase() === resolvedModule.toLowerCase()
    : resolvedEntry === resolvedModule
}

if (isDirectExecution()) {
  void startServer({ installSignalHandlers: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') {
      const listenError = error as NodeJS.ErrnoException & { address?: string; port?: number }
      console.error(`[Server] 启动失败：${listenError.address ?? '监听地址'}:${listenError.port ?? ''} 已被占用`)
    } else {
      console.error('[Server] 启动失败:', error)
    }
    process.exitCode = 1
  })
}
