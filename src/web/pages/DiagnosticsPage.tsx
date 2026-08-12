import { Navigate, useLocation, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import SectionNav, { sectionLocation } from '../components/layout/SectionNav'
import type { IconName } from '../components/ui/Icon'
import { SectionFrame, WorkspaceFrame } from '../components/ui/PageFrame'
import MessagesPage from './MessagesPage'
import ParameterPage from './ParameterPage'
import PidTuningPage from './PidTuningPage'
import WaveformPage from './WaveformPage'
import FlightLogsPage from './FlightLogsPage'
import LogAnalysisPage from './LogAnalysisPage'

type DiagnosticSection = 'parameters' | 'pid' | 'waveforms' | 'messages' | 'logs' | 'log-analysis'

const DEFAULT_SECTION: DiagnosticSection = 'parameters'

const sections: Array<{ id: DiagnosticSection; label: string; icon: IconName }> = [
  { id: 'parameters', label: 'diagnostics.section.parameters.label', icon: 'parameters' },
  { id: 'pid', label: 'diagnostics.section.pid.label', icon: 'tune' },
  { id: 'waveforms', label: 'diagnostics.section.waveforms.label', icon: 'waveform' },
  { id: 'messages', label: 'diagnostics.section.messages.label', icon: 'message' },
  { id: 'logs', label: 'diagnostics.section.logs.label', icon: 'folder' },
  { id: 'log-analysis', label: 'diagnostics.section.log-analysis.label', icon: 'log' },
]

function isDiagnosticSection(value: string | null): value is DiagnosticSection {
  return sections.some((section) => section.id === value)
}

export default function DiagnosticsPage() {
  const { t } = useTranslation()
  const location = useLocation()
  const [searchParams] = useSearchParams()
  const sectionParam = searchParams.get('section')
  const activeSection: DiagnosticSection = isDiagnosticSection(sectionParam) ? sectionParam : DEFAULT_SECTION
  const activeSectionConfig = sections.find((section) => section.id === activeSection) ?? sections[0]

  // Preserve old bookmarks while moving EKF into the consolidated Settings
  // workspace. Unrelated query state is retained.
  if (sectionParam === 'ekf') {
    const next = new URLSearchParams(searchParams)
    next.set('section', 'other')
    next.set('tab', 'ekf')
    return <Navigate replace to={{ pathname: '/settings', search: `?${next.toString()}` }} />
  }

  return (
    <WorkspaceFrame title={t('diagnostics.title')}>
      <div className="mc-section-layout">
        <SectionNav
          ariaLabel={t('diagnostics.ariaLabel')}
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
          description={t(`diagnostics.section.${activeSection}.description`)}
          focusKey={activeSection}
        >
          {activeSection === 'parameters' && <ParameterPage embedded />}
          {activeSection === 'pid' && <PidTuningPage />}
          {activeSection === 'waveforms' && <WaveformPage embedded />}
          {activeSection === 'messages' && <MessagesPage embedded />}
          {activeSection === 'logs' && <FlightLogsPage embedded />}
          {activeSection === 'log-analysis' && <LogAnalysisPage embedded />}
        </SectionFrame>
      </div>
    </WorkspaceFrame>
  )
}
