import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { createServer as createHttpServer } from 'node:http'
import test from 'node:test'
import { WebSocket } from 'ws'
import type {
  CalibrationSnapshot,
  ClientMessage,
  ConnectionConfig,
  ConnectionStatus,
  PortInfo,
  ServerMessage,
} from '../shared/types'
import {
  handleDownloadError,
  startServer,
  type BackendRuntime,
  type ConnectionManagerBoundary,
  type MavlinkBridgeBoundary,
} from './index'
import type { CalibrationStartRequest } from './mavlink/CalibrationSessionManager'
import {
  InputValidationError,
  isAllowedOrigin,
  parseClientMessage,
  parseConnectionConfig,
  parseServerConfig,
  type ServerConfig,
} from './validation'

const silentLogger = {
  log() {},
  warn() {},
  error() {},
}

class FakeConnectionManager extends EventEmitter implements ConnectionManagerBoundary {
  status: ConnectionStatus = 'disconnected'
  config: ConnectionConfig | null = null
  reconnect = null
  transportOpen = false
  vehicleReady = false
  rawSessionActive = false
  lastError = null
  reconnectTerminalReason: {
    code: string
    message: string
    attempt: number
    timestamp: number
  } | null = null
  disconnectCalls = 0
  expectedRebootCalls = 0
  connectError: Error | null = null
  disconnectWait: Promise<void> | null = null

  async scanPorts(): Promise<{ serial: PortInfo[]; bluetooth: PortInfo[] }> {
    return {
      serial: [{ path: 'COM_TEST', manufacturer: 'test' }],
      bluetooth: [],
    }
  }

  async connect(config: ConnectionConfig): Promise<void> {
    if (this.connectError) throw this.connectError
    this.config = config
    this.status = 'connecting'
    this.emit('statusChange', this.status)
    this.transportOpen = true
    this.status = 'connected'
    this.emit('transportChange', true)
    this.emit('statusChange', this.status)
  }

  async disconnect(): Promise<void> {
    this.disconnectCalls += 1
    if (this.disconnectWait) await this.disconnectWait
    this.transportOpen = false
    this.vehicleReady = false
    this.config = null
    this.status = 'disconnected'
    this.emit('statusChange', this.status)
  }

  expectVehicleReboot(): boolean {
    this.expectedRebootCalls += 1
    this.vehicleReady = false
    this.emit('vehicleReadyChange', false)
    return true
  }
}

class FakeCalibrationSession {
  terminal = false
  cancelSupported = true
  owner: string | null
  recoverUntil: number | null = null
  cancelCalls = 0
  terminateCodes: string[] = []
  private seq = 0
  private phase: CalibrationSnapshot['phase'] = 'starting'
  private failureCode: string | undefined

  constructor(readonly request: CalibrationStartRequest) {
    this.owner = request.ownerClientId
  }

  get sessionId(): string {
    return this.request.sessionId
  }

  start(): void {
    this.emit()
  }

  cancel(): { ok: true } {
    this.cancelCalls += 1
    return { ok: true }
  }

  terminate(code: string, _reason: string): void {
    if (this.terminal) return
    this.terminal = true
    this.terminateCodes.push(code)
    this.phase = 'failed'
    this.failureCode = code
    this.emit()
  }

  setOwner(ownerClientId: string | null, recoverUntil: number | null): void {
    this.owner = ownerClientId
    this.recoverUntil = recoverUntil
    this.emit()
  }

  /** Test helper: drive the session to a terminal phase via its emit path. */
  finish(phase: CalibrationSnapshot['phase']): void {
    if (this.terminal) return
    this.terminal = true
    this.phase = phase
    this.emit()
  }

  snapshot(): CalibrationSnapshot {
    return this.build()
  }

  private emit(): void {
    this.seq += 1
    this.request.emitSnapshot(this.build())
  }

  private build(): CalibrationSnapshot {
    return {
      sessionId: this.request.sessionId,
      seq: this.seq,
      ownerClientId: this.owner,
      recoverUntil: this.recoverUntil,
      requestId: this.request.requestId,
      family: 'px4',
      kind: this.request.kind,
      phase: this.phase,
      verification: 'not_applicable',
      progress: null,
      updatedAt: Date.now(),
      ...(this.failureCode ? { failureCode: this.failureCode } : {}),
      rebootRequired: false,
      cancelSupported: this.cancelSupported,
    }
  }
}

class FakeMavlinkBridge extends EventEmitter implements MavlinkBridgeBoundary {
  readonly messages: ClientMessage[] = []
  readonly calibrationSessions: FakeCalibrationSession[] = []
  currentParamRunId = 0
  destroyed = false
  parameterCancellationCalls = 0
  vehicleRebootQueued = true
  destroyError: Error | null = null
  readonly ftpDownloads = new Map<string, {
    filePath: string
    fileName: string
    sizeBytes: number
  }>()

  handleClientMessage(message: ClientMessage): { vehicleRebootQueued: boolean } {
    this.messages.push(message)
    if (message.type === 'param_request_list') this.currentParamRunId += 1
    const vehicleRebootQueued = message.type === 'reboot_vehicle' && this.vehicleRebootQueued
    if (message.type === 'reboot_vehicle' && !vehicleRebootQueued) {
      this.emit('message', {
        type: 'operation_error',
        data: {
          requestId: message.requestId,
          operation: 'reboot_vehicle',
          code: 'vehicle_armed',
          message: 'test reboot rejection',
          retryable: false,
        },
      } satisfies ServerMessage)
    }
    return { vehicleRebootQueued }
  }

  createCalibrationSession(request: CalibrationStartRequest): FakeCalibrationSession {
    const session = new FakeCalibrationSession(request)
    this.calibrationSessions.push(session)
    return session
  }

  cancelParameterDownload(): void {
    this.parameterCancellationCalls += 1
  }

  getFtpDownload(downloadId: string) {
    return this.ftpDownloads.get(downloadId) ?? null
  }

  destroy(): void {
    if (this.destroyError) throw this.destroyError
    this.destroyed = true
  }
}

type StartedTestServer = {
  runtime: BackendRuntime
  connManager: FakeConnectionManager
  bridge: FakeMavlinkBridge
  httpUrl: string
  wsUrl: string
}

function testConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return parseServerConfig({}, {
    host: '127.0.0.1',
    port: 0,
    remoteEnabled: false,
    authToken: null,
    allowedOrigins: [],
    wsMaxPayload: 16 * 1024,
    wsMaxClients: 8,
    ...overrides,
  })
}

async function startTestServer(
  config = testConfig(),
  timing: { heartbeatIntervalMs?: number; controllerLeaseMs?: number } = {},
): Promise<StartedTestServer> {
  const connManager = new FakeConnectionManager()
  const bridge = new FakeMavlinkBridge()
  const runtime = await startServer({
    config,
    services: { connManager, mavlinkBridge: bridge },
    logger: silentLogger,
    heartbeatIntervalMs: timing.heartbeatIntervalMs ?? 100,
    controllerLeaseMs: timing.controllerLeaseMs ?? 500,
    parameterSyncTimeoutMs: 1_000,
    shutdownTimeoutMs: 500,
  })
  const address = runtime.server.address()
  assert.ok(address && typeof address === 'object')
  const httpUrl = `http://127.0.0.1:${address.port}`
  return {
    runtime,
    connManager,
    bridge,
    httpUrl,
    wsUrl: `ws://127.0.0.1:${address.port}/ws`,
  }
}

