import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { createServer as createHttpServer } from 'node:http'
import test from 'node:test'
import { WebSocket } from 'ws'
import type {
  ClientMessage,
  ConnectionConfig,
  ConnectionStatus,
  PortInfo,
} from '../shared/types'
import {
  startServer,
  type BackendRuntime,
  type ConnectionManagerBoundary,
  type MavlinkBridgeBoundary,
} from './index'
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
  lastError = null
  reconnectTerminalReason: {
    code: string
    message: string
    attempt: number
    timestamp: number
  } | null = null
  disconnectCalls = 0
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
}

class FakeMavlinkBridge extends EventEmitter implements MavlinkBridgeBoundary {
  readonly messages: ClientMessage[] = []
  destroyed = false
  parameterCancellationCalls = 0
  destroyError: Error | null = null

  handleClientMessage(message: ClientMessage): void {
    this.messages.push(message)
  }

  cancelParameterDownload(): void {
    this.parameterCancellationCalls += 1
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
      type: 'command',
      requestId: 'not-ready',
      cmd: 'MAV_CMD_DO_SET_MODE',
      params: [1, 1, 0, 0, 0, 0, 0],
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
      type: 'command',
      requestId: 'mode-1',
      cmd: 'MAV_CMD_DO_SET_MODE',
      params: [1, 1, 0, 0, 0, 0, 0],
    }))
    await first.waitFor('controller', (message) => message.data?.reason === 'claimed')
    assert.equal(started.bridge.messages.length, 1)
    assert.equal(started.bridge.messages[0].type, 'command')

    second.ws.send(JSON.stringify({
      type: 'command',
      requestId: 'mode-2',
      cmd: 'MAV_CMD_DO_SET_MODE',
      params: [1, 2, 0, 0, 0, 0, 0],
    }))
    const conflict = await second.waitFor(
      'client_error',
      (message) => message.data?.requestId === 'mode-2',
    )
    assert.equal(conflict.data?.code, 'controller_conflict')
    assert.equal(started.bridge.messages.length, 1)

    first.ws.send(JSON.stringify({ type: 'release_control', requestId: 'release-1' }))
    await second.waitFor('controller', (message) => message.data?.reason === 'released')
    second.ws.send(JSON.stringify({
      type: 'command',
      requestId: 'mode-3',
      cmd: 'MAV_CMD_DO_SET_MODE',
      params: [1, 2, 0, 0, 0, 0, 0],
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
    started.bridge.emit('message', { type: 'param_complete', data: { count: 0 } })
    await first.waitFor('param_sync', (message) => message.data?.status === 'complete')

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
      type: 'command',
      requestId: 'claim-rest-control',
      cmd: 'MAV_CMD_DO_SET_MODE',
      params: [1, 1, 0, 0, 0, 0, 0],
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
      type: 'command',
      requestId: 'reclaim-rest-control',
      cmd: 'MAV_CMD_DO_SET_MODE',
      params: [1, 2, 0, 0, 0, 0, 0],
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
      type: 'command',
      cmd: 'MAV_CMD_DO_SET_MODE',
      params: [1, 1, 0, 0, 0, 0, 0],
    }))
    await first.waitFor('controller', (message) => message.data?.reason === 'claimed')
    await new Promise((resolve) => setTimeout(resolve, 90))
    await second.waitFor('controller', (message) => message.data?.reason === 'expired')

    second.ws.send(JSON.stringify({
      type: 'command',
      cmd: 'MAV_CMD_DO_SET_MODE',
      params: [1, 2, 0, 0, 0, 0, 0],
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
