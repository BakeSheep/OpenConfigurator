import assert from 'node:assert/strict'
import test from 'node:test'
import type { ServerMessage } from '../../shared/types'
import { useConnectionStore } from '../stores/connectionStore'
import { useParameterStore } from '../stores/parameterStore'
import { handleMessage, processServerMessage } from './useWebSocket'

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
