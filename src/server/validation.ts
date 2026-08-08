import { isIP } from 'node:net'
import {
  BAUD_RATES,
  FTP_MAX_PATH_BYTES,
  MAVLINK_COMMANDS,
  MESSAGE_RATE_OPTIONS,
  PX4_ESC_SERIAL_CONTROL_DEVICE_MAX,
  PX4_ESC_SERIAL_CONTROL_DEVICE_MIN,
} from '../shared/constants'
import { ESC_MAX_TARGETS } from '../shared/esc/types'
import type {
  AccelCalibrationPosition,
  CalibrationKind,
  ClientMessage,
  ConnectionConfig,
  MessageRateConfig,
} from '../shared/types'

const MAX_FLOAT32 = 3.4028234663852886e38
const PARAM_TYPES = new Set([1, 2, 3, 4, 5, 6, 9])
const REQUEST_ID_MAX_BYTES = 64
const PORT_NAME_MAX_BYTES = 512
const REMOTE_TOKEN_MIN_BYTES = 32
const REMOTE_TOKEN_MAX_BYTES = 512
const MESSAGE_RATE_KEYS = ['attitude', 'position', 'sensors', 'rc', 'status', 'hud', 'auxiliary'] as const
const MESSAGE_RATE_VALUES = new Set<number>(MESSAGE_RATE_OPTIONS)

export const DEFAULT_SERVER_HOST = '127.0.0.1'
export const DEFAULT_SERVER_PORT = 3000
export const DEFAULT_WS_MAX_PAYLOAD = 16 * 1024
export const DEFAULT_WS_MAX_CLIENTS = 8

export type BoundaryClientMessage = ClientMessage

const CLIENT_DENIED_COMMANDS = new Set<string>([
  'MAV_CMD_DO_SET_MODE',
  'MAV_CMD_PREFLIGHT_CALIBRATION',
  'MAV_CMD_PREFLIGHT_REBOOT_SHUTDOWN',
  'MAV_CMD_DO_MOTOR_TEST',
  'MAV_CMD_ACTUATOR_TEST',
  'MAV_CMD_DO_SET_SERVO',
  'MAV_CMD_SET_MESSAGE_INTERVAL',
  'MAV_CMD_REQUEST_MESSAGE',
  'MAV_CMD_DO_START_MAG_CAL',
  'MAV_CMD_DO_ACCEPT_MAG_CAL',
  'MAV_CMD_DO_CANCEL_MAG_CAL',
  'MAV_CMD_ACCELCAL_VEHICLE_POS',
])

export interface ServerConfig {
  host: string
  port: number
  remoteEnabled: boolean
  authToken: string | null
  allowedOrigins: string[]
  allowDevOrigin: boolean
  wsMaxPayload: number
  wsMaxClients: number
}

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
  const bytes = Buffer.byteLength(value, 'utf8')
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

