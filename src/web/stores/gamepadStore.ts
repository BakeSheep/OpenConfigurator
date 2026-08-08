import { create } from 'zustand'
import {
  canRepeatGamepadAction,
  isGamepadActionId,
  type GamepadActionId,
} from '../utils/gamepadActions'

export type { GamepadActionId } from '../utils/gamepadActions'

export interface ButtonAssignment {
  action: GamepadActionId
  repeat: boolean
}

export interface GamepadMapping {
  throttle: number
  yaw: number
  pitch: number
  roll: number
  armButton: number
  disarmButton: number
  modeButton: number
  rtlButton: number
}

export interface GamepadAdvancedSettings {
  throttleModeCenterZero: boolean
  throttleSmoothing: boolean
  axisFrequencyHz: number
  buttonFrequencyHz: number
  circleCorrection: boolean
  useDeadband: boolean
}

interface GamepadState {
  connected: boolean
  id: string | null
  axes: number[]
  buttons: boolean[]
  mapping: GamepadMapping
  buttonAssignments: Record<number, ButtonAssignment>
  deadzone: number
  expo: number
  advanced: GamepadAdvancedSettings
  enabled: boolean
  actionNotice: string
  setConnected: (connected: boolean, id?: string) => void
  setAxes: (axes: number[]) => void
  setButtons: (buttons: boolean[]) => void
  setMapping: (mapping: Partial<GamepadMapping>) => void
  setButtonAssignment: (button: number, assignment: Partial<ButtonAssignment>) => void
  setDeadzone: (dz: number) => void
  setExpo: (expo: number) => void
  setAdvanced: (settings: Partial<GamepadAdvancedSettings>) => void
  setEnabled: (enabled: boolean) => void
  setActionNotice: (notice: string) => void
}

const defaultMapping: GamepadMapping = {
  throttle: 1,
  yaw: 0,
  pitch: 3,
  roll: 2,
  armButton: 0,
  disarmButton: 1,
  modeButton: 3,
  rtlButton: 2,
}

const defaultAdvanced: GamepadAdvancedSettings = {
  throttleModeCenterZero: true,
  throttleSmoothing: false,
  axisFrequencyHz: 20,
  buttonFrequencyHz: 5,
  circleCorrection: true,
  useDeadband: true,
}

const STORAGE_KEY = 'skylab-gamepad-settings-v1'
type StoredGamepadSettings = Pick<GamepadState, 'mapping' | 'buttonAssignments' | 'deadzone' | 'expo' | 'advanced'>

// Deadzone feeds the divisor (1 - deadzone) in the axis shaping curve; clamp
// well below 1 so corrupted storage or callers cannot inject a near-singular
// value. The UI slider stays within 0-0.3.
const clampDeadzone = (value: number): number =>
  Number.isFinite(value) ? Math.min(0.3, Math.max(0, value)) : 0.1

function sanitizeAssignments(value: unknown): Record<number, ButtonAssignment> {
  const next: Record<number, ButtonAssignment> = {}
  if (typeof value !== 'object' || value === null) return next
  for (const [key, entry] of Object.entries(value as Record<string, Partial<ButtonAssignment>>)) {
    const button = Number(key)
    if (!Number.isSafeInteger(button) || button < 0 || !entry || !isGamepadActionId(entry.action)) continue
    const action = entry.action
    next[button] = {
      action,
      repeat: entry.repeat === true && canRepeatGamepadAction(action),
    }
  }
  return next
}

function readStoredSettings(): StoredGamepadSettings {
  const fallback = { mapping: defaultMapping, buttonAssignments: {}, deadzone: 0.1, expo: 0.3, advanced: defaultAdvanced }
  if (typeof window === 'undefined') return fallback
  try {
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}')
    return {
      mapping: { ...defaultMapping, ...stored.mapping },
      buttonAssignments: sanitizeAssignments(stored.buttonAssignments),
      deadzone: clampDeadzone(stored.deadzone ?? fallback.deadzone),
      expo: stored.expo ?? fallback.expo,
      advanced: { ...defaultAdvanced, ...stored.advanced },
    }
  } catch {
    return fallback
  }
}

function writeStoredSettings(settings: StoredGamepadSettings) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  } catch {
    // Storage can be blocked in privacy mode; live controls must still work.
  }
}

function pickStoredSettings(state: GamepadState): StoredGamepadSettings {
  return {
    mapping: state.mapping,
    buttonAssignments: state.buttonAssignments,
    deadzone: state.deadzone,
    expo: state.expo,
    advanced: state.advanced,
  }
}

const storedSettings = readStoredSettings()

export const useGamepadStore = create<GamepadState>((set) => ({
  connected: false,
  id: null,
  axes: [],
  buttons: [],
  ...storedSettings,
  enabled: false,
  actionNotice: '',
  setConnected: (connected, id) => set(connected
    ? { connected: true, id: id || null }
    : { connected: false, id: null, axes: [], buttons: [], actionNotice: '' }),
  setAxes: (axes) => set((state) =>
    state.axes.length === axes.length && axes.every((value, index) => Math.abs(value - state.axes[index]) < 0.001)
      ? state
      : { axes }
  ),
  setButtons: (buttons) => set((state) =>
    state.buttons.length === buttons.length && buttons.every((value, index) => value === state.buttons[index])
      ? state
      : { buttons }
  ),
  setMapping: (mapping) => set((state) => {
    const next = { ...state.mapping, ...mapping }
    writeStoredSettings({ ...pickStoredSettings(state), mapping: next })
    return { mapping: next }
  }),
  setButtonAssignment: (button, assignment) => set((state) => {
    const merged: ButtonAssignment = {
      action: state.buttonAssignments[button]?.action ?? 'none',
      repeat: state.buttonAssignments[button]?.repeat ?? false,
      ...assignment,
    }
    if (!canRepeatGamepadAction(merged.action)) merged.repeat = false
    const next = { ...state.buttonAssignments, [button]: merged }
    writeStoredSettings({ ...pickStoredSettings(state), buttonAssignments: next })
    return { buttonAssignments: next }
  }),
  setDeadzone: (deadzone) => set((state) => {
    const clamped = clampDeadzone(deadzone)
    writeStoredSettings({ ...pickStoredSettings(state), deadzone: clamped })
    return { deadzone: clamped }
  }),
  setExpo: (expo) => set((state) => {
    writeStoredSettings({ ...pickStoredSettings(state), expo })
    return { expo }
  }),
  setAdvanced: (advanced) => set((state) => {
    const next = { ...state.advanced, ...advanced }
    writeStoredSettings({ ...pickStoredSettings(state), advanced: next })
    return { advanced: next }
  }),
  setEnabled: (enabled) => set({ enabled }),
  setActionNotice: (actionNotice) => set({ actionNotice }),
}))
