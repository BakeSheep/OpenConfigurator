import { useLocation, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import SectionNav, { sectionLocation } from '../components/layout/SectionNav'
import type { IconName } from '../components/ui/Icon'
import { SectionFrame, WorkspaceFrame } from '../components/ui/PageFrame'
import AirframeSetupPage from './AirframeSetupPage'
import JoystickPage from './JoystickPage'
import MotorPage from './MotorPage'
import EscPage from './EscPage'
import OtherSettingsPage from './OtherSettingsPage'
import PortSettingsPage from './PortSettingsPage'
import ReceiverPage from './ReceiverPage'
import SensorPage from './SensorPage'

type SetupSection = 'airframe' | 'sensors' | 'receiver' | 'actuators' | 'esc' | 'joystick' | 'ports' | 'other'

const DEFAULT_SECTION: SetupSection = 'airframe'

const sections: Array<{ id: SetupSection; label: string; icon: IconName }> = [
  { id: 'airframe', label: 'settings.section.airframe.label', icon: 'flight' },
  { id: 'sensors', label: 'settings.section.sensors.label', icon: 'sensor' },
  { id: 'receiver', label: 'settings.section.receiver.label', icon: 'receiver' },
  { id: 'actuators', label: 'settings.section.actuators.label', icon: 'actuator' },
  { id: 'esc', label: 'settings.section.esc.label', icon: 'firmware' },
  { id: 'joystick', label: 'settings.section.joystick.label', icon: 'gamepad' },
  { id: 'ports', label: 'settings.section.ports.label', icon: 'plug' },
  { id: 'other', label: 'settings.section.other.label', icon: 'settings' },
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

        <SectionFrame
          title={t(activeSectionConfig.label)}
          description={t(`settings.section.${activeSection}.description`)}
          focusKey={activeSection}
        >
          {activeSection === 'airframe' && <AirframeSetupPage />}
          {activeSection === 'sensors' && <SensorPage embedded />}
          {activeSection === 'receiver' && <ReceiverPage embedded />}
          {activeSection === 'actuators' && <MotorPage embedded />}
          {activeSection === 'esc' && <EscPage embedded />}
          {activeSection === 'joystick' && <JoystickPage embedded />}
          {activeSection === 'ports' && <PortSettingsPage />}
          {activeSection === 'other' && <OtherSettingsPage />}
        </SectionFrame>
      </div>
    </WorkspaceFrame>
  )
}
