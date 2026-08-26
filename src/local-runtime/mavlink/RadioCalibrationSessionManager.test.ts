import assert from 'node:assert/strict'
import test from 'node:test'
import type { RcChannelsData, RuntimeEvent } from '../../shared/types'
import { RadioCalibrationSessionManager } from './RadioCalibrationSessionManager'

function rc(values: number[]): RcChannelsData {
  const data = { rssi: 100 } as RcChannelsData
  for (let index = 0; index < 18; index += 1) {
    ;(data as unknown as Record<string, number | null>)[`ch${index + 1}`] = values[index] ?? null
  }
  return data
}

test('radio calibration detects mappings and writes only after review', () => {
  let now = 1_000
  const messages: RuntimeEvent[] = []
  let applied = 0
  const manager = new RadioCalibrationSessionManager({
    now: () => now,
    broadcast: (message) => messages.push(message),
    emitToClient: (_clientId, message) => messages.push(message),
    pinController: () => {}, releaseController: () => {}, notifyCalibration: () => {},
    getVehicleContext: () => ({ fingerprint: 'vehicle-a', ready: true, armed: false }),
    applyCalibration: (_requestId, channels, mapped, _fingerprint, completion) => {
      applied += 1
      assert.deepEqual(mapped, { throttle: 3, yaw: 4, roll: 1, pitch: 2 })
      assert.equal(channels.length, 4)
      completion(true)
    },
  })
  const feedStable = (values: number[]) => {
    for (let index = 0; index < 3; index += 1) { now += 30; manager.handleRcChannels(rc(values)) }
  }
  const advance = () => {
    const snapshot = [...messages].reverse().find((message): message is Extract<RuntimeEvent, { type: 'radio_calibration_snapshot' }> => message.type === 'radio_calibration_snapshot')!
    manager.advance('owner', { requestId: `next-${now}`, data: { sessionId: snapshot.data.sessionId } })
  }

  manager.handleRcChannels(rc([1500, 1500, 1000, 1500]))
  manager.requestStart('owner', { requestId: 'start', data: { transmitterMode: 2 } })
  feedStable([1500, 1500, 1000, 1500]); advance()
  feedStable([1500, 1500, 2000, 1500]); advance()
  feedStable([1500, 1500, 1000, 1500]); advance()
  feedStable([1500, 1500, 1000, 2000]); advance()
  feedStable([1500, 1500, 1000, 1000]); advance()
  feedStable([2000, 1500, 1000, 1500]); advance()
  feedStable([1000, 1500, 1000, 1500]); advance()
  feedStable([1500, 2000, 1000, 1500]); advance()
  feedStable([1500, 1000, 1000, 1500]); advance()
  manager.handleRcChannels(rc([1000, 1000, 1000, 1000]))
  manager.handleRcChannels(rc([2000, 2000, 2000, 2000]))
  now += 600
  feedStable([1500, 1500, 1000, 1500]); advance()
  assert.equal(applied, 0)
  advance()
  assert.equal(applied, 1)
  const terminal = [...messages].reverse().find((message): message is Extract<RuntimeEvent, { type: 'radio_calibration_snapshot' }> => message.type === 'radio_calibration_snapshot')!
  assert.equal(terminal.data.phase, 'done')
})

test('cancelled radio calibration never applies parameters', () => {
  const messages: RuntimeEvent[] = []
  let applied = false
  const manager = new RadioCalibrationSessionManager({
    broadcast: (message) => messages.push(message), emitToClient: (_id, message) => messages.push(message),
    pinController: () => {}, releaseController: () => {}, notifyCalibration: () => {},
    getVehicleContext: () => ({ fingerprint: 'vehicle-a', ready: true, armed: false }),
    applyCalibration: () => { applied = true },
  })
  manager.handleRcChannels(rc([1500, 1500, 1000, 1500]))
  manager.requestStart('owner', { requestId: 'start', data: { transmitterMode: 2 } })
  const started = messages.find((message): message is Extract<RuntimeEvent, { type: 'radio_calibration_started' }> => message.type === 'radio_calibration_started')!
  manager.cancel('owner', { requestId: 'cancel', data: { sessionId: started.data.sessionId } })
  assert.equal(applied, false)
  const terminal = [...messages].reverse().find((message): message is Extract<RuntimeEvent, { type: 'radio_calibration_snapshot' }> => message.type === 'radio_calibration_snapshot')!
  assert.equal(terminal.data.phase, 'cancelled')
})