type JsonMessage = {
  type?: string
  data?: Record<string, unknown>
  generation?: number
}

class WsInbox {
  readonly messages: JsonMessage[] = []
  private waiters = new Set<{
    predicate: (message: JsonMessage) => boolean
    resolve: (message: JsonMessage) => void
    reject: (error: Error) => void
    timer: ReturnType<typeof setTimeout>
  }>()

  constructor(readonly ws: WebSocket) {
    ws.on('message', (raw) => {
      const message = JSON.parse(raw.toString()) as JsonMessage
      this.messages.push(message)
      for (const waiter of this.waiters) {
        if (!waiter.predicate(message)) continue
        clearTimeout(waiter.timer)
        this.waiters.delete(waiter)
        waiter.resolve(message)
      }
    })
  }

  waitFor(
    type: string,
    predicate: (message: JsonMessage) => boolean = () => true,
    timeoutMs = 1_000,
    afterIndex = 0,
  ): Promise<JsonMessage> {
    const existing = this.messages
      .slice(afterIndex)
      .find((message) => message.type === type && predicate(message))
    if (existing) return Promise.resolve(existing)
    return new Promise((resolve, reject) => {
      const timeoutError = new Error(`Timed out waiting for WebSocket message ${type}`)
      const waiter = {
        predicate: (message: JsonMessage) => message.type === type && predicate(message),
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters.delete(waiter)
          reject(timeoutError)
        }, timeoutMs),
      }
      this.waiters.add(waiter)
    })
  }
}

async function connectWs(url: string, token?: string): Promise<WsInbox> {
  const target = token ? `${url}?token=${encodeURIComponent(token)}` : url
  const ws = new WebSocket(target, { origin: 'http://localhost:5173' })
  const inbox = new WsInbox(ws)
  await once(ws, 'open')
  return inbox
}

async function closeWs(inbox: WsInbox): Promise<void> {
  if (inbox.ws.readyState === WebSocket.CLOSED) return
  const closed = once(inbox.ws, 'close')
  inbox.ws.close()
  await closed
}

async function rejectedWsStatus(url: string): Promise<number> {
  const ws = new WebSocket(url, { origin: 'http://localhost:5173' })
  return new Promise<number>((resolve, reject) => {
    ws.once('unexpected-response', (_request, response) => {
      const status = response.statusCode ?? 0
      response.resume()
      resolve(status)
    })
    ws.once('open', () => reject(new Error('rejected WebSocket unexpectedly opened')))
    ws.once('error', () => {})
  })
}

test('runtime validation enforces command, motor, connection, and IPv6 loopback contracts', () => {
  const arm = parseClientMessage({
    type: 'command',
    requestId: 'arm-1',
    cmd: 'MAV_CMD_COMPONENT_ARM_DISARM',
    params: [1, 0, 0, 0, 0, 0, 0],
    safetyConfirmation: 'arm',
  })
  assert.equal(arm.type, 'command')

  assert.throws(
    () => parseClientMessage({
      type: 'command',
      cmd: 'MAV_CMD_COMPONENT_ARM_DISARM',
      params: [1, 21196],
      safetyConfirmation: 'arm',
    }),
    (error) => error instanceof InputValidationError && error.code === 'unsafe_command_params',
  )
  assert.throws(
    () => parseClientMessage({
      type: 'command',
      cmd: 'MAV_CMD_ACTUATOR_TEST',
      params: [0, 0, 0, 0, 1101],
    }),
    (error) => error instanceof InputValidationError && error.code === 'restricted_command',
  )
  for (const cmd of ['MAV_CMD_DO_SET_MODE', 'MAV_CMD_PREFLIGHT_CALIBRATION', 'MAV_CMD_PREFLIGHT_REBOOT_SHUTDOWN']) {
    assert.throws(
      () => parseClientMessage({ type: 'command', cmd, params: [0, 0, 0, 0, 0, 0, 0] }),
      (error) => error instanceof InputValidationError && error.code === 'restricted_command',
    )
  }

  assert.deepEqual(
    parseClientMessage({
      type: 'reboot_vehicle',
      requestId: 'reboot-1',
      safetyConfirmation: 'reboot_flight_controller',
    }),
    {
      type: 'reboot_vehicle',
      requestId: 'reboot-1',
      safetyConfirmation: 'reboot_flight_controller',
    },
  )
  assert.throws(
    () => parseClientMessage({ type: 'reboot_vehicle', requestId: 'reboot-2' }),
    (error) => error instanceof InputValidationError && error.code === 'safety_confirmation_required',
  )

  assert.throws(
    () => parseClientMessage({
      type: 'motor_test',
      data: { instance: 1, throttle: 10, duration: 2 },
    }),
    (error) =>
      error instanceof InputValidationError
      && error.code === 'motor_safety_confirmation_required',
  )
  assert.equal(
    parseClientMessage({
      type: 'motor_test',
      data: { instance: 12, throttle: 0, duration: 0 },
    }).type,
    'motor_test',
  )

  assert.throws(
    () => parseClientMessage({
      type: 'motor_test',
      data: { instance: 13, throttle: 0, duration: 0 },
    }),
    (error) => error instanceof InputValidationError && error.path === 'data.instance',
  )

  assert.deepEqual(
    parseClientMessage({
      type: 'motor_test_batch',
      requestId: 'motor-all-start',
      data: {
        instances: [1, 2, 3, 4],
        throttle: 10,
        duration: 2,
        propsRemoved: true,
      },
    }),
    {
      type: 'motor_test_batch',
      requestId: 'motor-all-start',
      data: {
        instances: [1, 2, 3, 4],
        throttle: 10,
        duration: 2,
        propsRemoved: true,
      },
    },
  )
  assert.deepEqual(
    parseClientMessage({
      type: 'motor_test_batch',
      data: { instances: [1, 12], throttle: 0, duration: 0 },
    }),
    {
      type: 'motor_test_batch',
      data: { instances: [1, 12], throttle: 0, duration: 0 },
    },
  )
  for (const data of [
    { instances: [], throttle: 0, duration: 0 },
    { instances: [1, 1], throttle: 0, duration: 0 },
    { instances: [0], throttle: 0, duration: 0 },
    { instances: [13], throttle: 0, duration: 0 },
    { instances: [1, 2], throttle: 10, duration: 2 },
  ]) {
    assert.throws(
      () => parseClientMessage({ type: 'motor_test_batch', data }),
      (error) => error instanceof InputValidationError,
    )
  }

  const bluetoothConfig = parseConnectionConfig({
    type: 'bluetooth',
    port: 'COM8',
    baudRate: 57600,
    bluetoothAddress: 'AA:BB:CC:DD:EE:FF',
  })
  assert.equal(bluetoothConfig.bluetoothAddress, 'AA:BB:CC:DD:EE:FF')
  assert.throws(
    () => parseConnectionConfig({
      type: 'bluetooth',
      port: 'COM8',
      baudRate: 57600,
      bluetoothAddress: 'not-an-address',
    }),
    (error) => error instanceof InputValidationError && error.path === 'bluetoothAddress',
  )

  const ipv6Config = testConfig({ host: '::1', port: 3000 })
  assert.equal(isAllowedOrigin('http://[::1]:3000', ipv6Config), true)
  assert.equal(isAllowedOrigin('http://evil.example:3000', ipv6Config), false)
  assert.equal(isAllowedOrigin('http://127.evil.example:5173', ipv6Config), false)

  assert.throws(
    () => parseServerConfig({ HOST: '0.0.0.0' }),
    (error) => error instanceof InputValidationError && error.code === 'remote_binding_disabled',
  )
  assert.throws(
    () => parseServerConfig({
      HOST: '0.0.0.0',
      SKYLAB_ALLOW_REMOTE: 'true',
      SKYLAB_AUTH_TOKEN: 'short',
    }),
    (error) => error instanceof InputValidationError && error.path === 'SKYLAB_AUTH_TOKEN',
  )
})

