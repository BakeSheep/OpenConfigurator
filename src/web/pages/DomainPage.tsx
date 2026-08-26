import { Navigate, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { WorkspaceFrame, SectionFrame } from '../components/ui/PageFrame'
import DomainNav from '../components/layout/DomainNav'
import { domainById } from '../navigation'
import AirframeSetupPage from './AirframeSetupPage'
import SensorPage from './SensorPage'
import PowerSetupPage from './PowerSetupPage'
import SafetySetupPage from './SafetySetupPage'
import PortSettingsPage from './PortSettingsPage'
import MotorPage from './MotorPage'
import EscPage from './EscPage'
import ReceiverPage from './ReceiverPage'
import JoystickPage from './JoystickPage'
import FlightModeSetupPage from './FlightModeSetupPage'
import ParameterPage from './ParameterPage'
import PidTuningPage from './PidTuningPage'
import EkfFusionPanel from '../components/ekf/EkfFusionPanel'
import MessagesPage from './MessagesPage'
import WaveformPage from './WaveformPage'
import FlightLogsPage from './FlightLogsPage'
import LogAnalysisPage from './LogAnalysisPage'

export default function DomainPage({ domainId }: { domainId: string }) {
  const { t } = useTranslation()
  const location = useLocation()
  const domain = domainById(domainId)
  if (!domain) return <Navigate to="/dashboard" replace />
  const item = domain.items.find((candidate) => candidate.path.split('?')[0] === location.pathname)
  if (!item) return <Navigate to={domain.defaultPath} replace />
  const content = (() => {
    switch (item.id) {
      case 'dashboard': return <Navigate to="/dashboard" replace />
      case 'flight': return <Navigate to="/flight" replace />
      case 'airframe': return <AirframeSetupPage />
      case 'sensors': return <SensorPage embedded />
      case 'calibration': return <SensorPage embedded view="calibration" />
      case 'power': return <PowerSetupPage />
      case 'safety': return <SafetySetupPage />
      case 'ports': return <PortSettingsPage />
      case 'mapping': return <MotorPage embedded panel="mapping" />
      case 'motor-test': return <MotorPage embedded panel="test" />
      case 'esc': return <EscPage embedded />
      case 'receiver': return <ReceiverPage embedded />
      case 'joystick': return <JoystickPage embedded />
      case 'flight-modes': return <FlightModeSetupPage />
      case 'parameters': return <ParameterPage embedded />
      case 'pid': return <PidTuningPage />
      case 'ekf': return <EkfFusionPanel />
      case 'messages': return <MessagesPage embedded tab="messages" />
      case 'message-status': return <MessagesPage embedded tab="status" />
      case 'message-terminal': return <MessagesPage embedded tab="terminal" />
      case 'waveforms': return <WaveformPage embedded />
      case 'logs': return <FlightLogsPage embedded />
      case 'log-analysis': return <LogAnalysisPage embedded />
      default: return null
    }
  })()
  if (!content || content.type === Navigate) return content
  return <WorkspaceFrame title={t(domain.labelKey)}>
    <DomainNav items={domain.items} ariaLabel={t('navigation.domainPages')} />
    {/* WorkspaceViewport owns route scroll restoration; avoid a second
        section scrollIntoView that can jump the main pane on sub-page changes. */}
    <SectionFrame title={t(item.labelKey)} visuallyHideHeader>{content}</SectionFrame>
  </WorkspaceFrame>
}
