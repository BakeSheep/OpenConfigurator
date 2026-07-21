import { useState } from 'react'
import { Link } from 'react-router-dom'
import Icon, { type IconName } from '../components/ui/Icon'
import { PageHeader, PageTabs } from '../components/ui/PageFrame'

const tabs = [
  { id: 'airframe', label: '机架类型' },
  { id: 'flight', label: '飞行控制' },
  { id: 'motor', label: '电机设置' },
  { id: 'receiver', label: '遥控器' },
  { id: 'ekf', label: 'EKF' },
]

interface SetupTileProps {
  to: string
  icon: IconName
  title: string
  description: string
  status: string
}

function SetupTile({ to, icon, title, description, status }: SetupTileProps) {
  return (
    <Link to={to} className="mc-card mc-card--hover flex min-h-[160px] flex-col p-5 no-underline">
      <div className="flex items-start justify-between gap-4">
        <span
          className="grid h-10 w-10 place-items-center rounded-xl"
          style={{ background: 'var(--accent-dim)', color: 'var(--accent)' }}
        >
          <Icon name={icon} size={20} />
        </span>
        <span
          className="rounded-full px-2 py-1 text-[10px] font-semibold"
          style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
        >
          {status}
        </span>
      </div>
      <h2 className="mt-5 text-[15px] font-bold" style={{ color: 'var(--text-primary)' }}>{title}</h2>
      <p className="mt-1 text-[12px] leading-5" style={{ color: 'var(--text-secondary)' }}>{description}</p>
    </Link>
  )
}

export default function SettingsPage() {
  const [activeTab, setActiveTab] = useState('airframe')

  return (
    <div className="mc-workspace mc-fade-in">
      <PageHeader title="飞控设置" description="配置飞控参数与硬件设置" />
      <PageTabs tabs={tabs} active={activeTab} onChange={setActiveTab} />

      <section className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        <SetupTile to="/flight" icon="flight" title="飞行控制" description="解锁、起飞、模式切换与飞行前安全检查。" status="飞行" />
        <SetupTile to="/motors" icon="motor" title="电机设置" description="按安全流程验证电机顺序、旋向和油门输出。" status="硬件" />
        <SetupTile to="/receiver" icon="receiver" title="遥控器" description="查看 RC 通道并完成遥控器校准与反向设置。" status="输入" />
        <SetupTile to="/joystick" icon="gamepad" title="游戏手柄" description="将 USB 或蓝牙游戏手柄映射为 RC 覆盖控制。" status="新增" />
        <SetupTile to="/sensors" icon="sensor" title="传感器与 EKF" description="校准 IMU、罗盘和气压计，并配置融合状态。" status="校准" />
        <SetupTile to="/parameters" icon="parameters" title="参数管理" description="下载、搜索、编辑并导出 PX4 飞控参数。" status="高级" />
      </section>
    </div>
  )
}