test('runtime validation accepts DataFlash log requests and preserves erase safety', () => {
  assert.deepEqual(
    parseClientMessage({ type: 'log_list', requestId: 'logs-1' }),
    { type: 'log_list', requestId: 'logs-1' },
  )
  assert.deepEqual(
    parseClientMessage({
      type: 'log_download',
      requestId: 'log-download-1',
      data: { logId: 42 },
    }),
    {
      type: 'log_download',
      requestId: 'log-download-1',
      data: { logId: 42 },
    },
  )
  assert.throws(
    () => parseClientMessage({
      type: 'log_download',
      data: { logId: 65_536 },
    }),
    (error) => error instanceof InputValidationError && error.path === 'data.logId',
  )
  assert.equal(
    parseClientMessage({ type: 'log_download_cancel' }).type,
    'log_download_cancel',
  )
  assert.throws(
    () => parseClientMessage({ type: 'log_erase' }),
    (error) =>
      error instanceof InputValidationError
      && error.code === 'safety_confirmation_required',
  )
  assert.equal(
    parseClientMessage({
      type: 'log_erase',
      safetyConfirmation: 'erase_all_logs',
    }).type,
    'log_erase',
  )
})

test('WebSocket boundary forwards a validated DataFlash log-list request', async () => {
  const started = await startTestServer()
  const client = await connectWs(started.wsUrl)
  try {
    await client.waitFor('hello')
    started.connManager.status = 'connected'
    started.connManager.transportOpen = true
    started.connManager.vehicleReady = true
    started.connManager.emit('statusChange', 'connected')

    client.ws.send(JSON.stringify({
      type: 'log_list',
      requestId: 'logs-accepted',
    }))
    await new Promise((resolve) => setTimeout(resolve, 25))
    assert.equal(started.bridge.messages.length, 1)
    assert.deepEqual(started.bridge.messages[0], {
      type: 'log_list',
      requestId: 'logs-accepted',
    })
  } finally {
    await closeWs(client)
    await started.runtime.shutdown('test')
  }
})
test('REST boundary returns stable JSON errors and accepts only validated connection configs', async () => {
  const started = await startTestServer()
  try {
    const invalid = await fetch(`${started.httpUrl}/api/connections/connect`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'http://localhost:5173',
      },
      body: JSON.stringify({ type: 'udp', port: 'COM1', baudRate: 57600 }),
    })
    assert.equal(invalid.status, 400)
    assert.equal((await invalid.json() as any).error.code, 'unsupported_connection_type')
    assert.equal(invalid.headers.get('x-powered-by'), null)
    assert.equal(invalid.headers.get('x-content-type-options'), 'nosniff')
    assert.match(invalid.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/)
    assert.match(invalid.headers.get('cache-control') ?? '', /no-store/)

    const malformed = await fetch(`${started.httpUrl}/api/connections/connect`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'http://localhost:5173',
      },
      body: '{',
    })
    assert.equal(malformed.status, 400)
    assert.equal((await malformed.json() as any).error.code, 'invalid_json')

    const oversized = await fetch(`${started.httpUrl}/api/connections/connect`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'http://localhost:5173',
      },
      body: JSON.stringify({ padding: 'x'.repeat(17 * 1024) }),
    })
    assert.equal(oversized.status, 413)
    assert.equal((await oversized.json() as any).error.code, 'payload_too_large')

    const unknown = await fetch(`${started.httpUrl}/api/does-not-exist`, {
      headers: { Origin: 'http://localhost:5173' },
    })
    assert.equal(unknown.status, 404)
    assert.match(unknown.headers.get('content-type') ?? '', /application\/json/)
    assert.equal((await unknown.json() as any).error.code, 'api_not_found')

    const forbiddenOrigin = await fetch(`${started.httpUrl}/api/connections/status`, {
      headers: { Origin: 'http://evil.example' },
    })
    assert.equal(forbiddenOrigin.status, 403)
    assert.equal((await forbiddenOrigin.json() as any).error.code, 'origin_forbidden')

    const valid = await fetch(`${started.httpUrl}/api/connections/connect`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'http://127.0.0.1:5173',
      },
      body: JSON.stringify({ type: 'serial', port: 'COM_TEST', baudRate: 57600 }),
    })
    assert.equal(valid.status, 200)
    assert.equal(started.connManager.config?.port, 'COM_TEST')
  } finally {
    await started.runtime.shutdown('test')
  }
})

