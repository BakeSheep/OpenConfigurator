import { useLocation, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import SectionNav, { sectionLocation } from '../components/layout/SectionNav'
import Icon, { type IconName } from '../components/ui/Icon'
import { Button } from '../components/ui/Button'
import { SectionFrame, WorkspaceFrame } from '../components/ui/PageFrame'
import StatePanel from '../components/ui/StatePanel'
import { useConnectionStore } from '../stores/connectionStore'
import { useParameterStore } from '../stores/parameterStore'
import { useTelemetryStore } from '../stores/telemetryStore'
import { buildFrameConfigView } from '../utils/vehicleConfig'
import JoystickPage from './JoystickPage'
import MotorPage from './MotorPage'
import EscPage from './EscPage'
import PortSettingsPage from './PortSettingsPage'
import ReceiverPage from './ReceiverPage'
import SensorPage from './SensorPage'

type SetupSection = 'airframe' | 'sensors' | 'actuators' | 'esc' | 'receiver' | 'joystick' | 'ports'

const DEFAULT_SECTION: SetupSection = 'airframe'

const sections: Array<{ id: SetupSection; label: string; icon: IconName }> = [
  { id: 'airframe', label: 'settings.section.airframe.label', icon: 'flight' },
  { id: 'sensors', label: 'settings.section.sensors.label', icon: 'sensor' },
  { id: 'actuators', label: 'settings.section.actuators.label', icon: 'actuator' },
  { id: 'esc', label: 'settings.section.esc.label', icon: 'firmware' },
  { id: 'receiver', label: 'settings.section.receiver.label', icon: 'receiver' },
  { id: 'joystick', label: 'settings.section.joystick.label', icon: 'gamepad' },
  { id: 'ports', label: 'settings.section.ports.label', icon: 'plug' },
]

function isSetupSection(value: string | null): value is SetupSection {
  return sections.some((section) => section.id === value)
}

export default function SettingsPage() {
  const { t } = useTranslation()
  const location = useLocation()
  const [searchParams] = useSearchParams()
  const sectionParam = searchParams.get('section')
  const activeSection: SetupSection = isSetupSection(sectionParam) ? sectionParam : DEFAULT_SECTION
  const activeSectionConfig = sections.find((section) => section.id === activeSection) ?? sections[0]
  const params = useParameterStore((state) => state.params)
  const vehicleReady = useConnectionStore((state) => state.vehicleReady)
  const setConnectDialogOpen = useConnectionStore((state) => state.setConnectDialogOpen)
  const vehicleIdentity = useTelemetryStore((state) => state.vehicleIdentity)
  // Family-specific frame view: SYS_AUTOSTART for PX4, FRAME_CLASS/FRAME_TYPE
  // for ArduPilot. No frame writes are offered in this release.
  const frameView = params.size > 0 ? buildFrameConfigView(vehicleIdentity, params) : null

  return (
    <WorkspaceFrame title={t('settings.title')}>
      <div className="mc-section-layout">
        <SectionNav
          ariaLabel={t('settings.ariaLabel')}
          activeId={activeSection}
          items={sections.map((section) => ({
            id: section.id,
            label: t(section.label),
            icon: section.icon,
            to: sectionLocation(location.pathname, searchParams, section.id, DEFAULT_SECTION),
          }))}
        />

        <SectionFrame title={t(activeSectionConfig.label)} focusKey={activeSection}>
          {activeSection === 'airframe' && (
            <div className="mc-setup-overview mc-fade-in">
              {params.size === 0 ? (
                <StatePanel
                  kind={vehicleReady ? 'loading' : 'disconnected'}
                  title={vehicleReady ? t('settings.waitingParams') : t('common.notConnected')}
                  description={t('settings.connectPrompt')}
                  action={!vehicleReady
                    ? <Button tone="primary" onClick={() => setConnectDialogOpen(true)}>{t('common.connect')}</Button>
                    : undefined}
                />
              ) : (
              <section className="mc-card mc-setup-identity">
                <span className="mc-setup-identity__icon"><Icon name="flight" size={34} /></span>
                <div>
                  <span className="mc-eyebrow">{t('settings.currentFrame')}</span>
                  <h3>{frameView?.name ?? t('settings.waitingParams')}</h3>
                  <p>{frameView
                    ? frameView.frameSource
                    : params.size > 0 && vehicleIdentity
                      ? t('settings.frameNotSupported')
                      : t('settings.autoIdentify')}</p>
                </div>
              </section>
              )}
            </div>
          )}
          {activeSection === 'sensors' && <SensorPage embedded />}
          {activeSection === 'actuators' && <MotorPage embedded />}
          {activeSection === 'esc' && <EscPage embedded />}
          {activeSection === 'receiver' && <ReceiverPage embedded />}
          {activeSection === 'joystick' && <JoystickPage embedded />}
          {activeSection === 'ports' && <PortSettingsPage />}
        </SectionFrame>
      </div>
    </WorkspaceFrame>
  )
}
