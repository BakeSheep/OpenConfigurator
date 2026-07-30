// ESC discovery over MSP + 4-way transports. Read-only for this milestone:
// enters passthrough (ArduPilot), probes each 4-way channel with
// DeviceInitFlash and classifies the firmware family from the interface mode.
// No erase/write is performed here. Unknown devices degrade to read-only.
//
// Provenance note: the exact DeviceInitFlash response layout and MCU
// signatures are Pending hardware verification (docs/ESC-PROTOCOL-SOURCES.md);
// classification is therefore conservative and never enables writes on its own.
import {
  EscError,
  type EscDeviceInfo,
  type EscFirmwareKind,
} from '../../shared/esc'
import type { EscByteTransport } from './EscByteTransport'
import {
  decodeMspResponse,
  encodeMspRequest,
  MSP_COMMANDS,
  mspFrameLength,
  type MspResponse,
} from './msp'
import {
  ackToError,
  decodeFourWay,
  encodeFourWay,
  FOUR_WAY_COMMANDS,
  fourWayFrameLength,
  type FourWayResponse,
} from './fourWay'

// Per-command 4-way timeouts. Init and erase are slower than plain reads.
const FOUR_WAY_TIMEOUTS = {
  default: 1000,
  initFlash: 3000,
  reset: 2000,
  exit: 1000,
} as const

const MSP_TIMEOUT_MS = 1500

/** 4-way interface mode reported by DeviceInitFlash (Pending offsets). */
export const FOUR_WAY_INTERFACE_MODE = {
  SiLC2: 0, // SiLabs C2 (older BLHeli)
  SiLBLB: 1, // SiLabs BLHeli bootloader (EFM8)
  AtmBLB: 2, // Atmel BLHeli bootloader
  AtmSK: 3, // Atmel SimonK
  ARMBLB: 4, // ARM bootloader (AM32)
} as const

/** Thin MSP client bound to a transport (used to enter ArduPilot passthrough). */
export class MspClient {
  constructor(private readonly transport: EscByteTransport) {}

  async request(
    command: number,
    payload: Uint8Array,
    signal: AbortSignal,
  ): Promise<MspResponse> {
    const frame = await this.transport.transact(
      encodeMspRequest(command, payload),
      { timeoutMs: MSP_TIMEOUT_MS, frameLength: mspFrameLength, label: `msp:${command}` },
      signal,
    )
    const response = decodeMspResponse(frame)
    if (response.isError) {
      throw new EscError('nack', `MSP 命令 ${command} 返回错误`)
    }
    return response
  }

  /** Probe MSP availability; returns the API version payload. */
  apiVersion(signal: AbortSignal): Promise<MspResponse> {
    return this.request(MSP_COMMANDS.API_VERSION, new Uint8Array(0), signal)
  }

  /** Enter BLHeli passthrough (returns the reported ESC count when present). */
  async setPassthrough(signal: AbortSignal): Promise<number | null> {
    const response = await this.request(MSP_COMMANDS.SET_PASSTHROUGH, new Uint8Array(0), signal)
    return response.payload.length >= 1 ? response.payload[0] : null
  }
}

/** Thin 4-way client bound to a transport. */
export class FourWayClient {
  constructor(private readonly transport: EscByteTransport) {}