test('WebSocket boundary sends hello/errors and enforces controller lease plus parameter generation', async () => {
  const started = await startTestServer()
  const first = await connectWs(started.wsUrl)
  const second = await connectWs(started.wsUrl)
  try {
    const hello = await first.waitFor('hello')
    assert.equal(hello.data?.protocolVersion, 1)
    assert.equal(typeof hello.data?.restControlToken, 'string')
    const secondHello = await second.waitFor('hello')
    assert.equal(typeof secondHello.data?.clientId, 'string')
    assert.equal(typeof secondHello.data?.restControlToken, 'string')
    assert.notEqual(hello.data?.restControlToken, secondHello.data?.restControlToken)
    const connection = await first.waitFor('connection')
    assert.equal(connection.data?.status, 'disconnected')
    assert.equal(connection.data?.transportOpen, false)
    assert.equal(connection.data?.rawSessionActive, false)

    second.ws.send(JSON.stringify({
      type: 'manual_control',
      requestId: 'bad-control',
      data: { x: 2000, y: 0, z: 0, r: 0 },
    }))
    const validationError = await second.waitFor(
      'client_error',
      (message) => message.data?.requestId === 'bad-control',
    )
    assert.equal(validationError.data?.code, 'out_of_range')

    second.ws.send(JSON.stringify({
      type: 'set_flight_mode',
      requestId: 'not-ready',
      data: { modeId: 1 },
    }))
    const notReady = await second.waitFor(
      'client_error',
      (message) => message.data?.requestId === 'not-ready',
    )
    assert.equal(notReady.data?.code, 'target_not_ready')
    assert.equal(started.bridge.messages.length, 0)

    started.connManager.status = 'connected'
    started.connManager.transportOpen = true
    started.connManager.vehicleReady = true
    started.connManager.emit('statusChange', 'connected')

    first.ws.send(JSON.stringify({
      type: 'set_flight_mode',
      requestId: 'mode-1',
      data: { modeId: 1 },
    }))
    await first.waitFor('controller', (message) => message.data?.reason === 'claimed')
    assert.equal(started.bridge.messages.length, 1)
    assert.equal(started.bridge.messages[0].type, 'set_flight_mode')

    second.ws.send(JSON.stringify({
      type: 'set_flight_mode',
      requestId: 'mode-2',
      data: { modeId: 2 },
    }))
    const conflict = await second.waitFor(
      'client_error',
      (message) => message.data?.requestId === 'mode-2',
    )
    assert.equal(conflict.data?.code, 'controller_conflict')
    assert.equal(started.bridge.messages.length, 1)

    second.ws.send(JSON.stringify({
      type: 'fs_download_cancel',
      requestId: 'cancel-not-owner',
    }))
    const cancelConflict = await second.waitFor(
      'client_error',
      (message) => message.data?.requestId === 'cancel-not-owner',
    )
    assert.equal(cancelConflict.data?.code, 'controller_conflict')
    assert.equal(started.bridge.messages.length, 1)

    first.ws.send(JSON.stringify({ type: 'release_control', requestId: 'release-1' }))
    await second.waitFor('controller', (message) => message.data?.reason === 'released')
    second.ws.send(JSON.stringify({
      type: 'set_flight_mode',
      requestId: 'mode-3',
      data: { modeId: 2 },
    }))
    await second.waitFor(
      'controller',
      (message) =>
        message.data?.reason === 'claimed'
        && message.data?.clientId === secondHello.data?.clientId,
    )
    assert.equal(started.bridge.messages.length, 2)

    second.ws.send(JSON.stringify({ type: 'param_request_list', requestId: 'params-1' }))
    const generationOne = await second.waitFor(
      'param_sync',
      (message) => message.data?.status === 'started',
    )
    assert.equal(generationOne.data?.generation, 1)

    first.ws.send(JSON.stringify({ type: 'param_request_list', requestId: 'params-2' }))
    const paramConflict = await first.waitFor(
      'client_error',
      (message) => message.data?.requestId === 'params-2',
    )
    assert.equal(paramConflict.data?.code, 'param_sync_conflict')

    await closeWs(second)
    await first.waitFor('controller', (message) => message.data?.reason === 'disconnected')
    await first.waitFor(
      'param_sync',
      (message) =>
        message.data?.status === 'cancelled'
        && message.data?.reason === 'owner_disconnected',
    )
    assert.equal(started.bridge.parameterCancellationCalls, 1)
    const messagesBeforeParameterClaim = first.messages.length
    first.ws.send(JSON.stringify({ type: 'param_request_list', requestId: 'params-3' }))
    await first.waitFor(
      'controller',
      (message) =>
        message.data?.reason === 'claimed'
        && message.data?.clientId === hello.data?.clientId,
      1_000,
      messagesBeforeParameterClaim,
    )
    const generationTwo = await first.waitFor(
      'param_sync',
      (message) => message.data?.status === 'started' && message.data?.generation === 2,
    )
    assert.equal(generationTwo.data?.generation, 2)
    assert.equal(started.bridge.currentParamRunId, 2)

    const beforeStaleRun = first.messages.length
    started.bridge.emit('message', {
      type: 'param',
      data: { id: 'STALE_RUN', value: 1, type: 9, param_count: 1, param_index: 0 },
      paramRunId: 1,
    })
    started.bridge.emit('message', {
      type: 'param_complete',
      data: { count: 1 },
      paramRunId: 1,
    })
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.equal(
      first.messages.slice(beforeStaleRun).some((message) =>
        message.type === 'param_batch'
        || (message.type === 'param_sync' && message.data?.status === 'complete')),
      false,
      'late events from the cancelled run must not contaminate the new generation',
    )

    started.bridge.emit('message', {
      type: 'param',
      data: { id: 'CURRENT_RUN', value: 2, type: 9, param_count: 1, param_index: 0 },
      paramRunId: 2,
    })
    started.bridge.emit('message', {
      type: 'param_complete',
      data: { count: 1 },
      paramRunId: 2,
    })
    const currentBatch = await first.waitFor(
      'param_batch',
      (message) => message.generation === 2,
      1_000,
      beforeStaleRun,
    )
    assert.equal((currentBatch.data as unknown as Array<{ id: string }>)[0]?.id, 'CURRENT_RUN')
    await first.waitFor(
      'param_sync',
      (message) => message.data?.status === 'complete' && message.data?.generation === 2,
      1_000,
      beforeStaleRun,
    )

    // The compatibility flag must track the physical transport even while a
    // lifecycle status is briefly stale during bounded teardown.
    started.connManager.status = 'connected'
    started.connManager.transportOpen = false
    started.connManager.vehicleReady = false
    started.connManager.emit('transportChange', false)
    const transportClosing = await first.waitFor(
      'connection',
      (message) =>
        message.data?.status === 'connected'
        && message.data?.transportOpen === false
        && message.data?.connected === false,
    )
    assert.equal(transportClosing.data?.vehicleReady, false)

    started.connManager.reconnectTerminalReason = {
      code: 'MAX_ATTEMPTS',
      message: 'reconnect exhausted',
      attempt: 10,
      timestamp: 1234,
    }
    started.connManager.status = 'error'
    started.connManager.emit('statusChange', 'error')
    const releasedOnConnectionChange = await first.waitFor(
      'controller',
      (message) => message.data?.reason === 'connection_changed',
    )
    assert.equal(releasedOnConnectionChange.data?.clientId, null)
    const terminalConnection = await first.waitFor(
      'connection',
      (message) => {
        const terminal = message.data?.reconnectTerminalReason as
          | Record<string, unknown>
          | undefined
        return terminal?.code === 'MAX_ATTEMPTS' && terminal.attempt === 10
      },
    )
    assert.equal(
      (terminalConnection.data?.reconnectTerminalReason as Record<string, unknown>).message,
      'reconnect exhausted',
    )
  } finally {
    await closeWs(first)
    await closeWs(second)
    await started.runtime.shutdown('test')
  }
  assert.equal(started.bridge.destroyed, true)
  assert.ok(started.connManager.disconnectCalls >= 1)
  assert.equal(started.runtime.server.listening, false)
})

