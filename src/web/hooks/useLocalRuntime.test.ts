import assert from 'node:assert/strict'
import test from 'node:test'
import type { RuntimeEvent } from '../../shared/types'
import { useConnectionStore } from '../stores/connectionStore'
import { useParameterStore } from '../stores/parameterStore'
import { handleMessage, processRuntimeEvent } from './useLocalRuntime'

const connectionEvent = (vehicleReady: boolean): RuntimeEvent => ({
  type: 'connection',
  data: {
    connected: true,
    status: 'connected',
    transportOpen: true,
    vehicleReady,
    rawSessionActive: false,
    safetyEpoch: 1,
    safetyAuthorityId: '00000000-0000-4000-8000-000000000001',
    port: 'local-test-port',
    type: 'serial',
    baudRate: 115200,
  },
})

test('a soft vehicle-readiness loss preserves parameters across heartbeat recovery', () => {
  useConnectionStore.getState().setDisconnected()
  useParameterStore.getState().clear()
  handleMessage(connectionEvent(true))
  useParameterStore.getState().addParam({ id: 'TEST_PARAM', value: 1, type: 9, param_count: 1, param_index: 0 })
  handleMessage(connectionEvent(false))
  assert.equal(useConnectionStore.getState().transportOpen, true)
  assert.equal(useParameterStore.getState().params.has('TEST_PARAM'), true)
  handleMessage(connectionEvent(true))
  assert.equal(useParameterStore.getState().params.has('TEST_PARAM'), true)
})

test('runtime parse and handler failures are isolated from later events', () => {
  const errors: unknown[][] = []
  const originalError = console.error
  console.error = (...args: unknown[]) => { errors.push(args) }
  try {
    processRuntimeEvent('{')
    processRuntimeEvent('{"type":"connection"}')
    processRuntimeEvent(JSON.stringify(connectionEvent(true)))
  } finally {
    console.error = originalError
  }
  assert.equal(errors.length, 2)
  assert.equal(useConnectionStore.getState().vehicleReady, true)
})

test('local safety authority changes update epoch without a cross-browser lease', () => {
  handleMessage({
    type: 'safety_authority',
    data: {
      safetyEpoch: 8,
      safetyAuthorityId: '00000000-0000-4000-8000-000000000008',
      reason: 'safety_changed',
    },
  })
  const state = useConnectionStore.getState()
  assert.equal(state.safetyEpoch, 8)
  assert.equal(state.safetyAuthorityId, '00000000-0000-4000-8000-000000000008')
})
