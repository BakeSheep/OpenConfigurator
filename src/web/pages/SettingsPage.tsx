import { useState } from 'react'
import EkfFusionPanel from '../components/ekf/EkfFusionPanel'
import Icon from '../components/ui/Icon'
import { PageHeader, PageTabs } from '../components/ui/PageFrame'
import FlightControlPage from './FlightControlPage'
import JoystickPage from './JoystickPage'
import MotorPage from './MotorPage'
import ParameterPage from './ParameterPage'
import PortSettingsPage from './PortSettingsPage'
import ReceiverPage from './ReceiverPage'
import { useParameterStore } from '../stores/parameterStore'
import { getPx4AirframeInfo } from '../utils/px4Airframes'

const tabs = [
  { id: 'airframe', label: '机架类型' },
  { id: 'motor', label: '电机设置' },
  { id: 'receiver', label: '遥控器' },
  { id: 'joystick', label: '游戏手柄' },
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
  const sysAutostart = useParameterStore((state) => state.params.get('SYS_AUTOSTART')?.value)
  const airframeInfo = getPx4AirframeInfo(sysAutostart)
  const autostartId = Number.isFinite(sysAutostart) ? Math.round(sysAutostart!) : null

  return (
    <div className="mc-workspace mc-fade-in mc-data-workspace">
      <PageHeader title="飞控设置" description="配置飞控参数、输入设备与硬件设置" />
      <PageTabs tabs={tabs} active={activeTab} onChange={setActiveTab} />

      {activeTab === 'airframe' ? (
        <section className="mc-airframe-section">
          <header><h2>机架类型</h2><p>选择与您的无人机匹配的机架类型</p></header>
          <div className="mc-capability-note" data-state={airframeInfo ? 'detected' : 'waiting'}>
            <Icon name={airframeInfo ? 'check' : 'warning'} size={15} />
            <span>
              {airframeInfo && autostartId !== null
                ? `当前飞控机架：${airframeInfo.name}（SYS_AUTOSTART ${autostartId}）`
                : '连接飞控并完成参数同步后，将根据 SYS_AUTOSTART 自动识别当前机架。'}
            </span>
          </div>
          <div className="mc-airframe-grid">
            {airframes.map(([id, title, option, icon]) => (
              <button
                type="button"
                key={id}
                disabled
                data-active={airframeInfo?.cardId === id}
                aria-current={airframeInfo?.cardId === id ? 'true' : undefined}
                title={airframeInfo?.cardId === id ? `当前机架 · SYS_AUTOSTART ${autostartId}` : '机架参数写入尚未接入'}
              >
                <span className="mc-airframe-illustration"><Icon name={icon} size={58} /><i /><i /><i /><i /></span>
                <strong>{title}</strong>
                <select className="mc-select" value={option} onChange={() => undefined} disabled aria-label={title + ' 型号'}><option>{option}</option></select>
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
      {activeTab === 'joystick' && <JoystickPage embedded />}
      {activeTab === 'ports' && <PortSettingsPage />}
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