test('REST connection mutations respect the active WebSocket controller lease', async () => {
  const started = await startTestServer(testConfig(), { controllerLeaseMs: 5_000 })
  const owner = await connectWs(started.wsUrl)
  const observer = await connectWs(started.wsUrl)
  try {
    const ownerHello = await owner.waitFor('hello')
    const observerHello = await observer.waitFor('hello')
    const ownerToken = ownerHello.data?.restControlToken
    const observerToken = observerHello.data?.restControlToken
    assert.equal(typeof ownerToken, 'string')
    assert.equal(typeof observerToken, 'string')

    started.connManager.status = 'connected'
    started.connManager.transportOpen = true
    started.connManager.vehicleReady = true
    started.connManager.emit('statusChange', 'connected')
    owner.ws.send(JSON.stringify({
      type: 'set_flight_mode',
      requestId: 'claim-rest-control',
      data: { modeId: 1 },
    }))
    await owner.waitFor('controller', (message) => message.data?.reason === 'claimed')

    const noToken = await fetch(`${started.httpUrl}/api/connections/connect`, {
      method: 'POST',
      headers: {
        Origin: 'http://localhost:5173',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ type: 'serial', port: 'COM_OWNER', baudRate: 57600 }),
    })
    assert.equal(noToken.status, 409)
    assert.equal((await noToken.json() as any).error.code, 'controller_conflict')

    const observerAttempt = await fetch(`${started.httpUrl}/api/connections/disconnect`, {
      method: 'POST',
      headers: {
        Origin: 'http://localhost:5173',
        'X-SkyLab-Control-Token': String(observerToken),
      },
    })
    assert.equal(observerAttempt.status, 409)
    assert.equal((await observerAttempt.json() as any).error.code, 'controller_conflict')
    assert.equal(started.connManager.disconnectCalls, 0)

    const ownerConnect = await fetch(`${started.httpUrl}/api/connections/connect`, {
      method: 'POST',
      headers: {
        Origin: 'http://localhost:5173',
        'Content-Type': 'application/json',
        'X-SkyLab-Control-Token': String(ownerToken),
      },
      body: JSON.stringify({ type: 'serial', port: 'COM_OWNER', baudRate: 57600 }),
    })
    assert.equal(ownerConnect.status, 200)
    assert.equal(started.connManager.config?.port, 'COM_OWNER')

    started.connManager.vehicleReady = true
    const messagesBeforeReclaim = owner.messages.length
    owner.ws.send(JSON.stringify({
      type: 'set_flight_mode',
      requestId: 'reclaim-rest-control',
      data: { modeId: 2 },
    }))
    await owner.waitFor(
      'controller',
      (message) => message.data?.reason === 'claimed',
      1_000,
      messagesBeforeReclaim,
    )

    const ownerDisconnect = await fetch(`${started.httpUrl}/api/connections/disconnect`, {
      method: 'POST',
      headers: {
        Origin: 'http://localhost:5173',
        'X-SkyLab-Control-Token': String(ownerToken),
      },
    })
    assert.equal(ownerDisconnect.status, 200)
    assert.equal(started.connManager.disconnectCalls, 1)
  } finally {
    await closeWs(owner)
    await closeWs(observer)
    await started.runtime.shutdown('test')
  }
})

test('WebSocket rejects binary frames and remote mode requires a token', async () => {
  const token = 'test-token-that-is-at-least-thirty-two-bytes'
  const started = await startTestServer(testConfig({
    remoteEnabled: true,
    authToken: token,
    wsMaxClients: 1,
    wsMaxPayload: 1024,
  }))
  try {
    const unauthorizedStatus = await rejectedWsStatus(started.wsUrl)
    assert.equal(unauthorizedStatus, 401)

    const authorized = await connectWs(started.wsUrl, token)
    try {
      await authorized.waitFor('hello')
      assert.equal(
        await rejectedWsStatus(`${started.wsUrl}?token=${encodeURIComponent(token)}`),
        503,
      )
      authorized.ws.send(Buffer.from([1, 2, 3]))
      const binaryError = await authorized.waitFor('client_error')
      assert.equal(binaryError.data?.code, 'binary_not_supported')
      await once(authorized.ws, 'close')
    } finally {
      if (authorized.ws.readyState !== WebSocket.CLOSED) authorized.ws.terminate()
    }

    const oversizedSocket = await connectWs(started.wsUrl, token)
    oversizedSocket.ws.send(JSON.stringify({ type: 'x', padding: 'x'.repeat(2 * 1024) }))
    const [oversizedCloseCode] = await once(oversizedSocket.ws, 'close')
    assert.equal(oversizedCloseCode, 1009)

    const noToken = await fetch(`${started.httpUrl}/api/connections/status`, {
      headers: { Origin: 'http://localhost:5173' },
    })
    assert.equal(noToken.status, 401)
    const withToken = await fetch(`${started.httpUrl}/api/connections/status`, {
      headers: {
        Origin: 'http://localhost:5173',
        Authorization: `Bearer ${token}`,
      },
    })
    assert.equal(withToken.status, 200)

    started.connManager.connectError = new Error('private path C:\\Users\\secret\\COM9 failed')
    const internalFailure = await fetch(`${started.httpUrl}/api/connections/connect`, {
      method: 'POST',
      headers: {
        Origin: 'http://localhost:5173',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ type: 'serial', port: 'COM9', baudRate: 57600 }),
    })
    assert.equal(internalFailure.status, 500)
    const internalBody = await internalFailure.json() as any
    assert.equal(internalBody.error.code, 'internal_error')
    assert.equal(internalBody.error.message, '服务器内部错误')
    assert.doesNotMatch(JSON.stringify(internalBody), /Users|COM9|private path/)
  } finally {
    await started.runtime.shutdown('test')
  }
})

test('expired controller leases allow a waiting observer to become controller', async () => {
  const started = await startTestServer(testConfig(), {
    heartbeatIntervalMs: 20,
    controllerLeaseMs: 50,
  })
  const first = await connectWs(started.wsUrl)
  const second = await connectWs(started.wsUrl)
  try {
    const secondHello = await second.waitFor('hello')
    started.connManager.status = 'connected'
    started.connManager.transportOpen = true
    started.connManager.vehicleReady = true
    started.connManager.emit('statusChange', 'connected')
    first.ws.send(JSON.stringify({
      type: 'set_flight_mode',
      data: { modeId: 1 },
    }))
    await first.waitFor('controller', (message) => message.data?.reason === 'claimed')
    await new Promise((resolve) => setTimeout(resolve, 90))
    await second.waitFor('controller', (message) => message.data?.reason === 'expired')

    second.ws.send(JSON.stringify({
      type: 'set_flight_mode',
      data: { modeId: 2 },
    }))
    await second.waitFor(
      'controller',
      (message) =>
        message.data?.reason === 'claimed'
        && message.data?.clientId === secondHello.data?.clientId,
    )
    assert.equal(started.bridge.messages.length, 2)
  } finally {
    await closeWs(first)
    await closeWs(second)
    await started.runtime.shutdown('test')
  }
})

