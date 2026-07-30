import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { appRuntimeMode } from './runtime'
import './index.css'

// Demo mode fills the stores with synthetic telemetry (static GitHub Pages
// preview, README screenshots). Seeding must finish before the first render so
// the UI never flashes a "disconnected" frame, and so the WS lifecycle in App
// is decided against the final runtime mode.
async function bootstrap() {
  if (appRuntimeMode === 'demo') {
    const { startDemoMode } = await import('./demo/demoMode')
    startDemoMode()
  }

  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  )
}

void bootstrap()
