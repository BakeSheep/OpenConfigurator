import { create } from 'zustand'

export type Theme = 'dark' | 'light'

interface ThemeState {
  theme: Theme
  toggleTheme: () => void
  setTheme: (theme: Theme) => void
}

const applyTheme = (theme: Theme) => {
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('data-theme', theme)
  }
}

const getInitialTheme = (): Theme => {
  if (typeof window === 'undefined') return 'dark'
  try {
    const stored = localStorage.getItem('mc-theme') as Theme | null
    if (stored === 'light' || stored === 'dark') return stored
  } catch {
    // Storage can be unavailable in private browser contexts.
  }
  // A fresh install starts in the light theme; an explicit saved preference
  // above still takes precedence.
  return 'light'
}

const initialTheme = getInitialTheme()
applyTheme(initialTheme)

export const useThemeStore = create<ThemeState>((set) => ({
  theme: initialTheme,
  toggleTheme: () => {
    set((state) => {
      const next = state.theme === 'dark' ? 'light' : 'dark'
      applyTheme(next)
      try {
        localStorage.setItem('mc-theme', next)
      } catch {
        // Storage failures should never block theme switching.
      }
      return { theme: next }
    })
  },
  setTheme: (theme) => {
    applyTheme(theme)
    try {
      localStorage.setItem('mc-theme', theme)
    } catch {
      // Storage failures should never block theme switching.
    }
    set({ theme })
  },
}))
