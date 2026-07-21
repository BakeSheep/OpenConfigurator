import { HashRouter, Navigate, Route, Routes } from 'react-router-dom'
import ConnectDialog from './components/ConnectDialog'
import Sidebar from './components/layout/Sidebar'
import StatusBar from './components/layout/StatusBar'
import TelemetryBar from './components/layout/TelemetryBar'
import Topbar from './components/layout/Topbar'
import { useWebSocket } from './hooks/useWebSocket'
import ConnectionPage from './pages/ConnectionPage'
import DashboardPage from './pages/DashboardPage'
import FlightControlPage from './pages/FlightControlPage'
import HardwarePage from './pages/HardwarePage'
import JoystickPage from './pages/JoystickPage'
import MotorPage from './pages/MotorPage'
import ParameterPage from './pages/ParameterPage'
import ReceiverPage from './pages/ReceiverPage'
import SensorPage from './pages/SensorPage'
import SettingsPage from './pages/SettingsPage'
import WorkspacePlaceholderPage from './pages/WorkspacePlaceholderPage'

export default function App() {
  useWebSocket()

  return (
    <HashRouter>
      <div className="mc-app-shell">
        <Topbar />
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
              <Route path="/messages" element={<WorkspacePlaceholderPage title="消息" description="查看飞控状态和系统消息" icon="message" />} />
              <Route path="/missions" element={<WorkspacePlaceholderPage title="航线" description="规划、编辑并上传飞行任务" icon="route" />} />
              <Route path="/logs" element={<WorkspacePlaceholderPage title="日志" description="浏览并导出飞控日志" icon="log" />} />
              <Route path="/waveforms" element={<WorkspacePlaceholderPage title="波形" description="检查实时飞控数据波形" icon="waveform" />} />
              <Route path="/firmware" element={<WorkspacePlaceholderPage title="固件" description="检查并更新飞控固件" icon="firmware" />} />
              <Route path="/hardware" element={<HardwarePage />} />
              <Route path="/rtk" element={<WorkspacePlaceholderPage title="RTK" description="管理高精度定位状态与基站连接" icon="rtk" />} />
              <Route path="/motors" element={<MotorPage />} />
              <Route path="/receiver" element={<ReceiverPage />} />
              <Route path="/joystick" element={<JoystickPage />} />
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
