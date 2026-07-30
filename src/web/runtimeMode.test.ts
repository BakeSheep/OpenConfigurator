import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  connectBackendIfEnabled,
  isReadOnlyRuntime,
  resolveRuntimeMode,
  shouldConnectBackend,
} from './runtimeMode'

test('VITE_APP_MODE=demo forces demo mode regardless of dev/query', () => {
  assert.equal(resolveRuntimeMode({ appMode: 'demo', dev: false, search: '' }), 'demo')
  assert.equal(resolveRuntimeMode({ appMode: 'demo', dev: true, search: '' }), 'demo')
})

test('dev builds honor the ?demo=1 query parameter', () => {
  assert.equal(resolveRuntimeMode({ appMode: undefined, dev: true, search: '?demo=1' }), 'demo')
  assert.equal(resolveRuntimeMode({ appMode: undefined, dev: true, search: '?demo' }), 'demo')
})

test('production builds ignore ?demo=1 - only the dedicated demo build may enable it', () => {
  assert.equal(resolveRuntimeMode({ appMode: undefined, dev: false, search: '?demo=1' }), 'live')
})

test('default is live mode', () => {
  assert.equal(resolveRuntimeMode({ appMode: undefined, dev: false, search: '' }), 'live')
  assert.equal(resolveRuntimeMode({ appMode: 'production', dev: false, search: '' }), 'live')
})

test('demo mode never connects to the backend, live mode does', () => {
  assert.equal(shouldConnectBackend('demo'), false)
  assert.equal(shouldConnectBackend('live'), true)
  assert.equal(isReadOnlyRuntime('demo'), true)
  assert.equal(isReadOnlyRuntime('live'), false)
})

test('disabled socket lifecycle never invokes the WebSocket connector', () => {
  let connectionAttempts = 0
  const started = connectBackendIfEnabled(
    shouldConnectBackend('demo'),
    () => { connectionAttempts += 1 },
  )
  assert.equal(started, false)
  assert.equal(connectionAttempts, 0)
})

test('enabled socket lifecycle invokes the connector once', () => {
  let connectionAttempts = 0
  const started = connectBackendIfEnabled(
    shouldConnectBackend('live'),
    () => { connectionAttempts += 1 },
  )
  assert.equal(started, true)
  assert.equal(connectionAttempts, 1)
})
