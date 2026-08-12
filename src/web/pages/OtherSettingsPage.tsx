import { useTranslation } from 'react-i18next'
import EkfFusionPanel from '../components/ekf/EkfFusionPanel'
import { PageTabs } from '../components/ui/PageFrame'
import { TabPanel } from '../components/ui/Tabs'
import { useQueryTab } from '../hooks/useQueryTab'
import PowerSetupPage from './PowerSetupPage'
import SafetySetupPage from './SafetySetupPage'

const OTHER_TABS = ['power', 'safety', 'ekf'] as const

export default function OtherSettingsPage() {
  const { t } = useTranslation()
  const [activeTab, setActiveTab] = useQueryTab(OTHER_TABS, 'power')

  return (
    <div className="mc-setup-page mc-fade-in">
      <PageTabs
        tabs={[
          { id: 'power', label: t('settings.section.power.label') },
          { id: 'safety', label: t('settings.section.safety.label') },
          { id: 'ekf', label: t('diagnostics.section.ekf.label') },
        ]}
        active={activeTab}
        onChange={setActiveTab}
        ariaLabel={t('settings.otherTasks')}
        idBase="other-settings"
      />
      <TabPanel idBase="other-settings" tabId={activeTab}>
        {activeTab === 'power' && <PowerSetupPage />}
        {activeTab === 'safety' && <SafetySetupPage />}
        {activeTab === 'ekf' && (
          <section className="mc-settings-task" aria-label={t('diagnostics.ekfSettingsTitle')}>
            <EkfFusionPanel />
          </section>
        )}
      </TabPanel>
    </div>
  )
}
