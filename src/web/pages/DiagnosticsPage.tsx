import { useSearchParams } from 'react-router-dom'
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
  { id: 'parameters', label: '完整参数', description: '同步、搜索和写入', icon: 'parameters' },
  { id: 'pid', label: 'PID 调参', description: '姿态与角速度控制', icon: 'tune' },
  { id: 'ekf', label: 'EKF 融合', description: '状态估计数据源', icon: 'settings' },
  { id: 'waveforms', label: '实时波形', description: '多通道趋势观察', icon: 'waveform' },
  { id: 'messages', label: 'MAVLink 消息', description: '数据流与状态文本', icon: 'message' },
  { id: 'logs', label: '飞行日志', description: '浏览与下载日志', icon: 'folder' },
  { id: 'log-analysis', label: '日志分析', description: 'ULog 图表与诊断', icon: 'log' },
]

function isDiagnosticSection(value: string | null): value is DiagnosticSection {
  return sections.some((section) => section.id === value)
}

export default function DiagnosticsPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const sectionParam = searchParams.get('section')
  const activeSection: DiagnosticSection = isDiagnosticSection(sectionParam) ? sectionParam : 'parameters'

  return (
    <div className="mc-workspace mc-workspace--full mc-fade-in">
      <PageHeader title="调参与诊断" description="集中管理飞控参数、估计器配置与实时通信诊断。" />
      <div className="mc-subworkspace">
        <CollapsibleSubnav ariaLabel="调参与诊断" storageKey="oc-diagnostics-subnav-collapsed">
          {sections.map((section) => (
            <button key={section.id} type="button" data-active={section.id === activeSection} aria-label={section.label} title={section.label} aria-current={section.id === activeSection ? 'page' : undefined} onClick={() => setSearchParams(section.id === 'parameters' ? {} : { section: section.id }, { replace: true })}>
              <span><Icon name={section.icon} size={18} /></span>
              <span><strong>{section.label}</strong><small>{section.description}</small></span>
            </button>
          ))}
        </CollapsibleSubnav>
        <section className="mc-subworkspace__content">
          {activeSection === 'parameters' && <ParameterPage embedded />}
          {activeSection === 'pid' && <PidTuningPage />}
          {activeSection === 'ekf' && <section className="mc-card mc-diagnostics-ekf"><header><h2>EKF 融合设置</h2><p>选择参与状态估计的传感器与高度参考源，修改后按飞控要求重启。</p></header><EkfFusionPanel /></section>}
          {activeSection === 'waveforms' && <WaveformPage embedded />}
          {activeSection === 'messages' && <MessagesPage embedded />}
          {activeSection === 'logs' && <FlightLogsPage embedded />}
          {activeSection === 'log-analysis' && <LogAnalysisPage embedded />}
        </section>
      </div>
    </div>
  )
}
