import i18next from 'i18next'
import { initReactI18next } from 'react-i18next'
import { zh } from './locales/zh'
import { en } from './locales/en'

export const SUPPORTED_LANGUAGES = ['zh', 'en'] as const

let initialized = false

export function initI18n(language: string = 'zh') {
  if (initialized) return i18next
  initialized = true

  i18next.use(initReactI18next).init({
    resources: {
      zh: { translation: zh },
      en: { translation: en },
    },
    lng: language,
    fallbackLng: 'zh',
    interpolation: { escapeValue: false },
  })

  return i18next
}
