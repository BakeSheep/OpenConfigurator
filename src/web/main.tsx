import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { appRuntimeMode } from './runtime'
import { initI18n } from './i18n/config'
import { documentLanguage, getInitialLanguage } from './stores/languageStore'
import './index.css'

// Demo mode fills the stores with synthetic telemetry (static GitHub Pages
// preview, README screenshots). Seeding must finish before the first render so
// the UI never flashes a "disconnected" frame, and so the WS lifecycle in App
// is decided against the final runtime mode.
async function bootstrap() {
  const lang = getInitialLanguage()
  initI18n(lang)
  document.documentElement.setAttribute('data-lang', lang)
  document.documentElement.lang = documentLanguage(lang)

  if (appRuntimeMode === 'demo') {
    const { startDemoMode } = await import('./demo/demoMode')
    const stopDemoMode = startDemoMode()
    window.addEventListener('pagehide', stopDemoMode, { once: true })
    if (import.meta.hot) import.meta.hot.dispose(stopDemoMode)
  }

  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  )
}

void bootstrap()
