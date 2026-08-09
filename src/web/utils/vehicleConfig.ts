// Family-specific frame/actuator read models. Pure functions over the
// downloaded parameter set; the vehicle profile decides which parameter
// names are consulted, and unknown values are preserved verbatim.
import i18next from 'i18next'
import type { ParamData, VehicleIdentity } from '../../shared/types'
import type { AutopilotFamily } from '../../shared/vehicleProfiles'
import { getPx4AirframeInfo } from './px4Airframes'

const t = i18next.t.bind(i18next)

export interface FrameOutputChannel {
  label: string
  paramId: string
  functionValue: number
  /** 1-based motor number when the function drives a motor, else null. */
  motorInstance: number | null
  /** SERVO_OUTPUT_RAW port carrying this channel's live output value. */
  port: number
  /** 1-based channel index within that port. */
  channel: number
}

export interface FrameConfigView {
  name: string
  motorCount: number | null
  outputChannels: FrameOutputChannel[]
  protocolLabel: string
  /** Which parameters identify the frame (for display, e.g. FRAME_CLASS). */
  frameSource: string
}

// ArduPilot Copter FRAME_CLASS values (documented subset). Motor counts are
// only claimed for classes whose geometry is unambiguous.
const ARDUPILOT_FRAME_CLASSES: Record<number, { name: string; motorCount: number | null }> = {
  0: { name: 'Undefined', motorCount: null },
  1: { name: 'Quad', motorCount: 4 },
  2: { name: 'Hexa', motorCount: 6 },
  3: { name: 'Octa', motorCount: 8 },
  4: { name: 'OctaQuad', motorCount: 8 },
  5: { name: 'Y6', motorCount: 6 },
  6: { name: 'Heli', motorCount: null },
  7: { name: 'Tri', motorCount: 3 },
  9: { name: 'SingleCopter', motorCount: 1 },
  10: { name: 'CoaxCopter', motorCount: 2 },
  11: { name: 'BiCopter', motorCount: 2 },
  12: { name: 'DodecaHexa', motorCount: 12 },
  13: { name: 'HeliDual', motorCount: null },
  14: { name: 'Deca', motorCount: 10 },
  15: { name: 'HeliQuad', motorCount: null },
}

const ARDUPILOT_FRAME_TYPES: Record<number, string> = {
  0: 'Plus',
  1: 'X',
  2: 'V',
  3: 'H',
  4: 'V-Tail',
  5: 'A-Tail',
  10: 'Y6B',
  11: 'Y6F',
  12: 'BetaFlightX',
  13: 'DJIX',
  14: 'ClockwiseX',
  18: 'BetaFlightXReversed',
}

// MOT_PWM_TYPE values from the ArduPilot parameter documentation.
const ARDUPILOT_PWM_TYPES: Record<number, string> = {
  0: 'Normal PWM',
  1: 'OneShot',
  2: 'OneShot125',
  3: 'Brushed',
  4: 'DShot150',
  5: 'DShot300',
  6: 'DShot600',
  7: 'DShot1200',
  8: 'PWMRange',
}

// ArduPilot keeps Motor9..12 in a separate SERVOx_FUNCTION range.
const ARDUPILOT_MOTOR_FUNCTIONS = [33, 34, 35, 36, 37, 38, 39, 40, 82, 83, 84, 85] as const
// PX4 external motor functions are 101..112 (internal 1xx + transport offset).
const PX4_MOTOR_FUNCTION_BASE = 100
const MAX_MOTORS = 12
const MAX_SERVO_OUTPUTS = 16

/** Accept only an explicit, bounded integer motor count from FC parameters. */
export function normalizeAuthoritativeMotorCount(value: number | null | undefined): number | null {
  return Number.isInteger(value) && value! >= 1 && value! <= MAX_MOTORS ? value! : null
}

function px4BusProtocol(params: Map<string, ParamData>, prefix: string): string {
  const values: number[] = []
  for (let timer = 0; timer < 8; timer += 1) {
    const value = params.get(`${prefix}_TIM${timer}`)?.value
    if (Number.isFinite(value) && !values.includes(value!)) values.push(value!)
  }
  if (values.length === 0) return t('vehicleConfig.fcDefault')
  if (values.length > 1) return t('vehicleConfig.groupedConfig')
  const protocols: Record<number, string> = {
    [-8]: 'BDShot150',
    [-7]: 'BDShot300',
    [-6]: 'BDShot600',
    [-5]: 'DShot150',
    [-4]: 'DShot300',
    [-3]: 'DShot600',
    [-1]: 'OneShot',
  }
  return protocols[values[0]] || (values[0] > 0 ? `PWM ${values[0]} Hz` : t('vehicleConfig.fcDefault'))
}

