import { create } from 'zustand'

const MAX_SHELL_OUTPUT = 200_000

export function appendTerminalText(current: string, incoming: string): string {
  let output = current
  for (const char of incoming) {
    const code = char.charCodeAt(0)
    if (char === '\b') {
      if (output.length > 0 && output[output.length - 1] !== '\n') output = output.slice(0, -1)
      continue
    }
    if ((code < 0x20 && char !== '\n' && char !== '\r' && char !== '\t') || code === 0x7f) {
      continue
    }
    output += char
  }
  return output.length > MAX_SHELL_OUTPUT ? output.slice(-MAX_SHELL_OUTPUT) : output
}

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
    return { output: appendTerminalText(state.output, text) }
  }),
  clear: () => set({ output: '' }),
  reset: () => set({ active: false, output: '', reason: null }),
}))
