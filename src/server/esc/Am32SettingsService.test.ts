import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AM32_LAYOUT_SIZE,
  EscError,
  type EscDeviceInfo,
} from '../../shared/esc'
import type { FourWayResponse } from './fourWay'
import { Am32SettingsService } from './Am32SettingsService'

const AM32_SIGNATURE = 0x1f06
const AM32_INTERFACE_MODE = 4
const AM32_EEPROM_ADDRESS = 0x7c00

function response(params: Uint8Array): FourWayResponse {
  return { command: 0, address: 0, params, ack: 0 }
}

function initIdentity(
  signature = AM32_SIGNATURE,
  interfaceMode = AM32_INTERFACE_MODE,
): FourWayResponse {
  return response(Uint8Array.of(
    signature & 0xff,
    (signature >> 8) & 0xff,
    0,
    interfaceMode,
  ))
}

function eeprom(layoutRevision = 3): Uint8Array {
  const raw = new Uint8Array(AM32_LAYOUT_SIZE)
  raw[0x01] = layoutRevision
  return raw
}

function device(overrides: Partial<EscDeviceInfo> = {}): EscDeviceInfo {
  return {
    index: 2,
    interfaceMode: AM32_INTERFACE_MODE,
    firmwareKind: 'am32',
    firmwareName: 'AM32',
    firmwareVersion: '2.0',
    mcuSignature: AM32_SIGNATURE,
    mcuName: 'STM32F051',
    bootloaderVersion: '1',
    layoutRevision: 3,
    writable: true,
    ...overrides,
  }
}

class FakeFourWay {
  readonly initChannels: number[] = []
  readonly readCalls: Array<{ address: number; length: number }> = []
  written: Uint8Array | null = null

  constructor(
    private readonly identity: FourWayResponse,
    private readonly freshRaw: Uint8Array,
  ) {}

  async initFlash(channel: number, _signal: AbortSignal): Promise<FourWayResponse> {
    this.initChannels.push(channel)
    return this.identity
  }

  async read(
    address: number,
    length: number,
    _signal: AbortSignal,
  ): Promise<FourWayResponse> {
    this.readCalls.push({ address, length })
    return response(
      this.readCalls.length === 1
        ? this.freshRaw.slice()
        : (this.written?.slice() ?? new Uint8Array(0)),
    )
  }

  async write(
    address: number,
    data: Uint8Array,
    _signal: AbortSignal,
  ): Promise<FourWayResponse> {
    assert.equal(address, AM32_EEPROM_ADDRESS)
    this.written = data.slice()
    return response(Uint8Array.of(0))
  }
}

test('AM32 write rejects a changed signature or interface before reading EEPROM', async () => {
  for (const identity of [
    initIdentity(0x3506, AM32_INTERFACE_MODE),
    initIdentity(AM32_SIGNATURE, 1),
  ]) {
    const fourWay = new FakeFourWay(identity, eeprom())
    const service = new Am32SettingsService(fourWay)

    await assert.rejects(
      service.write(
        'session-identity-change',
        device(),
        eeprom(),
        { motorDirection: 1 },
        new AbortController().signal,
      ),
      (error: unknown) =>
        error instanceof EscError
        && error.code === 'target_mismatch'
        && error.escIndex === 2,
    )
    assert.deepEqual(fourWay.initChannels, [2])
    assert.equal(fourWay.readCalls.length, 0)
    assert.equal(fourWay.written, null)
  }
})

test('AM32 write rejects a newly unsupported EEPROM layout', async () => {
  const fourWay = new FakeFourWay(initIdentity(), eeprom(0xff))
  const service = new Am32SettingsService(fourWay)

  await assert.rejects(
    service.write(
      'session-layout-change',
      device(),
      eeprom(),
      { motorDirection: 1 },
      new AbortController().signal,
    ),
    (error: unknown) =>
      error instanceof EscError
      && error.code === 'unsupported_signature_or_layout',
  )
  assert.equal(fourWay.written, null)
})

test('AM32 write rejects a changed layout even when both revisions are supported', async () => {
  const fourWay = new FakeFourWay(initIdentity(), eeprom(2))
  const service = new Am32SettingsService(fourWay)

  await assert.rejects(
    service.write(
      'session-supported-layout-change',
      device({ layoutRevision: 3 }),
      eeprom(3),
      { motorDirection: 1 },
      new AbortController().signal,
    ),
    (error: unknown) =>
      error instanceof EscError
      && error.code === 'target_mismatch',
  )
  assert.equal(fourWay.written, null)
})

test('AM32 write patches fresh EEPROM and preserves its unknown bytes', async () => {
  const stale = eeprom(3)
  const fresh = eeprom(3)
  const unknownOffset = 0x70
  stale[unknownOffset] = 0x11
  fresh[unknownOffset] = 0x77
  const fourWay = new FakeFourWay(initIdentity(), fresh)
  const service = new Am32SettingsService(fourWay)

  const result = await service.write(
    'session-fresh-eeprom',
    device({ layoutRevision: 3 }),
    stale,
    { motorDirection: 1 },
    new AbortController().signal,
  )

  assert.deepEqual(fourWay.initChannels, [2])
  assert.deepEqual(fourWay.readCalls, [
    { address: AM32_EEPROM_ADDRESS, length: AM32_LAYOUT_SIZE },
    { address: AM32_EEPROM_ADDRESS, length: AM32_LAYOUT_SIZE },
  ])
  assert.ok(fourWay.written)
  assert.equal(fourWay.written[0x11], 1, 'requested field is patched')
  assert.equal(
    fourWay.written[unknownOffset],
    0x77,
    'unknown byte comes from the fresh EEPROM, not the stale snapshot',
  )
  assert.equal(result.device.layoutRevision, 3)
  assert.equal(result.raw[unknownOffset], 0x77)
  assert.equal(stale[unknownOffset], 0x11, 'caller snapshot is not mutated')
})

test('AM32 write classifies readback verify mismatch as write_state_unknown (H4)', async () => {
  const fresh = eeprom(3)
  // Create a fourWay where read returns different content after write
  let readCount = 0
  const badFourWay = {
    async initFlash() { return initIdentity() },
    async read() {
      readCount++
      if (readCount === 1) return response(fresh.slice())
      // Return corrupted verify data
      const corrupt = fresh.slice()
      corrupt[0x11] = 0x99
      return response(corrupt)
    },
    async write() { return response(Uint8Array.of(0)) },
  }
  const service = new Am32SettingsService(badFourWay as any)

  await assert.rejects(
    service.write(
      'session-verify-fail',
      device({ layoutRevision: 3 }),
      fresh,
      { motorDirection: 1 },
      new AbortController().signal,
    ),
    (error: unknown) =>
      error instanceof EscError
      && error.code === 'write_state_unknown'
      && error.escIndex === 2
      && error.retryable === false,
  )
})

test('AM32 write classifies timeout / link failure as write_state_unknown (H4)', async () => {
  const fresh = eeprom(3)
  const failFourWay = {
    async initFlash() { return initIdentity() },
    async read() { return response(fresh.slice()) },
    async write() { throw new EscError('timeout', '超时') },
  }
  const service = new Am32SettingsService(failFourWay as any)

  await assert.rejects(
    service.write(
      'session-write-timeout',
      device({ layoutRevision: 3 }),
      fresh,
      { motorDirection: 1 },
      new AbortController().signal,
    ),
    (error: unknown) =>
      error instanceof EscError
      && error.code === 'write_state_unknown'
      && error.escIndex === 2
      && error.retryable === false,
  )
}) // End of AM32 settings safety regression tests.
