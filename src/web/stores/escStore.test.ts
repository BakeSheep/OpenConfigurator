// Reducer tests for the ESC store: session replacement, stale-event rejection,
// absolute progress, log ring buffer and reset semantics.
// Run directly: tsx src/web/stores/escStore.test.ts
import assert from 'node:assert/strict'
import { ESC_LOG_CAPACITY, type EscSessionSnapshot } from '../../shared/esc'
import { useEscStore } from './escStore'

function session(overrides: Partial<EscSessionSnapshot> = {}): EscSessionSnapshot {
  return {
    state: 'active',
    sessionId: 's1',
    mode: 'ardupilot_passthrough',
    ownerClientId: 'client-a',
    escCount: 0,
    activeJobId: null,
    recoverUntil: null,
    reason: null,
    capabilities: { read: true, write: false },
    ...overrides,
  }
}

function run(): void {
  const store = useEscStore.getState()
  store.reset()

  // Recovery credentials survive transient WebSocket-store resets.
  store.setRecovery({ sessionId: 's1', recoveryToken: '0123456789abcdef' })
  store.reset()
  assert.equal(useEscStore.getState().recovery?.sessionId, 's1')

  // Session snapshot replaces prior state.
  store.applySession(session())
  assert.equal(useEscStore.getState().session?.sessionId, 's1')

  // Devices for the active session are accepted.
  store.applyDevices('s1', [
    {
      index: 0,
      interfaceMode: 4,
      firmwareKind: 'am32',
      firmwareName: null,
      firmwareVersion: null,
      mcuSignature: null,
      mcuName: null,
      bootloaderVersion: null,
      layoutRevision: null,
      writable: false,
    },
  ])
  assert.equal(useEscStore.getState().devices.length, 1)

  // Stale device list from a different session id is ignored.
  store.applyDevices('other', [])
  assert.equal(useEscStore.getState().devices.length, 1, 'stale device list ignored')

  // Progress snapshots overwrite with absolute values.
  store.applyProgress({
    sessionId: 's1', jobId: 'j1', kind: 'settings_write', escIndex: 0, phase: 'write',
    bytesDone: 100, bytesTotal: 1000, currentTargetOrdinal: 1, targetCount: 1,
  })
  store.applyProgress({
    sessionId: 's1', jobId: 'j1', kind: 'settings_write', escIndex: 0, phase: 'verify',
    bytesDone: 500, bytesTotal: 1000, currentTargetOrdinal: 1, targetCount: 1,
  })
  assert.equal(useEscStore.getState().activeJob?.bytesDone, 500, 'progress is absolute')

  // Stale progress from another session is ignored.
  store.applyProgress({
    sessionId: 'other', jobId: 'jx', kind: 'settings_write', escIndex: 0, phase: 'write',
    bytesDone: 999, bytesTotal: 1000, currentTargetOrdinal: 1, targetCount: 1,
  })
  assert.equal(useEscStore.getState().activeJob?.bytesDone, 500, 'stale progress ignored')

  // Job done clears the active job without fabricating success/failure elsewhere.
  store.applyJobDone({ sessionId: 's1', jobId: 'j1', kind: 'settings_write', ok: true, perTarget: [] })
  assert.equal(useEscStore.getState().activeJob, null)
  assert.equal(useEscStore.getState().lastJobResult?.ok, true)

  // Changing session id invalidates devices/settings and stale errors.
  store.applyOpError({ operation: 'esc_devices_scan', code: 'timeout', message: 'old failure', retryable: true })
  store.applySession(session({ sessionId: 's2' }))
  assert.equal(useEscStore.getState().lastError, null, 'new session clears stale error')
  assert.equal(useEscStore.getState().devices.length, 0, 'new session clears devices')

  // Log ring buffer caps at ESC_LOG_CAPACITY.
  const entries = Array.from({ length: ESC_LOG_CAPACITY + 50 }, (_, i) => ({
    level: 'info' as const,
    text: `line ${i}`,
    timestamp: i,
  }))
  store.appendLog('s2', entries)
  const log = useEscStore.getState().log
  assert.equal(log.length, ESC_LOG_CAPACITY, 'log capped at capacity')
  assert.equal(log[log.length - 1].text, `line ${ESC_LOG_CAPACITY + 49}`, 'newest kept')

  // Idle session drops live job/device state without a job result.
  store.applyProgress({
    sessionId: 's2', jobId: 'j2', kind: 'scan', escIndex: null, phase: 'scan',
    bytesDone: 0, bytesTotal: 0, currentTargetOrdinal: 1, targetCount: 1,
  })
  store.applySession(session({ sessionId: 's2', state: 'idle', activeJobId: null, ownerClientId: null }))
  assert.equal(useEscStore.getState().activeJob, null, 'idle clears active job')
  assert.equal(useEscStore.getState().devices.length, 0)
  assert.equal(useEscStore.getState().recovery, null, 'idle clears recovery credential')

  // reset() returns to the pristine state.
  store.reset()
  assert.equal(useEscStore.getState().session, null)
  assert.equal(useEscStore.getState().log.length, 0)

  console.log('escStore reducer tests passed')
}

run()
