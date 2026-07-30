import {
  AM32_LAYOUT_SIZE,
  decodeAm32Eeprom,
  encodeAm32Eeprom,
  EscError,
  isSupportedAm32Layout,
  type EscDeviceInfo,
  type EscSettingsSnapshot,
  type EscSettingsValues,
} from '../../shared/esc'
import { FourWayClient, parseDeviceInitInfo } from './EscDetector'

interface Am32McuProfile {
  name: string
  eepromAddress: number
}

const AM32_MCU_PROFILES: Readonly<Record<number, Am32McuProfile>> = {
  0x1f06: { name: 'STM32F051', eepromAddress: 0x7c00 },
  0x3506: { name: 'ARM 64K', eepromAddress: 0xf800 },
  0x1506: { name: 'NXP', eepromAddress: 0xe000 },
}

export interface Am32ReadResult {
  device: EscDeviceInfo
  snapshot: EscSettingsSnapshot
  raw: Uint8Array
}

/**
 * AM32 settings-only EEPROM access over the official 4-way flow.
 * Firmware erase/write commands are intentionally not exposed by this class.
 */
export class Am32SettingsService {
  constructor(private readonly fourWay: FourWayClient) {}

  async read(
    sessionId: string,
    escIndex: number,
    signal: AbortSignal,
  ): Promise<Am32ReadResult> {
    const init = await this.fourWay.initFlash(escIndex, signal)
    const identity = parseDeviceInitInfo(init)
    const signature = identity.signature
    const profile = signature === null ? undefined : AM32_MCU_PROFILES[signature]
    if (!profile) {
      throw new EscError(
        'unsupported_signature_or_layout',
        signature === null
          ? 'ESC 未返回 MCU 签名，无法定位 AM32 参数区'
          : `暂不支持 MCU 签名 0x${signature.toString(16).padStart(4, '0')}`,
        { escIndex },
      )
    }

    const nameBytes = await this.fourWay.read(profile.eepromAddress - 32, 32, signal)
    const raw = (await this.fourWay.read(profile.eepromAddress, AM32_LAYOUT_SIZE, signal)).params
    if (raw.length !== AM32_LAYOUT_SIZE) {
      throw new EscError(
        'validation_failed',
        `ESC #${escIndex + 1} 参数区长度异常：${raw.length}`,
        { escIndex },
      )
    }

    const firmwareName = decodeAscii(nameBytes.params)
    const layoutRevision = raw[0x01]
    const supported = isSupportedAm32Layout(layoutRevision)
    const version = `${raw[0x03]}.${raw[0x04]}`
    const device: EscDeviceInfo = {
      index: escIndex,
      interfaceMode: identity.interfaceMode,
      firmwareKind: 'am32',
      firmwareName: firmwareName || 'AM32',
      firmwareVersion: version,
      mcuSignature: signature,
      mcuName: profile.name,
      bootloaderVersion: String(raw[0x02]),
      layoutRevision,
      writable: supported,
      ...(supported ? {} : { reason: 'unsupported_signature_or_layout' as const }),
    }

    let values: EscSettingsValues = {}
    if (supported) values = decodeAm32Eeprom(raw).values
    return {
      device,
      raw: raw.slice(),
      snapshot: {
        sessionId,
        escIndex,
        firmwareKind: 'am32',
        layoutRevision,
        writable: supported,
        values,
        rawBase64: Buffer.from(raw).toString('base64'),
      },
    }
  }

  async write(
    sessionId: string,
    device: EscDeviceInfo,
    original: Uint8Array,
    values: EscSettingsValues,
    signal: AbortSignal,
  ): Promise<Am32ReadResult> {
    if (!device.writable || device.mcuSignature === null) {
      throw new EscError(
        'unsupported_signature_or_layout',
        `ESC #${device.index + 1} 不允许写入`,
        { escIndex: device.index },
      )
    }
    const profile = AM32_MCU_PROFILES[device.mcuSignature]
    if (!profile) {
      throw new EscError(
        'unsupported_signature_or_layout',
        `ESC #${device.index + 1} 的 MCU 不受支持`,
        { escIndex: device.index },
      )
    }

    await this.fourWay.initFlash(device.index, signal)
    const encoded = encodeAm32Eeprom(original, values)
    await this.fourWay.write(profile.eepromAddress, encoded, signal)
    const verified = (await this.fourWay.read(
      profile.eepromAddress,
      AM32_LAYOUT_SIZE,
      signal,
    )).params
    if (!bytesEqual(encoded, verified)) {
      throw new EscError(
        'verify_failed',
        `ESC #${device.index + 1} 写入后的读回校验失败`,
        { escIndex: device.index },
      )
    }
    const decoded = decodeAm32Eeprom(verified)
    return {
      device: { ...device, layoutRevision: decoded.layoutRevision, writable: true },
      raw: verified.slice(),
      snapshot: {
        sessionId,
        escIndex: device.index,
        firmwareKind: 'am32',
        layoutRevision: decoded.layoutRevision,
        writable: true,
        values: decoded.values,
        rawBase64: Buffer.from(verified).toString('base64'),
      },
    }
  }
}

function decodeAscii(bytes: Uint8Array): string {
  const end = bytes.findIndex((byte) => byte === 0 || byte === 0xff)
  const usable = end < 0 ? bytes : bytes.subarray(0, end)
  return new TextDecoder('ascii').decode(usable).trim()
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return false
  }
  return true
}
