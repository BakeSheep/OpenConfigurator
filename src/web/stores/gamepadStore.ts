import { create } from 'zustand'

export type GamepadActionId =
  | 'none' | 'arm' | 'disarm' | 'toggle_arm'
  | 'manual' | 'altitude' | 'position' | 'mission' | 'hold'
  | 'rtl' | 'land' | 'stabilized' | 'acro'

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

function readStoredSettings(): StoredGamepadSettings {
  const fallback = { mapping: defaultMapping, buttonAssignments: {}, deadzone: 0.1, expo: 0.3, advanced: defaultAdvanced }
  if (typeof window === 'undefined') return fallback
  try {
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}')
    return {
      mapping: { ...defaultMapping, ...stored.mapping },
      buttonAssignments: stored.buttonAssignments ?? {},
      deadzone: stored.deadzone ?? fallback.deadzone,
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
    : { connected: false, id: null, axes: [], buttons: [], enabled: false, actionNotice: '' }),
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
    const next = {
      ...state.buttonAssignments,
      [button]: {
        action: state.buttonAssignments[button]?.action ?? 'none',
        repeat: state.buttonAssignments[button]?.repeat ?? false,
        ...assignment,
      },
    }
    writeStoredSettings({ ...pickStoredSettings(state), buttonAssignments: next })
    return { buttonAssignments: next }
  }),
  setDeadzone: (deadzone) => set((state) => {
    writeStoredSettings({ ...pickStoredSettings(state), deadzone })
    return { deadzone }
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
