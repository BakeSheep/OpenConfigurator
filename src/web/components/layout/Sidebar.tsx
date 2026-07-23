import { NavLink } from 'react-router-dom'
import Icon, { type IconName } from '../ui/Icon'

interface NavigationItem {
  to: string
  label: string
  icon: IconName
}

const navigationItems: NavigationItem[] = [
  { to: '/dashboard', label: '仪表盘', icon: 'dashboard' },
  { to: '/settings', label: '设置', icon: 'settings' },
  { to: '/sensors', label: '传感器', icon: 'sensor' },
  { to: '/parameters', label: '参数', icon: 'parameters' },
  { to: '/messages', label: '消息', icon: 'message' },
  { to: '/missions', label: '航线', icon: 'route' },
  { to: '/logs', label: '日志', icon: 'log' },
  { to: '/waveforms', label: '波形', icon: 'waveform' },
  { to: '/firmware', label: '固件', icon: 'firmware' },
]

export default function Sidebar() {
  return (
    <aside className="mc-sidebar">
      <nav className="mc-sidebar__nav" aria-label="主导航">
        {navigationItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            title={item.label}
            className={({ isActive }) => 'mc-sidebar__item' + (isActive ? ' is-active' : '')}
          >
            <Icon name={item.icon} size={21} />
            <span>{item.label}</span>
          </NavLink>
        ))}
      </nav>
      <NavLink to="/rtk" title="RTK" className={({ isActive }) => 'mc-sidebar__item mc-sidebar__rtk' + (isActive ? ' is-active' : '')}>
        <Icon name="rtk" size={20} />
        <span>RTK</span>
      </NavLink>
    </aside>
  )
}
