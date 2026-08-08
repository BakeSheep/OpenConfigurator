// Tests for ESC discovery: passthrough entry, per-channel init, firmware-family
// classification and graceful degradation of failed/unknown probes.
// Run directly: tsx src/server/esc/EscDetector.test.ts
import assert from 'node:assert/strict'
import { crc16Xmodem, EscError } from '../../shared/esc'
import type {
  EscByteTransport,
  EscTransactionOptions,
  EscTransportTarget,
} from './EscByteTransport'
import {
  detectEscs,
  firmwareKindFromInterfaceMode,
  FOUR_WAY_INTERFACE_MODE,
  FourWayClient,
  MspClient,
  parseDeviceInitInfo,
} from './EscDetector'
import {
  decodeFourWay,
  encodeFourWay,
  FOUR_WAY_ACK,
  FOUR_WAY_COMMANDS,
  FOUR_WAY_RESPONSE_START,
} from './fourWay'
import { decodeMspResponse, encodeMspRequest, mspChecksum, MSP_COMMANDS } from './msp'

function fourWayResponse(command: number, params: number[], ack: number = FOUR_WAY_ACK.OK): Uint8Array {
  const head = Uint8Array.of(FOUR_WAY_RESPONSE_START, command, 0, 0, params.length, ...params, ack)
  const crc = crc16Xmodem(head)
  return Uint8Array.of(...head, (crc >> 8) & 0xff, crc & 0xff)
}

function mspResponse(command: number, payload: number[]): Uint8Array {
  const crc = mspChecksum(command, Uint8Array.from(payload))
  return Uint8Array.of(0x24, 0x4d, 0x3e, payload.length, command, ...payload, crc)
}

/**
 * Scripted transport that decodes each request and replies from a handler.
 * frameLength is applied so the caller receives exactly one frame.
 */
class ScriptedTransport implements EscByteTransport {
  readonly kind = 'ardupilot_raw' as const
  readonly capabilities = { read: true, write: false }
  constructor(private readonly handler: (request: Uint8Array) => Uint8Array) {}
  async open(_t: EscTransportTarget, _s: AbortSignal): Promise<void> {}
  async transact(
    request: Uint8Array,
    options: EscTransactionOptions,
    _signal: AbortSignal,
  ): Promise<Uint8Array> {
    const reply = this.handler(request)
    const length = options.frameLength(reply)
    if (length === null) throw new EscError('timeout', 'scripted transport produced a partial frame')
    return reply.subarray(0, length)
  }
  async close(_reason: string): Promise<void> {}
  onAborted(_listener: (error: EscError) => void): () => void {
    return () => {}
  }
}

