import { useSearchParams } from 'react-router-dom'
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
  { id: 'airframe', label: '机架', description: '识别当前飞行器配置', icon: 'flight' },
  { id: 'sensors', label: '传感器', description: '监控与校准', icon: 'sensor' },
  { id: 'actuators', label: '执行器', description: '输出映射与电机测试', icon: 'motor' },
  { id: 'esc', label: '电调', description: '直通配置与固件刷写', icon: 'motor' },
  { id: 'receiver', label: '遥控器', description: '通道监控', icon: 'receiver' },
  { id: 'joystick', label: '游戏手柄', description: '轴、按钮与响应曲线', icon: 'gamepad' },
  { id: 'ports', label: '端口', description: 'MAVLink 串口实例', icon: 'plug' },
]

function isSetupSection(value: string | null): value is SetupSection {
  return sections.some((section) => section.id === value)
}

export default function SettingsPage() {
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
    <div className="mc-workspace mc-workspace--wide mc-fade-in">
      <PageHeader title="飞行器设置" description="按硬件配置流程组织机架、传感器、执行器与控制输入。" />
      <div className="mc-subworkspace">
        <CollapsibleSubnav ariaLabel="飞行器设置" storageKey="oc-settings-subnav-collapsed">
          {sections.map((section) => (
            <button
              key={section.id}
              type="button"
              data-active={section.id === activeSection}
              aria-label={section.label}
              title={section.label}
              aria-current={section.id === activeSection ? 'page' : undefined}
              onClick={() => selectSection(section.id)}
            >
              <span><Icon name={section.icon} size={18} /></span>
              <span><strong>{section.label}</strong><small>{section.description}</small></span>
            </button>
          ))}
        </CollapsibleSubnav>

        <section className="mc-subworkspace__content" aria-live="polite">
          {activeSection === 'airframe' && (
            <div className="mc-setup-overview mc-fade-in">
              <section className="mc-card mc-setup-identity">
                <span className="mc-setup-identity__icon"><Icon name="flight" size={34} /></span>
                <div>
                  <span className="mc-eyebrow">当前机架</span>
                  <h2>{frameView?.name ?? '等待飞控参数'}</h2>
                  <p>{frameView
                    ? frameView.frameSource
                    : params.size > 0 && vehicleIdentity
                      ? '当前飞控类型尚未适配机架识别。'
                      : '连接飞控并完成参数同步后自动识别。'}</p>
                </div>
              </section>
              <section className="mc-card mc-setup-guidance">
                <h2>配置顺序</h2>
                <ol>
                  <li><span>1</span><div><strong>确认机架</strong><small>核对飞控中的机架参数（PX4：SYS_AUTOSTART；ArduPilot：FRAME_CLASS/FRAME_TYPE），不在未支持的界面中修改机架。</small></div></li>
                  <li><span>2</span><div><strong>校准传感器</strong><small>完成 IMU、罗盘和气压计校准，并检查实时数据。</small></div></li>
                  <li><span>3</span><div><strong>映射执行器</strong><small>确认物理输出、电机编号与旋向，再执行无桨测试。</small></div></li>
                  <li><span>4</span><div><strong>检查控制输入</strong><small>确认遥控器或游戏手柄通道响应正确。</small></div></li>
                </ol>
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
