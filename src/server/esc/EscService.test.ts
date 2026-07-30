// Boundary + orchestration tests for the ESC service and its WS message
// validation: parse guards, ownership, ready-target policy, and the ArduPilot
// scan path vs the not-yet-supported direct/PX4 detection.
// Run directly: tsx src/server/esc/EscService.test.ts
import assert from 'node:assert/strict'
import { crc16Xmodem, EscError, type EscSessionSnapshot } from '../../shared/esc'
import type { ClientMessage, ServerMessage } from '../../shared/types'
import { InputValidationError, parseClientMessage } from '../validation'
import type { ConnectionManager } from '../connection/ConnectionManager'
import type { MavlinkBridge } from '../mavlink/MavlinkBridge'
import { EscService } from './EscService'
import type { EscByteTransport, EscTransactionOptions, EscTransportTarget } from './EscByteTransport'
import { FOUR_WAY_ACK, FOUR_WAY_COMMANDS, FOUR_WAY_START } from './fourWay'
import { mspChecksum, MSP_COMMANDS } from './msp'

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function expectValidationFail(input: unknown, label: string): void {
  assert.throws(
    () => parseClientMessage(input),
    (error: unknown) => error instanceof InputValidationError,
    label,
  )
}

// ---------------------------------------------------------------------------
// Validation of esc_* client messages.
// ---------------------------------------------------------------------------
function validationTests(): void {
  // Valid messages parse.
  const ardu = parseClientMessage({ type: 'esc_session_start', data: { mode: 'ardupilot_passthrough' } }) as ClientMessage
  assert.equal(ardu.type, 'esc_session_start')
  const px4 = parseClientMessage({ type: 'esc_session_start', data: { mode: 'px4_serial_control', channels: [20, 21] } })
  assert.equal(px4.type, 'esc_session_start')
  const direct = parseClientMessage({ type: 'esc_session_start', data: { mode: 'direct', port: 'COM9' } })
  assert.deepEqual((direct as { data: unknown }).data, { mode: 'direct', port: 'COM9', baudRate: 19200 })

  const sid = 'abcd1234-0000'
  parseClientMessage({ type: 'esc_session_exit', data: { sessionId: sid } })
  parseClientMessage({ type: 'esc_devices_scan', data: { sessionId: sid } })
  parseClientMessage({ type: 'esc_settings_read', data: { sessionId: sid, targets: 'all' } })
  parseClientMessage({ type: 'esc_settings_read', data: { sessionId: sid, targets: [0, 1, 2] } })
  parseClientMessage({
    type: 'esc_flash_start',
    data: { sessionId: sid, targets: [0], assetId: 'asset-123', safetyConfirmation: 'flash_esc_props_removed' },
  })

  // Rejections.
  expectValidationFail({ type: 'esc_session_start', data: { mode: 'nope' } }, 'bad mode')
  expectValidationFail({ type: 'esc_session_start', data: { mode: 'px4_serial_control', channels: [19] } }, 'channel below range')
  expectValidationFail({ type: 'esc_session_start', data: { mode: 'px4_serial_control', channels: [28] } }, 'channel above range')
  expectValidationFail({ type: 'esc_session_start', data: { mode: 'direct', port: 'COM9', baudRate: 57600 } }, 'wrong baud')
  expectValidationFail({ type: 'esc_session_start', data: { mode: 'direct', port: '' } }, 'empty port')
  expectValidationFail({ type: 'esc_settings_read', data: { sessionId: sid, targets: [0, 0] } }, 'duplicate targets')
  expectValidationFail({ type: 'esc_settings_read', data: { sessionId: sid, targets: [] } }, 'empty targets')
  expectValidationFail({ type: 'esc_settings_read', data: { sessionId: 'short', targets: 'all' } }, 'short sessionId')
  expectValidationFail(
    { type: 'esc_flash_start', data: { sessionId: sid, targets: [0], assetId: 'a' } },
    'missing safety confirmation',
  )
  expectValidationFail(
    { type: 'esc_flash_start', data: { sessionId: sid, targets: [0], assetId: 'a', safetyConfirmation: 'nope' } },
    'wrong safety literal',
  )
  expectValidationFail(
    { type: 'esc_session_reclaim', data: { sessionId: sid, recoveryToken: 'short' } },
    'short recovery token',
  )

  console.log('ESC message validation checks passed')
}

// ---------------------------------------------------------------------------
// Orchestration with a scripted transport.
// ---------------------------------------------------------------------------
function fourWayResponse(command: number, params: number[], ack: number = FOUR_WAY_ACK.OK): Uint8Array {
  const head = Uint8Array.of(FOUR_WAY_START, command, 0, 0, params.length, ...params, ack)
  const crc = crc16Xmodem(head)
  return Uint8Array.of(...head, (crc >> 8) & 0xff, crc & 0xff)
}

function mspResponse(command: number, payload: number[]): Uint8Array {
  const crc = mspChecksum(command, Uint8Array.from(payload))
  return Uint8Array.of(0x24, 0x4d, 0x3e, payload.length, command, ...payload, crc)
}