async function run(): Promise<void> {
  const signal = new AbortController().signal

  // Interface-mode classification.
  assert.equal(firmwareKindFromInterfaceMode(FOUR_WAY_INTERFACE_MODE.ARMBLB), 'am32')
  assert.equal(firmwareKindFromInterfaceMode(FOUR_WAY_INTERFACE_MODE.SiLBLB), 'blheli_s')
  assert.equal(firmwareKindFromInterfaceMode(99), 'unknown')
  assert.equal(firmwareKindFromInterfaceMode(null), 'unknown')

  // parseDeviceInitInfo extracts signature + interface mode.
  {
    const response = decodeFourWay(fourWayResponse(FOUR_WAY_COMMANDS.DeviceInitFlash, [0x14, 0x40, 0x00, 0x04]))
    const info = parseDeviceInitInfo(response)
    assert.equal(info.signature, 0x4014)
    assert.equal(info.interfaceMode, FOUR_WAY_INTERFACE_MODE.ARMBLB)
  }

  // MspClient enters passthrough.
  {
    const transport = new ScriptedTransport((request) => {
      const decoded = decodeMspResponse(mirrorMsp(request))
      if (decoded.command === MSP_COMMANDS.SET_PASSTHROUGH) return mspResponse(MSP_COMMANDS.SET_PASSTHROUGH, [4])
      return mspResponse(decoded.command, [])
    })
    const msp = new MspClient(transport)
    const count = await msp.setPassthrough(signal)
    assert.equal(count, 4)
  }

  // A stale MSP response for a different command is rejected.
  {
    const transport = new ScriptedTransport(() => mspResponse(MSP_COMMANDS.API_VERSION, [1, 2, 3]))
    const msp = new MspClient(transport)
    await assert.rejects(
      () => msp.setPassthrough(signal),
      (error: unknown) => error instanceof EscError && error.code === 'target_mismatch',
    )
  }

  // A stale or cross-command response must never be accepted as the reply.
  {
    const transport = new ScriptedTransport(() =>
      fourWayResponse(FOUR_WAY_COMMANDS.ProtocolGetVersion, [0]),
    )
    const fourWay = new FourWayClient(transport)
    await assert.rejects(
      () => fourWay.testAlive(signal),
      (error: unknown) => error instanceof EscError && error.code === 'target_mismatch',
    )
  }

  // detectEscs classifies AM32 vs SiLabs across channels; failures degrade.
  {
    const modes = [FOUR_WAY_INTERFACE_MODE.ARMBLB, FOUR_WAY_INTERFACE_MODE.SiLBLB]
    let transientInitAttempts = 0
    let failedInitAttempts = 0
    const transport = new ScriptedTransport((request) => {
      const decoded = decodeFourWay(padFourWayRequestToResponse(request))
      if (decoded.command === FOUR_WAY_COMMANDS.ProtocolGetVersion) {
        return fourWayResponse(FOUR_WAY_COMMANDS.ProtocolGetVersion, [107])
      }
      if (decoded.command === FOUR_WAY_COMMANDS.DeviceInitFlash) {
        const channel = decoded.params[0]
        if (channel === 1 && ++transientInitAttempts < 3) {
          // Retryable FC/ESC failures can clear after the bootloader wakes.
          return fourWayResponse(FOUR_WAY_COMMANDS.DeviceInitFlash, [0], FOUR_WAY_ACK.GeneralError)
        }
        if (channel === 2) {
          // Third ESC exhausts the host retry budget and degrades cleanly.
          failedInitAttempts += 1
          return fourWayResponse(FOUR_WAY_COMMANDS.DeviceInitFlash, [0], FOUR_WAY_ACK.UnknownError)
        }
        const mode = modes[channel] ?? 99
        return fourWayResponse(FOUR_WAY_COMMANDS.DeviceInitFlash, [0x00, 0x00, 0x00, mode])
      }
      return fourWayResponse(decoded.command, [])
    })
    const fourWay = new FourWayClient(transport)
    const escs = await detectEscs(fourWay, 3, signal)
    assert.equal(escs.length, 3)
    assert.equal(escs[0].firmwareKind, 'am32')
    assert.equal(escs[0].interfaceMode, FOUR_WAY_INTERFACE_MODE.ARMBLB)
    assert.equal(escs[0].writable, false, 'detection never marks writable')
    assert.equal(escs[0].reason, 'not_validated')
    assert.equal(escs[1].firmwareKind, 'blheli_s')
    assert.equal(transientInitAttempts, 3, 'retryable failure recovers within budget')
    assert.equal(failedInitAttempts, 5, 'retryable failure uses the full host retry budget')
    assert.equal(escs[2].firmwareKind, 'unknown')
    assert.equal(escs[2].reason, 'detect_failed')
  }

  console.log('EscDetector discovery tests passed')
}

// The scripted transport only sees requests; to reuse the decoders we rebuild
// the equivalent "response-shaped" buffer. MSP request and response share the
// size/cmd/crc layout apart from the direction byte, so flip it to `>`.
function mirrorMsp(request: Uint8Array): Uint8Array {
  const mirrored = Uint8Array.from(request)
  mirrored[2] = 0x3e // '>'
  return mirrored
}

// A 4-way request has no ACK byte; decodeFourWay expects one. Insert an OK ACK
// before the CRC so the request can be decoded to inspect command/params.
function padFourWayRequestToResponse(request: Uint8Array): Uint8Array {
  const paramLen = request[4] === 0 ? 256 : request[4]
  const head = Uint8Array.from(request.subarray(0, 5 + paramLen))
  head[0] = FOUR_WAY_RESPONSE_START
  const withAck = Uint8Array.of(...head, FOUR_WAY_ACK.OK)
  const crc = crc16Xmodem(withAck)
  return Uint8Array.of(...withAck, (crc >> 8) & 0xff, crc & 0xff)
}

// Keep encoders referenced so the imports document the tested surface.
void encodeFourWay
void encodeMspRequest

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