export function parseClientMessage(value: unknown): BoundaryClientMessage {
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
        fail('restricted_command', `${cmd} 仅允许由后端专用安全流程发送`, 'cmd')
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
      } else if (cmd === 'MAV_CMD_NAV_TAKEOFF') {
        if (safetyConfirmation !== 'takeoff') {
          fail('safety_confirmation_required', '起飞命令必须显式确认 takeoff', 'safetyConfirmation')
        }
        if (params.length < 7 || params[6] < 0.5 || params[6] > 500) {
          fail('unsafe_command_params', '起飞高度必须在 0.5..500 米之间', 'params[6]')
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
      }, id) as BoundaryClientMessage
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
      return withRequestId({
        type: 'param_set',
        data: { id: paramId, value: paramValue, paramType },
      }, id) as BoundaryClientMessage
    }

    case 'param_request_list':
      return withRequestId({ type: 'param_request_list' }, id) as BoundaryClientMessage

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
      return withRequestId({ type: 'message_rates_set', data: rates }, id) as BoundaryClientMessage
    }

    case 'shell_open':
      return withRequestId({ type: 'shell_open' }, id) as BoundaryClientMessage

    case 'shell_write': {
      const data = record(input.data, 'data')
      restrictKeys(data, ['text'], 'data')
      const shellText = text(data.text, 'data.text', { minBytes: 1, maxBytes: 1024 })
      if (shellText.includes('\0')) fail('invalid_format', '终端输入不能包含 NUL 字节', 'data.text')
      return withRequestId({ type: 'shell_write', data: { text: shellText } }, id) as BoundaryClientMessage
    }

    case 'shell_close':
      return withRequestId({ type: 'shell_close' }, id) as BoundaryClientMessage

    case 'reboot_vehicle':
      if (id === undefined) fail('missing_request_id', 'reboot_vehicle 必须携带 requestId', 'requestId')
      if (input.safetyConfirmation !== 'reboot_flight_controller') {
        fail('safety_confirmation_required', '重启飞控必须显式确认 reboot_flight_controller', 'safetyConfirmation')
      }
      return withRequestId({
        type: 'reboot_vehicle',
        safetyConfirmation: 'reboot_flight_controller' as const,
      }, id) as BoundaryClientMessage

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
      }, id) as BoundaryClientMessage
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
      }, id) as BoundaryClientMessage
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
        }, id) as BoundaryClientMessage
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
        }, id) as BoundaryClientMessage
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
      }, id) as BoundaryClientMessage
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
      return withRequestId({ type: 'manual_control', data: control }, id) as BoundaryClientMessage
    }

    case 'motor_test': {
      const data = record(input.data, 'data')
      const throttle = finiteNumber(data.throttle, 'data.throttle', { min: 0, max: 100 })
      const duration = finiteNumber(data.duration, 'data.duration', { min: 0, max: 30 })
      const propsRemoved = data.propsRemoved === true
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
      return withRequestId({
        type: 'motor_test',
        data: {
          instance: finiteNumber(data.instance, 'data.instance', { min: 1, max: 12, integer: true }),
          throttle,
          duration,
          ...(propsRemoved ? { propsRemoved: true } : {}),
        },
      }, id) as BoundaryClientMessage
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
      return withRequestId({
        type: 'motor_test_batch',
        data: {
          instances,
          throttle,
          duration,
          ...(propsRemoved ? { propsRemoved: true } : {}),
        },
      }, id) as BoundaryClientMessage
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

    case 'release_control':
      return withRequestId({ type: 'release_control' }, id)

    case 'fs_list': {
      const data = record(input.data, 'data')
      return withRequestId({
        type: 'fs_list',
        data: { path: devicePath(data.path, 'data.path') },
      }, id) as BoundaryClientMessage
    }

    case 'fs_download': {
      const data = record(input.data, 'data')
      return withRequestId({
        type: 'fs_download',
        data: { path: devicePath(data.path, 'data.path') },
      }, id) as BoundaryClientMessage
    }

    case 'fs_download_cancel':
      return withRequestId({ type: 'fs_download_cancel' }, id) as BoundaryClientMessage

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
      return withRequestId({
        type: 'fs_delete',
        data: { entries },
        safetyConfirmation: 'delete_files' as const,
      }, id) as BoundaryClientMessage
    }

    case 'esc_session_start': {
      const data = record(input.data, 'data')
      const mode = text(data.mode, 'data.mode', { minBytes: 1, maxBytes: 32, pattern: /^[a-z0-9_]+$/ })
      if (mode === 'ardupilot_passthrough') {
        return withRequestId({
          type: 'esc_session_start',
          data: { mode: 'ardupilot_passthrough' },
        }, id) as BoundaryClientMessage
      }
      if (mode === 'px4_serial_control') {
        const channels = escChannels(data.channels)
        return withRequestId({
          type: 'esc_session_start',
          data: { mode: 'px4_serial_control', channels },
        }, id) as BoundaryClientMessage
      }
      if (mode === 'direct') {
        return withRequestId({
          type: 'esc_session_start',
          data: { mode: 'direct' },
        }, id) as BoundaryClientMessage
      }
      return fail('unsupported_esc_mode', `不支持的 ESC 连接模式：${mode}`, 'data.mode')
    }

    case 'esc_session_reclaim': {
      const data = record(input.data, 'data')
      return withRequestId({
        type: 'esc_session_reclaim',
        data: {
          sessionId: escSessionId(data.sessionId),
          recoveryToken: text(data.recoveryToken, 'data.recoveryToken', {
            minBytes: 16,
            maxBytes: 128,
            pattern: /^[A-Za-z0-9_-]+$/,
          }),
        },
      }, id) as BoundaryClientMessage
    }

    case 'esc_session_exit':
      return withRequestId({
        type: 'esc_session_exit',
        data: { sessionId: escSessionId(record(input.data, 'data').sessionId) },
      }, id) as BoundaryClientMessage

    case 'esc_devices_scan':
      return withRequestId({
        type: 'esc_devices_scan',
        data: { sessionId: escSessionId(record(input.data, 'data').sessionId) },
      }, id) as BoundaryClientMessage

    case 'esc_settings_read': {
      const data = record(input.data, 'data')
      const targets = data.targets === 'all' ? 'all' as const : escTargets(data.targets)
      return withRequestId({
        type: 'esc_settings_read',
        data: { sessionId: escSessionId(data.sessionId), targets },
      }, id) as BoundaryClientMessage
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
      }, id) as BoundaryClientMessage
    }

    case 'log_list':
      return withRequestId({ type: 'log_list' }, id) as BoundaryClientMessage

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
      }, id) as BoundaryClientMessage
    }

    case 'log_download_cancel':
      return withRequestId({ type: 'log_download_cancel' }, id) as BoundaryClientMessage

    case 'log_erase': {
      if (input.safetyConfirmation !== 'erase_all_logs') {
        fail(
          'safety_confirmation_required',
          '擦除全部 DataFlash 日志必须显式确认 erase_all_logs',
          'safetyConfirmation',
        )
      }
      return withRequestId({
        type: 'log_erase',
        safetyConfirmation: 'erase_all_logs' as const,
      }, id) as BoundaryClientMessage
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

  return {
    type: input.type,
    port,
    baudRate,
    ...(vendorId === undefined ? {} : { vendorId }),
    ...(productId === undefined ? {} : { productId }),
    ...(bluetoothServiceClassId === undefined ? {} : { bluetoothServiceClassId }),
    ...(bluetoothAddress === undefined ? {} : { bluetoothAddress }),
  }
}

