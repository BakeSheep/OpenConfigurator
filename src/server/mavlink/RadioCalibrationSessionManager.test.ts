import assert from 'node:assert/strict'
import test from 'node:test'
import type { RcChannelsData, ServerMessage } from '../../shared/types'
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
  const messages: ServerMessage[] = []
  let applied = 0
  const manager = new RadioCalibrationSessionManager({
    now: () => now,
    broadcast: (message) => messages.push(message),
    emitToClient: (_clientId, message) => messages.push(message),
    pinController: () => {}, releaseController: () => {}, notifyCalibration: () => {},
    applyCalibration: (_requestId, channels, mapped, completion) => {
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
    const snapshot = [...messages].reverse().find((message): message is Extract<ServerMessage, { type: 'radio_calibration_snapshot' }> => message.type === 'radio_calibration_snapshot')!
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
  const terminal = [...messages].reverse().find((message): message is Extract<ServerMessage, { type: 'radio_calibration_snapshot' }> => message.type === 'radio_calibration_snapshot')!
  assert.equal(terminal.data.phase, 'done')
})

test('cancelled radio calibration never applies parameters', () => {
  const messages: ServerMessage[] = []
  let applied = false
  const manager = new RadioCalibrationSessionManager({
    broadcast: (message) => messages.push(message), emitToClient: (_id, message) => messages.push(message),
    pinController: () => {}, releaseController: () => {}, notifyCalibration: () => {},
    applyCalibration: () => { applied = true },
  })
  manager.handleRcChannels(rc([1500, 1500, 1000, 1500]))
  manager.requestStart('owner', { requestId: 'start', data: { transmitterMode: 2 } })
  const started = messages.find((message): message is Extract<ServerMessage, { type: 'radio_calibration_started' }> => message.type === 'radio_calibration_started')!
  manager.cancel('owner', { requestId: 'cancel', data: { sessionId: started.data.sessionId } })
  assert.equal(applied, false)
  const terminal = [...messages].reverse().find((message): message is Extract<ServerMessage, { type: 'radio_calibration_snapshot' }> => message.type === 'radio_calibration_snapshot')!
  assert.equal(terminal.data.phase, 'cancelled')
})

test('orphaned radio calibration can only be reclaimed with its recovery token', () => {
  let now = 10_000
  const messages: Array<{ clientId: string; message: ServerMessage }> = []
  const pinned: string[] = []
  const manager = new RadioCalibrationSessionManager({
    now: () => now,
    broadcast: (message) => messages.push({ clientId: '*', message }),
    emitToClient: (clientId, message) => messages.push({ clientId, message }),
    pinController: (clientId) => pinned.push(clientId),
    releaseController: () => {}, notifyCalibration: () => {}, applyCalibration: () => {},
  })
  manager.handleRcChannels(rc([1500, 1500, 1000, 1500]))
  manager.requestStart('owner-a', { requestId: 'start', data: { transmitterMode: 2 } })
  const startedEnvelope = messages.find(({ message }) => message.type === 'radio_calibration_started')
  assert.ok(startedEnvelope)
  const started = startedEnvelope.message
  assert.equal(started.type, 'radio_calibration_started')
  if (started.type !== 'radio_calibration_started') throw new Error('missing calibration start response')
  manager.handleClientDisconnected('owner-a')
  manager.reclaim('owner-b', { requestId: 'wrong', data: { sessionId: started.data.sessionId, recoveryToken: 'wrong-token' } })
  assert.equal(pinned.includes('owner-b'), false)
  now += 500
  manager.reclaim('owner-b', {
    requestId: 'reclaim',
    data: { sessionId: started.data.sessionId, recoveryToken: started.data.recoveryToken },
  })
  assert.equal(pinned[pinned.length - 1], 'owner-b')
  const reclaimed = messages.filter(({ clientId, message }) => clientId === 'owner-b' && message.type === 'radio_calibration_started')
  assert.equal(reclaimed.length, 1)
  manager.destroy()
})
