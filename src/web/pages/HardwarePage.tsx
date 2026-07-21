import { Link } from 'react-router-dom'
import Icon, { type IconName } from '../components/ui/Icon'
import { PageHeader } from '../components/ui/PageFrame'

const hardwareTools: Array<{ to: string; icon: IconName; title: string; description: string }> = [
  { to: '/motors', icon: 'motor', title: '电机测试', description: '通过带保护的测试流程验证输出、旋向与编号。' },
  { to: '/receiver', icon: 'receiver', title: '遥控器输入', description: '监控每个 PWM 通道，并开始遥控器校准。' },
  { to: '/joystick', icon: 'gamepad', title: '游戏手柄', description: '查看实时摇杆输入并安全启用 RC 覆盖。' },
]

export default function HardwarePage() {
  return (
    <div className="mc-workspace mc-fade-in">
      <PageHeader title="硬件" description="管理电机、输入设备与外设工具" />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {hardwareTools.map((tool) => (
          <Link key={tool.to} to={tool.to} className="mc-card mc-card--hover p-5 no-underline">
            <span
              className="grid h-11 w-11 place-items-center rounded-xl"
              style={{ background: 'var(--accent-dim)', color: 'var(--accent)' }}
            >
              <Icon name={tool.icon} size={22} />
            </span>
            <h2 className="mt-5 text-[15px] font-bold" style={{ color: 'var(--text-primary)' }}>{tool.title}</h2>
            <p className="mt-1 text-[12px] leading-5" style={{ color: 'var(--text-secondary)' }}>{tool.description}</p>
          </Link>
        ))}
      </div>
    </div>
  )
}
