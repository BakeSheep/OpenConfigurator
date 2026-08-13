// Boundary + orchestration tests for the ESC service and its WS message
// validation: parse guards, ownership, ready-target policy, and the ArduPilot
// scan path vs the not-yet-supported direct/PX4 detection.
// Run directly: tsx src/server/esc/EscService.test.ts
import assert from 'node:assert/strict'
import {
  AM32_LAYOUT_SIZE,
  crc16Xmodem,
  EscError,
  ESC_SESSION_SAFETY_CONFIRMATION,
  type EscSessionSnapshot,
} from '../../shared/esc'
import type { ClientMessage, ServerMessage } from '../../shared/types'
import { InputValidationError, parseClientMessage } from '../validation'
import { buildVehicleIdentity } from '../../shared/vehicleProfiles'
import type { ConnectionManager } from '../connection/ConnectionManager'
import type { MavlinkBridge } from '../mavlink/MavlinkBridge'
import { EscService } from './EscService'
import type { EscByteTransport, EscTransactionOptions, EscTransportTarget } from './EscByteTransport'
import { FOUR_WAY_ACK, FOUR_WAY_COMMANDS, FOUR_WAY_RESPONSE_START } from './fourWay'
import { mspChecksum, MSP_COMMANDS } from './msp'

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const TEST_SAFETY_EXPECTATION = {
  expectedSafetyEpoch: 1,
  expectedSafetyAuthorityId: '00000000-0000-4000-8000-000000000001',
} as const

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
  const ardu = parseClientMessage({
    type: 'esc_session_start',
    safetyConfirmation: ESC_SESSION_SAFETY_CONFIRMATION,
    ...TEST_SAFETY_EXPECTATION,
    data: { mode: 'ardupilot_passthrough' },
  }) as ClientMessage
  assert.equal(ardu.type, 'esc_session_start')
  const px4 = parseClientMessage({
    type: 'esc_session_start',
    safetyConfirmation: ESC_SESSION_SAFETY_CONFIRMATION,
    ...TEST_SAFETY_EXPECTATION,
    data: { mode: 'px4_serial_control', channels: [20, 21] },
  })
  assert.equal(px4.type, 'esc_session_start')
  const direct = parseClientMessage({
    type: 'esc_session_start',
    safetyConfirmation: ESC_SESSION_SAFETY_CONFIRMATION,
    ...TEST_SAFETY_EXPECTATION,
    data: { mode: 'direct' },
  })
  assert.deepEqual((direct as { data: unknown }).data, { mode: 'direct' })

  const sid = 'abcd1234-0000'
  parseClientMessage({ type: 'esc_session_exit', data: { sessionId: sid } })
  parseClientMessage({ type: 'esc_devices_scan', data: { sessionId: sid } })
  parseClientMessage({ type: 'esc_settings_read', data: { sessionId: sid, targets: 'all' } })
  parseClientMessage({ type: 'esc_settings_read', data: { sessionId: sid, targets: [0, 1, 2] } })
  parseClientMessage({
    type: 'esc_settings_write',
    data: { sessionId: sid, targets: [0], values: { timingAdvance: 14.0625 } },
  })

  // Rejections.
  expectValidationFail(
    { type: 'esc_session_start', data: { mode: 'ardupilot_passthrough' } },
    'missing ESC safety confirmation',
  )
  expectValidationFail(
    {
      type: 'esc_session_start',
      safetyConfirmation: 'esc_props_removed',
      data: { mode: 'ardupilot_passthrough' },
    },
    'incomplete ESC safety confirmation',
  )
  expectValidationFail(
    {
      type: 'esc_session_start',
      safetyConfirmation: ESC_SESSION_SAFETY_CONFIRMATION,
      data: { mode: 'ardupilot_passthrough' },
    },
    'ESC safety confirmation without authority epoch',
  )
  expectValidationFail({ type: 'esc_session_start', safetyConfirmation: ESC_SESSION_SAFETY_CONFIRMATION, data: { mode: 'nope' } }, 'bad mode')
  expectValidationFail({ type: 'esc_session_start', safetyConfirmation: ESC_SESSION_SAFETY_CONFIRMATION, data: { mode: 'px4_serial_control', channels: [19] } }, 'channel below range')
  expectValidationFail({ type: 'esc_session_start', safetyConfirmation: ESC_SESSION_SAFETY_CONFIRMATION, data: { mode: 'px4_serial_control', channels: [28] } }, 'channel above range')
  expectValidationFail({ type: 'esc_session_start', safetyConfirmation: ESC_SESSION_SAFETY_CONFIRMATION, data: { mode: 'px4_serial_control', channels: [20, 20] } }, 'duplicate channels (L6)')
  expectValidationFail({ type: 'esc_settings_read', data: { sessionId: sid, targets: [0, 0] } }, 'duplicate targets')
  expectValidationFail({ type: 'esc_settings_read', data: { sessionId: sid, targets: [] } }, 'empty targets')
  expectValidationFail({ type: 'esc_settings_read', data: { sessionId: 'short', targets: 'all' } }, 'short sessionId')
  expectValidationFail(
    { type: 'esc_flash_start', data: { sessionId: sid, targets: [0], assetId: 'a' } },
    'firmware flashing is not part of the protocol',
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
function fourWayResponse(
  command: number,
  params: number[],
  ack: number = FOUR_WAY_ACK.OK,
  address = 0,
): Uint8Array {
  const head = Uint8Array.of(
    FOUR_WAY_RESPONSE_START,
    command,
    (address >> 8) & 0xff,
    address & 0xff,
    params.length === 256 ? 0 : params.length,
    ...params,
    ack,
  )
  const crc = crc16Xmodem(head)
  return Uint8Array.of(...head, (crc >> 8) & 0xff, crc & 0xff)
}

function mspResponse(command: number, payload: number[]): Uint8Array {
  const crc = mspChecksum(command, Uint8Array.from(payload))
  return Uint8Array.of(0x24, 0x4d, 0x3e, payload.length, command, ...payload, crc)
}

class ScriptedTransport implements EscByteTransport {
  readonly commands: number[] = []
  readonly mspCommands: number[] = []
  readonly initChannels: number[] = []
  readonly writeChannels: number[] = []
  readonly capabilities = { read: true, write: true }
  disconnectAfterFirstWrite: (() => void) | null = null
  failWriteChannel: number | null = null
  private selectedChannel = 0
  private readonly eepromByChannel = new Map<number, Uint8Array>()
  constructor(readonly kind: EscByteTransport['kind']) {}
  async open(_t: EscTransportTarget, _s: AbortSignal): Promise<void> {}
  async transact(request: Uint8Array, options: EscTransactionOptions, _signal: AbortSignal): Promise<Uint8Array> {
    let reply: Uint8Array
    if (request[0] === 0x24) {
      // MSP: reply to SET_PASSTHROUGH with a 2-ESC count.
      const command = request[4]
      this.mspCommands.push(command)
      reply = command === MSP_COMMANDS.SET_PASSTHROUGH ? mspResponse(command, [2]) : mspResponse(command, [])
    } else {
      const command = request[1]
      const address = (request[2] << 8) | request[3]
      this.commands.push(command)
      if (command === FOUR_WAY_COMMANDS.DeviceInitFlash) {
        this.selectedChannel = request[5]
        this.initChannels.push(this.selectedChannel)
        reply = fourWayResponse(command, [0x06, 0x1f, 0x00, 4], FOUR_WAY_ACK.OK, address)
      } else if (command === FOUR_WAY_COMMANDS.DeviceRead) {
        const length = request[5] === 0 ? 256 : request[5]
        if (address === 0x7be0) {
          const name = new Uint8Array(length)
          name.set(new TextEncoder().encode('AM32'))
          reply = fourWayResponse(command, [...name], FOUR_WAY_ACK.OK, address)
        } else {
          let raw = this.eepromByChannel.get(this.selectedChannel)
          if (!raw) {
            raw = new Uint8Array(AM32_LAYOUT_SIZE)
            raw[0x01] = 3
            this.eepromByChannel.set(this.selectedChannel, raw)
          }
          reply = fourWayResponse(command, [...raw.subarray(0, length)], FOUR_WAY_ACK.OK, address)
        }
      } else if (command === FOUR_WAY_COMMANDS.DeviceWrite) {
        if (this.failWriteChannel !== null && this.selectedChannel === this.failWriteChannel) {
          throw new EscError('timeout', '写入超时')
        }
        const length = request[4] === 0 ? 256 : request[4]
        this.eepromByChannel.set(this.selectedChannel, request.slice(5, 5 + length))
        this.writeChannels.push(this.selectedChannel)
        if (this.writeChannels.length === 1) this.disconnectAfterFirstWrite?.()
        reply = fourWayResponse(command, [0], FOUR_WAY_ACK.OK, address)
      } else {
        reply = fourWayResponse(command, [0], FOUR_WAY_ACK.OK, address)
      }
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

function createService(
  kind: EscByteTransport['kind'],
  family: 'ardupilot' | 'px4' | 'unknown' = kind === 'ardupilot_raw' ? 'ardupilot' : kind === 'px4_serial_control' ? 'px4' : 'unknown',
  pwmType = 5,
  vehicleTypeId = 2,
  armedState: boolean | null = false,
  isLinkBusy?: () => string | null,
) {
  const emitted: ServerMessage[] = []
  const targeted: Array<{ clientId: string; message: ServerMessage }> = []
  const pins: Array<{ clientId: string; sessionId: string }> = []
  const releases: string[] = []
  const transport = new ScriptedTransport(kind)
  const service = new EscService({
    connManager: {
      status: 'connected',
      config: { type: 'serial', port: 'COM9', baudRate: 19200 },
    } as unknown as ConnectionManager,
    bridge: {} as unknown as MavlinkBridge,
    emit: (message) => emitted.push(message),
    emitToClient: (clientId, message) => targeted.push({ clientId, message }),
    getVehicleIdentity: () => family === 'ardupilot'
      ? buildVehicleIdentity(3, vehicleTypeId)
      : family === 'px4'
        ? buildVehicleIdentity(12, vehicleTypeId)
        : buildVehicleIdentity(0, vehicleTypeId),
    getParameterValue: (id) => {
      if (id === 'SERVO_BLH_AUTO' && family === 'ardupilot') return 1
      if (id === 'MOT_PWM_TYPE' && family === 'ardupilot') return pwmType
      if (id === 'PASSTHRU_EN' && family === 'px4') return 1
      return null
    },
    getArmedState: () => armedState,
    ...(isLinkBusy ? { isLinkBusy } : {}),
    pinController: (clientId, sessionId) => pins.push({ clientId, sessionId }),
    releaseController: (sessionId) => releases.push(sessionId),
    transportFactory: () => transport,
    idleTimeoutMs: 60_000,
    orphanGraceMs: 60_000,
  })
  return { service, emitted, targeted, pins, releases, transport }
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
    const { service, emitted, targeted, pins, transport } = createService('ardupilot_raw')
    await service.handleClientMessage('client-a', {
      type: 'esc_session_start',
      safetyConfirmation: ESC_SESSION_SAFETY_CONFIRMATION,
      ...TEST_SAFETY_EXPECTATION,
      data: { mode: 'ardupilot_passthrough' },
    })
    await wait(10)
    const session = lastSession(emitted)
    assert.ok(session && session.state === 'active')
    assert.equal(session.mode, 'ardupilot_passthrough')
    assert.equal(pins.length >= 1, true)
    assert.equal(targeted.length, 1, 'recovery credential is sent exactly once')
    assert.equal(targeted[0].clientId, 'client-a', 'credential is owner-only')
    assert.equal(targeted[0].message.type, 'esc_session_started')
    const devices = emitted.find((m) => m.type === 'esc_devices') as
      | { data: { escs: unknown[] } }
      | undefined
    assert.ok(devices, 'esc_devices emitted')
    assert.equal(devices.data.escs.length, 2, 'passthrough reported 2 ESCs')
    assert.deepEqual(
      transport.mspCommands.slice(0, 2),
      [MSP_COMMANDS.API_VERSION, MSP_COMMANDS.SET_PASSTHROUGH],
      'MSP availability is probed before passthrough is enabled',
    )
    assert.equal(
      transport.commands[0],
      FOUR_WAY_COMMANDS.ProtocolGetVersion,
      'FC-side 4-way protocol is probed before any ESC channel',
    )

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
    assert.ok(transport.commands.includes(FOUR_WAY_COMMANDS.InterfaceExit), 'orderly exit sends InterfaceExit')
    await service.destroy()
  }

  // A second start while one session lives is rejected.
  {
    const { service, emitted } = createService('ardupilot_raw')
    await service.handleClientMessage('client-a', {
      type: 'esc_session_start',
      safetyConfirmation: ESC_SESSION_SAFETY_CONFIRMATION,
      ...TEST_SAFETY_EXPECTATION,
      data: { mode: 'ardupilot_passthrough' },
    })
    await wait(10)
    await service.handleClientMessage('client-b', {
      type: 'esc_session_start',
      safetyConfirmation: ESC_SESSION_SAFETY_CONFIRMATION,
      ...TEST_SAFETY_EXPECTATION,
      data: { mode: 'ardupilot_passthrough' },
    })
    const conflict = emitted.find((m) => m.type === 'esc_op_error'
      && (m as { data: { code: string } }).data.code === 'session_exists')
    assert.ok(conflict, 'second session rejected with session_exists')
    await service.destroy()
  }

  // H3: Armed preflight check blocks session start for ardupilot and px4
  {
    const { service, emitted } = createService('ardupilot_raw', 'ardupilot', 5, 2, true)
    await service.handleClientMessage('client-a', {
      type: 'esc_session_start',
      safetyConfirmation: ESC_SESSION_SAFETY_CONFIRMATION,
      ...TEST_SAFETY_EXPECTATION,
      data: { mode: 'ardupilot_passthrough' },
    })
    const armedErr = emitted.find((m) => m.type === 'esc_op_error'
      && (m as { data: { code: string } }).data.code === 'precondition_failed')
    assert.ok(armedErr, 'armed ardupilot rejects ESC session start')
    assert.equal(service.snapshot().state, 'idle')
    await service.destroy()
  }

  {
    const { service, emitted } = createService('px4_serial_control', 'px4', 5, 2, true)
    await service.handleClientMessage('client-a', {
      type: 'esc_session_start',
      safetyConfirmation: ESC_SESSION_SAFETY_CONFIRMATION,
      ...TEST_SAFETY_EXPECTATION,
      data: { mode: 'px4_serial_control', channels: [20] },
    })
    const armedErr = emitted.find((m) => m.type === 'esc_op_error'
      && (m as { data: { code: string } }).data.code === 'precondition_failed')
    assert.ok(armedErr, 'armed px4 rejects ESC session start')
    assert.equal(service.snapshot().state, 'idle')
    await service.destroy()
  }

  // H3: Live vehicle armed event terminates active ESC session
  {
    const { service, emitted } = createService('ardupilot_raw')
    await service.handleClientMessage('client-a', {
      type: 'esc_session_start',
      safetyConfirmation: ESC_SESSION_SAFETY_CONFIRMATION,
      ...TEST_SAFETY_EXPECTATION,
      data: { mode: 'ardupilot_passthrough' },
    })
    await wait(10)
    assert.equal(service.snapshot().state, 'active')
    service.handleVehicleSafetyBoundary('vehicle_armed')
    await wait(10)
    assert.equal(service.snapshot().state, 'idle', 'vehicle armed event terminates active session')
    await service.destroy()
  }

  // M5: Link busy gate blocks start
  {
    const { service, emitted } = createService('ardupilot_raw', 'ardupilot', 5, 2, false, () => 'log_transfer')
    await service.handleClientMessage('client-a', {
      type: 'esc_session_start',
      safetyConfirmation: ESC_SESSION_SAFETY_CONFIRMATION,
      ...TEST_SAFETY_EXPECTATION,
      data: { mode: 'ardupilot_passthrough' },
    })
    const busyErr = emitted.find((m) => m.type === 'esc_op_error'
      && (m as { data: { code: string } }).data.code === 'busy')
    assert.ok(busyErr, 'link busy rejects ESC session start')
    assert.equal(service.snapshot().state, 'idle')
    await service.destroy()
  }

  // H4: ESC write timeout/failure stops batch immediately and marks write_state_unknown
  {
    const { service, emitted, transport } = createService('ardupilot_raw')
    await service.handleClientMessage('client-a', {
      type: 'esc_session_start',
      safetyConfirmation: ESC_SESSION_SAFETY_CONFIRMATION,
      ...TEST_SAFETY_EXPECTATION,
      data: { mode: 'ardupilot_passthrough' },
    })
    await wait(10)
    const session = lastSession(emitted)
    assert.ok(session?.sessionId)

    // Make target #0 fail during write
    transport.failWriteChannel = 0

    await service.handleClientMessage('client-a', {
      type: 'esc_settings_write',
      requestId: 'write-failure-batch-stop',
      data: {
        sessionId: session.sessionId,
        targets: [0, 1],
        values: { motorDirection: 1 },
      },
    })

    // Verify batch was stopped: target 1 must NEVER be written or initiated
    assert.equal(transport.writeChannels.includes(1), false, 'target #1 must NOT be written after target #0 error')
    const doneMsg = emitted.find((m) => m.type === 'esc_job_done' && m.data.kind === 'settings_write') as { data: { ok: boolean; perTarget: Array<{ escIndex: number; ok: boolean; error?: { code: string } }> } } | undefined
    assert.ok(doneMsg)
    assert.equal(doneMsg.data.ok, false)
    assert.equal(doneMsg.data.perTarget.length, 1, 'only target #0 was processed')
    assert.equal(doneMsg.data.perTarget[0].ok, false)
    assert.equal(doneMsg.data.perTarget[0].error?.code, 'write_state_unknown')

    // Verify device cache updated with write_state_unknown & writable=false
    const devicesMsg = emitted.filter((m) => m.type === 'esc_devices').pop() as { data: { escs: Array<{ index: number; writable: boolean; reason?: string }> } } | undefined
    assert.ok(devicesMsg)
    const failedDevice = devicesMsg.data.escs.find((e) => e.index === 0)
    assert.ok(failedDevice)
    assert.equal(failedDevice.writable, false)
    assert.equal(failedDevice.reason, 'write_state_unknown')

    await service.destroy()
  }

  // Losing the controller owner during target #1 may finish that target's
  // atomic write/readback, but must never enter target #2 with the old
  // props-removed / stable-power acknowledgement.
  {
    const { service, emitted, transport } = createService('ardupilot_raw')
    await service.handleClientMessage('client-a', {
      type: 'esc_session_start',
      safetyConfirmation: ESC_SESSION_SAFETY_CONFIRMATION,
      ...TEST_SAFETY_EXPECTATION,
      data: { mode: 'ardupilot_passthrough' },
    })
    const session = lastSession(emitted)
    assert.ok(session?.sessionId)
    const initBaseline = transport.initChannels.length
    const emittedBaseline = emitted.length
    transport.disconnectAfterFirstWrite = () => service.handleClientDisconnected('client-a')

    await service.handleClientMessage('client-a', {
      type: 'esc_settings_write',
      requestId: 'disconnect-mid-batch',
      data: {
        sessionId: session.sessionId,
        targets: [0, 1],
        values: { motorDirection: 1 },
      },
    })

    assert.deepEqual(
      transport.writeChannels,
      [0],
      'disconnect after target #1 must prevent any write to target #2',
    )
    assert.deepEqual(
      transport.initChannels.slice(initBaseline),
      [0],
      'target #2 must not even enter DeviceInitFlash after disconnect',
    )
    const writeMessages = emitted.slice(emittedBaseline)
    assert.ok(writeMessages.some((message) =>
      message.type === 'esc_settings' && message.data.escIndex === 0),
    'target #1 completes its atomic write/readback')
    assert.equal(writeMessages.some((message) =>
      message.type === 'esc_job_progress'
      && message.data.kind === 'settings_write'
      && message.data.escIndex === 1), false)
    const orphaned = service.snapshot()
    assert.equal(orphaned.state, 'orphaned')
    assert.equal(orphaned.safetyConfirmed, false)
    assert.ok(writeMessages.some((message) =>
      message.type === 'esc_op_error'
      && message.data.requestId === 'disconnect-mid-batch'
      && message.data.code === 'precondition_failed'))
    await service.destroy()
  }

  // Missing server-side passthrough parameters fail closed even for the right stack.
  {
    const emitted: ServerMessage[] = []
    const service = new EscService({
      connManager: {} as ConnectionManager,
      bridge: {} as MavlinkBridge,
      emit: (message) => emitted.push(message),
      getVehicleIdentity: () => buildVehicleIdentity(12, 2),
      getParameterValue: () => null,
      getArmedState: () => false,
      pinController: () => undefined,
      releaseController: () => undefined,
      transportFactory: () => new ScriptedTransport('px4_serial_control'),
    })
    await service.handleClientMessage('client-a', {
      type: 'esc_session_start',
      safetyConfirmation: ESC_SESSION_SAFETY_CONFIRMATION,
      ...TEST_SAFETY_EXPECTATION,
      data: { mode: 'px4_serial_control', channels: [20] },
    })
    assert.ok(emitted.some((m) => m.type === 'esc_op_error'
      && (m as { data: { code: string } }).data.code === 'precondition_failed'))
    assert.equal(service.snapshot().state, 'idle')
    await service.destroy()
  }

  // ArduPilot passthrough requires a DShot motor protocol.
  {
    const { service, emitted } = createService('ardupilot_raw', 'ardupilot', 0)
    await service.handleClientMessage('client-a', {
      type: 'esc_session_start',
      safetyConfirmation: ESC_SESSION_SAFETY_CONFIRMATION,
      ...TEST_SAFETY_EXPECTATION,
      data: { mode: 'ardupilot_passthrough' },
    })
    assert.ok(emitted.some((m) => m.type === 'esc_op_error'
      && (m as { data: { code: string } }).data.code === 'precondition_failed'))
    assert.equal(service.snapshot().state, 'idle')
    await service.destroy()
  }

  // Stack-specific transports fail closed on a mismatched HEARTBEAT family.
  {
    const { service, emitted } = createService('ardupilot_raw', 'px4')
    await service.handleClientMessage('client-a', {
      type: 'esc_session_start',
      safetyConfirmation: ESC_SESSION_SAFETY_CONFIRMATION,
      ...TEST_SAFETY_EXPECTATION,
      data: { mode: 'ardupilot_passthrough' },
    })
    const mismatch = emitted.find((m) => m.type === 'esc_op_error'
      && (m as { data: { code: string } }).data.code === 'unsupported_vehicle_profile')
    assert.ok(mismatch, 'mismatched autopilot family is rejected before transport open')
    assert.equal(service.snapshot().state, 'idle')
    await service.destroy()
  }

  // ArduPilot classes that are still read-only cannot borrow the FC link for
  // passthrough, even when the DShot parameters otherwise satisfy preflight.
  {
    const { service, emitted } = createService('ardupilot_raw', 'ardupilot', 5, 1)
    await service.handleClientMessage('client-a', {
      type: 'esc_session_start',
      safetyConfirmation: ESC_SESSION_SAFETY_CONFIRMATION,
      ...TEST_SAFETY_EXPECTATION,
      data: { mode: 'ardupilot_passthrough' },
    })
    const readOnly = emitted.find((m) => m.type === 'esc_op_error'
      && (m as { data: { code: string } }).data.code === 'unsupported_vehicle_profile')
    assert.ok(readOnly, 'ArduPlane passthrough is rejected before transport open')
    assert.equal(service.snapshot().state, 'idle')
    await service.destroy()
  }

  // Direct scan reports not_supported (AM32 bootloader detection pending).
  {
    const { service, emitted } = createService('direct')
    await service.handleClientMessage('client-a', {
      type: 'esc_session_start',
      safetyConfirmation: ESC_SESSION_SAFETY_CONFIRMATION,
      ...TEST_SAFETY_EXPECTATION,
      data: { mode: 'direct' },
    })
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
