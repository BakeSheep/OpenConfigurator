import { create } from 'zustand'

const MAX_SHELL_OUTPUT = 200_000

interface ShellState {
  active: boolean
  output: string
  reason: string | null
  setStatus: (active: boolean, reason?: string) => void
  append: (text: string) => void
  clear: () => void
  reset: () => void
}

export const useShellStore = create<ShellState>((set) => ({
  active: false,
  output: '',
  reason: null,
  setStatus: (active, reason) => set({ active, reason: reason ?? null }),
  append: (text) => set((state) => {
    const next = state.output + text
    return { output: next.length > MAX_SHELL_OUTPUT ? next.slice(-MAX_SHELL_OUTPUT) : next }
  }),
  clear: () => set({ output: '' }),
  reset: () => set({ active: false, output: '', reason: null }),
}))
