import { lazy, Suspense, useEffect, useRef, type ReactNode } from 'react'
import { HashRouter, Navigate, Route, Routes, useLocation, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import ConnectDialog from './components/ConnectDialog'
import WorkspaceErrorBoundary from './components/ErrorBoundary'
import DemoBanner from './components/layout/DemoBanner'
import Sidebar from './components/layout/Sidebar'
import StatusBar from './components/layout/StatusBar'
import Topbar from './components/layout/Topbar'
import { useWebSocket } from './hooks/useWebSocket'
import { useGamepadController } from './hooks/useGamepadController'
import { backendEnabled } from './runtime'

const DashboardPage = lazy(() => import('./pages/DashboardPage'))
const FlightControlPage = lazy(() => import('./pages/FlightControlPage'))
const DomainPage = lazy(() => import('./pages/DomainPage'))

function LegacySettingsRedirect() {
  const [params] = useSearchParams()
  const section = params.get('section')
  const target: Record<string, string> = {
    sensors: '/airframe/sensors', actuators: '/propulsion', esc: '/propulsion/esc',
    receiver: '/control-input', joystick: '/control-input/joystick', other: '/tuning/ekf',
    airframe: '/airframe', power: '/airframe/power', safety: '/airframe/safety',
  }
  return <Navigate to={target[section ?? ''] ?? '/airframe'} replace />
}

function LegacyDiagnosticsRedirect() {
  const [params] = useSearchParams()
  const section = params.get('section')
  const target: Record<string, string> = {
    parameters: '/tuning', pid: '/tuning/pid', waveforms: '/flight-data/waveforms',
    messages: '/flight-data', logs: '/flight-logs', 'log-analysis': '/flight-logs/analysis', ekf: '/tuning/ekf',
  }
  return <Navigate to={target[section ?? ''] ?? '/tuning'} replace />
}

function WorkspaceViewport({ children }: { children: ReactNode }) {
  const location = useLocation()
  const mainRef = useRef<HTMLElement>(null)
  const previousPathRef = useRef(location.pathname)

  useEffect(() => {
    const pathChanged = previousPathRef.current !== location.pathname
    previousPathRef.current = location.pathname
    mainRef.current?.scrollTo({ top: 0, left: 0, behavior: 'auto' })
    if (!pathChanged) return

    const frame = window.requestAnimationFrame(() => {
      mainRef.current?.querySelector<HTMLElement>('.mc-page-title')?.focus({ preventScroll: true })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [location.pathname])

  return <main ref={mainRef} className="mc-app-shell__main">{children}</main>
}

export default function App() {
  const { t } = useTranslation()
  const { send } = useWebSocket(backendEnabled)
  useGamepadController(send)

  return (
    <HashRouter>
      <div className="mc-app-shell">
        <Topbar />
        <DemoBanner />
        <div className="mc-app-shell__body">
          <Sidebar placement="desktop" />
          <WorkspaceViewport>
            <WorkspaceErrorBoundary>
              <Suspense fallback={<div className="mc-route-loading" role="status">{t('app.loadingWorkspace')}</div>}>
                <Routes>
                  <Route path="/" element={<Navigate to="/dashboard" replace />} />
                  <Route path="/dashboard" element={<DashboardPage />} />
                  <Route path="/flight" element={<FlightControlPage />} />
                  <Route path="/airframe/*" element={<DomainPage domainId="airframe" />} />
                  <Route path="/propulsion/*" element={<DomainPage domainId="propulsion" />} />
                  <Route path="/control-input/*" element={<DomainPage domainId="control-input" />} />
                  <Route path="/tuning/*" element={<DomainPage domainId="tuning" />} />
                  <Route path="/flight-data/*" element={<DomainPage domainId="flight-data" />} />
                  <Route path="/flight-logs/*" element={<DomainPage domainId="flight-logs" />} />
                  <Route path="/settings" element={<LegacySettingsRedirect />} />
                  <Route path="/diagnostics" element={<LegacyDiagnosticsRedirect />} />
                  <Route path="/connect" element={<Navigate to="/dashboard" replace />} />
                  <Route path="/sensors" element={<Navigate to="/airframe/sensors" replace />} />
                  <Route path="/parameters" element={<Navigate to="/tuning" replace />} />
                  <Route path="/messages" element={<Navigate to="/flight-data" replace />} />
                  <Route path="/waveforms" element={<Navigate to="/flight-data/waveforms" replace />} />
                  <Route path="/missions" element={<Navigate to="/dashboard" replace />} />
                  <Route path="/logs" element={<Navigate to="/flight-logs" replace />} />
                  <Route path="/log-analysis" element={<Navigate to="/flight-logs/analysis" replace />} />
                  <Route path="/flight-data/logs" element={<Navigate to="/flight-logs" replace />} />
                  <Route path="/flight-data/log-analysis" element={<Navigate to="/flight-logs/analysis" replace />} />
                  <Route path="/hardware" element={<Navigate to="/airframe" replace />} />
                  <Route path="/motors" element={<Navigate to="/propulsion" replace />} />
                  <Route path="/esc" element={<Navigate to="/propulsion/esc" replace />} />
                  <Route path="/receiver" element={<Navigate to="/control-input" replace />} />
                  <Route path="/joystick" element={<Navigate to="/control-input/joystick" replace />} />
                  <Route path="*" element={<Navigate to="/dashboard" replace />} />
                </Routes>
              </Suspense>
            </WorkspaceErrorBoundary>
          </WorkspaceViewport>
          <Sidebar placement="mobile" />
        </div>
        <StatusBar />
        <ConnectDialog />
      </div>
    </HashRouter>
  )
}
