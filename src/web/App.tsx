import { HashRouter, Navigate, Route, Routes } from 'react-router-dom'
import ConnectDialog from './components/ConnectDialog'
import ParameterProgressBar from './components/layout/ParameterProgressBar'
import Sidebar from './components/layout/Sidebar'
import StatusBar from './components/layout/StatusBar'
import TelemetryBar from './components/layout/TelemetryBar'
import Topbar from './components/layout/Topbar'
import { useWebSocket } from './hooks/useWebSocket'
import { useGamepadController } from './hooks/useGamepadController'
import ConnectionPage from './pages/ConnectionPage'
import DashboardPage from './pages/DashboardPage'
import FlightControlPage from './pages/FlightControlPage'
import FirmwarePage from './pages/FirmwarePage'
import LogsPage from './pages/LogsPage'
import MessagesPage from './pages/MessagesPage'
import MotorPage from './pages/MotorPage'
import ParameterPage from './pages/ParameterPage'
import ReceiverPage from './pages/ReceiverPage'
import SensorPage from './pages/SensorPage'
import SettingsPage from './pages/SettingsPage'
import WaveformPage from './pages/WaveformPage'
import WorkspacePlaceholderPage from './pages/WorkspacePlaceholderPage'

export default function App() {
  const { send } = useWebSocket()
  useGamepadController(send)

  return (
    <HashRouter>
      <div className="mc-app-shell">
        <Topbar />
        <ParameterProgressBar />
        <TelemetryBar />
        <div className="mc-app-shell__body">
          <Sidebar />
          <main className="mc-app-shell__main">
            <Routes>
              <Route path="/" element={<Navigate to="/dashboard" replace />} />
              <Route path="/connect" element={<ConnectionPage />} />
              <Route path="/dashboard" element={<DashboardPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="/sensors" element={<SensorPage />} />
              <Route path="/parameters" element={<ParameterPage />} />
              <Route path="/messages" element={<MessagesPage />} />
              <Route path="/missions" element={<WorkspacePlaceholderPage title="航线" description="规划、编辑并上传飞行任务" icon="route" />} />
              <Route path="/logs" element={<LogsPage />} />
              <Route path="/waveforms" element={<WaveformPage />} />
              <Route path="/firmware" element={<FirmwarePage />} />
              <Route path="/hardware" element={<Navigate to="/settings" replace />} />
              <Route path="/rtk" element={<WorkspacePlaceholderPage title="RTK" description="管理高精度定位状态与基站连接" icon="rtk" />} />
              <Route path="/motors" element={<MotorPage />} />
              <Route path="/receiver" element={<ReceiverPage />} />
              <Route path="/joystick" element={<Navigate to="/settings" replace />} />
              <Route path="/flight" element={<FlightControlPage />} />
              <Route path="*" element={<Navigate to="/dashboard" replace />} />
            </Routes>
          </main>
        </div>
        <StatusBar />
        <ConnectDialog />
      </div>
    </HashRouter>
  )
}
