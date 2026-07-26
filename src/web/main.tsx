import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'

// Dev-only showcase mode: `?demo=1` fills the stores with synthetic telemetry
// (README screenshots). Never active in production builds - it fakes
// vehicleReady and must not coexist with a real flight controller link.
if (import.meta.env.DEV && new URLSearchParams(window.location.search).has('demo')) {
  import('./demo/demoMode').then((m) => m.startDemoMode())
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
