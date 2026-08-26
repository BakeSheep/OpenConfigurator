import assert from 'node:assert/strict'
import test from 'node:test'
import { ESC_SESSION_SAFETY_CONFIRMATION } from '../shared/esc'
import type { RuntimeEvent } from '../shared/types'
import { LocalRuntimeCoordinator } from './LocalRuntimeCoordinator'
import { ByteBuffer } from './platform/ByteBuffer'

type InjectableBridge = {
  handleMessage(message: {
    msgId: number
    payload: ByteBuffer
    seq: number
    sysId: number
    compId: number
    version: 2
  }): void
}

function heartbeatPayload(): ByteBuffer {
  const payload = ByteBuffer.alloc(9)
  payload.writeUInt32LE(0x03040000, 0)
  payload[4] = 2
  payload[5] = 12
  payload[7] = 4
  payload[8] = 3
  return payload
}

function paramValuePayload(id: string, value: number, type = 5): ByteBuffer {
  const payload = ByteBuffer.alloc(25)
  payload.writeInt32LE(value, 0)
  payload.writeUInt16LE(1, 4)
  payload.writeUInt16LE(0, 6)
  ByteBuffer.from(id, 'ascii').copy(payload, 8, 0, 16)
  payload[24] = type
  return payload
}

function messageId(frame: Uint8Array): number {
  return frame[0] === 0xfd
    ? frame[7] | (frame[8] << 8) | (frame[9] << 16)
    : frame[5]
}

test('coordinator wires live safety authority into parameter and ESC guards', async () => {
  const events: RuntimeEvent[] = []
  const writes: Uint8Array[] = []
  const coordinator = new LocalRuntimeCoordinator({
    emit: (event) => events.push(event),
    write: (data) => {
      writes.push(data)
      return true
    },
    cancelQueuedWrites: () => 0,
  })

  try {
    coordinator.open(
      { type: 'serial', port: 'test-port', baudRate: 115200 },
      { protocol: 'v2' },
    )
    const bridge = (coordinator as unknown as { bridge: InjectableBridge }).bridge
    const inject = (msgId: number, payload: ByteBuffer) => bridge.handleMessage({
      msgId,
      payload,
      seq: 0,
      sysId: 42,
      compId: 1,
      version: 2,
    })

    inject(0, heartbeatPayload())
    inject(0, heartbeatPayload())
    inject(0, heartbeatPayload())
    inject(22, paramValuePayload('CBRK_IO_SAFETY', 0))

    const target = [...events].reverse().find((event): event is Extract<RuntimeEvent, { type: 'target' }> =>
      event.type === 'target' && event.data.ready)
    assert.ok(target?.data.safetyEpoch)
    assert.ok(target.data.safetyAuthorityId)

    const paramFramesBefore = writes.filter((frame) => messageId(frame) === 23).length
    coordinator.handleCommand({
      type: 'param_set',
      requestId: 'sensitive-write',
      safetyConfirmation: 'sensitive_param',
      expectedSafetyEpoch: target.data.safetyEpoch,
      expectedSafetyAuthorityId: target.data.safetyAuthorityId,
      data: { id: 'CBRK_IO_SAFETY', value: 1, paramType: 5 },
    })
    assert.equal(writes.filter((frame) => messageId(frame) === 23).length, paramFramesBefore + 1)

    coordinator.handleCommand({
      type: 'esc_session_start',
      requestId: 'unsafe-direct-reuse',
      safetyConfirmation: ESC_SESSION_SAFETY_CONFIRMATION,
      expectedSafetyEpoch: target.data.safetyEpoch,
      expectedSafetyAuthorityId: target.data.safetyAuthorityId,
      data: { mode: 'direct' },
    })
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    const escError = [...events].reverse().find((event): event is Extract<RuntimeEvent, { type: 'esc_op_error' }> =>
      event.type === 'esc_op_error')
    assert.equal(escError?.data.code, 'precondition_failed')
  } finally {
    coordinator.destroy()
  }
})