test('radio calibration rejects stale samples and terminates on target, ready, or armed boundaries', () => {
  let now = 20_000
  let context = { fingerprint: 'vehicle-a', ready: true, armed: false as boolean | null }
  const messages: RuntimeEvent[] = []
  let applied = 0
  const manager = new RadioCalibrationSessionManager({
    now: () => now,
    broadcast: (message) => messages.push(message),
    emitToClient: (_clientId, message) => messages.push(message),
    pinController: () => {},
    releaseController: () => {},
    notifyCalibration: () => {},
    getVehicleContext: () => context,
    applyCalibration: () => { applied += 1 },
  })

  manager.handleRcChannels(rc([1500, 1500, 1000, 1500]))
  now += 2_000
  manager.requestStart('owner', { requestId: 'stale-start', data: { transmitterMode: 2 } })
  assert.ok(messages.some((message) => message.type === 'operation_error'
    && message.data.requestId === 'stale-start'
    && message.data.code === 'rc_sample_stale'))

  manager.handleRcChannels(rc([1500, 1500, 1000, 1500]))
  manager.requestStart('owner', { requestId: 'fresh-start', data: { transmitterMode: 2 } })
  const started = messages.find((message): message is Extract<RuntimeEvent, { type: 'radio_calibration_started' }> => (
    message.type === 'radio_calibration_started' && message.data.requestId === 'fresh-start'
  ))!
  context = { ...context, fingerprint: 'vehicle-b' }
  manager.advance('owner', { requestId: 'after-target-change', data: { sessionId: started.data.sessionId } })
  const targetTerminal = [...messages].reverse().find((message): message is Extract<RuntimeEvent, { type: 'radio_calibration_snapshot' }> => message.type === 'radio_calibration_snapshot')!
  assert.equal(targetTerminal.data.phase, 'failed')
  assert.equal(targetTerminal.data.failureCode, 'safety_context_changed')
  assert.equal(applied, 0)

  context = { fingerprint: 'vehicle-c', ready: true, armed: false }
  manager.handleRcChannels(rc([1500, 1500, 1000, 1500]))
  manager.requestStart('owner', { requestId: 'armed-start', data: { transmitterMode: 2 } })
  context = { ...context, armed: true }
  manager.handleVehicleSafetyBoundary('vehicle_armed')
  const armedTerminal = [...messages].reverse().find((message): message is Extract<RuntimeEvent, { type: 'radio_calibration_snapshot' }> => message.type === 'radio_calibration_snapshot')!
  assert.equal(armedTerminal.data.phase, 'failed')
  assert.equal(armedTerminal.data.failureCode, 'vehicle_armed')

  context = { fingerprint: 'vehicle-d', ready: true, armed: false }
  manager.handleRcChannels(rc([1500, 1500, 1000, 1500]))
  manager.requestStart('owner', { requestId: 'ready-transition-start', data: { transmitterMode: 2 } })
  context = { ...context, ready: false }
  manager.handleVehicleSafetyBoundary('vehicle_not_ready')
  const readyTerminal = [...messages].reverse().find((message): message is Extract<RuntimeEvent, { type: 'radio_calibration_snapshot' }> => message.type === 'radio_calibration_snapshot')!
  assert.equal(readyTerminal.data.phase, 'failed')
  assert.equal(readyTerminal.data.failureCode, 'vehicle_not_ready')

  context = { fingerprint: 'vehicle-e', ready: false, armed: false }
  manager.handleRcChannels(rc([1500, 1500, 1000, 1500]))
  manager.requestStart('owner', { requestId: 'not-ready-start', data: { transmitterMode: 2 } })
  assert.ok(messages.some((message) => message.type === 'operation_error'
    && message.data.requestId === 'not-ready-start'
    && message.data.code === 'safety_context_unavailable'))
})
