import { EscError } from '../errors'
import type {
  EscSettingsField,
  EscSettingsGroup,
  EscSettingsValues,
} from '../types'

export const AM32_LAYOUT_SIZE = 0xb8
export const AM32_SUPPORTED_LAYOUTS = [1, 2, 3] as const

export const AM32_SETTINGS_GROUPS: ReadonlyArray<{
  key: EscSettingsGroup
  label: string
  description: string
}> = [
  { key: 'essentials', label: 'esc.am32.section.essentials', description: 'esc.am32.section.essentials.desc' },
  { key: 'motor', label: 'esc.am32.section.motor', description: 'esc.am32.section.motor.desc' },
  { key: 'extended', label: 'esc.am32.section.extended', description: 'esc.am32.section.extended.desc' },
  { key: 'limits', label: 'esc.am32.section.limits', description: 'esc.am32.section.limits.desc' },
  { key: 'current', label: 'esc.am32.section.current', description: 'esc.am32.section.current.desc' },
  { key: 'sine', label: 'esc.am32.section.sine', description: 'esc.am32.section.sine.desc' },
  { key: 'brake', label: 'esc.am32.section.brake', description: 'esc.am32.section.brake.desc' },
  { key: 'servo', label: 'esc.am32.section.servo', description: 'esc.am32.section.servo.desc' },
]

const bool = (
  key: string,
  label: string,
  group: EscSettingsGroup,
  offset: number,
  extra: Partial<EscSettingsField> = {},
): EscSettingsField => ({
  key,
  label,
  group,
  offset,
  size: 1,
  kind: 'bool',
  scope: 'common',
  ...extra,
})

const number = (
  key: string,
  label: string,
  group: EscSettingsGroup,
  offset: number,
  min: number,
  max: number,
  step: number,
  extra: Partial<EscSettingsField> = {},
): EscSettingsField => ({
  key,
  label,
  group,
  offset,
  size: 1,
  kind: 'number',
  scope: 'common',
  min,
  max,
  step,
  ...extra,
})

const enumeration = (
  key: string,
  label: string,
  group: EscSettingsGroup,
  offset: number,
  options: Array<{ value: number; label: string }>,
  extra: Partial<EscSettingsField> = {},
): EscSettingsField => ({
  key,
  label,
  group,
  offset,
  size: 1,
  kind: 'enum',
  scope: 'common',
  options,
  ...extra,
})

/**
 * AM32 EEPROM fields supported by the settings-only configurator.
 * Offsets and transforms follow the official AM32 Configurator EEPROM layout.
 * Unknown bytes are deliberately absent and are preserved during encoding.
 */
