import { Link, NavLink, useLocation } from 'react-router-dom'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import Icon from '../ui/Icon'
import { navigationDomains } from '../../navigation'

export default function Sidebar({ placement = 'desktop' }: { placement?: 'desktop' | 'mobile' }) {
  const { t } = useTranslation()
  const location = useLocation()
  const [moreOpen, setMoreOpen] = useState(false)
  const visibleDomains = placement === 'mobile' ? navigationDomains.slice(0, 4) : navigationDomains
  return (
    <aside className={`mc-sidebar mc-sidebar--${placement}`}>
      <nav className="mc-sidebar__nav" aria-label={t('sidebar.ariaLabel')}>
        {visibleDomains.map((item) => (
          <NavLink
            key={item.id}
            to={item.defaultPath}
            title={t(item.labelKey)}
            className={({ isActive }) => 'mc-sidebar__item' + (isActive ? ' is-active' : '')}
          >
            <Icon name={item.icon} size={21} />
            <span>{t(item.labelKey)}</span>
          </NavLink>
        ))}
        {placement === 'mobile' && <button type="button" className="mc-sidebar__more" aria-expanded={moreOpen} onClick={() => setMoreOpen((open) => !open)}><Icon name="grid" size={21} /><span>{t('sidebar.more')}</span></button>}
      </nav>
      {placement === 'mobile' && moreOpen && <div className="mc-sidebar__more-menu" role="menu">{navigationDomains.slice(4).map((item) => <Link key={item.id} role="menuitem" to={item.defaultPath} data-active={location.pathname.startsWith(item.defaultPath)} onClick={() => setMoreOpen(false)}>{t(item.labelKey)}</Link>)}</div>}
    </aside>
  )
}
