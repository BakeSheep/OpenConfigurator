import { useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import CollapsibleSubnav from '../components/layout/CollapsibleSubnav'
import EkfFusionPanel from '../components/ekf/EkfFusionPanel'
import Icon, { type IconName } from '../components/ui/Icon'
import { PageHeader } from '../components/ui/PageFrame'
import MessagesPage from './MessagesPage'
import ParameterPage from './ParameterPage'
import PidTuningPage from './PidTuningPage'
import WaveformPage from './WaveformPage'
import FlightLogsPage from './FlightLogsPage'
import LogAnalysisPage from './LogAnalysisPage'

type DiagnosticSection = 'parameters' | 'pid' | 'ekf' | 'waveforms' | 'messages' | 'logs' | 'log-analysis'

const sections: Array<{ id: DiagnosticSection; label: string; description: string; icon: IconName }> = [
  { id: 'parameters', label: 'diagnostics.section.parameters.label', description: 'diagnostics.section.parameters.description', icon: 'parameters' },
  { id: 'pid', label: 'diagnostics.section.pid.label', description: 'diagnostics.section.pid.description', icon: 'tune' },
  { id: 'ekf', label: 'diagnostics.section.ekf.label', description: 'diagnostics.section.ekf.description', icon: 'settings' },
  { id: 'waveforms', label: 'diagnostics.section.waveforms.label', description: 'diagnostics.section.waveforms.description', icon: 'waveform' },
  { id: 'messages', label: 'diagnostics.section.messages.label', description: 'diagnostics.section.messages.description', icon: 'message' },
  { id: 'logs', label: 'diagnostics.section.logs.label', description: 'diagnostics.section.logs.description', icon: 'folder' },
  { id: 'log-analysis', label: 'diagnostics.section.log-analysis.label', description: 'diagnostics.section.log-analysis.description', icon: 'log' },
]

function isDiagnosticSection(value: string | null): value is DiagnosticSection {
  return sections.some((section) => section.id === value)
}

export default function DiagnosticsPage() {
  const { t } = useTranslation()
  const [searchParams, setSearchParams] = useSearchParams()
  const sectionParam = searchParams.get('section')
  const activeSection: DiagnosticSection = isDiagnosticSection(sectionParam) ? sectionParam : 'parameters'

  return (
    <div className="mc-workspace mc-workspace--full mc-fade-in">
      <PageHeader title={t('diagnostics.title')} description={t('diagnostics.description')} />
      <div className="mc-subworkspace">
        <CollapsibleSubnav ariaLabel={t('diagnostics.ariaLabel')} storageKey="oc-diagnostics-subnav-collapsed">
          {sections.map((section) => (
            <button key={section.id} type="button" data-active={section.id === activeSection} aria-label={t(section.label)} title={t(section.label)} aria-current={section.id === activeSection ? 'page' : undefined} onClick={() => setSearchParams(section.id === 'parameters' ? {} : { section: section.id }, { replace: true })}>
              <span><Icon name={section.icon} size={18} /></span>
              <span><strong>{t(section.label)}</strong><small>{t(section.description)}</small></span>
            </button>
          ))}
        </CollapsibleSubnav>
        <section className="mc-subworkspace__content">
          {activeSection === 'parameters' && <ParameterPage embedded />}
          {activeSection === 'pid' && <PidTuningPage />}
          {activeSection === 'ekf' && <section className="mc-card mc-diagnostics-ekf"><header><h2>{t('diagnostics.ekfSettingsTitle')}</h2><p>{t('diagnostics.ekfSettingsHint')}</p></header><EkfFusionPanel /></section>}
          {activeSection === 'waveforms' && <WaveformPage embedded />}
          {activeSection === 'messages' && <MessagesPage embedded />}
          {activeSection === 'logs' && <FlightLogsPage embedded />}
          {activeSection === 'log-analysis' && <LogAnalysisPage embedded />}
        </section>
      </div>
    </div>
  )
}
