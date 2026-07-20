import { HashRouter, Routes, Route, Navigate } from 'react-router-dom'
import Topbar from './components/layout/Topbar'
import TelemetryBar from './components/layout/TelemetryBar'
import StatusBar from './components/layout/StatusBar'
import Sidebar from './components/layout/Sidebar'
import ConnectDialog from './components/ConnectDialog'
import { useWebSocket } from './hooks/useWebSocket'
import ConnectionPage from './pages/ConnectionPage'
import DashboardPage from './pages/DashboardPage'
import SensorPage from './pages/SensorPage'
import ParameterPage from './pages/ParameterPage'
import MotorPage from './pages/MotorPage'
import ReceiverPage from './pages/ReceiverPage'
import JoystickPage from './pages/JoystickPage'
import FlightControlPage from './pages/FlightControlPage'

export default function App() {
  useWebSocket()

  return (
    <HashRouter>
      <div className="flex flex-col h-screen w-screen overflow-hidden" style={{ background: 'var(--bg-primary)' }}>
        <Topbar />
        <TelemetryBar />
        <div className="flex flex-1 min-h-0">
          <Sidebar />
          <main className="flex-1 overflow-y-auto min-w-0">
            <Routes>
              <Route path="/" element={<Navigate to="/dashboard" replace />} />
              <Route path="/connect" element={<ConnectionPage />} />
              <Route path="/dashboard" element={<DashboardPage />} />
              <Route path="/sensors" element={<SensorPage />} />
              <Route path="/parameters" element={<ParameterPage />} />
              <Route path="/motors" element={<MotorPage />} />
              <Route path="/receiver" element={<ReceiverPage />} />
              <Route path="/joystick" element={<JoystickPage />} />
              <Route path="/flight" element={<FlightControlPage />} />
            </Routes>
          </main>
        </div>
        <StatusBar />
        <ConnectDialog />
      </div>
    </HashRouter>
  )
}