export const AM32_SETTINGS_FIELDS: readonly EscSettingsField[] = [
  bool('disableStickCalibration', 'esc.am32.field.disableStickCalibration', 'essentials', 0x07, {
    minLayoutRevision: 3,
    description: 'esc.am32.field.disableStickCalibration.desc',
  }),
  enumeration('protocol', 'esc.am32.field.protocol', 'essentials', 0x2e, [
    { value: 0, label: 'esc.am32.enum.protocol.auto' },
    { value: 1, label: 'DShot' },
    { value: 2, label: 'Servo PWM' },
    { value: 3, label: 'esc.am32.enum.protocol.serial' },
    { value: 4, label: 'esc.am32.enum.protocol.extendedDshot' },
  ]),
  enumeration('motorDirection', 'esc.am32.field.motorDirection', 'essentials', 0x11, [
    { value: 0, label: 'esc.am32.enum.motorDirection.forward' },
    { value: 1, label: 'esc.am32.enum.motorDirection.reverse' },
  ]),
  bool('bidirectional', 'esc.am32.field.bidirectional', 'essentials', 0x12),

  bool('stuckRotorProtection', 'esc.am32.field.stuckRotorProtection', 'motor', 0x16),
  bool('stallProtection', 'esc.am32.field.stallProtection', 'motor', 0x1d),
  bool('hallSensors', 'esc.am32.field.hallSensors', 'motor', 0x27),
  bool('intervalTelemetry', 'esc.am32.field.intervalTelemetry', 'motor', 0x1f),
  bool('complementaryPwm', 'esc.am32.field.complementaryPwm', 'motor', 0x14),
  bool('autoTimingAdvance', 'esc.am32.field.autoTimingAdvance', 'motor', 0x2f),
  enumeration('pwmType', 'esc.am32.field.pwmType', 'motor', 0x15, [
    { value: 0, label: 'esc.am32.enum.pwmType.fixed' },
    { value: 1, label: 'esc.am32.enum.pwmType.variable' },
    { value: 2, label: 'esc.am32.enum.pwmType.rpmBased' },
  ]),
  number('timingAdvance', 'esc.am32.field.timingAdvance', 'motor', 0x17, 0, 22.5, 7.5, {
    maxLayoutRevision: 2,
    unit: '°',
    precision: 1,
    scale: 7.5,
  }),
  number('timingAdvance', 'esc.am32.field.timingAdvance', 'motor', 0x17, 0, 22.5, 0.9375, {
    minLayoutRevision: 3,
    unit: '°',
    precision: 4,
    scale: 0.9375,
    add: -9.375,
  }),
  number('startupPower', 'esc.am32.field.startupPower', 'motor', 0x19, 50, 150, 1, { unit: '%' }),
  number('motorKv', 'esc.am32.field.motorKv', 'motor', 0x1a, 20, 10220, 40, {
    scale: 40,
    add: 20,
  }),
  number('motorPoles', 'esc.am32.field.motorPoles', 'motor', 0x1b, 2, 36, 1),
  number('beeperVolume', 'esc.am32.field.beeperVolume', 'motor', 0x1e, 0, 11, 1),
  number('pwmFrequency', 'esc.am32.field.pwmFrequency', 'motor', 0x18, 8, 144, 1, {
    unit: 'kHz',
    disabledIf: { key: 'pwmType', equals: 2 },
  }),

  number('rampRate', 'esc.am32.field.rampRate', 'extended', 0x05, 0.1, 25.5, 0.1, {
    minLayoutRevision: 3,
    unit: '%/ms',
    precision: 1,
    scale: 0.1,
  }),
  number('minimumDutyCycle', 'esc.am32.field.minimumDutyCycle', 'extended', 0x06, 0.5, 100, 0.5, {
    minLayoutRevision: 3,
    unit: '%',
    precision: 1,
    scale: 0.5,
  }),

  enumeration('lowVoltageCutoff', 'esc.am32.field.lowVoltageCutoff', 'limits', 0x24, [
    { value: 0, label: 'esc.am32.enum.lowVoltageCutoff.off' },
    { value: 1, label: 'esc.am32.enum.lowVoltageCutoff.perCell' },
    { value: 2, label: 'esc.am32.enum.lowVoltageCutoff.absolute' },
  ]),
  number('temperatureLimit', 'esc.am32.field.temperatureLimit', 'limits', 0x2b, 70, 140, 1, {
    unit: '°C',
    disabledValue: 255,
  }),
  number('currentLimit', 'esc.am32.field.currentLimit', 'limits', 0x2c, 0, 200, 2, {
    unit: 'A',
    scale: 2,
    disabledValue: 404,
  }),
  number('lowVoltageThreshold', 'esc.am32.field.lowVoltageThreshold', 'limits', 0x25, 2.5, 3.5, 0.01, {
    unit: 'V',
    precision: 2,
    scale: 0.01,
    add: 2.5,
    visibleIf: { key: 'lowVoltageCutoff', equals: 1 },
  }),
  number('absoluteVoltageThreshold', 'esc.am32.field.absoluteVoltageThreshold', 'limits', 0x08, 0.5, 50, 0.5, {
    minLayoutRevision: 3,
    unit: 'V',
    precision: 1,
    scale: 0.5,
    visibleIf: { key: 'lowVoltageCutoff', equals: 2 },
  }),

  number('currentP', 'esc.am32.field.currentP', 'current', 0x09, 0, 255, 1, {
    minLayoutRevision: 3,
    disabledIf: { key: 'currentLimit', equals: 404 },
  }),
  number('currentI', 'esc.am32.field.currentI', 'current', 0x0a, 0, 255, 1, {
    minLayoutRevision: 3,
    disabledIf: { key: 'currentLimit', equals: 404 },
  }),
  number('currentD', 'esc.am32.field.currentD', 'current', 0x0b, 0, 255, 1, {
    minLayoutRevision: 3,
    disabledIf: { key: 'currentLimit', equals: 404 },
  }),

  bool('sinusoidalStartup', 'esc.am32.field.sinusoidalStartup', 'sine', 0x13),
  number('sineModeRange', 'esc.am32.field.sineModeRange', 'sine', 0x28, 5, 25, 1),
  number('sineModePower', 'esc.am32.field.sineModePower', 'sine', 0x2d, 1, 10, 1),

  bool('carReverseBraking', 'esc.am32.field.carReverseBraking', 'brake', 0x26),
  enumeration('brakeOnStop', 'esc.am32.field.brakeOnStop', 'brake', 0x1c, [
    { value: 0, label: 'esc.am32.enum.brakeOnStop.off' },
    { value: 1, label: 'esc.am32.enum.brakeOnStop.onStop' },
    { value: 2, label: 'esc.am32.enum.brakeOnStop.active' },
  ]),
  number('brakeStrength', 'esc.am32.field.brakeStrength', 'brake', 0x29, 0, 10, 1),
  number('runningBrakeLevel', 'esc.am32.field.runningBrakeLevel', 'brake', 0x2a, 0, 10, 1),
  number('activeBrakePower', 'esc.am32.field.activeBrakePower', 'brake', 0x0c, 0, 10, 1, {
    minLayoutRevision: 3,
    disabledValue: 0,
  }),

  number('servoLowThreshold', 'esc.am32.field.servoLowThreshold', 'servo', 0x20, 750, 1258, 2, {
    unit: 'µs',
    scale: 2,
    add: 750,
    scope: 'perEsc',
  }),
  number('servoHighThreshold', 'esc.am32.field.servoHighThreshold', 'servo', 0x21, 1750, 2258, 2, {
    unit: 'µs',
    scale: 2,
    add: 1750,
    scope: 'perEsc',
  }),
  number('servoNeutral', 'esc.am32.field.servoNeutral', 'servo', 0x22, 1374, 1629, 1, {
    unit: 'µs',
    add: 1374,
    scope: 'perEsc',
  }),
  number('servoDeadBand', 'esc.am32.field.servoDeadBand', 'servo', 0x23, 0, 255, 1, {
    unit: 'µs',
    scope: 'perEsc',
  }),
]