test('calibration sessions pin the lease, isolate mutations and support reclaim', async () => {
  const started = await startTestServer(testConfig(), { controllerLeaseMs: 300 })
  const owner = await connectWs(started.wsUrl)
  const observer = await connectWs(started.wsUrl)
  try {
    const ownerHello = await owner.waitFor('hello')
    const observerHello = await observer.waitFor('hello')
    assert.ok(ownerHello.data && observerHello.data)
    started.connManager.status = 'connected'
    started.connManager.transportOpen = true
    started.connManager.vehicleReady = true
    started.connManager.emit('statusChange', 'connected')

    // Owner starts a calibration session: lease claimed, owner-only token.
    owner.ws.send(JSON.stringify({
      type: 'start_calibration',
      requestId: 'cal-own',
      data: { kind: 'accel' },
    }))
    await owner.waitFor('controller', (message) => message.data?.reason === 'claimed')
    const sessionStarted = await owner.waitFor('calibration_session_started')
    const sessionId = sessionStarted.data?.sessionId as string
    const recoveryToken = sessionStarted.data?.recoveryToken as string
    assert.ok(sessionId && recoveryToken)
    assert.equal(started.bridge.calibrationSessions.length, 1)
    const session = started.bridge.calibrationSessions[0]
    await observer.waitFor(
      'calibration_update',
      (message) => message.data?.phase === 'starting',
    )
    // The observer must never see the recovery token.
    assert.equal(
      observer.messages.some((message) => JSON.stringify(message).includes(recoveryToken)),
      false,
    )

    // Observer actions are refused by the pinned lease and never reach the session.
    observer.ws.send(JSON.stringify({
      type: 'calibration_action',
      requestId: 'obs-act',
      data: { sessionId, action: 'cancel' },
    }))
    const conflict = await observer.waitFor(
      'client_error',
      (message) => message.data?.requestId === 'obs-act',
    )
    assert.equal(conflict.data?.code, 'controller_conflict')
    assert.equal(session.cancelCalls, 0)

    // Reboot is an exit path only for the pinned session owner. An observer
    // cannot use it to interrupt someone else's calibration.
    observer.ws.send(JSON.stringify({
      type: 'reboot_vehicle',
      requestId: 'obs-reboot',
      safetyConfirmation: 'reboot_flight_controller',
    }))
    const rebootConflict = await observer.waitFor(
      'client_error',
      (message) => message.data?.requestId === 'obs-reboot',
    )
    assert.equal(rebootConflict.data?.code, 'controller_conflict')
    assert.equal(session.terminal, false)

    // The pinned lease never expires even past controllerLeaseMs.
    await new Promise((resolve) => setTimeout(resolve, 450))
    assert.equal(
      owner.messages.some((message) =>
        message.type === 'controller' && message.data?.reason === 'expired'),
      false,
      'pinned lease must not expire',
    )

    // Other MAVLink mutations are isolated during the session - owner included.
    owner.ws.send(JSON.stringify({
      type: 'set_flight_mode',
      requestId: 'mode-during-cal',
      data: { modeId: 1 },
    }))
    const isolated = await owner.waitFor(
      'client_error',
      (message) => message.data?.requestId === 'mode-during-cal',
    )
    assert.equal(isolated.data?.code, 'calibration_session_active')
    assert.equal(started.bridge.messages.length, 0)

    // release_control is refused while the session runs.
    owner.ws.send(JSON.stringify({ type: 'release_control', requestId: 'rel-1' }))
    const releaseRefused = await owner.waitFor(
      'client_error',
      (message) => message.data?.requestId === 'rel-1',
    )
    assert.equal(releaseRefused.data?.code, 'calibration_session_active')

    // ESC sessions are mutually exclusive with calibration.
    owner.ws.send(JSON.stringify({
      type: 'esc_session_start',
      requestId: 'esc-1',
      data: { mode: 'direct' },
    }))
    const escRefused = await owner.waitFor(
      'client_error',
      (message) => message.data?.requestId === 'esc-1',
    )
    assert.equal(escRefused.data?.code, 'calibration_session_active')

    // A second start by the owner is deduplicated by the manager.
    owner.ws.send(JSON.stringify({
      type: 'start_calibration',
      requestId: 'cal-again',
      data: { kind: 'gyro' },
    }))
    const busy = await owner.waitFor(
      'operation_error',
      (message) => message.data?.requestId === 'cal-again',
    )
    assert.equal(busy.data?.code, 'calibration_busy')
    assert.equal(started.bridge.calibrationSessions.length, 1)

    // Emergency disarm is the only generic passthrough and interrupts the run.
    owner.ws.send(JSON.stringify({
      type: 'command',
      requestId: 'disarm-1',
      cmd: 'MAV_CMD_COMPONENT_ARM_DISARM',
      params: [0, 0],
      safetyConfirmation: 'disarm',
    }))
    await owner.waitFor(
      'calibration_update',
      (message) => message.data?.failureCode === 'interrupted_by_disarm',
    )
    assert.equal(started.bridge.messages.length, 1)
    assert.equal(started.bridge.messages[0].type, 'command')

    // Terminal session releases the pin: mutations work again for the owner.
    owner.ws.send(JSON.stringify({
      type: 'set_flight_mode',
      requestId: 'mode-after-cal',
      data: { modeId: 1 },
    }))
    for (let i = 0; i < 20 && started.bridge.messages.length < 2; i++) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    assert.equal(started.bridge.messages.length, 2)
    assert.equal(started.bridge.messages[1].type, 'set_flight_mode')

    // Reboot is a deliberate calibration exit: the owner may pass it through,
    // and the session is terminated so it cannot remain pinned after restart.
    owner.ws.send(JSON.stringify({
      type: 'start_calibration',
      requestId: 'cal-before-reboot',
      data: { kind: 'accel' },
    }))
    await owner.waitFor(
      'calibration_session_started',
      (message) => message.data?.requestId === 'cal-before-reboot',
    )
    const rebootMessageIndex = owner.messages.length
    owner.ws.send(JSON.stringify({
      type: 'reboot_vehicle',
      requestId: 'reboot-during-cal',
      safetyConfirmation: 'reboot_flight_controller',
    }))
    const rebootOffline = await owner.waitFor(
      'connection',
      (message) => message.data?.vehicleReady === false
        && message.data?.transportOpen === true,
      1_000,
      rebootMessageIndex,
    )
    assert.equal(rebootOffline.data?.status, 'connected')
    await owner.waitFor(
      'calibration_update',
      (message) => message.data?.failureCode === 'interrupted_by_reboot',
    )
    assert.equal(started.bridge.messages.length, 3)
    assert.equal(started.bridge.messages[2].type, 'reboot_vehicle')
    assert.equal(started.connManager.expectedRebootCalls, 1)
  } finally {
    await closeWs(observer)
    await closeWs(owner)
    await started.runtime.shutdown()
  }
})

