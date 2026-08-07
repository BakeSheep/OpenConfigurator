import { useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import CollapsibleSubnav from '../components/layout/CollapsibleSubnav'
import Icon, { type IconName } from '../components/ui/Icon'
import { PageHeader } from '../components/ui/PageFrame'
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

const sections: Array<{ id: SetupSection; label: string; description: string; icon: IconName }> = [
  { id: 'airframe', label: 'settings.section.airframe.label', description: 'settings.section.airframe.description', icon: 'flight' },
  { id: 'sensors', label: 'settings.section.sensors.label', description: 'settings.section.sensors.description', icon: 'sensor' },
  { id: 'actuators', label: 'settings.section.actuators.label', description: 'settings.section.actuators.description', icon: 'actuator' },
  { id: 'esc', label: 'settings.section.esc.label', description: 'settings.section.esc.description', icon: 'firmware' },
  { id: 'receiver', label: 'settings.section.receiver.label', description: 'settings.section.receiver.description', icon: 'receiver' },
  { id: 'joystick', label: 'settings.section.joystick.label', description: 'settings.section.joystick.description', icon: 'gamepad' },
  { id: 'ports', label: 'settings.section.ports.label', description: 'settings.section.ports.description', icon: 'plug' },
]

function isSetupSection(value: string | null): value is SetupSection {
  return sections.some((section) => section.id === value)
}

export default function SettingsPage() {
  const { t } = useTranslation()
  const [searchParams, setSearchParams] = useSearchParams()
  const sectionParam = searchParams.get('section')
  const activeSection: SetupSection = isSetupSection(sectionParam) ? sectionParam : 'airframe'
  const params = useParameterStore((state) => state.params)
  const vehicleIdentity = useTelemetryStore((state) => state.vehicleIdentity)
  // Family-specific frame view: SYS_AUTOSTART for PX4, FRAME_CLASS/FRAME_TYPE
  // for ArduPilot. No frame writes are offered in this release.
  const frameView = params.size > 0 ? buildFrameConfigView(vehicleIdentity, params) : null

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
          {activeSection === 'airframe' && (
            <div className="mc-setup-overview mc-fade-in">
              <section className="mc-card mc-setup-identity">
                <span className="mc-setup-identity__icon"><Icon name="flight" size={34} /></span>
                <div>
                  <span className="mc-eyebrow">{t('settings.currentFrame')}</span>
                  <h2>{frameView?.name ?? t('settings.waitingParams')}</h2>
                  <p>{frameView
                    ? frameView.frameSource
                    : params.size > 0 && vehicleIdentity
                      ? t('settings.frameNotSupported')
                      : t('settings.autoIdentify')}</p>
                </div>
              </section>
            </div>
          )}
          {activeSection === 'sensors' && <SensorPage embedded />}
          {activeSection === 'actuators' && <MotorPage embedded />}
          {activeSection === 'esc' && <EscPage embedded />}
          {activeSection === 'receiver' && <ReceiverPage embedded />}
          {activeSection === 'joystick' && <JoystickPage embedded />}
          {activeSection === 'ports' && <PortSettingsPage />}
        </section>
      </div>
    </div>
  )
}
