import { DEFAULT_MESSAGE_RATES } from '../shared/constants'
import type { MessageRateConfig, ServerMessage } from '../shared/types'

type MessageRateGroup = keyof MessageRateConfig

const TELEMETRY_GROUPS: Record<string, MessageRateGroup> = {
  ATTITUDE: 'attitude',
  GPS_RAW_INT: 'position',
  GLOBAL_POSITION_INT: 'position',
  SYS_STATUS: 'status',
  VFR_HUD: 'hud',
  BATTERY_STATUS: 'auxiliary',
  EXTENDED_SYS_STATE: 'status',
}

const SENSOR_GROUPS: Record<string, MessageRateGroup> = {
  SCALED_IMU: 'sensors',
  SCALED_IMU2: 'sensors',
  SCALED_IMU3: 'sensors',
  RAW_IMU: 'sensors',
  HIGHRES_IMU: 'sensors',
  SCALED_PRESSURE: 'sensors',
  OPTICAL_FLOW: 'auxiliary',
  OPTICAL_FLOW_RAD: 'auxiliary',
  DISTANCE_SENSOR: 'auxiliary',
  RANGEFINDER: 'auxiliary',
}

function rateLimitIdentity(message: ServerMessage): { group: MessageRateGroup; key: string } | null {
  if (message.type === 'telemetry') {
    const group = TELEMETRY_GROUPS[message.msgType]
    return group ? { group, key: `telemetry:${message.msgType}` } : null
  }
  if (message.type === 'sensor') {
    const group = SENSOR_GROUPS[message.msgType]
    return group ? { group, key: `sensor:${message.msgType}` } : null
  }
  if (message.type === 'motor_outputs' || message.type === 'rc_channels') {
    return { group: 'rc', key: message.type }
  }
  if (message.type === 'ekf_status' || message.type === 'status') {
    return { group: 'status', key: message.type }
  }
  return null
}

/** Hard server-to-browser ceiling when a component ignores SET_MESSAGE_INTERVAL. */
export class MessageRateLimiter {
  private rates: MessageRateConfig = { ...DEFAULT_MESSAGE_RATES }
  private readonly lastForwardedAt = new Map<string, number>()

  setRates(rates: MessageRateConfig): void {
    this.rates = { ...rates }
    this.lastForwardedAt.clear()
  }

  reset(): void {
    this.lastForwardedAt.clear()
  }

  shouldForward(message: ServerMessage, now = Date.now()): boolean {
    const identity = rateLimitIdentity(message)
    if (!identity) return true
    const minimumIntervalMs = 1000 / this.rates[identity.group]
    const last = this.lastForwardedAt.get(identity.key)
    if (last !== undefined && now - last < minimumIntervalMs) return false
    this.lastForwardedAt.set(identity.key, now)
    return true
  }
}
