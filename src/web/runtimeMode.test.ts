import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  startLocalRuntimeIfEnabled,
  isReadOnlyRuntime,
  resolveRuntimeMode,
  shouldStartLocalRuntime,
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

test('demo mode never starts the local runtime, live mode does', () => {
  assert.equal(shouldStartLocalRuntime('demo'), false)
  assert.equal(shouldStartLocalRuntime('live'), true)
  assert.equal(isReadOnlyRuntime('demo'), true)
  assert.equal(isReadOnlyRuntime('live'), false)
})

test('disabled runtime lifecycle never invokes the local runtime connector', () => {
  let connectionAttempts = 0
  const started = startLocalRuntimeIfEnabled(
    shouldStartLocalRuntime('demo'),
    () => { connectionAttempts += 1 },
  )
  assert.equal(started, false)
  assert.equal(connectionAttempts, 0)
})

test('enabled runtime lifecycle invokes the connector once', () => {
  let connectionAttempts = 0
  const started = startLocalRuntimeIfEnabled(
    shouldStartLocalRuntime('live'),
    () => { connectionAttempts += 1 },
  )
  assert.equal(started, true)
  assert.equal(connectionAttempts, 1)
})

test('live runtime has no demo interceptor: sendRuntimeCommand cannot fake delivery', async () => {
  // Without startDemoMode (never called in live builds), no client-message
  // interceptor is registered and no local runtime exists, so every send fails
  // rather than being silently absorbed as a fake success.
  const { sendRuntimeCommand } = await import('./hooks/useLocalRuntime')
  assert.equal(
    sendRuntimeCommand({ type: 'start_calibration', requestId: 'x', data: { kind: 'accel' } }),
    false,
  )
  assert.equal(sendRuntimeCommand({ type: 'param_request_list' }), false)
})
