import { NavLink } from 'react-router-dom'
import Icon, { type IconName } from '../ui/Icon'

interface NavigationItem {
  to: string
  label: string
  icon: IconName
}

const navigationItems: NavigationItem[] = [
  { to: '/dashboard', label: '总览', icon: 'dashboard' },
  { to: '/flight', label: '飞行操作', icon: 'flight' },
  { to: '/settings', label: '飞行器设置', icon: 'settings' },
  { to: '/diagnostics', label: '调参与诊断', icon: 'waveform' },
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
    </aside>
  )
}
