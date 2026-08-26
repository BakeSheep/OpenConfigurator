// Boundary + orchestration tests for the ESC service and its runtime message
// validation: parse guards, ownership, ready-target policy, and the ArduPilot
// scan path vs the not-yet-supported direct/PX4 detection.
// Run directly: tsx src/local-runtime/esc/EscService.test.ts
import assert from 'node:assert/strict'
import {
  AM32_LAYOUT_SIZE,
  crc16Xmodem,
  EscError,
  ESC_SESSION_SAFETY_CONFIRMATION,
  type EscSessionSnapshot,
} from '../../shared/esc'
import type { RuntimeCommand, RuntimeEvent } from '../../shared/types'
import { InputValidationError, parseRuntimeCommand } from '../validation'
import { buildVehicleIdentity } from '../../shared/vehicleProfiles'
import type { BrowserConnectionManager } from '../connection/BrowserConnectionManager'
import type { MavlinkBridge } from '../mavlink/MavlinkBridge'
import { EscService } from './EscService'
import { ESC_SAFETY_SNAPSHOT_MAX_AGE_MS, type EscSafetySnapshot } from './EscSafetyContext'
import type { EscByteTransport, EscTransactionOptions, EscTransportTarget } from './EscByteTransport'
import { FOUR_WAY_ACK, FOUR_WAY_COMMANDS, FOUR_WAY_RESPONSE_START } from './fourWay'
import { mspChecksum, MSP_COMMANDS } from './msp'

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail('timed out waiting for asynchronous condition')
    await wait(5)
  }
}

const TEST_SAFETY_EXPECTATION = {
  expectedSafetyEpoch: 1,
  expectedSafetyAuthorityId: '00000000-0000-4000-8000-000000000001',
} as const

function expectValidationFail(input: unknown, label: string): void {
  assert.throws(
    () => parseRuntimeCommand(input),
    (error: unknown) => error instanceof InputValidationError,
    label,
  )
}

// ---------------------------------------------------------------------------
// Validation of esc_* client messages.
// ---------------------------------------------------------------------------
function validationTests(): void {
  // Valid messages parse.
  const ardu = parseRuntimeCommand({
    type: 'esc_session_start',
    safetyConfirmation: ESC_SESSION_SAFETY_CONFIRMATION,
    ...TEST_SAFETY_EXPECTATION,
    data: { mode: 'ardupilot_passthrough' },
  }) as RuntimeCommand
  assert.equal(ardu.type, 'esc_session_start')
  const px4 = parseRuntimeCommand({
    type: 'esc_session_start',
    safetyConfirmation: ESC_SESSION_SAFETY_CONFIRMATION,
    ...TEST_SAFETY_EXPECTATION,
    data: { mode: 'px4_serial_control', channels: [20, 21] },
  })
  assert.equal(px4.type, 'esc_session_start')
  const direct = parseRuntimeCommand({
    type: 'esc_session_start',
    safetyConfirmation: ESC_SESSION_SAFETY_CONFIRMATION,
    ...TEST_SAFETY_EXPECTATION,
    data: { mode: 'direct' },
  })
  assert.deepEqual((direct as { data: unknown }).data, { mode: 'direct' })

  const sid = 'abcd1234-0000'
  parseRuntimeCommand({ type: 'esc_session_exit', data: { sessionId: sid } })
  parseRuntimeCommand({ type: 'esc_devices_scan', data: { sessionId: sid } })
  parseRuntimeCommand({ type: 'esc_settings_read', data: { sessionId: sid, targets: 'all' } })
  parseRuntimeCommand({ type: 'esc_settings_read', data: { sessionId: sid, targets: [0, 1, 2] } })
  parseRuntimeCommand({
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
  closeCalls = 0
  disconnectAfterFirstWrite: (() => void) | null = null
  afterFirstWrite: (() => void) | null = null
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
        const length = request[4] === 0 ? 256 : request[4]
        this.eepromByChannel.set(this.selectedChannel, request.slice(5, 5 + length))
        this.writeChannels.push(this.selectedChannel)
        if (this.writeChannels.length === 1) {
          this.disconnectAfterFirstWrite?.()
          this.afterFirstWrite?.()
        }
        reply = fourWayResponse(command, [0], FOUR_WAY_ACK.OK, address)
      } else {
        reply = fourWayResponse(command, [0], FOUR_WAY_ACK.OK, address)
      }
    }
    const length = options.frameLength(reply)
    if (length === null) throw new EscError('timeout', 'partial frame')
    return reply.subarray(0, length)
  }
  async close(_reason: string): Promise<void> {
    this.closeCalls += 1
  }
  onAborted(_listener: (error: EscError) => void): () => void {
    return () => {}
  }
}