function parseBoolean(value: string | undefined, name: string): boolean {
  if (value === undefined || value === '') return false
  if (value === 'true' || value === '1') return true
  if (value === 'false' || value === '0') return false
  return fail('invalid_environment', `${name} 必须是 true/false 或 1/0`, name)
}

function parseEnvironmentInteger(
  value: string | undefined,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined || value === '') return fallback
  if (!/^\d+$/.test(value)) {
    return fail('invalid_environment', `${name} 必须是整数`, name)
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    return fail('invalid_environment', `${name} 必须在 ${min}..${max} 范围内`, name)
  }
  return parsed
}

function parseOverrideInteger(
  value: number,
  name: string,
  min: number,
  max: number,
): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    return fail('invalid_environment', `${name} 必须在 ${min}..${max} 范围内`, name)
  }
  return value
}

function validateHost(value: string): string {
  if (isIP(value)) return value
  if (value.length > 253 || /[^\x21-\x7e]/.test(value) || /[/:?#@\[\]]/.test(value)) {
    return fail('invalid_environment', 'HOST 不是有效的 IP 地址或主机名', 'HOST')
  }
  if (!/^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(value)) {
    return fail('invalid_environment', 'HOST 不是有效的 IP 地址或主机名', 'HOST')
  }
  return value.toLowerCase()
}

function normalizeConfiguredOrigin(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return fail('invalid_environment', `无效的 Origin：${value}`, 'SKYLAB_ALLOWED_ORIGINS')
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:')
    || url.username
    || url.password
    || (url.pathname !== '/' && url.pathname !== '')
    || url.search
    || url.hash
  ) {
    return fail('invalid_environment', `Origin 必须是纯 http(s) 源：${value}`, 'SKYLAB_ALLOWED_ORIGINS')
  }
  return url.origin
}

export function isLoopbackHost(host: string): boolean {
  const lower = host.toLowerCase()
  const normalized = lower.startsWith('[') && lower.endsWith(']')
    ? lower.slice(1, -1)
    : lower
  if (normalized === 'localhost') return true
  if (isIP(normalized) === 4) return normalized.split('.')[0] === '127'
  return normalized === '::1' || normalized === '0:0:0:0:0:0:0:1'
}

