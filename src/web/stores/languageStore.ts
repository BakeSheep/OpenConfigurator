import { create } from 'zustand'
import i18next from 'i18next'

export type Language = 'zh' | 'en'

interface LanguageState {
  language: Language
  setLanguage: (lang: Language) => void
  toggleLanguage: () => void
}

const STORAGE_KEY = 'mc-lang'

export const documentLanguage = (lang: Language): string => lang === 'zh' ? 'zh-CN' : 'en'

export function getInitialLanguage(): Language {
  if (typeof window === 'undefined') return 'zh'
  try {
    const stored = localStorage.getItem(STORAGE_KEY) as Language | null
    if (stored === 'zh' || stored === 'en') return stored
  } catch {
    // Storage can be unavailable in private browser contexts.
  }
  // Fall back to browser language for first-time visitors.
  return navigator.language.startsWith('zh') ? 'zh' : 'en'
}

function applyLanguage(lang: Language) {
  i18next.changeLanguage(lang)
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('data-lang', lang)
    document.documentElement.lang = documentLanguage(lang)
  }
}

const initialLanguage = getInitialLanguage()
// The entry point initializes i18next before rendering (initI18n in main.tsx).
// Calling changeLanguage before init would throw, so only sync state here when
// i18next is already initialized (e.g. tests that import this store directly).
if (i18next.isInitialized) {
  applyLanguage(initialLanguage)
}

export const useLanguageStore = create<LanguageState>((set) => ({
  language: initialLanguage,
  setLanguage: (lang) => {
    applyLanguage(lang)
    try {
      localStorage.setItem(STORAGE_KEY, lang)
    } catch {
      // Storage failures should never block language switching.
    }
    set({ language: lang })
  },
  toggleLanguage: () => {
    set((state) => {
      const nextLang: Language = state.language === 'zh' ? 'en' : 'zh'
      applyLanguage(nextLang)
      try {
        localStorage.setItem(STORAGE_KEY, nextLang)
      } catch {
        // Storage failures should never block language switching.
      }
      return { language: nextLang }
    })
  },
}))
