import {
  BAUD_RATES,
  FTP_MAX_PATH_BYTES,
  MAVLINK_COMMANDS,
  MESSAGE_RATE_OPTIONS,
  PX4_ESC_SERIAL_CONTROL_DEVICE_MAX,
  PX4_ESC_SERIAL_CONTROL_DEVICE_MIN,
} from '../shared/constants'
import { ESC_MAX_TARGETS, ESC_SESSION_SAFETY_CONFIRMATION } from '../shared/esc/types'
import type {
  AccelCalibrationPosition,
  CalibrationKind,
  ConnectionConfig,
  MessageRateConfig,
  RuntimeCommand,
  VehicleConfigFeature,
} from '../shared/types'

const MAX_FLOAT32 = 3.4028234663852886e38
const PARAM_TYPES = new Set([1, 2, 3, 4, 5, 6, 9])
const REQUEST_ID_MAX_BYTES = 64
const PORT_NAME_MAX_BYTES = 512
const MESSAGE_RATE_KEYS = ['attitude', 'position', 'sensors', 'rc', 'status', 'hud', 'auxiliary'] as const
const MESSAGE_RATE_VALUES = new Set<number>(MESSAGE_RATE_OPTIONS)
const VEHICLE_CONFIG_FEATURES = new Set<VehicleConfigFeature>(['flight_modes', 'power', 'safety'])

export type BoundaryRuntimeCommand = RuntimeCommand

const CLIENT_DENIED_COMMANDS = new Set<string>([
  'MAV_CMD_DO_SET_MODE',
  'MAV_CMD_PREFLIGHT_CALIBRATION',
  'MAV_CMD_PREFLIGHT_REBOOT_SHUTDOWN',
  'MAV_CMD_DO_MOTOR_TEST',
  'MAV_CMD_ACTUATOR_TEST',
  'MAV_CMD_DO_SET_SERVO',
  'MAV_CMD_SET_MESSAGE_INTERVAL',
  'MAV_CMD_REQUEST_MESSAGE',
  'MAV_CMD_DO_AUTOTUNE_ENABLE',
  'MAV_CMD_DO_START_MAG_CAL',
  'MAV_CMD_DO_ACCEPT_MAG_CAL',
  'MAV_CMD_DO_CANCEL_MAG_CAL',
  'MAV_CMD_ACCELCAL_VEHICLE_POS',
])

export class InputValidationError extends Error {
  readonly code: string
  readonly path?: string

  constructor(code: string, message: string, path?: string) {
    super(message)
    this.name = 'InputValidationError'
    this.code = code
    this.path = path
  }
}

function fail(code: string, message: string, path?: string): never {
  throw new InputValidationError(code, message, path)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) fail('invalid_type', `${path} 必须是对象`, path)
  return value
}

function text(
  value: unknown,
  path: string,
  options: { minBytes?: number; maxBytes: number; pattern?: RegExp },
): string {
  if (typeof value !== 'string') fail('invalid_type', `${path} 必须是字符串`, path)
  const bytes = new TextEncoder().encode(value).byteLength
  const minBytes = options.minBytes ?? 0
  if (bytes < minBytes || bytes > options.maxBytes) {
    fail('out_of_range', `${path} 长度必须在 ${minBytes}..${options.maxBytes} 字节之间`, path)
  }
  if (options.pattern && !options.pattern.test(value)) {
    fail('invalid_format', `${path} 格式无效`, path)
  }
  return value
}

function optionalText(
  value: unknown,
  path: string,
  options: { minBytes?: number; maxBytes: number; pattern?: RegExp },
): string | undefined {
  if (value === undefined) return undefined
  return text(value, path, options)
}

function finiteNumber(
  value: unknown,
  path: string,
  options: { min?: number; max?: number; integer?: boolean } = {},
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail('invalid_number', `${path} 必须是有限数值`, path)
  }
  if (options.integer && !Number.isInteger(value)) {
    fail('invalid_integer', `${path} 必须是整数`, path)
  }
  if (options.min !== undefined && value < options.min) {
    fail('out_of_range', `${path} 不得小于 ${options.min}`, path)
  }
  if (options.max !== undefined && value > options.max) {
    fail('out_of_range', `${path} 不得大于 ${options.max}`, path)
  }
  return value
}

function safetyAuthorityId(value: unknown): string {
  return text(value, 'expectedSafetyAuthorityId', {
    minBytes: 36,
    maxBytes: 36,
    pattern: /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  })
}

function requiredSafetyContext(
  input: Record<string, unknown>,
  operation: string,
): { expectedSafetyEpoch: number; expectedSafetyAuthorityId: string } {
  if (input.expectedSafetyEpoch === undefined || input.expectedSafetyAuthorityId === undefined) {
    fail(
      'safety_epoch_required',
      `${operation} 必须绑定当前 safety authority/epoch`,
      'expectedSafetyEpoch',
    )
  }
  return {
    expectedSafetyEpoch: finiteNumber(input.expectedSafetyEpoch, 'expectedSafetyEpoch', {
      min: 0,
      max: Number.MAX_SAFE_INTEGER,
      integer: true,
    }),
    expectedSafetyAuthorityId: safetyAuthorityId(input.expectedSafetyAuthorityId),
  }
}

function requestId(value: unknown): string | undefined {
  return optionalText(value, 'requestId', {
    minBytes: 1,
    maxBytes: REQUEST_ID_MAX_BYTES,
    pattern: /^[\x20-\x7e]+$/,
  })
}

function withRequestId<T extends object>(
  message: T,
  id: string | undefined,
): T & { requestId?: string } {
  return id === undefined ? message : { ...message, requestId: id }
}