function buildArduPilotView(params: Map<string, ParamData>): FrameConfigView {
  const frameClassRaw = params.get('FRAME_CLASS')?.value
  const frameTypeRaw = params.get('FRAME_TYPE')?.value
  const frameClass = Number.isFinite(frameClassRaw) ? Math.round(frameClassRaw!) : null
  const frameType = Number.isFinite(frameTypeRaw) ? Math.round(frameTypeRaw!) : null
  const classInfo = frameClass === null ? null : ARDUPILOT_FRAME_CLASSES[frameClass]
  const typeName = frameType === null ? null : ARDUPILOT_FRAME_TYPES[frameType]
  const className = classInfo?.name ?? (frameClass === null ? t('vehicleConfig.waitingForParams') : `Class ${frameClass}`)
  const name = `${className} / ${typeName ?? (frameType === null ? '—' : `Type ${frameType}`)}`

  // Render SERVO1_FUNCTION through the last present SERVOx_FUNCTION.
  const outputChannels: FrameOutputChannel[] = []
  let lastPresent = 0
  for (let channel = 1; channel <= MAX_SERVO_OUTPUTS; channel += 1) {
    if (params.has(`SERVO${channel}_FUNCTION`)) lastPresent = channel
  }
  for (let channel = 1; channel <= lastPresent; channel += 1) {
    const paramId = `SERVO${channel}_FUNCTION`
    const param = params.get(paramId)
    if (!param) continue
    const functionValue = Math.round(param.value)
    const motorFunctionIndex = ARDUPILOT_MOTOR_FUNCTIONS.indexOf(functionValue as typeof ARDUPILOT_MOTOR_FUNCTIONS[number])
    const motorInstance = motorFunctionIndex >= 0 ? motorFunctionIndex + 1 : null
    outputChannels.push({
      label: `SERVO${channel}`,
      paramId,
      functionValue,
      motorInstance,
      port: 0,
      channel,
    })
  }

  const pwmTypeRaw = params.get('MOT_PWM_TYPE')?.value
  const pwmType = Number.isFinite(pwmTypeRaw) ? Math.round(pwmTypeRaw!) : null
  const protocolLabel = pwmType === null
    ? t('vehicleConfig.unknown')
    : ARDUPILOT_PWM_TYPES[pwmType] ?? `MOT_PWM_TYPE ${pwmType}`

  return {
    name,
    motorCount: classInfo?.motorCount ?? null,
    outputChannels,
    protocolLabel,
    frameSource: `FRAME_CLASS ${frameClass ?? '—'} / FRAME_TYPE ${frameType ?? '—'}`,
  }
}

function buildPx4View(params: Map<string, ParamData>): FrameConfigView {
  const sysAutostart = params.get('SYS_AUTOSTART')?.value
  const autostartId = Number.isFinite(sysAutostart) ? Math.round(sysAutostart!) : null
  const rotorCountRaw = params.get('CA_ROTOR_COUNT')?.value
  const motorCount = normalizeAuthoritativeMotorCount(rotorCountRaw)

  const outputChannels: FrameOutputChannel[] = []
  for (const bus of [
    { prefix: 'PWM_MAIN', label: 'MAIN', port: 0 },
    { prefix: 'PWM_AUX', label: 'AUX', port: 1 },
  ]) {
    for (let channel = 1; channel <= MAX_SERVO_OUTPUTS; channel += 1) {
      const paramId = `${bus.prefix}_FUNC${channel}`
      const param = params.get(paramId)
      if (!param) continue
      const functionValue = Math.round(param.value)
      const motorInstance = functionValue > PX4_MOTOR_FUNCTION_BASE
        && functionValue <= PX4_MOTOR_FUNCTION_BASE + MAX_MOTORS
        ? functionValue - PX4_MOTOR_FUNCTION_BASE
        : null
      outputChannels.push({
        label: `${bus.label}${channel}`,
        paramId,
        functionValue,
        motorInstance,
        port: bus.port,
        channel,
      })
    }
  }

  return {
    name: getPx4AirframeInfo(sysAutostart)?.name
      ?? (autostartId !== null ? `PX4 Airframe #${autostartId}` : (motorCount === 4 || motorCount === null ? 'Quadrotor' : `${motorCount} Motor Geometry`)),
    motorCount,
    outputChannels,
    protocolLabel: px4BusProtocol(params, 'PWM_MAIN'),
    frameSource: autostartId === null ? 'SYS_AUTOSTART —' : `SYS_AUTOSTART ${autostartId}`,
  }
}

/**
 * Normalized frame/actuator model for the selected profile, or null when the
 * family has no adapter (unknown vehicles stay read-only with no guesses).
 */
export function buildFrameConfigView(
  identity: VehicleIdentity | null,
  params: Map<string, ParamData>,
): FrameConfigView | null {
  if (!identity) return null
  if (identity.family === 'px4') return buildPx4View(params)
  if (identity.family === 'ardupilot') return buildArduPilotView(params)
  return null
}

export interface MotorFunctionOption {
  value: number
  label: string
}

/** Output-function dropdown options (Disabled + Motor 1..N) per family. */
export function motorFunctionOptions(
  family: AutopilotFamily,
  motorCount: number,
): MotorFunctionOption[] {
  const functions = family === 'ardupilot'
    ? ARDUPILOT_MOTOR_FUNCTIONS
    : family === 'px4' ? Array.from({ length: MAX_MOTORS }, (_, index) => PX4_MOTOR_FUNCTION_BASE + index + 1) : null
  if (functions === null) return []
  const count = Math.min(MAX_MOTORS, Math.max(1, motorCount))
  return [
    { value: 0, label: 'Disabled' },
    ...Array.from({ length: count }, (_, index) => ({
      value: functions[index],
      label: `Motor ${index + 1}`,
    })),
  ]
}