test('calibration owner disconnect enters recovery and reclaim transfers ownership', async () => {
  const started = await startTestServer(testConfig(), { controllerLeaseMs: 300 })
  const owner = await connectWs(started.wsUrl)
  const observer = await connectWs(started.wsUrl)
  try {
    await owner.waitFor('hello')
    const observerHello = await observer.waitFor('hello')
    started.connManager.status = 'connected'
    started.connManager.transportOpen = true
    started.connManager.vehicleReady = true
    started.connManager.emit('statusChange', 'connected')

    owner.ws.send(JSON.stringify({
      type: 'start_calibration',
      requestId: 'cal-own',
      data: { kind: 'accel' },
    }))
    const sessionStarted = await owner.waitFor('calibration_session_started')
    const sessionId = sessionStarted.data?.sessionId as string
    const recoveryToken = sessionStarted.data?.recoveryToken as string
    const session = started.bridge.calibrationSessions[0]

    // Owner drops: the snapshot enters the recoverable state.
    await closeWs(owner)
    await observer.waitFor(
      'calibration_update',
      (message) => message.data?.ownerClientId === null && message.data?.recoverUntil !== null,
    )

    // Wrong token is rejected; the session stays orphaned.
    observer.ws.send(JSON.stringify({
      type: 'calibration_reclaim',
      requestId: 'rec-bad',
      data: { sessionId, recoveryToken: 'wrong-token-0123456789abcdef' },
    }))
    const deniedReclaim = await observer.waitFor(
      'operation_error',
      (message) => message.data?.requestId === 'rec-bad',
    )
    assert.equal(deniedReclaim.data?.code, 'reclaim_denied')

    // Correct token transfers ownership to the observer.
    observer.ws.send(JSON.stringify({
      type: 'calibration_reclaim',
      requestId: 'rec-good',
      data: { sessionId, recoveryToken },
    }))
    await observer.waitFor('calibration_session_started')
    await observer.waitFor(
      'calibration_update',
      (message) => message.data?.ownerClientId === observerHello.data?.clientId,
    )

    // The new owner can act on the session.
    observer.ws.send(JSON.stringify({
      type: 'calibration_action',
      requestId: 'act-new-owner',
      data: { sessionId, action: 'cancel' },
    }))
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(session.cancelCalls, 1)

    // Link drop terminates the session.
    started.connManager.status = 'disconnected'
    started.connManager.transportOpen = false
    started.connManager.vehicleReady = false
    started.connManager.emit('statusChange', 'disconnected')
    await observer.waitFor(
      'calibration_update',
      (message) => message.data?.failureCode === 'link_lost',
    )
    assert.deepEqual(session.terminateCodes, ['link_lost'])
  } finally {
    await closeWs(observer)
    await closeWs(owner)
    await started.runtime.shutdown()
  }
})

test('a successful calibration triggers exactly one post-cal parameter sync', async () => {
  const started = await startTestServer(testConfig(), { controllerLeaseMs: 500 })
  const owner = await connectWs(started.wsUrl)
  const observer = await connectWs(started.wsUrl)
  try {
    await owner.waitFor('hello')
    await observer.waitFor('hello')
    started.connManager.status = 'connected'
    started.connManager.transportOpen = true
    started.connManager.vehicleReady = true
    started.connManager.emit('statusChange', 'connected')

    owner.ws.send(JSON.stringify({
      type: 'start_calibration',
      requestId: 'cal-own',
      data: { kind: 'accel' },
    }))
    await owner.waitFor('calibration_session_started')
    const session = started.bridge.calibrationSessions[0]
    assert.equal(started.bridge.messages.length, 0)

    // Drive the session to a successful terminal state; both clients see done.
    session.finish('done')
    await observer.waitFor('calibration_update', (message) => message.data?.phase === 'done')

    // Exactly one PARAM_REQUEST_LIST reached the bridge, and a param_sync
    // 'started' was broadcast for the owner.
    const paramRequests = started.bridge.messages.filter((message) => message.type === 'param_request_list')
    assert.equal(paramRequests.length, 1)
    const sync = await owner.waitFor('param_sync', (message) => message.data?.status === 'started')
    assert.equal(sync.data?.ownerClientId, (await owner.waitFor('hello')).data?.clientId)

    // A repeated terminal snapshot for the same session must not re-trigger.
    session.finish('done')
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(
      started.bridge.messages.filter((message) => message.type === 'param_request_list').length,
      1,
    )

    // Starting the next calibration supersedes the best-effort post-cal
    // parameter refresh instead of being rejected as link_busy.
    owner.ws.send(JSON.stringify({
      type: 'start_calibration',
      requestId: 'cal-next-gyro',
      data: { kind: 'gyro' },
    }))
    const nextSession = await owner.waitFor(
      'calibration_session_started',
      (message) => message.data?.requestId === 'cal-next-gyro',
    )
    assert.ok(nextSession.data?.sessionId)
    assert.equal(started.bridge.parameterCancellationCalls, 1)
    assert.equal(started.bridge.calibrationSessions[1]?.request.kind, 'gyro')
  } finally {
    await closeWs(observer)
    await closeWs(owner)
    await started.runtime.shutdown()
  }
})

test('listen failures clean up injected services instead of leaking a runtime', async () => {
  const occupied = createHttpServer()
  occupied.listen(0, '127.0.0.1')
  await once(occupied, 'listening')
  const address = occupied.address()
  assert.ok(address && typeof address === 'object')

  const connManager = new FakeConnectionManager()
  const bridge = new FakeMavlinkBridge()
  try {
    await assert.rejects(
      startServer({
        config: testConfig({ port: address.port }),
        services: { connManager, mavlinkBridge: bridge },
        logger: silentLogger,
        shutdownTimeoutMs: 200,
      }),
      (error: NodeJS.ErrnoException) => error.code === 'EADDRINUSE',
    )
    assert.equal(bridge.destroyed, true)
    assert.equal(connManager.disconnectCalls, 1)
  } finally {
    await new Promise<void>((resolve, reject) => {
      occupied.close((error) => error ? reject(error) : resolve())
    })
  }
})

test('serves packaged web assets from an injected static directory', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const staticDir = await mkdtemp(join(tmpdir(), 'oc-static-'))
  const connManager = new FakeConnectionManager()
  const bridge = new FakeMavlinkBridge()
  let runtime: BackendRuntime | null = null

  try {
    await writeFile(join(staticDir, 'index.html'), '<!doctype html><title>packaged-shell</title>')
    await writeFile(join(staticDir, 'desktop-check.txt'), 'desktop-assets-ready')
    runtime = await startServer({
      config: testConfig(),
      services: { connManager, mavlinkBridge: bridge },
      staticDir,
      logger: silentLogger,
      shutdownTimeoutMs: 500,
    })
    const address = runtime.server.address()
    assert.ok(address && typeof address === 'object')
    const baseUrl = `http://127.0.0.1:${address.port}`

    const asset = await fetch(`${baseUrl}/desktop-check.txt`, {
      headers: { origin: baseUrl },
    })
    assert.equal(asset.status, 200)
    assert.equal(await asset.text(), 'desktop-assets-ready')

    const route = await fetch(`${baseUrl}/settings/esc`, {
      headers: { accept: 'text/html' },
    })
    assert.equal(route.status, 200)
    assert.match(await route.text(), /packaged-shell/)
  } finally {
    if (runtime) await runtime.shutdown('test')
    await rm(staticDir, { recursive: true, force: true })
  }
})

