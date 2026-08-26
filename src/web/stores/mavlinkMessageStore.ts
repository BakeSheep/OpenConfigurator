import { create } from 'zustand'
import type { RuntimeEvent } from '../../shared/types'

export const MAVLINK_MESSAGE_LIVE_MS = 4_000
export const MAVLINK_RATE_WINDOW_MS = 5_000
const MAX_RATE_SAMPLES = 200

export interface MavlinkMessageSample {
  msgType: string
  lastSeen: number
  totalCount: number
  timestamps: number[]
  latestData: unknown
}

interface MavlinkMessageState {
  messages: Record<string, MavlinkMessageSample>
  record: (msgType: string, data: unknown, nowMs?: number) => void
  reset: () => void
}

function observedMavlinkMessage(message: RuntimeEvent): { msgType: string; data: unknown } | null {
  switch (message.type) {
    case 'telemetry':
    case 'sensor':
      return { msgType: message.msgType, data: message.data }
    case 'status':
      return { msgType: 'HEARTBEAT', data: message.data }
    case 'statustext':
      return { msgType: 'STATUSTEXT', data: message.data }
    case 'rc_channels':
      return { msgType: 'RC_CHANNELS', data: message.data }
    case 'motor_outputs':
      return { msgType: 'SERVO_OUTPUT_RAW', data: message.data }
    case 'ekf_status':
      return { msgType: 'ESTIMATOR_STATUS', data: message.data }
    case 'autopilot_version':
      return { msgType: 'AUTOPILOT_VERSION', data: message.data }
    default:
      return null
  }
}

export const useMavlinkMessageStore = create<MavlinkMessageState>((set) => ({
  messages: {},
  record: (msgType, data, nowMs) => set((state) => {
    const now = nowMs ?? Date.now()
    const previous = state.messages[msgType]
    const cutoff = now - MAVLINK_RATE_WINDOW_MS
    const timestamps = [
      ...(previous?.timestamps.filter((timestamp) => timestamp >= cutoff) ?? []),
      now,
    ].slice(-MAX_RATE_SAMPLES)
    return {
      messages: {
        ...state.messages,
        [msgType]: {
          msgType,
          lastSeen: now,
          totalCount: (previous?.totalCount ?? 0) + 1,
          timestamps,
          latestData: data,
        },
      },
    }
  }),
  reset: () => set({ messages: {} }),
}))

export function recordMavlinkRuntimeEvent(message: RuntimeEvent, nowMs?: number): void {
  const observed = observedMavlinkMessage(message)
  if (!observed) return
  useMavlinkMessageStore.getState().record(observed.msgType, observed.data, nowMs)
}

export function isMavlinkMessageLive(
  sample: MavlinkMessageSample | undefined,
  nowMs: number,
): boolean {
  return sample !== undefined && nowMs - sample.lastSeen < MAVLINK_MESSAGE_LIVE_MS
}

export function measuredMavlinkHz(
  sample: MavlinkMessageSample | undefined,
  nowMs: number,
): number | null {
  if (!sample || !isMavlinkMessageLive(sample, nowMs)) return null
  const cutoff = nowMs - MAVLINK_RATE_WINDOW_MS
  const timestamps = sample.timestamps.filter((timestamp) => timestamp >= cutoff)
  if (timestamps.length < 2) return null
  const elapsedMs = timestamps[timestamps.length - 1] - timestamps[0]
  return elapsedMs > 0 ? ((timestamps.length - 1) * 1_000) / elapsedMs : null
}