export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false
  const normalized = address.toLowerCase().split('%')[0]
  if (normalized.startsWith('::ffff:')) {
    return isLoopbackHost(normalized.slice('::ffff:'.length))
  }
  return isLoopbackHost(normalized)
}

export function parseServerConfig(
  env: NodeJS.ProcessEnv = process.env,
  overrides: Partial<ServerConfig> = {},
): ServerConfig {
  const host = validateHost((overrides.host ?? env.HOST?.trim()) || DEFAULT_SERVER_HOST)
  const port = overrides.port === undefined
    ? parseEnvironmentInteger(env.PORT, 'PORT', DEFAULT_SERVER_PORT, 1, 65535)
    : parseOverrideInteger(overrides.port, 'PORT', 0, 65535)
  const remoteEnabled = overrides.remoteEnabled
    ?? parseBoolean(env.SKYLAB_ALLOW_REMOTE, 'SKYLAB_ALLOW_REMOTE')
  if (!isLoopbackHost(host) && !remoteEnabled) {
    fail(
      'remote_binding_disabled',
      '非本机 HOST 必须显式设置 SKYLAB_ALLOW_REMOTE=true',
      'HOST',
    )
  }

  const rawToken = overrides.authToken ?? env.SKYLAB_AUTH_TOKEN?.trim() ?? null
  const authToken = rawToken === ''
    ? null
    : rawToken
  if (remoteEnabled && !authToken) {
    fail('missing_auth_token', '远程模式必须设置 SKYLAB_AUTH_TOKEN', 'SKYLAB_AUTH_TOKEN')
  }
  if (authToken) {
    text(authToken, 'SKYLAB_AUTH_TOKEN', {
      minBytes: REMOTE_TOKEN_MIN_BYTES,
      maxBytes: REMOTE_TOKEN_MAX_BYTES,
      pattern: /^[\x21-\x7e]+$/,
    })
  }

  const configuredOrigins = env.SKYLAB_ALLOWED_ORIGINS
    ? env.SKYLAB_ALLOWED_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean)
    : []
  const allowedOrigins = overrides.allowedOrigins
    ?? configuredOrigins.map(normalizeConfiguredOrigin)

  return {
    host,
    port,
    remoteEnabled,
    authToken,
    allowedOrigins: [...new Set(allowedOrigins.map(normalizeConfiguredOrigin))],
    allowDevOrigin: overrides.allowDevOrigin ?? env.NODE_ENV !== 'production',
    wsMaxPayload: overrides.wsMaxPayload === undefined
      ? parseEnvironmentInteger(
        env.SKYLAB_WS_MAX_PAYLOAD,
        'SKYLAB_WS_MAX_PAYLOAD',
        DEFAULT_WS_MAX_PAYLOAD,
        1024,
        64 * 1024,
      )
      : parseOverrideInteger(overrides.wsMaxPayload, 'SKYLAB_WS_MAX_PAYLOAD', 1024, 64 * 1024),
    wsMaxClients: overrides.wsMaxClients === undefined
      ? parseEnvironmentInteger(
        env.SKYLAB_WS_MAX_CLIENTS,
        'SKYLAB_WS_MAX_CLIENTS',
        DEFAULT_WS_MAX_CLIENTS,
        1,
        64,
      )
      : parseOverrideInteger(overrides.wsMaxClients, 'SKYLAB_WS_MAX_CLIENTS', 1, 64),
  }
}

export function isAllowedOrigin(origin: string, config: ServerConfig): boolean {
  let normalized: string
  let url: URL
  try {
    url = new URL(origin)
    normalized = url.origin
  } catch {
    return false
  }
  if (normalized !== origin || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
    return false
  }
  if (config.allowedOrigins.includes(normalized)) return true

  const hostname = url.hostname.toLowerCase()
  if (!isLoopbackHost(hostname)) return false
  const effectivePort = url.port || (url.protocol === 'https:' ? '443' : '80')
  return effectivePort === String(config.port)
    || (config.allowDevOrigin && effectivePort === '5173')
}
