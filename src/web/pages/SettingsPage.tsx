import { useState } from 'react'
import EkfFusionPanel from '../components/ekf/EkfFusionPanel'
import Icon from '../components/ui/Icon'
import { PageHeader, PageTabs } from '../components/ui/PageFrame'
import ConnectionPage from './ConnectionPage'
import FlightControlPage from './FlightControlPage'
import MotorPage from './MotorPage'
import ParameterPage from './ParameterPage'
import ReceiverPage from './ReceiverPage'

const tabs = [
  { id: 'airframe', label: '机架类型' },
  { id: 'motor', label: '电机设置' },
  { id: 'receiver', label: '遥控器' },
  { id: 'ports', label: '端口设置' },
  { id: 'pid', label: 'PID 调参' },
  { id: 'ekf', label: 'EKF' },
  { id: 'other', label: '其他' },
]

const airframes = [
  ['airship', 'Airship', 'Cloudship', 'flight'], ['autogyro', 'Autogyro', 'ThunderFly Auto-G2', 'flight'],
  ['balloon', 'Balloon', 'ThunderFly balloon TF-B1', 'altitude'], ['dodeca', 'Dodecarotor coaxial', 'Generic Dodecarotor', 'motor'],
  ['helicopter', 'Helicopter', 'Generic Helicopter', 'flight'], ['hexa-plus', 'Hexarotor +', 'Generic Hexarotor +', 'motor'],
  ['hexa-coax', 'Hexarotor Coaxial', 'Generic Hexarotor coaxial', 'motor'], ['hexa-x', 'Hexarotor X', 'Generic Hexarotor X', 'motor'],
  ['octo-plus', 'Octorotor +', 'Generic Octocopter +', 'motor'], ['octo-x', 'Octorotor X', 'Generic Octocopter X', 'motor'],
  ['quad-plus', 'Quadrotor +', 'Generic Quad +', 'motor'], ['quad-x', 'Quadrotor X', 'Generic Quadcopter', 'motor'],
] as const

export default function SettingsPage() {
  const [activeTab, setActiveTab] = useState('airframe')
  const [selectedAirframe, setSelectedAirframe] = useState('quad-x')

  return (
    <div className="mc-workspace mc-fade-in mc-data-workspace">
      <PageHeader title="飞控设置" description="配置飞控参数与硬件设置" />
      <PageTabs tabs={tabs} active={activeTab} onChange={setActiveTab} />

      {activeTab === 'airframe' ? (
        <section className="mc-airframe-section">
          <header><h2>机架类型</h2><p>选择与您的无人机匹配的机架类型</p></header>
          <div className="mc-airframe-grid">
            {airframes.map(([id, title, option, icon]) => (
              <button type="button" key={id} data-active={selectedAirframe === id} onClick={() => setSelectedAirframe(id)}>
                <span className="mc-airframe-illustration"><Icon name={icon} size={58} /><i /><i /><i /><i /></span>
                <strong>{title}</strong>
                <select className="mc-select" value={option} onChange={() => undefined} onClick={(event) => event.stopPropagation()} aria-label={title + ' 型号'}><option>{option}</option></select>
              </button>
            ))}
          </div>
        </section>
      ) : <SettingsInlinePanel activeTab={activeTab} />}
    </div>
  )
}

function SettingsInlinePanel({ activeTab }: { activeTab: string }) {
  return (
    <section className="mc-settings-inline mc-fade-in" key={activeTab}>
      {activeTab === 'motor' && <MotorPage />}
      {activeTab === 'receiver' && <ReceiverPage embedded />}
      {activeTab === 'ports' && <ConnectionPage />}
      {activeTab === 'pid' && <ParameterPage />}
      {activeTab === 'ekf' && (
        <div className="mc-settings-ekf">
          <header><h2>EKF 融合设置</h2><p>选择参与状态估计的传感器与高度参考源。</p></header>
          <EkfFusionPanel />
        </div>
      )}
      {activeTab === 'other' && <FlightControlPage />}
    </section>
  )
}