test('shutdown returns at its deadline when a service cleanup never resolves', async () => {
  const connManager = new FakeConnectionManager()
  connManager.disconnectWait = new Promise<void>(() => undefined)
  const bridge = new FakeMavlinkBridge()
  const runtime = await startServer({
    config: testConfig(),
    services: { connManager, mavlinkBridge: bridge },
    logger: silentLogger,
    heartbeatIntervalMs: 100,
    shutdownTimeoutMs: 30,
  })

  const startedAt = Date.now()
  const result = await runtime.shutdown('hung_cleanup_test')
  const elapsed = Date.now() - startedAt

  assert.equal(result.timedOut, true)
  assert.ok(elapsed >= 20, `shutdown returned before its deadline (${elapsed}ms)`)
  assert.ok(elapsed < 500, `shutdown was not bounded (${elapsed}ms)`)
  assert.equal(runtime.server.listening, false)
  assert.equal(connManager.disconnectCalls, 1)
  assert.equal(bridge.destroyed, true)
  assert.deepEqual(await runtime.shutdown('again'), { timedOut: true })
})

test('shutdown contains a synchronous bridge cleanup failure and still releases the connection', async () => {
  const started = await startTestServer()
  started.bridge.destroyError = new Error('synchronous destroy failure')

  const result = await started.runtime.shutdown('sync_cleanup_failure_test')

  assert.deepEqual(result, { timedOut: false })
  assert.equal(started.connManager.disconnectCalls, 1)
  assert.equal(started.runtime.server.listening, false)
})

test('log download endpoint validates ids and streams registered files', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const started = await startTestServer()
  const dir = await mkdtemp(join(tmpdir(), 'oc-rest-log-'))
  try {
    const filePath = join(dir, 'aabbccddeeff0011.ulg')
    await writeFile(filePath, Buffer.from('ULogTESTDATA'))
    started.bridge.ftpDownloads.set('aabbccddeeff0011', {
      filePath,
      fileName: '10_30_00.ulg',
      sizeBytes: 12,
    })
    started.bridge.ftpDownloads.set('0011223344556677', {
      filePath: join(dir, 'missing.ulg'),
      fileName: 'missing.ulg',
      sizeBytes: 12,
    })

    // Path metacharacters and wrong lengths never reach the filesystem.
    for (const bad of ['..%2F..%2Fetc', 'AABBCCDDEEFF0011', 'aabb', 'aabbccddeeff001122']) {
      const response = await fetch(`${started.httpUrl}/api/logs/downloads/${bad}`)
      assert.equal(response.status, 404, `expected 404 for ${bad}`)
      const body = await response.json() as { success: boolean; error: { code: string } }
      assert.equal(body.success, false)
    }

    // Valid format but unknown id.
    const unknown = await fetch(`${started.httpUrl}/api/logs/downloads/0123456789abcdef`)
    assert.equal(unknown.status, 404)

    // A registered file that disappeared before headers are sent retains the
    // structured 404 response instead of falling through to a generic error.
    const missing = await fetch(`${started.httpUrl}/api/logs/downloads/0011223344556677`)
    assert.equal(missing.status, 404)
    assert.equal(
      (await missing.json() as { error: { code: string } }).error.code,
      'download_not_found',
    )

    // Registered id streams the file with a download disposition.
    const ok = await fetch(`${started.httpUrl}/api/logs/downloads/aabbccddeeff0011`)
    assert.equal(ok.status, 200)
    assert.match(ok.headers.get('content-disposition') ?? '', /attachment/)
    assert.match(ok.headers.get('content-disposition') ?? '', /10_30_00\.ulg/)
    assert.equal(Buffer.from(await ok.arrayBuffer()).toString(), 'ULogTESTDATA')
  } finally {
    await started.runtime.shutdown('test_complete')
    await rm(dir, { recursive: true, force: true })
  }
})

test('a bridge-rejected reboot does not lower vehicle readiness', async () => {
  const started = await startTestServer()
  const client = await connectWs(started.wsUrl)
  try {
    await client.waitFor('hello')
    started.connManager.status = 'connected'
    started.connManager.transportOpen = true
    started.connManager.vehicleReady = true
    started.connManager.emit('statusChange', 'connected')
    await client.waitFor(
      'connection',
      (message) => message.data?.vehicleReady === true,
    )

    started.bridge.vehicleRebootQueued = false
    const messageIndex = client.messages.length
    client.ws.send(JSON.stringify({
      type: 'reboot_vehicle',
      requestId: 'reboot-rejected-by-bridge',
      safetyConfirmation: 'reboot_flight_controller',
    }))
    const rejection = await client.waitFor(
      'operation_error',
      (message) => message.data?.requestId === 'reboot-rejected-by-bridge',
      1_000,
      messageIndex,
    )

    assert.equal(rejection.data?.code, 'vehicle_armed')
    assert.equal(started.connManager.expectedRebootCalls, 0)
    assert.equal(started.connManager.vehicleReady, true)
    assert.equal(
      client.messages.slice(messageIndex).some((message) =>
        message.type === 'connection' && message.data?.vehicleReady === false),
      false,
    )
  } finally {
    await closeWs(client)
    await started.runtime.shutdown('test')
  }
})

test('WebSocket boundary validates and forwards grouped message-rate settings', async () => {
  const started = await startTestServer()
  const client = await connectWs(started.wsUrl)
  try {
    await client.waitFor('hello')
    started.connManager.status = 'connected'
    started.connManager.transportOpen = true
    started.connManager.vehicleReady = true
    started.connManager.emit('statusChange', 'connected')

    client.ws.send(JSON.stringify({
      type: 'message_rates_set',
      requestId: 'rates-boundary',
      data: { attitude: 8, position: 2, sensors: 2, rc: 2, status: 1, hud: 1, auxiliary: 2 },
    }))
    await client.waitFor('controller', (message) => message.data?.reason === 'claimed')
    assert.equal(started.bridge.messages.length, 1)
    assert.deepEqual(started.bridge.messages[0], {
      type: 'message_rates_set',
      requestId: 'rates-boundary',
      data: { attitude: 8, position: 2, sensors: 2, rc: 2, status: 1, hud: 1, auxiliary: 2 },
    })
  } finally {
    await closeWs(client)
    await started.runtime.shutdown('test')
  }
})

test('download errors after headers are sent are forwarded for stream termination', () => {
  const transferError = new Error('stream failed after partial response')
  let forwarded: unknown
  let statusCalls = 0
  const response = {
    headersSent: true,
    status() {
      statusCalls++
      return this
    },
    json() {
      assert.fail('must not attempt a second response after headers are sent')
    },
  } as unknown as Parameters<typeof handleDownloadError>[1]
  const next = ((error?: unknown) => {
    forwarded = error
  }) as Parameters<typeof handleDownloadError>[2]

  handleDownloadError(transferError, response, next)

  assert.equal(forwarded, transferError)
  assert.equal(statusCalls, 0)
})