  private async command(
    command: number,
    address: number,
    params: Uint8Array,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<FourWayResponse> {
    const frame = await this.transport.transact(
      encodeFourWay(command, address, params),
      { timeoutMs, frameLength: fourWayFrameLength, label: `4way:0x${command.toString(16)}` },
      signal,
    )
    const response = decodeFourWay(frame)
    const ackError = ackToError(response.ack)
    if (ackError) throw ackError
    return response
  }

  testAlive(signal: AbortSignal): Promise<FourWayResponse> {
    // Control commands carry a single param byte: param_len 0 means 256 on the
    // wire, so a genuine zero-length frame is never sent.
    return this.command(FOUR_WAY_COMMANDS.InterfaceTestAlive, 0, Uint8Array.of(0), FOUR_WAY_TIMEOUTS.default, signal)
  }

  protocolVersion(signal: AbortSignal): Promise<FourWayResponse> {
    return this.command(FOUR_WAY_COMMANDS.ProtocolGetVersion, 0, Uint8Array.of(0), FOUR_WAY_TIMEOUTS.default, signal)
  }

  /** Initialize flashing on a 0-based ESC channel; response carries device info. */
  initFlash(channel: number, signal: AbortSignal): Promise<FourWayResponse> {
    return this.command(
      FOUR_WAY_COMMANDS.DeviceInitFlash,
      0,
      Uint8Array.of(channel & 0xff),
      FOUR_WAY_TIMEOUTS.initFlash,
      signal,
    )
  }

  /** Read `length` bytes (1..256) from `address`; length 256 encoded as 0. */
  read(address: number, length: number, signal: AbortSignal): Promise<FourWayResponse> {
    if (length < 1 || length > 256) {
      throw new EscError('validation_failed', '4-way 读取长度必须在 1..256')
    }
    return this.command(
      FOUR_WAY_COMMANDS.DeviceRead,
      address,
      Uint8Array.of(length === 256 ? 0 : length),
      FOUR_WAY_TIMEOUTS.default,
      signal,
    )
  }

  reset(channel: number, signal: AbortSignal): Promise<FourWayResponse> {
    return this.command(FOUR_WAY_COMMANDS.DeviceReset, 0, Uint8Array.of(channel & 0xff), FOUR_WAY_TIMEOUTS.reset, signal)
  }

  exit(signal: AbortSignal): Promise<FourWayResponse> {
    return this.command(FOUR_WAY_COMMANDS.InterfaceExit, 0, Uint8Array.of(0), FOUR_WAY_TIMEOUTS.exit, signal)
  }
}

/** Parsed device identity fields extracted from a DeviceInitFlash response. */
export interface DeviceInitInfo {
  interfaceMode: number | null
  signature: number | null
}

/**
 * Extract identity fields from a DeviceInitFlash response. Layout is Pending:
 * params = [signature_hi, signature_lo, boot_pages?, interface_mode].
 */
export function parseDeviceInitInfo(response: FourWayResponse): DeviceInitInfo {
  const { params } = response
  const signature = params.length >= 2 ? (params[0] << 8) | params[1] : null
  const interfaceMode = params.length >= 4 ? params[3] : null
  return { interfaceMode, signature }
}

/** Map an interface mode to a firmware family for display only. */
export function firmwareKindFromInterfaceMode(interfaceMode: number | null): EscFirmwareKind {
  switch (interfaceMode) {
    case FOUR_WAY_INTERFACE_MODE.ARMBLB:
      return 'am32'
    case FOUR_WAY_INTERFACE_MODE.SiLBLB:
    case FOUR_WAY_INTERFACE_MODE.SiLC2:
      // BLHeli_S vs Bluejay is decided later by firmware name; default here.
      return 'blheli_s'
    default:
      return 'unknown'
  }
}

/**
 * Discover ESCs on an already-open transport that speaks 4-way (post
 * passthrough for ArduPilot). Returns one EscDeviceInfo per channel; failed
 * probes are reported as unknown/read-only rather than aborting the scan.
 */
export async function detectEscs(
  fourWay: FourWayClient,
  channelCount: number,
  signal: AbortSignal,
): Promise<EscDeviceInfo[]> {
  await fourWay.testAlive(signal)
  const escs: EscDeviceInfo[] = []
  for (let index = 0; index < channelCount; index++) {
    escs.push(await detectOne(fourWay, index, signal))
  }
  return escs
}

async function detectOne(
  fourWay: FourWayClient,
  index: number,
  signal: AbortSignal,
): Promise<EscDeviceInfo> {
  try {
    const response = await fourWay.initFlash(index, signal)
    const { interfaceMode, signature } = parseDeviceInitInfo(response)
    const firmwareKind = firmwareKindFromInterfaceMode(interfaceMode)
    return {
      index,
      interfaceMode,
      firmwareKind,
      firmwareName: null,
      firmwareVersion: null,
      mcuSignature: signature,
      mcuName: null,
      bootloaderVersion: null,
      layoutRevision: null,
      // Writes require a hardware-validated layout (Task 10+); detection
      // alone never marks a device writable.
      writable: false,
      reason: firmwareKind === 'unknown' ? 'unsupported_signature_or_layout' : 'not_validated',
    }
  } catch (error) {
    // A single ESC failing to init must not abort discovery of the others.
    void error
    return {
      index,
      interfaceMode: null,
      firmwareKind: 'unknown',
      firmwareName: null,
      firmwareVersion: null,
      mcuSignature: null,
      mcuName: null,
      bootloaderVersion: null,
      layoutRevision: null,
      writable: false,
      reason: 'detect_failed',
    }
  }
}