export function isSupportedAm32Layout(revision: number): boolean {
  return AM32_SUPPORTED_LAYOUTS.includes(revision as (typeof AM32_SUPPORTED_LAYOUTS)[number])
}

export function am32FieldsForRevision(revision: number): EscSettingsField[] {
  return AM32_SETTINGS_FIELDS.filter((field) => {
    if (field.minLayoutRevision !== undefined && revision < field.minLayoutRevision) return false
    if (field.maxLayoutRevision !== undefined && revision > field.maxLayoutRevision) return false
    return true
  })
}

export function decodeAm32Eeprom(raw: Uint8Array): {
  layoutRevision: number
  values: EscSettingsValues
} {
  assertLayoutWindow(raw)
  const layoutRevision = raw[0x01]
  if (!isSupportedAm32Layout(layoutRevision)) {
    throw new EscError(
      'unsupported_signature_or_layout',
      'errors.esc.am32.unsupportedLayout',
    )
  }
  const values: EscSettingsValues = {}
  for (const field of am32FieldsForRevision(layoutRevision)) {
    const rawValue = readUnsigned(raw, field.offset, field.size)
    values[field.key] = rawValue * (field.scale ?? 1) + (field.add ?? 0)
  }
  return { layoutRevision, values }
}

export function encodeAm32Eeprom(
  original: Uint8Array,
  patch: EscSettingsValues,
): Uint8Array {
  const { layoutRevision, values } = decodeAm32Eeprom(original)
  const fields = am32FieldsForRevision(layoutRevision)
  const encoded = original.slice()

  for (const [key, displayValue] of Object.entries(patch)) {
    const field = fields.find((candidate) => candidate.key === key)
    if (!field) {
      throw new EscError('validation_failed', 'errors.esc.am32.unsupportedParam')
    }
    if (!Number.isFinite(displayValue)) {
      throw new EscError('validation_failed', 'errors.esc.am32.notANumber')
    }
    if (field.kind === 'bool' && displayValue !== 0 && displayValue !== 1) {
      throw new EscError('validation_failed', 'errors.esc.am32.boolOnly')
    }
    if (
      field.kind === 'enum'
      && !field.options?.some((option) => option.value === displayValue)
    ) {
      throw new EscError('validation_failed', 'errors.esc.am32.invalidOption')
    }
    const isDisabledSentinel = field.disabledValue === displayValue
    if (
      !isDisabledSentinel
      && ((field.min !== undefined && displayValue < field.min)
        || (field.max !== undefined && displayValue > field.max))
    ) {
      throw new EscError('validation_failed', 'errors.esc.am32.outOfRange')
    }
    const rawValue = Math.round((displayValue - (field.add ?? 0)) / (field.scale ?? 1))
    const rawMax = 2 ** (field.size * 8) - 1
    if (rawValue < 0 || rawValue > rawMax) {
      throw new EscError('validation_failed', 'errors.esc.am32.encodeOverflow')
    }
    writeUnsigned(encoded, field.offset, field.size, rawValue)
    values[key] = displayValue
  }
  return encoded
}

function assertLayoutWindow(raw: Uint8Array): void {
  if (raw.length !== AM32_LAYOUT_SIZE) {
    throw new EscError(
      'validation_failed',
      'errors.esc.am32.invalidLength',
    )
  }
}

function readUnsigned(raw: Uint8Array, offset: number, size: number): number {
  let value = 0
  for (let byte = 0; byte < size; byte++) value |= raw[offset + byte] << (byte * 8)
  return value >>> 0
}

function writeUnsigned(raw: Uint8Array, offset: number, size: number, value: number): void {
  for (let byte = 0; byte < size; byte++) raw[offset + byte] = (value >>> (byte * 8)) & 0xff
}
