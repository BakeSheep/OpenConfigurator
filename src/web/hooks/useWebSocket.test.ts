import assert from 'node:assert/strict'
import test from 'node:test'
import type { ServerMessage } from '../../shared/types'
import { useConnectionStore } from '../stores/connectionStore'
import { useAutotuneStore } from '../stores/autotuneStore'
import { useParameterStore } from '../stores/parameterStore'
import { connectSocket, handleMessage, processServerMessage } from './useWebSocket'

const connectionMessage = (vehicleReady: boolean): ServerMessage => ({
  type: 'connection',
  data: {
    connected: true,
    status: 'connected',
    transportOpen: true,
    vehicleReady,
    rawSessionActive: false,
    safetyEpoch: 1,
    safetyAuthorityId: '00000000-0000-4000-8000-000000000001',
    port: 'COM_TEST',
    type: 'serial',
    baudRate: 115200,
  },
})

test('a soft vehicle-readiness loss preserves parameters across heartbeat recovery', () => {
  useConnectionStore.getState().setDisconnected()
  useParameterStore.getState().clear()

  handleMessage(connectionMessage(true))
  useParameterStore.getState().addParam({
    id: 'TEST_PARAM',
    value: 1,
    type: 9,
    param_count: 1,
    param_index: 0,
  })

  handleMessage(connectionMessage(false))
  assert.equal(useConnectionStore.getState().transportOpen, true)
  assert.equal(useConnectionStore.getState().vehicleReady, false)
  assert.equal(useParameterStore.getState().params.has('TEST_PARAM'), true)

  handleMessage(connectionMessage(true))
  assert.equal(useParameterStore.getState().params.has('TEST_PARAM'), true)
})

test('parse and handler failures are isolated from later WebSocket messages', () => {
  const errors: unknown[][] = []
  const originalError = console.error
  console.error = (...args: unknown[]) => { errors.push(args) }
  try {
    processServerMessage('{')
    processServerMessage('{"type":"connection"}')
    processServerMessage(JSON.stringify(connectionMessage(true)))
  } finally {
    console.error = originalError
  }

  assert.equal(errors.length, 2)
  assert.match(String(errors[0][0]), /Parse error/)
  assert.match(String(errors[1][0]), /Message handler error/)
  assert.equal(useConnectionStore.getState().vehicleReady, true)
})

test('autotune snapshots dispatch to the persistent session store', () => {
  useAutotuneStore.getState().reset()
  handleMessage({
    type: 'autotune_update',
    data: {
      sessionId: 'autotune-ws', seq: 1, requestId: 'autotune-request',
      ownerClientId: 'client-a', recoverUntil: null, family: 'px4', phase: 'tuning',
      verification: 'not_applicable', progress: 40, axis: 'pitch', initialModeId: 3,
      updatedAt: 1, cancelSupported: false, baselineParameters: { MC_ROLLRATE_P: 0.1 },
    },
  })
  assert.equal(useAutotuneStore.getState().snapshot?.sessionId, 'autotune-ws')
  assert.equal(useAutotuneStore.getState().snapshot?.progress, 40)
})