class ScriptedTransport implements EscByteTransport {
  readonly capabilities = { read: true, write: false, flash: false, melody: false }
  constructor(readonly kind: EscByteTransport['kind']) {}
  async open(_t: EscTransportTarget, _s: AbortSignal): Promise<void> {}
  async transact(request: Uint8Array, options: EscTransactionOptions, _signal: AbortSignal): Promise<Uint8Array> {
    let reply: Uint8Array
    if (request[0] === 0x24) {
      // MSP: reply to SET_PASSTHROUGH with a 2-ESC count.
      const command = request[4]
      reply = command === MSP_COMMANDS.SET_PASSTHROUGH ? mspResponse(command, [2]) : mspResponse(command, [])
    } else {
      const command = request[1]
      reply = command === FOUR_WAY_COMMANDS.DeviceInitFlash
        ? fourWayResponse(command, [0x00, 0x00, 0x00, 4]) // ARM/AM32
        : fourWayResponse(command, [0])
    }
    const length = options.frameLength(reply)
    if (length === null) throw new EscError('timeout', 'partial frame')
    return reply.subarray(0, length)
  }
  async close(_reason: string): Promise<void> {}
  onAborted(_listener: (error: EscError) => void): () => void {
    return () => {}
  }
}

function createService(kind: EscByteTransport['kind']) {
  const emitted: ServerMessage[] = []
  const pins: Array<{ clientId: string; sessionId: string }> = []
  const releases: string[] = []
  const service = new EscService({
    connManager: {} as unknown as ConnectionManager,
    bridge: {} as unknown as MavlinkBridge,
    emit: (message) => emitted.push(message),
    pinController: (clientId, sessionId) => pins.push({ clientId, sessionId }),
    releaseController: (sessionId) => releases.push(sessionId),
    transportFactory: () => new ScriptedTransport(kind),
    idleTimeoutMs: 60_000,
    orphanGraceMs: 60_000,
  })
  return { service, emitted, pins, releases }
}

function lastSession(emitted: ServerMessage[]): EscSessionSnapshot | undefined {
  for (let i = emitted.length - 1; i >= 0; i--) {
    if (emitted[i].type === 'esc_session') return (emitted[i] as { data: EscSessionSnapshot }).data
  }
  return undefined
}

async function orchestrationTests(): Promise<void> {
  // ArduPilot: start auto-scans and emits esc_devices with classified ESCs.
  {
    const { service, emitted, pins } = createService('ardupilot_raw')
    await service.handleClientMessage('client-a', {
      type: 'esc_session_start',
      data: { mode: 'ardupilot_passthrough' },
    })
    await wait(10)
    const session = lastSession(emitted)
    assert.ok(session && session.state === 'active')
    assert.equal(session.mode, 'ardupilot_passthrough')
    assert.equal(pins.length >= 1, true)
    const devices = emitted.find((m) => m.type === 'esc_devices') as
      | { data: { escs: unknown[] } }
      | undefined
    assert.ok(devices, 'esc_devices emitted')
    assert.equal(devices.data.escs.length, 2, 'passthrough reported 2 ESCs')

    // Non-owner cannot exit; owner can.
    await service.handleClientMessage('intruder', {
      type: 'esc_session_exit',
      data: { sessionId: session.sessionId! },
    })
    const notOwner = emitted.find((m) => m.type === 'esc_op_error'
      && (m as { data: { code: string } }).data.code === 'not_owner')
    assert.ok(notOwner, 'non-owner exit rejected with not_owner')
    assert.equal(service.snapshot().state, 'active', 'session survives non-owner exit')

    await service.handleClientMessage('client-a', {
      type: 'esc_session_exit',
      data: { sessionId: session.sessionId! },
    })
    assert.equal(service.snapshot().state, 'idle')
    await service.destroy()
  }

  // A second start while one session lives is rejected.
  {
    const { service, emitted } = createService('ardupilot_raw')
    await service.handleClientMessage('client-a', { type: 'esc_session_start', data: { mode: 'ardupilot_passthrough' } })
    await wait(10)
    await service.handleClientMessage('client-b', { type: 'esc_session_start', data: { mode: 'ardupilot_passthrough' } })
    const conflict = emitted.find((m) => m.type === 'esc_op_error'
      && (m as { data: { code: string } }).data.code === 'session_exists')
    assert.ok(conflict, 'second session rejected with session_exists')
    await service.destroy()
  }

  // Direct scan reports not_supported (AM32 bootloader detection pending).
  {
    const { service, emitted } = createService('direct')
    await service.handleClientMessage('client-a', { type: 'esc_session_start', data: { mode: 'direct', port: 'COM9', baudRate: 19200 } })
    await wait(10)
    const notSupported = emitted.find((m) => m.type === 'esc_op_error'
      && (m as { data: { code: string } }).data.code === 'not_supported')
    assert.ok(notSupported, 'direct scan reports not_supported for now')
    // The session itself stays active (transport opened successfully).
    assert.equal(service.snapshot().state, 'active')
    await service.destroy()
  }

  console.log('ESC service orchestration checks passed')
}

async function run(): Promise<void> {
  validationTests()
  await orchestrationTests()
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
