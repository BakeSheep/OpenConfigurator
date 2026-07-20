import { create } from 'zustand'

interface GamepadMapping {
  throttle: number  // axis index
  yaw: number
  pitch: number
  roll: number
  armButton: number
  disarmButton: number
  modeButton: number
  rtlButton: number
}

interface GamepadState {
  connected: boolean
  id: string | null
  axes: number[]
  buttons: boolean[]
  mapping: GamepadMapping
  deadzone: number
  expo: number
  enabled: boolean
  setConnected: (connected: boolean, id?: string) => void
  setAxes: (axes: number[]) => void
  setButtons: (buttons: boolean[]) => void
  setMapping: (mapping: Partial<GamepadMapping>) => void
  setDeadzone: (dz: number) => void
  setExpo: (expo: number) => void
  setEnabled: (enabled: boolean) => void
}

export const useGamepadStore = create<GamepadState>((set) => ({
  connected: false,
  id: null,
  axes: [],
  buttons: [],
  mapping: {
    throttle: 1,   // Left stick Y
    yaw: 0,        // Left stick X
    pitch: 3,      // Right stick Y
    roll: 2,       // Right stick X
    armButton: 0,
    disarmButton: 1,
    modeButton: 3,
    rtlButton: 2,
  },
  deadzone: 0.1,
  expo: 0.3,
  enabled: false,
  setConnected: (connected, id) => set({ connected, id: id || null }),
  setAxes: (axes) => set({ axes }),
  setButtons: (buttons) => set({ buttons }),
  setMapping: (mapping) => set((state) => ({ mapping: { ...state.mapping, ...mapping } })),
  setDeadzone: (deadzone) => set({ deadzone }),
  setExpo: (expo) => set({ expo }),
  setEnabled: (enabled) => set({ enabled }),
}))