test('a retryable rejection restarts the automatic parameter request', async () => {
  const originalWindow = globalThis.window
  const originalWebSocket = globalThis.WebSocket

  class FakeWebSocket {
    static readonly CONNECTING = 0
    static readonly OPEN = 1
    static readonly CLOSING = 2
    static readonly CLOSED = 3
    static instance: FakeWebSocket | null = null

    readyState = FakeWebSocket.CONNECTING
    sent: string[] = []
    onopen: (() => void) | null = null
    onmessage: ((event: { data: string }) => void) | null = null
    onclose: (() => void) | null = null
    onerror: (() => void) | null = null

    constructor(readonly url: string) {
      FakeWebSocket.instance = this
    }

    open() {
      this.readyState = FakeWebSocket.OPEN
      this.onopen?.()
    }

    receive(message: ServerMessage) {
      this.onmessage?.({ data: JSON.stringify(message) })
    }

    send(data: string) {
      this.sent.push(data)
    }

    close() {
      if (this.readyState === FakeWebSocket.CLOSED) return
      this.readyState = FakeWebSocket.CLOSED
      this.onclose?.()
    }
  }

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location: { protocol: 'http:', hostname: 'localhost', port: '5173' } },
  })
  Object.defineProperty(globalThis, 'WebSocket', {
    configurable: true,
    value: FakeWebSocket,
  })

  try {
    // Reset the module-level readiness edge left by earlier message-handler
    // tests, then provide the same snapshot sequence as a live WebSocket join.
    handleMessage({
      type: 'connection',
      data: {
        connected: false,
        status: 'disconnected',
        transportOpen: false,
        vehicleReady: false,
        rawSessionActive: false,
        safetyEpoch: 2,
        safetyAuthorityId: '00000000-0000-4000-8000-000000000002',
      },
    })

    connectSocket()
    const socket = FakeWebSocket.instance
    assert.ok(socket)
    socket.open()
    socket.receive({
      type: 'hello',
      data: {
        protocolVersion: 1,
        clientId: 'auto-client',
        restControlToken: 'test-token',
        capabilities: [],
        maxPayload: 1024,
        controllerLeaseMs: 10_000,
        safetyEpoch: 2,
        safetyAuthorityId: '00000000-0000-4000-8000-000000000002',
      },
    })
    // A real serial connection reports transport-open before the first
    // heartbeat makes the vehicle ready. This must not be mistaken for a soft
    // readiness loss from an already-synchronized vehicle.
    socket.receive(connectionMessage(false))
    socket.receive(connectionMessage(true))
    socket.receive({
      type: 'target',
      data: {
        systemId: 1,
        componentId: 1,
        ready: true,
        reason: 'selected',
        identity: null,
      },
    })
    socket.receive({
      type: 'controller',
      data: {
        clientId: null,
        expiresAt: null,
        safetyEpoch: 2,
        safetyAuthorityId: '00000000-0000-4000-8000-000000000002',
        reason: 'snapshot',
      },
    })

    await new Promise((resolve) => setTimeout(resolve, 360))
    assert.equal(socket.sent.length, 1)
    const firstRequest = JSON.parse(socket.sent[0]) as { type: string; requestId?: string }
    assert.equal(firstRequest.type, 'param_request_list')
    assert.match(firstRequest.requestId ?? '', /^auto-param-/)

    socket.receive({
      type: 'client_error',
      data: {
        code: 'target_not_ready',
        message: '目标尚未就绪',
        requestId: firstRequest.requestId,
        retryable: true,
      },
    })

    await new Promise((resolve) => setTimeout(resolve, 820))
    assert.equal(socket.sent.length, 2)
    const secondRequest = JSON.parse(socket.sent[1]) as { type: string; requestId?: string }
    assert.equal(secondRequest.type, 'param_request_list')
    assert.notEqual(secondRequest.requestId, firstRequest.requestId)

    // Bridge-level transient failures arrive after the generation has started
    // (for example when a log/FTP transfer briefly owns the MAVLink channel).
    socket.receive({
      type: 'param_sync',
      data: {
        generation: 4,
        status: 'started',
        ownerClientId: 'auto-client',
      },
    })
    socket.receive({
      type: 'operation_error',
      generation: 4,
      data: {
        operation: 'param_request_list',
        code: 'ftp_busy',
        message: '文件传输正在进行',
        requestId: secondRequest.requestId,
        retryable: true,
      },
    })
    socket.receive({
      type: 'param_sync',
      data: {
        generation: 4,
        status: 'failed',
        ownerClientId: 'auto-client',
        reason: 'bridge_rejected',
      },
    })

    await new Promise((resolve) => setTimeout(resolve, 820))
    assert.equal(socket.sent.length, 3)
    const thirdRequest = JSON.parse(socket.sent[2]) as { type: string; requestId?: string }
    assert.equal(thirdRequest.type, 'param_request_list')

    // A successful generation closes the automatic state so later snapshots
    // cannot accidentally repeat a completed full parameter download.
    socket.receive({
      type: 'param_sync',
      data: {
        generation: 5,
        status: 'started',
        ownerClientId: 'auto-client',
      },
    })
    socket.receive({
      type: 'param_complete',
      generation: 5,
      data: { count: 1 },
    })
    socket.receive({
      type: 'param_sync',
      data: {
        generation: 5,
        status: 'complete',
        ownerClientId: 'auto-client',
      },
    })
    assert.equal(useParameterStore.getState().loading, false)
    assert.equal(socket.sent.length, 3)
  } finally {
    FakeWebSocket.instance?.close()
    Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow })
    Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: originalWebSocket })
  }
})
