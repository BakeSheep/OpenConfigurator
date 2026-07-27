import { lazy, Suspense } from 'react'
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom'
import ConnectDialog from './components/ConnectDialog'
import ParameterProgressBar from './components/layout/ParameterProgressBar'
import Sidebar from './components/layout/Sidebar'
import StatusBar from './components/layout/StatusBar'
import Topbar from './components/layout/Topbar'
import { useWebSocket } from './hooks/useWebSocket'
import { useGamepadController } from './hooks/useGamepadController'

const DashboardPage = lazy(() => import('./pages/DashboardPage'))
const DiagnosticsPage = lazy(() => import('./pages/DiagnosticsPage'))
const FlightControlPage = lazy(() => import('./pages/FlightControlPage'))
const SettingsPage = lazy(() => import('./pages/SettingsPage'))

export default function App() {
  const { send } = useWebSocket()
  useGamepadController(send)

  return (
    <HashRouter>
      <div className="mc-app-shell">
        <Topbar />
        <ParameterProgressBar />
        <div className="mc-app-shell__body">
          <Sidebar />
          <main className="mc-app-shell__main">
            <Suspense fallback={<div className="mc-route-loading" role="status">正在加载工作区…</div>}>
              <Routes>
                <Route path="/" element={<Navigate to="/dashboard" replace />} />
                <Route path="/dashboard" element={<DashboardPage />} />
                <Route path="/flight" element={<FlightControlPage />} />
                <Route path="/settings" element={<SettingsPage />} />
                <Route path="/diagnostics" element={<DiagnosticsPage />} />
                <Route path="/connect" element={<Navigate to="/dashboard" replace />} />
                <Route path="/sensors" element={<Navigate to="/settings?section=sensors" replace />} />
                <Route path="/parameters" element={<Navigate to="/diagnostics" replace />} />
                <Route path="/messages" element={<Navigate to="/diagnostics?section=messages" replace />} />
                <Route path="/waveforms" element={<Navigate to="/diagnostics?section=waveforms" replace />} />
                <Route path="/missions" element={<Navigate to="/dashboard" replace />} />
                <Route path="/logs" element={<Navigate to="/diagnostics?section=logs" replace />} />
                <Route path="/log-analysis" element={<Navigate to="/diagnostics?section=log-analysis" replace />} />
                <Route path="/hardware" element={<Navigate to="/settings" replace />} />
                <Route path="/motors" element={<Navigate to="/settings?section=actuators" replace />} />
                <Route path="/receiver" element={<Navigate to="/settings?section=receiver" replace />} />
                <Route path="/joystick" element={<Navigate to="/settings?section=joystick" replace />} />
                <Route path="*" element={<Navigate to="/dashboard" replace />} />
              </Routes>
            </Suspense>
          </main>
        </div>
        <StatusBar />
        <ConnectDialog />
      </div>
    </HashRouter>
  )
}