/**
 * A flight-controller filesystem path forwarded over MAVLink FTP. Absolute,
 * bounded, free of control characters and free of `..` traversal segments -
 * the FC firmware must never receive a path we could not display verbatim.
 */
function devicePath(value: unknown, path: string): string {
  const parsed = text(value, path, {
    minBytes: 1,
    maxBytes: FTP_MAX_PATH_BYTES,
    pattern: /^\/[^\0-\x1f\x7f]*$/,
  })
  const segments = parsed.split('/')
  if (segments.some((segment) => segment === '..')) {
    fail('invalid_format', `${path} 不得包含 .. 路径段`, path)
  }
  return parsed
}

// -- Calibration validation helpers ------------------------------------------

const CALIBRATION_KINDS: ReadonlySet<string> =
  new Set<CalibrationKind>(['accel', 'accel_simple', 'gyro', 'mag', 'baro', 'level'])

function calibrationSessionId(value: unknown): string {
  return text(value, 'data.sessionId', {
    minBytes: 8,
    maxBytes: 64,
    pattern: /^[0-9a-fA-F-]+$/,
  })
}

/** Reject unexpected keys so action payloads stay strict discriminated unions. */
function restrictKeys(
  data: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  for (const key of Object.keys(data)) {
    if (!allowed.includes(key)) {
      fail('unexpected_field', `${path}.${key} 不是该消息允许的字段`, `${path}.${key}`)
    }
  }
}

// -- ESC validation helpers -------------------------------------------------

function escSessionId(value: unknown): string {
  return text(value, 'data.sessionId', {
    minBytes: 8,
    maxBytes: 64,
    pattern: /^[0-9a-fA-F-]+$/,
  })
}

function escJobId(value: unknown): string {
  return text(value, 'data.jobId', {
    minBytes: 8,
    maxBytes: 64,
    pattern: /^[0-9a-fA-F-]+$/,
  })
}

/** Validate an ESC target index list: 1..ESC_MAX_TARGETS unique 0-based indices. */
function escTargets(value: unknown): number[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > ESC_MAX_TARGETS) {
    fail('invalid_params', `data.targets 必须是 1..${ESC_MAX_TARGETS} 项的数组`, 'data.targets')
  }
  const seen = new Set<number>()
  const targets = value.map((item, index) => {
    const target = finiteNumber(item, `data.targets[${index}]`, {
      min: 0,
      max: ESC_MAX_TARGETS - 1,
      integer: true,
    })
    if (seen.has(target)) fail('invalid_params', 'data.targets 不得重复', 'data.targets')
    seen.add(target)
    return target
  })
  return targets
}

/** Validate PX4 SERIAL_CONTROL ESC channel ids (20..27). */
function escChannels(value: unknown): number[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > ESC_MAX_TARGETS) {
    fail('invalid_params', `data.channels 必须是 1..${ESC_MAX_TARGETS} 项的数组`, 'data.channels')
  }
  return value.map((item, index) =>
    finiteNumber(item, `data.channels[${index}]`, {
      min: PX4_ESC_SERIAL_CONTROL_DEVICE_MIN,
      max: PX4_ESC_SERIAL_CONTROL_DEVICE_MAX,
      integer: true,
    })
  )
}

/** Validate a settings write map: bounded key count, finite numeric values. */
function escValues(value: unknown): Record<string, number> {
  const map = record(value, 'data.values')
  const keys = Object.keys(map)
  if (keys.length < 1 || keys.length > 128) {
    fail('invalid_params', 'data.values 必须包含 1..128 个字段', 'data.values')
  }
  const result: Record<string, number> = {}
  for (const key of keys) {
    if (!/^[A-Za-z0-9_]{1,32}$/.test(key)) {
      fail('invalid_params', `data.values 键名无效：${key}`, 'data.values')
    }
    result[key] = finiteNumber(map[key], `data.values.${key}`, { min: -MAX_FLOAT32, max: MAX_FLOAT32 })
  }
  return result
}

