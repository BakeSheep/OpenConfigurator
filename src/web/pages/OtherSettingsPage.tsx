import { useTranslation } from 'react-i18next'
import PowerSetupPage from './PowerSetupPage'
import SafetySetupPage from './SafetySetupPage'

export default function OtherSettingsPage() {
  const { t } = useTranslation()

  return (
    <div className="mc-setup-page mc-fade-in">
      <section className="mc-settings-section" aria-labelledby="other-power-title">
        <header className="mc-settings-section__heading">
          <div>
            <span className="mc-eyebrow">POWER</span>
            <h2 id="other-power-title">{t('settings.section.power.label')}</h2>
            <p>{t('settings.section.power.description')}</p>
          </div>
        </header>
        <PowerSetupPage />
      </section>

      <section className="mc-settings-section" aria-labelledby="other-safety-title">
        <header className="mc-settings-section__heading">
          <div>
            <span className="mc-eyebrow">SAFETY</span>
            <h2 id="other-safety-title">{t('settings.section.safety.label')}</h2>
            <p>{t('settings.section.safety.description')}</p>
          </div>
        </header>
        <SafetySetupPage />
      </section>
    </div>
  )
}
