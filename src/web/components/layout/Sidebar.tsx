import { NavLink } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import Icon, { type IconName } from '../ui/Icon'

interface NavigationItem {
  to: string
  labelKey: string
  icon: IconName
}

const navigationItems: NavigationItem[] = [
  { to: '/dashboard', labelKey: 'sidebar.dashboard', icon: 'dashboard' },
  { to: '/flight', labelKey: 'sidebar.flight', icon: 'flight' },
  { to: '/settings', labelKey: 'sidebar.settings', icon: 'settings' },
  { to: '/diagnostics', labelKey: 'sidebar.diagnostics', icon: 'waveform' },
]

export default function Sidebar() {
  const { t } = useTranslation()
  return (
    <aside className="mc-sidebar">
      <nav className="mc-sidebar__nav" aria-label={t('sidebar.ariaLabel')}>
        {navigationItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            title={t(item.labelKey)}
            className={({ isActive }) => 'mc-sidebar__item' + (isActive ? ' is-active' : '')}
          >
            <Icon name={item.icon} size={21} />
            <span>{t(item.labelKey)}</span>
          </NavLink>
        ))}
      </nav>
    </aside>
  )
}