export function parseRuntimeCommand(value: unknown): BoundaryRuntimeCommand {
  const input = record(value, 'message')
  const type = text(input.type, 'type', { minBytes: 1, maxBytes: 64, pattern: /^[a-z_]+$/ })
  const id = requestId(input.requestId)

  switch (type) {
    case 'command': {
      const cmd = text(input.cmd, 'cmd', {
        minBytes: 1,
        maxBytes: 64,
        pattern: /^MAV_CMD_[A-Z0-9_]+$/,
      })
      if (!Object.prototype.hasOwnProperty.call(MAVLINK_COMMANDS, cmd)) {
        fail('unsupported_command', `不支持的 MAVLink 命令：${cmd}`, 'cmd')
      }
      if (CLIENT_DENIED_COMMANDS.has(cmd)) {
        fail('restricted_command', `${cmd} 仅允许由本地运行时专用安全流程发送`, 'cmd')
      }
      if (!Array.isArray(input.params) || input.params.length > 7) {
        fail('invalid_params', 'params 必须是最多包含 7 项的数组', 'params')
      }
      const params = input.params.map((item, index) =>
        finiteNumber(item, `params[${index}]`, { min: -MAX_FLOAT32, max: MAX_FLOAT32 })
      )
      const safetyConfirmation = optionalText(input.safetyConfirmation, 'safetyConfirmation', {
        minBytes: 1,
        maxBytes: 16,
        pattern: /^[a-z_]+$/,
      })
      const expectedSafetyEpoch = input.expectedSafetyEpoch === undefined
        ? undefined
        : finiteNumber(input.expectedSafetyEpoch, 'expectedSafetyEpoch', {
            min: 0,
            max: Number.MAX_SAFE_INTEGER,
            integer: true,
          })
      const expectedSafetyAuthorityId = input.expectedSafetyAuthorityId === undefined
        ? undefined
        : safetyAuthorityId(input.expectedSafetyAuthorityId)
      if (
        safetyConfirmation !== undefined
        && safetyConfirmation !== 'arm'
        && safetyConfirmation !== 'disarm'
        && safetyConfirmation !== 'takeoff'
      ) {
        fail('invalid_safety_confirmation', 'safetyConfirmation 值无效', 'safetyConfirmation')
      }
      if (cmd === 'MAV_CMD_COMPONENT_ARM_DISARM') {
        if ((params[0] !== 0 && params[0] !== 1) || (params[1] ?? 0) !== 0) {
          fail(
            'unsafe_command_params',
            'ARM_DISARM 仅允许普通解锁/上锁，禁止 force-arm magic 或其他动作',
            'params',
          )
        }
        const requiredConfirmation = params[0] === 1 ? 'arm' : 'disarm'
        if (safetyConfirmation !== requiredConfirmation) {
          fail(
            'safety_confirmation_required',
            `ARM_DISARM 必须显式确认 ${requiredConfirmation}`,
            'safetyConfirmation',
          )
        }
        if (
          params[0] === 1
          && (expectedSafetyEpoch === undefined || expectedSafetyAuthorityId === undefined)
        ) {
          fail(
            'safety_epoch_required',
            '解锁必须绑定当前 safety authority/epoch',
            'expectedSafetyEpoch',
          )
        }
      } else if (cmd === 'MAV_CMD_NAV_TAKEOFF') {
        if (safetyConfirmation !== 'takeoff') {
          fail('safety_confirmation_required', '起飞命令必须显式确认 takeoff', 'safetyConfirmation')
        }
        if (params.length < 7 || params[6] < 0.5 || params[6] > 500) {
          fail('unsafe_command_params', '起飞高度必须在 0.5..500 米之间', 'params[6]')
        }
        if (expectedSafetyEpoch === undefined || expectedSafetyAuthorityId === undefined) {
          fail('safety_epoch_required', '起飞必须绑定当前 safety authority/epoch', 'expectedSafetyEpoch')
        }
      } else if (safetyConfirmation !== undefined) {
        fail(
          'unexpected_safety_confirmation',
          `${cmd} 不接受 safetyConfirmation`,
          'safetyConfirmation',
        )
      }
      return withRequestId({
        type: 'command',
        cmd,
        params,
        ...(safetyConfirmation ? { safetyConfirmation } : {}),
        ...(expectedSafetyEpoch === undefined ? {} : { expectedSafetyEpoch }),
        ...(expectedSafetyAuthorityId === undefined ? {} : { expectedSafetyAuthorityId }),
      }, id) as BoundaryRuntimeCommand
    }

    case 'param_set': {
      const data = record(input.data, 'data')
      const paramId = text(data.id, 'data.id', {
        minBytes: 1,
        maxBytes: 16,
        pattern: /^[\x21-\x7e]+$/,
      })
      const paramValue = finiteNumber(data.value, 'data.value', {
        min: -MAX_FLOAT32,
        max: MAX_FLOAT32,
      })
      const paramType = finiteNumber(data.paramType, 'data.paramType', {
        min: 1,
        max: 9,
        integer: true,
      })
      if (!PARAM_TYPES.has(paramType)) {
        fail('unsupported_param_type', `不支持的 MAV_PARAM_TYPE：${paramType}`, 'data.paramType')
      }
      const safetyConfirmation = input.safetyConfirmation === undefined
        ? undefined
        : text(input.safetyConfirmation, 'safetyConfirmation', {
            minBytes: 1,
            maxBytes: 32,
            pattern: /^sensitive_param$/,
          }) as 'sensitive_param'
      const expectedSafetyEpoch = input.expectedSafetyEpoch === undefined
        ? undefined
        : finiteNumber(input.expectedSafetyEpoch, 'expectedSafetyEpoch', {
            min: 0,
            max: Number.MAX_SAFE_INTEGER,
            integer: true,
          })
      const expectedSafetyAuthorityId = input.expectedSafetyAuthorityId === undefined
        ? undefined
        : safetyAuthorityId(input.expectedSafetyAuthorityId)
      if (
        safetyConfirmation === 'sensitive_param'
        && (expectedSafetyEpoch === undefined || expectedSafetyAuthorityId === undefined)
      ) {
        fail('safety_epoch_required', '敏感参数写入必须绑定当前 safety authority/epoch', 'expectedSafetyEpoch')
      }
      if (
        safetyConfirmation === undefined
        && (expectedSafetyEpoch !== undefined || expectedSafetyAuthorityId !== undefined)
      ) {
        fail('unexpected_safety_context', '未确认敏感参数写入时不得携带 safety authority/epoch', 'expectedSafetyEpoch')
      }
      return withRequestId({
        type: 'param_set',
        data: { id: paramId, value: paramValue, paramType },
        ...(safetyConfirmation === undefined ? {} : { safetyConfirmation }),
        ...(expectedSafetyEpoch === undefined ? {} : { expectedSafetyEpoch }),
        ...(expectedSafetyAuthorityId === undefined ? {} : { expectedSafetyAuthorityId }),
      }, id) as BoundaryRuntimeCommand
    }

    case 'vehicle_config_set': {
      if (id === undefined) fail('missing_request_id', 'vehicle_config_set 必须携带 requestId', 'requestId')
      const feature = text(input.feature, 'feature', {
        minBytes: 1,
        maxBytes: 32,
        pattern: /^[a-z_]+$/,
      }) as VehicleConfigFeature
      if (!VEHICLE_CONFIG_FEATURES.has(feature)) {
        fail('invalid_feature', `不支持的配置功能：${feature}`, 'feature')
      }
      const data = record(input.data, 'data')
      restrictKeys(data, ['id', 'value'], 'data')
      const configId = text(data.id, 'data.id', {
        minBytes: 1,
        maxBytes: 16,
        pattern: /^[A-Z0-9_]+$/,
      })
      const configValue = finiteNumber(data.value, 'data.value', {
        min: -MAX_FLOAT32,
        max: MAX_FLOAT32,
      })
      const confirmation = input.safetyConfirmation
      if (confirmation !== undefined && confirmation !== 'reduce_failsafe_protection') {
        fail('invalid_safety_confirmation', '配置安全确认值无效', 'safetyConfirmation')
      }
      if (confirmation !== undefined && feature !== 'safety') {
        fail('unexpected_safety_confirmation', '仅安全配置接受降低保护确认', 'safetyConfirmation')
      }
      if (
        confirmation === undefined
        && (input.expectedSafetyEpoch !== undefined || input.expectedSafetyAuthorityId !== undefined)
      ) {
        fail('unexpected_safety_context', '未确认降低保护时不得携带 safety authority/epoch', 'expectedSafetyEpoch')
      }
      const context = confirmation === 'reduce_failsafe_protection'
        ? requiredSafetyContext(input, '降低失效保护')
        : null
      return {
        type: 'vehicle_config_set',
        requestId: id,
        feature,
        data: { id: configId, value: configValue },
        ...(confirmation ? { safetyConfirmation: 'reduce_failsafe_protection' as const, ...context! } : {}),
      }
    }

    case 'airframe_apply': {
      if (id === undefined) fail('missing_request_id', 'airframe_apply 必须携带 requestId', 'requestId')
      if (input.safetyConfirmation !== 'apply_airframe') {
        fail('safety_confirmation_required', '应用机架必须显式确认 apply_airframe', 'safetyConfirmation')
      }
      const context = requiredSafetyContext(input, '应用机架')
      const data = record(input.data, 'data')
      if (data.family === 'px4') {
        restrictKeys(data, ['family', 'autostartId'], 'data')
        return {
          type: 'airframe_apply',
          requestId: id,
          safetyConfirmation: 'apply_airframe',
          ...context,
          data: {
            family: 'px4',
            autostartId: finiteNumber(data.autostartId, 'data.autostartId', {
              min: 1,
              max: 100000,
              integer: true,
            }),
          },
        }
      }
      if (data.family === 'ardupilot') {
        restrictKeys(data, ['family', 'frameClass', 'frameType'], 'data')
        return {
          type: 'airframe_apply',
          requestId: id,
          safetyConfirmation: 'apply_airframe',
          ...context,
          data: {
            family: 'ardupilot',
            frameClass: finiteNumber(data.frameClass, 'data.frameClass', {
              min: 0,
              max: 255,
              integer: true,
            }),
            frameType: finiteNumber(data.frameType, 'data.frameType', {
              min: 0,
              max: 255,
              integer: true,
            }),
          },
        }
      }
      return fail('invalid_airframe_family', 'data.family 必须是 px4 或 ardupilot', 'data.family')
    }

    case 'radio_calibration_start': {
      if (id === undefined) fail('missing_request_id', 'radio_calibration_start 必须携带 requestId', 'requestId')
      const context = requiredSafetyContext(input, '遥控器校准')
      const data = record(input.data, 'data')
      restrictKeys(data, ['transmitterMode'], 'data')
      return {
        type: 'radio_calibration_start',
        requestId: id,
        ...context,
        data: {
          transmitterMode: finiteNumber(data.transmitterMode, 'data.transmitterMode', {
            min: 1,
            max: 4,
            integer: true,
          }) as 1 | 2 | 3 | 4,
        },
      }
    }

    case 'radio_calibration_advance':
    case 'radio_calibration_cancel': {
      if (id === undefined) fail('missing_request_id', `${type} 必须携带 requestId`, 'requestId')
      const data = record(input.data, 'data')
      restrictKeys(data, ['sessionId'], 'data')
      return {
        type,
        requestId: id,
        data: { sessionId: calibrationSessionId(data.sessionId) },
      } as BoundaryRuntimeCommand
    }

    case 'param_request_list':
      return withRequestId({ type: 'param_request_list' }, id) as BoundaryRuntimeCommand

    case 'message_rates_set': {
      const data = record(input.data, 'data')
      restrictKeys(data, MESSAGE_RATE_KEYS, 'data')
      const rates = {} as MessageRateConfig
      for (const key of MESSAGE_RATE_KEYS) {
        const rate = finiteNumber(data[key], `data.${key}`, { min: 1, max: 20, integer: true })
        if (!MESSAGE_RATE_VALUES.has(rate)) {
          fail('unsupported_message_rate', `data.${key} 不是支持的消息频率`, `data.${key}`)
        }
        rates[key] = rate
      }
      return withRequestId({ type: 'message_rates_set', data: rates }, id) as BoundaryRuntimeCommand
    }

    case 'shell_open':
      return withRequestId({ type: 'shell_open' }, id) as BoundaryRuntimeCommand

    case 'shell_write': {
      const data = record(input.data, 'data')
      restrictKeys(data, ['text'], 'data')
      const shellText = text(data.text, 'data.text', { minBytes: 1, maxBytes: 1024 })
      if (shellText.includes('\0')) fail('invalid_format', '终端输入不能包含 NUL 字节', 'data.text')
      return withRequestId({ type: 'shell_write', data: { text: shellText } }, id) as BoundaryRuntimeCommand
    }

    case 'shell_close':
      return withRequestId({ type: 'shell_close' }, id) as BoundaryRuntimeCommand

    case 'reboot_vehicle': {
      if (id === undefined) fail('missing_request_id', 'reboot_vehicle 必须携带 requestId', 'requestId')
      if (input.safetyConfirmation !== 'reboot_flight_controller') {
        fail('safety_confirmation_required', '重启飞控必须显式确认 reboot_flight_controller', 'safetyConfirmation')
      }
      const expectedSafetyEpoch = finiteNumber(input.expectedSafetyEpoch, 'expectedSafetyEpoch', {
        min: 0,
        max: Number.MAX_SAFE_INTEGER,
        integer: true,
      })
      const expectedSafetyAuthorityId = safetyAuthorityId(input.expectedSafetyAuthorityId)
      return withRequestId({
        type: 'reboot_vehicle',
        safetyConfirmation: 'reboot_flight_controller' as const,
        expectedSafetyEpoch,
        expectedSafetyAuthorityId,
      }, id) as BoundaryRuntimeCommand
    }

    case 'set_flight_mode': {
      const data = record(input.data, 'data')
      // Only the profile mode id crosses the boundary; the server encodes the
      // stack-specific MAV_CMD_DO_SET_MODE parameters after capability checks.
      const modeId = finiteNumber(data.modeId, 'data.modeId', {
        min: 0,
        max: 0xffffffff,
        integer: true,
      })
      return withRequestId({
        type: 'set_flight_mode',
        data: { modeId },
      }, id) as BoundaryRuntimeCommand
    }

    case 'start_calibration': {
      if (id === undefined) {
        fail('missing_request_id', 'start_calibration 必须携带 requestId', 'requestId')
      }
      const data = record(input.data, 'data')
      restrictKeys(data, ['kind'], 'data')
      const kind = text(data.kind, 'data.kind', { minBytes: 1, maxBytes: 16, pattern: /^[a-z_]+$/ })
      if (!CALIBRATION_KINDS.has(kind)) {
        fail('invalid_calibration_kind', `不支持的校准类型：${kind}`, 'data.kind')
      }
      return withRequestId({
        type: 'start_calibration',
        data: { kind: kind as CalibrationKind },
      }, id) as BoundaryRuntimeCommand
    }

    case 'calibration_action': {
      if (id === undefined) {
        fail('missing_request_id', 'calibration_action 必须携带 requestId', 'requestId')
      }
      const data = record(input.data, 'data')
      const sessionId = calibrationSessionId(data.sessionId)
      const action = text(data.action, 'data.action', {
        minBytes: 1,
        maxBytes: 32,
        pattern: /^[a-z_]+$/,
      })
      if (action === 'cancel' || action === 'accept_mag') {
        restrictKeys(data, ['sessionId', 'action'], 'data')
        return withRequestId({
          type: 'calibration_action',
          data: { sessionId, action },
        }, id) as BoundaryRuntimeCommand
      }
      if (action === 'confirm_position') {
        restrictKeys(data, ['sessionId', 'action', 'position'], 'data')
        const position = finiteNumber(data.position, 'data.position', {
          min: 1,
          max: 6,
          integer: true,
        }) as AccelCalibrationPosition
        return withRequestId({
          type: 'calibration_action',
          data: { sessionId, action, position },
        }, id) as BoundaryRuntimeCommand
      }
      return fail('invalid_calibration_action', `不支持的校准会话动作：${action}`, 'data.action')
    }

    case 'calibration_reclaim': {
      if (id === undefined) {
        fail('missing_request_id', 'calibration_reclaim 必须携带 requestId', 'requestId')
      }
      const data = record(input.data, 'data')
      restrictKeys(data, ['sessionId', 'recoveryToken'], 'data')
      return withRequestId({
        type: 'calibration_reclaim',
        data: {
          sessionId: calibrationSessionId(data.sessionId),
          recoveryToken: text(data.recoveryToken, 'data.recoveryToken', {
            minBytes: 16,
            maxBytes: 128,
            pattern: /^[A-Za-z0-9_-]+$/,
          }),
        },
      }, id) as BoundaryRuntimeCommand
    }

    case 'autotune_start': {
      if (id === undefined) fail('missing_request_id', 'autotune_start 必须携带 requestId', 'requestId')
      restrictKeys(input, [
        'type', 'requestId', 'safetyConfirmation',
        'expectedSafetyEpoch', 'expectedSafetyAuthorityId',
      ], 'message')
      if (input.safetyConfirmation !== 'autotune_in_flight') {
        fail('safety_confirmation_required', '自动调参必须显式确认 autotune_in_flight', 'safetyConfirmation')
      }
      return {
        type: 'autotune_start',
        requestId: id,
        safetyConfirmation: 'autotune_in_flight',
        expectedSafetyEpoch: finiteNumber(input.expectedSafetyEpoch, 'expectedSafetyEpoch', {
          min: 0, max: Number.MAX_SAFE_INTEGER, integer: true,
        }),
        expectedSafetyAuthorityId: safetyAuthorityId(input.expectedSafetyAuthorityId),
      }
    }

    case 'autotune_action': {
      if (id === undefined) fail('missing_request_id', 'autotune_action 必须携带 requestId', 'requestId')
      const data = record(input.data, 'data')
      restrictKeys(data, ['sessionId', 'action'], 'data')
      const action = text(data.action, 'data.action', {
        minBytes: 1, maxBytes: 32, pattern: /^[a-z_]+$/,
      })
      if (action !== 'abort' && action !== 'test_gains' && action !== 'restore_gains') {
        fail('invalid_autotune_action', `不支持的自动调参动作：${action}`, 'data.action')
      }
      return {
        type: 'autotune_action',
        requestId: id,
        data: {
          sessionId: calibrationSessionId(data.sessionId),
          action: action as 'abort' | 'test_gains' | 'restore_gains',
        },
      }
    }

    case 'autotune_reclaim': {
      if (id === undefined) fail('missing_request_id', 'autotune_reclaim 必须携带 requestId', 'requestId')
      const data = record(input.data, 'data')
      restrictKeys(data, ['sessionId', 'recoveryToken'], 'data')
      return {
        type: 'autotune_reclaim',
        requestId: id,
        data: {
          sessionId: calibrationSessionId(data.sessionId),
          recoveryToken: text(data.recoveryToken, 'data.recoveryToken', {
            minBytes: 16, maxBytes: 128, pattern: /^[A-Za-z0-9_-]+$/,
          }),
        },
      }
    }

    case 'manual_control': {
      const data = record(input.data, 'data')
      const buttons = data.buttons === undefined
        ? undefined
        : finiteNumber(data.buttons, 'data.buttons', { min: 0, max: 0xffff, integer: true })
      const control = {
        x: finiteNumber(data.x, 'data.x', { min: -1000, max: 1000 }),
        y: finiteNumber(data.y, 'data.y', { min: -1000, max: 1000 }),
        z: finiteNumber(data.z, 'data.z', { min: 0, max: 1000 }),
        r: finiteNumber(data.r, 'data.r', { min: -1000, max: 1000 }),
        ...(buttons === undefined ? {} : { buttons }),
      }
      return withRequestId({ type: 'manual_control', data: control }, id) as BoundaryRuntimeCommand
    }

    case 'motor_test': {
      const data = record(input.data, 'data')
      const throttle = finiteNumber(data.throttle, 'data.throttle', { min: 0, max: 100 })
      const duration = finiteNumber(data.duration, 'data.duration', { min: 0, max: 30 })
      const propsRemoved = data.propsRemoved === true
      const expectedSafetyEpoch = input.expectedSafetyEpoch === undefined
        ? undefined
        : finiteNumber(input.expectedSafetyEpoch, 'expectedSafetyEpoch', {
            min: 0,
            max: Number.MAX_SAFE_INTEGER,
            integer: true,
          })
      const expectedSafetyAuthorityId = input.expectedSafetyAuthorityId === undefined
        ? undefined
        : safetyAuthorityId(input.expectedSafetyAuthorityId)
      if (throttle > 0 && (!propsRemoved || duration <= 0)) {
        fail(
          'motor_safety_confirmation_required',
          '启动电机测试必须确认已拆除螺旋桨，且 duration 必须大于 0',
          'data.propsRemoved',
        )
      }
      if (throttle === 0 && duration !== 0) {
        fail('unsafe_motor_test', '停止电机测试时 duration 必须为 0', 'data.duration')
      }
      if (throttle > 0 && (expectedSafetyEpoch === undefined || expectedSafetyAuthorityId === undefined)) {
        fail('safety_epoch_required', '启动电机测试必须绑定当前 safety authority/epoch', 'expectedSafetyEpoch')
      }
      return withRequestId({
        type: 'motor_test',
        data: {
          instance: finiteNumber(data.instance, 'data.instance', { min: 1, max: 12, integer: true }),
          throttle,
          duration,
          ...(propsRemoved ? { propsRemoved: true } : {}),
        },
        ...(expectedSafetyEpoch === undefined ? {} : { expectedSafetyEpoch }),
        ...(expectedSafetyAuthorityId === undefined ? {} : { expectedSafetyAuthorityId }),
      }, id) as BoundaryRuntimeCommand
    }

    case 'motor_test_batch': {
      const data = record(input.data, 'data')
      if (!Array.isArray(data.instances) || data.instances.length < 1 || data.instances.length > 12) {
        fail('invalid_motor_instances', 'data.instances 必须是 1..12 项的数组', 'data.instances')
      }
      const instances = data.instances.map((value, index) =>
        finiteNumber(value, `data.instances[${index}]`, { min: 1, max: 12, integer: true }))
      if (new Set(instances).size !== instances.length) {
        fail('duplicate_motor_instance', 'data.instances 不能包含重复电机实例', 'data.instances')
      }
      const throttle = finiteNumber(data.throttle, 'data.throttle', { min: 0, max: 100 })
      const duration = finiteNumber(data.duration, 'data.duration', { min: 0, max: 30 })
      const propsRemoved = data.propsRemoved === true
      const expectedSafetyEpoch = input.expectedSafetyEpoch === undefined
        ? undefined
        : finiteNumber(input.expectedSafetyEpoch, 'expectedSafetyEpoch', {
            min: 0,
            max: Number.MAX_SAFE_INTEGER,
            integer: true,
          })
      const expectedSafetyAuthorityId = input.expectedSafetyAuthorityId === undefined
        ? undefined
        : safetyAuthorityId(input.expectedSafetyAuthorityId)
      if (throttle > 0 && (!propsRemoved || duration <= 0)) {
        fail(
          'motor_safety_confirmation_required',
          '启动电机测试必须确认已拆除螺旋桨，且 duration 必须大于 0',
          'data.propsRemoved',
        )
      }
      if (throttle === 0 && duration !== 0) {
        fail('unsafe_motor_test', '停止电机测试时 duration 必须为 0', 'data.duration')
      }
      if (throttle > 0 && (expectedSafetyEpoch === undefined || expectedSafetyAuthorityId === undefined)) {
        fail('safety_epoch_required', '启动电机测试必须绑定当前 safety authority/epoch', 'expectedSafetyEpoch')
      }
      return withRequestId({
        type: 'motor_test_batch',
        data: {
          instances,
          throttle,
          duration,
          ...(propsRemoved ? { propsRemoved: true } : {}),
        },
        ...(expectedSafetyEpoch === undefined ? {} : { expectedSafetyEpoch }),
        ...(expectedSafetyAuthorityId === undefined ? {} : { expectedSafetyAuthorityId }),
      }, id) as BoundaryRuntimeCommand
    }

    case 'select_target': {
      const data = record(input.data, 'data')
      return withRequestId({
        type: 'select_target',
        data: {
          systemId: finiteNumber(data.systemId, 'data.systemId', { min: 1, max: 254, integer: true }),
          componentId: finiteNumber(data.componentId, 'data.componentId', { min: 1, max: 255, integer: true }),
        },
      }, id)
    }

    case 'fs_list': {
      const data = record(input.data, 'data')
      return withRequestId({
        type: 'fs_list',
        data: { path: devicePath(data.path, 'data.path') },
      }, id) as BoundaryRuntimeCommand
    }

    case 'fs_download': {
      const data = record(input.data, 'data')
      return withRequestId({
        type: 'fs_download',
        data: { path: devicePath(data.path, 'data.path') },
      }, id) as BoundaryRuntimeCommand
    }

    case 'fs_download_cancel':
      return withRequestId({ type: 'fs_download_cancel' }, id) as BoundaryRuntimeCommand

    case 'fs_delete': {
      const data = record(input.data, 'data')
      if (input.safetyConfirmation !== 'delete_files') {
        fail(
          'safety_confirmation_required',
          '删除飞控文件必须显式确认 delete_files',
          'safetyConfirmation',
        )
      }
      if (!Array.isArray(data.entries) || data.entries.length < 1 || data.entries.length > 64) {
        fail('invalid_params', 'data.entries 必须是 1..64 项的数组', 'data.entries')
      }
      const entries = data.entries.map((item, index) => {
        const entry = record(item, `data.entries[${index}]`)
        if (entry.kind !== 'file' && entry.kind !== 'dir') {
          fail('invalid_params', `data.entries[${index}].kind 必须是 file 或 dir`, `data.entries[${index}].kind`)
        }
        return {
          path: devicePath(entry.path, `data.entries[${index}].path`),
          kind: entry.kind as 'file' | 'dir',
        }
      })
      const expectedSafetyEpoch = finiteNumber(input.expectedSafetyEpoch, 'expectedSafetyEpoch', {
        min: 0,
        max: Number.MAX_SAFE_INTEGER,
        integer: true,
      })
      const expectedSafetyAuthorityId = safetyAuthorityId(input.expectedSafetyAuthorityId)
      return withRequestId({
        type: 'fs_delete',
        data: { entries },
        safetyConfirmation: 'delete_files' as const,
        expectedSafetyEpoch,
        expectedSafetyAuthorityId,
      }, id) as BoundaryRuntimeCommand
    }

    case 'esc_session_start': {
      if (input.safetyConfirmation !== ESC_SESSION_SAFETY_CONFIRMATION) {
        fail(
          'safety_confirmation_required',
          `ESC 配置会话必须显式确认 ${ESC_SESSION_SAFETY_CONFIRMATION}`,
          'safetyConfirmation',
        )
      }
      const data = record(input.data, 'data')
      const expectedSafetyEpoch = finiteNumber(input.expectedSafetyEpoch, 'expectedSafetyEpoch', {
        min: 0,
        max: Number.MAX_SAFE_INTEGER,
        integer: true,
      })
      const expectedSafetyAuthorityId = safetyAuthorityId(input.expectedSafetyAuthorityId)
      const mode = text(data.mode, 'data.mode', { minBytes: 1, maxBytes: 32, pattern: /^[a-z0-9_]+$/ })
      if (mode === 'ardupilot_passthrough') {
        return withRequestId({
          type: 'esc_session_start',
          safetyConfirmation: ESC_SESSION_SAFETY_CONFIRMATION,
          expectedSafetyEpoch,
          expectedSafetyAuthorityId,
          data: { mode: 'ardupilot_passthrough' },
        }, id) as BoundaryRuntimeCommand
      }
      if (mode === 'px4_serial_control') {
        const channels = escChannels(data.channels)
        return withRequestId({
          type: 'esc_session_start',
          safetyConfirmation: ESC_SESSION_SAFETY_CONFIRMATION,
          expectedSafetyEpoch,
          expectedSafetyAuthorityId,
          data: { mode: 'px4_serial_control', channels },
        }, id) as BoundaryRuntimeCommand
      }
      if (mode === 'direct') {
        return withRequestId({
          type: 'esc_session_start',
          safetyConfirmation: ESC_SESSION_SAFETY_CONFIRMATION,
          expectedSafetyEpoch,
          expectedSafetyAuthorityId,
          data: { mode: 'direct' },
        }, id) as BoundaryRuntimeCommand
      }
      return fail('unsupported_esc_mode', `不支持的 ESC 连接模式：${mode}`, 'data.mode')
    }

    case 'esc_session_exit':
      return withRequestId({
        type: 'esc_session_exit',
        data: { sessionId: escSessionId(record(input.data, 'data').sessionId) },
      }, id) as BoundaryRuntimeCommand

    case 'esc_devices_scan':
      return withRequestId({
        type: 'esc_devices_scan',
        data: { sessionId: escSessionId(record(input.data, 'data').sessionId) },
      }, id) as BoundaryRuntimeCommand

    case 'esc_settings_read': {
      const data = record(input.data, 'data')
      const targets = data.targets === 'all' ? 'all' as const : escTargets(data.targets)
      return withRequestId({
        type: 'esc_settings_read',
        data: { sessionId: escSessionId(data.sessionId), targets },
      }, id) as BoundaryRuntimeCommand
    }

    case 'esc_settings_write': {
      const data = record(input.data, 'data')
      return withRequestId({
        type: 'esc_settings_write',
        data: {
          sessionId: escSessionId(data.sessionId),
          targets: escTargets(data.targets),
          values: escValues(data.values),
        },
      }, id) as BoundaryRuntimeCommand
    }

    case 'log_list':
      return withRequestId({ type: 'log_list' }, id) as BoundaryRuntimeCommand

    case 'log_download': {
      const data = record(input.data, 'data')
      return withRequestId({
        type: 'log_download',
        data: {
          logId: finiteNumber(data.logId, 'data.logId', {
            min: 0,
            max: 0xffff,
            integer: true,
          }),
        },
      }, id) as BoundaryRuntimeCommand
    }

    case 'log_download_cancel':
      return withRequestId({ type: 'log_download_cancel' }, id) as BoundaryRuntimeCommand

    case 'log_erase': {
      if (input.safetyConfirmation !== 'erase_all_logs') {
        fail(
          'safety_confirmation_required',
          '擦除全部 DataFlash 日志必须显式确认 erase_all_logs',
          'safetyConfirmation',
        )
      }
      const expectedSafetyEpoch = finiteNumber(input.expectedSafetyEpoch, 'expectedSafetyEpoch', {
        min: 0,
        max: Number.MAX_SAFE_INTEGER,
        integer: true,
      })
      const expectedSafetyAuthorityId = safetyAuthorityId(input.expectedSafetyAuthorityId)
      return withRequestId({
        type: 'log_erase',
        safetyConfirmation: 'erase_all_logs' as const,
        expectedSafetyEpoch,
        expectedSafetyAuthorityId,
      }, id) as BoundaryRuntimeCommand
    }

    default:
      return fail('unsupported_message', `不支持的消息类型：${type}`, 'type')
  }
}

