import { useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import CollapsibleSubnav from '../components/layout/CollapsibleSubnav'
import Icon, { type IconName } from '../components/ui/Icon'
import { PageHeader } from '../components/ui/PageFrame'
import JoystickPage from './JoystickPage'
import MotorPage from './MotorPage'
import EscPage from './EscPage'
import PortSettingsPage from './PortSettingsPage'
import ReceiverPage from './ReceiverPage'
import SensorPage from './SensorPage'
import AirframeSetupPage from './AirframeSetupPage'
import OtherSettingsPage from './OtherSettingsPage'

type SetupSection = 'airframe' | 'sensors' | 'radio' | 'actuators' | 'esc' | 'joystick' | 'ports' | 'other'
type LegacySetupSection = 'receiver' | 'flight-modes' | 'power' | 'safety'

const sections: Array<{ id: SetupSection; label: string; description: string; icon: IconName }> = [
  { id: 'airframe', label: 'settings.section.airframe.label', description: 'settings.section.airframe.description', icon: 'flight' },
  { id: 'sensors', label: 'settings.section.sensors.label', description: 'settings.section.sensors.description', icon: 'sensor' },
  { id: 'radio', label: 'settings.section.receiver.label', description: 'settings.section.receiver.description', icon: 'receiver' },
  { id: 'actuators', label: 'settings.section.actuators.label', description: 'settings.section.actuators.description', icon: 'actuator' },
  { id: 'esc', label: 'settings.section.esc.label', description: 'settings.section.esc.description', icon: 'firmware' },
  { id: 'joystick', label: 'settings.section.joystick.label', description: 'settings.section.joystick.description', icon: 'gamepad' },
  { id: 'ports', label: 'settings.section.ports.label', description: 'settings.section.ports.description', icon: 'plug' },
  { id: 'other', label: 'settings.section.other.label', description: 'settings.section.other.description', icon: 'settings' },
]

const legacySections: Record<LegacySetupSection, SetupSection> = {
  receiver: 'radio',
  'flight-modes': 'radio',
  power: 'other',
  safety: 'other',
}

function isSetupSection(value: string | null): value is SetupSection {
  return sections.some((section) => section.id === value)
}

export default function SettingsPage() {
  const { t } = useTranslation()
  const [searchParams, setSearchParams] = useSearchParams()
  const sectionParam = searchParams.get('section')
  const legacySection = sectionParam && sectionParam in legacySections
    ? legacySections[sectionParam as LegacySetupSection]
    : null
  const activeSection: SetupSection = legacySection ?? (isSetupSection(sectionParam) ? sectionParam : 'airframe')

  useEffect(() => {
    if (legacySection) setSearchParams({ section: legacySection }, { replace: true })
  }, [legacySection, setSearchParams])

  const selectSection = (section: SetupSection) => {
    setSearchParams(section === 'airframe' ? {} : { section }, { replace: true })
  }

  return (
    <div className="mc-workspace mc-workspace--full mc-fade-in">
      <PageHeader title={t('settings.title')} description={t('settings.description')} />
      <div className="mc-subworkspace">
        <CollapsibleSubnav ariaLabel={t('settings.ariaLabel')} storageKey="oc-settings-subnav-collapsed">
          {sections.map((section) => (
            <button
              key={section.id}
              type="button"
              data-active={section.id === activeSection}
              aria-label={t(section.label)}
              title={t(section.label)}
              aria-current={section.id === activeSection ? 'page' : undefined}
              onClick={() => selectSection(section.id)}
            >
              <span><Icon name={section.icon} size={18} /></span>
              <span><strong>{t(section.label)}</strong><small>{t(section.description)}</small></span>
            </button>
          ))}
        </CollapsibleSubnav>

        <section className="mc-subworkspace__content" aria-live="polite">
          {activeSection === 'airframe' && <AirframeSetupPage />}
          {activeSection === 'sensors' && <SensorPage embedded />}
          {activeSection === 'radio' && <ReceiverPage embedded />}
          {activeSection === 'actuators' && <MotorPage embedded />}
          {activeSection === 'esc' && <EscPage embedded />}
          {activeSection === 'joystick' && <JoystickPage embedded />}
          {activeSection === 'ports' && <PortSettingsPage />}
          {activeSection === 'other' && <OtherSettingsPage />}
        </section>
      </div>
    </div>
  )
}