function createService(
  kind: EscByteTransport['kind'],
  family: 'ardupilot' | 'px4' | 'unknown' = kind === 'ardupilot_raw' ? 'ardupilot' : kind === 'px4_serial_control' ? 'px4' : 'unknown',
  pwmType = 5,
  vehicleTypeId = 2,
) {
  const emitted: RuntimeEvent[] = []
  const targeted: Array<{ clientId: string; message: RuntimeEvent }> = []
  const pins: Array<{ clientId: string; sessionId: string }> = []
  const releases: string[] = []
  const transport = new ScriptedTransport(kind)
  const service = new EscService({
    connManager: {
      status: 'connected',
      config: { type: 'serial', port: 'COM9', baudRate: 19200 },
    } as unknown as BrowserConnectionManager,
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
    pinController: (clientId, sessionId) => pins.push({ clientId, sessionId }),
    releaseController: (sessionId) => releases.push(sessionId),
    transportFactory: () => transport,
    idleTimeoutMs: 60_000,
    orphanGraceMs: 60_000,
  })
  return { service, emitted, targeted, pins, releases, transport }
}

function lastSession(emitted: RuntimeEvent[]): EscSessionSnapshot | undefined {
  for (let i = emitted.length - 1; i >= 0; i--) {
    if (emitted[i].type === 'esc_session') return (emitted[i] as { data: EscSessionSnapshot }).data
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Server-authoritative safety context (OCSA-002): armed/unknown/stale
// snapshots and generation changes refuse or terminate every operation.
// ---------------------------------------------------------------------------
type SafetyMode = 'ardupilot_passthrough' | 'px4_serial_control' | 'direct'

function disarmedSnapshot(overrides: Partial<EscSafetySnapshot> = {}): EscSafetySnapshot {
  return {
    armed: false,
    ready: true,
    fingerprint: 'gen-1',
    observedAt: Date.now(),
    fcActivityObserved: true,
    connectionKey: '["connected",true]',
    ...overrides,
  }
}

function createSafetyService(
  mode: SafetyMode,
  initial: EscSafetySnapshot | null = disarmedSnapshot(),
) {
  let snapshot: EscSafetySnapshot | null = initial === null ? null : { ...initial }
  const emitted: RuntimeEvent[] = []
  const targeted: Array<{ clientId: string; message: RuntimeEvent }> = []
  const transport = new ScriptedTransport(
    mode === 'direct' ? 'direct' : mode === 'px4_serial_control' ? 'px4_serial_control' : 'ardupilot_raw',
  )
  const service = new EscService({
    connManager: {
      status: 'connected',
      config: { type: 'serial', port: 'COM9', baudRate: 19200 },
    } as unknown as BrowserConnectionManager,
    bridge: {} as unknown as MavlinkBridge,
    emit: (message) => emitted.push(message),
    emitToClient: (clientId, message) => targeted.push({ clientId, message }),
    getVehicleIdentity: () => mode === 'px4_serial_control'
      ? buildVehicleIdentity(12, 2)
      : buildVehicleIdentity(3, 2),
    getParameterValue: (id) => {
      if (id === 'SERVO_BLH_AUTO') return 1
      if (id === 'MOT_PWM_TYPE') return 5
      if (id === 'PASSTHRU_EN') return 1
      return null
    },
    pinController: () => undefined,
    releaseController: () => undefined,
    getSafetyContext: () => (snapshot === null ? null : { ...snapshot }),
    transportFactory: () => transport,
    idleTimeoutMs: 60_000,
    orphanGraceMs: 60_000,
  })
  return {
    service,
    emitted,
    targeted,
    transport,
    setSnapshot(next: EscSafetySnapshot | null): void {
      snapshot = next === null ? null : { ...next }
    },
  }
}

function startMessage(mode: SafetyMode): Extract<Parameters<EscService['handleRuntimeCommand']>[1], { type: 'esc_session_start' }> {
  return {
    type: 'esc_session_start',
    safetyConfirmation: ESC_SESSION_SAFETY_CONFIRMATION,
    ...TEST_SAFETY_EXPECTATION,
    data: mode === 'px4_serial_control'
      ? { mode, channels: [20, 21] }
      : { mode },
  } as Extract<Parameters<EscService['handleRuntimeCommand']>[1], { type: 'esc_session_start' }>
}

function lastOpErrorCode(emitted: RuntimeEvent[]): string | undefined {
  for (let i = emitted.length - 1; i >= 0; i--) {
    if (emitted[i].type === 'esc_op_error') {
      return (emitted[i] as { data: { code: string } }).data.code
    }
  }
  return undefined
}

async function startSession(
  harness: ReturnType<typeof createSafetyService>,
  mode: SafetyMode,
  clientId = 'client-a',
): Promise<string> {
  await harness.service.handleRuntimeCommand(clientId, startMessage(mode))
  await wait(10)
  const session = harness.service.snapshot()
  assert.equal(session.state, 'active', `session must start for ${mode}`)
  return session.sessionId!
}

async function safetyContextTests(): Promise<void> {
  // Entry gates: armed / unknown / stale snapshots refuse the start and leave
  // no session behind, for both MAVLink-backed modes.
  for (const mode of ['ardupilot_passthrough', 'px4_serial_control'] as const) {
    for (const [label, overrides, expectedCode] of [
      ['armed', { armed: true }, 'armed'],
      ['unknown', { armed: null }, 'arming_state_unknown'],
      [
        'stale',
        { observedAt: Date.now() - ESC_SAFETY_SNAPSHOT_MAX_AGE_MS - 1000 },
        'arming_state_unknown',
      ],
      ['not-ready', { ready: false }, 'precondition_failed'],
    ] as const) {
      const harness = createSafetyService(mode, disarmedSnapshot(overrides))
      await harness.service.handleRuntimeCommand('client-a', startMessage(mode))
      assert.equal(lastOpErrorCode(harness.emitted), expectedCode, `${mode}/${label} entry code`)
      assert.equal(harness.service.snapshot().state, 'idle', `${mode}/${label} leaves no session`)
      assert.equal(harness.transport.closeCalls, 0, `${mode}/${label} never opened a transport`)
      await harness.service.destroy()
    }
  }

  // A missing snapshot fails closed as well.
  {
    const harness = createSafetyService('ardupilot_passthrough', null)
    await harness.service.handleRuntimeCommand('client-a', startMessage('ardupilot_passthrough'))
    assert.equal(lastOpErrorCode(harness.emitted), 'arming_state_unknown')
    assert.equal(harness.service.snapshot().state, 'idle')
    await harness.service.destroy()
  }

  // Mid-session arming: the next operation is refused and the whole session
  // is terminated, releasing the borrowed transport.
  {
    const harness = createSafetyService('ardupilot_passthrough')
    const sessionId = await startSession(harness, 'ardupilot_passthrough')
    harness.setSnapshot(disarmedSnapshot({ armed: true }))
    await harness.service.handleRuntimeCommand('client-a', {
      type: 'esc_devices_scan',
      requestId: 'scan-while-armed',
      data: { sessionId },
    })
    assert.equal(lastOpErrorCode(harness.emitted), 'armed', 'scan refused while armed')
    await waitFor(() => harness.service.snapshot().state === 'idle')
    assert.equal(harness.service.snapshot().state, 'idle', 'session terminated while armed')
    assert.equal(lastSession(harness.emitted)?.reason, 'armed')
    assert.equal(harness.transport.closeCalls, 1, 'transport released exactly once')
    await harness.service.destroy()
  }

  // Read refuses with the same fail-closed behaviour.
  {
    const harness = createSafetyService('ardupilot_passthrough')
    const sessionId = await startSession(harness, 'ardupilot_passthrough')
    harness.setSnapshot(disarmedSnapshot({ armed: null }))
    await harness.service.handleRuntimeCommand('client-a', {
      type: 'esc_settings_read',
      data: { sessionId, targets: [0] },
    })
    assert.equal(lastOpErrorCode(harness.emitted), 'arming_state_unknown')
    await waitFor(() => harness.service.snapshot().state === 'idle')
    assert.equal(harness.service.snapshot().state, 'idle')
    await harness.service.destroy()
  }

  // A write batch stops at the next target boundary once the snapshot turns
  // armed: target #0 may finish its atomic unit, target #1 is never entered.
  {
    const harness = createSafetyService('ardupilot_passthrough')
    const sessionId = await startSession(harness, 'ardupilot_passthrough')
    assert.ok(harness.transport.initChannels.length >= 2, 'auto-scan detected both ESCs')
    harness.transport.afterFirstWrite = () => harness.setSnapshot(disarmedSnapshot({ armed: true }))
    await harness.service.handleRuntimeCommand('client-a', {
      type: 'esc_settings_write',
      requestId: 'write-while-arming',
      data: { sessionId, targets: [0, 1], values: { motorDirection: 1 } },
    })
    assert.deepEqual(
      harness.transport.writeChannels,
      [0],
      'target #1 must not be written after the armed transition',
    )
    assert.equal(lastOpErrorCode(harness.emitted), 'armed')
    await waitFor(() => harness.service.snapshot().state === 'idle')
    assert.equal(harness.service.snapshot().state, 'idle')
    await harness.service.destroy()
  }

  // Target-identity generation changes terminate the operation.
  {
    const harness = createSafetyService('px4_serial_control')
    const sessionId = await startSession(harness, 'px4_serial_control')
    harness.setSnapshot(disarmedSnapshot({ fingerprint: 'gen-2' }))
    await harness.service.handleRuntimeCommand('client-a', {
      type: 'esc_devices_scan',
      data: { sessionId },
    })
    assert.equal(lastOpErrorCode(harness.emitted), 'target_mismatch')
    await waitFor(() => harness.service.snapshot().state === 'idle')
    assert.equal(harness.service.snapshot().state, 'idle')
    assert.equal(harness.transport.closeCalls, 1)
    await harness.service.destroy()
  }

  // Connection-epoch changes terminate the operation.
  {
    const harness = createSafetyService('ardupilot_passthrough')
    const sessionId = await startSession(harness, 'ardupilot_passthrough')
    harness.setSnapshot(disarmedSnapshot({ connectionKey: '["connected",false]' }))
    await harness.service.handleRuntimeCommand('client-a', {
      type: 'esc_settings_read',
      data: { sessionId, targets: [0] },
    })
    assert.equal(lastOpErrorCode(harness.emitted), 'link_unavailable')
    await waitFor(() => harness.service.snapshot().state === 'idle')
    assert.equal(harness.service.snapshot().state, 'idle')
    await harness.service.destroy()
  }

  // The push-based boundary terminates a live PX4 session immediately.
  {
    const harness = createSafetyService('px4_serial_control')
    await startSession(harness, 'px4_serial_control')
    harness.service.handleVehicleSafetyBoundary('vehicle_armed')
    await waitFor(() => harness.service.snapshot().state === 'idle')
    assert.equal(harness.service.snapshot().state, 'idle')
    assert.equal(lastSession(harness.emitted)?.reason, 'vehicle_armed')
    assert.equal(harness.transport.closeCalls, 1)
    await harness.service.destroy()
  }

  // Direct mode: a connection that ever showed FC activity is refused in
  // place; an explicit reconnect (fresh connection history) may enter.
  {
    const harness = createSafetyService('direct')
    await harness.service.handleRuntimeCommand('client-a', startMessage('direct'))
    assert.equal(lastOpErrorCode(harness.emitted), 'precondition_failed')
    assert.equal(harness.service.snapshot().state, 'idle')

    // Explicit reconnect: new connection, no FC heartbeat ever observed.
    harness.setSnapshot(disarmedSnapshot({
      armed: null,
      ready: false,
      fcActivityObserved: false,
      fingerprint: 'unavailable',
      observedAt: 0,
    }))
    await harness.service.handleRuntimeCommand('client-a', startMessage('direct'))
    assert.equal(harness.service.snapshot().state, 'active', 'clean direct-ESC link may enter')
    await harness.service.destroy()
  }

  console.log('ESC safety context checks passed')
}

async function orchestrationTests(): Promise<void> {
  // ArduPilot: start auto-scans and emits esc_devices with classified ESCs.
  {
    const { service, emitted, targeted, pins, transport } = createService('ardupilot_raw')
    await service.handleRuntimeCommand('client-a', {
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
    await service.handleRuntimeCommand('intruder', {
      type: 'esc_session_exit',
      data: { sessionId: session.sessionId! },
    })
    const notOwner = emitted.find((m) => m.type === 'esc_op_error'
      && (m as { data: { code: string } }).data.code === 'not_owner')
    assert.ok(notOwner, 'non-owner exit rejected with not_owner')
    assert.equal(service.snapshot().state, 'active', 'session survives non-owner exit')

    await service.handleRuntimeCommand('client-a', {
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
    await service.handleRuntimeCommand('client-a', {
      type: 'esc_session_start',
      safetyConfirmation: ESC_SESSION_SAFETY_CONFIRMATION,
      ...TEST_SAFETY_EXPECTATION,
      data: { mode: 'ardupilot_passthrough' },
    })
    await wait(10)
    await service.handleRuntimeCommand('client-b', {
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

  // Losing the controller owner during target #1 may finish that target's
  // atomic write/readback, but must never enter target #2 with the old
  // props-removed / stable-power acknowledgement.
  {
    const { service, emitted, transport } = createService('ardupilot_raw')
    await service.handleRuntimeCommand('client-a', {
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

    await service.handleRuntimeCommand('client-a', {
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

  // Missing runtime passthrough parameters fail closed even for the right stack.
  {
    const emitted: RuntimeEvent[] = []
    const service = new EscService({
      connManager: {} as BrowserConnectionManager,
      bridge: {} as MavlinkBridge,
      emit: (message) => emitted.push(message),
      getVehicleIdentity: () => buildVehicleIdentity(12, 2),
      getParameterValue: () => null,
      pinController: () => undefined,
      releaseController: () => undefined,
      transportFactory: () => new ScriptedTransport('px4_serial_control'),
    })
    await service.handleRuntimeCommand('client-a', {
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
    await service.handleRuntimeCommand('client-a', {
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
    await service.handleRuntimeCommand('client-a', {
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
    await service.handleRuntimeCommand('client-a', {
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
    await service.handleRuntimeCommand('client-a', {
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
  await safetyContextTests()
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