export function parseConnectionConfig(value: unknown): ConnectionConfig {
  const input = record(value, 'body')
  if (input.type !== 'serial' && input.type !== 'bluetooth') {
    fail('unsupported_connection_type', 'type 必须是 serial 或 bluetooth', 'type')
  }
  const port = text(input.port, 'port', {
    minBytes: 1,
    maxBytes: PORT_NAME_MAX_BYTES,
    pattern: /^[^\0-\x1f\x7f]+$/,
  }).trim()
  if (!port) fail('invalid_format', 'port 不得为空', 'port')

  const baudRate = finiteNumber(input.baudRate, 'baudRate', {
    min: 1,
    max: 4_000_000,
    integer: true,
  })
  if (!(BAUD_RATES as readonly number[]).includes(baudRate)) {
    fail('unsupported_baud_rate', `不支持的波特率：${baudRate}`, 'baudRate')
  }

  const hexIdOptions = {
    minBytes: 1,
    maxBytes: 10,
    pattern: /^(?:0x)?[0-9a-fA-F]+$/,
  }
  const vendorId = optionalText(input.vendorId, 'vendorId', hexIdOptions)
  const productId = optionalText(input.productId, 'productId', hexIdOptions)
  const bluetoothServiceClassId = optionalText(
    input.bluetoothServiceClassId,
    'bluetoothServiceClassId',
    { minBytes: 1, maxBytes: 128, pattern: /^[\x21-\x7e]+$/ },
  )
  const bluetoothAddress = optionalText(
    input.bluetoothAddress,
    'bluetoothAddress',
    {
      minBytes: 12,
      maxBytes: 17,
      pattern: /^(?:[0-9a-fA-F]{12}|(?:[0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2})$/,
    },
  )
  const bluetoothChannel = input.bluetoothChannel === undefined
    ? undefined
    : finiteNumber(input.bluetoothChannel, 'bluetoothChannel', {
      min: 1,
      max: 30,
      integer: true,
    })

  // Discovery-v2 identity fields (connection compatibility plan §4.1/§4.3).
  const identityTextOptions = {
    minBytes: 1,
    maxBytes: 256,
    pattern: /^[\x21-\x7e]+$/,
  }
  const deviceId = optionalText(input.deviceId, 'deviceId', identityTextOptions)
  const serialNumber = optionalText(input.serialNumber, 'serialNumber', identityTextOptions)
  const stablePath = optionalText(input.stablePath, 'stablePath', identityTextOptions)
  const transport = input.transport === undefined
    ? undefined
    : input.transport === 'serial'
      || input.transport === 'bluetooth-spp'
      || input.transport === 'bluetooth-ble'
      ? (input.transport as ConnectionConfig['transport'])
      : fail('invalid_format', 'transport 必须是 serial、bluetooth-spp 或 bluetooth-ble', 'transport')

  return {
    type: input.type,
    port,
    baudRate,
    ...(vendorId === undefined ? {} : { vendorId }),
    ...(productId === undefined ? {} : { productId }),
    ...(bluetoothServiceClassId === undefined ? {} : { bluetoothServiceClassId }),
    ...(bluetoothAddress === undefined ? {} : { bluetoothAddress }),
    ...(bluetoothChannel === undefined ? {} : { bluetoothChannel }),
    ...(deviceId === undefined ? {} : { deviceId }),
    ...(transport === undefined ? {} : { transport }),
    ...(stablePath === undefined ? {} : { stablePath }),
    ...(serialNumber === undefined ? {} : { serialNumber }),
  }
}
