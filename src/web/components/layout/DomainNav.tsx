import { useEffect, useRef } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import Icon from '../ui/Icon'
import type { NavigationItem } from '../../navigation'

export default function DomainNav({ items, ariaLabel }: { items: NavigationItem[]; ariaLabel: string }) {
  const { t } = useTranslation()
  const location = useLocation()
  const ref = useRef<HTMLElement>(null)
  useEffect(() => {
    const active = ref.current?.querySelector<HTMLElement>('[aria-current="page"]')
    const nav = ref.current
    // Keep the horizontal sub-navigation discoverable without allowing
    // scrollIntoView to move the routed workspace vertically.
    if (!nav || !active || nav.scrollWidth <= nav.clientWidth) return
    nav.scrollTo({
      left: Math.max(0, active.offsetLeft - (nav.clientWidth - active.offsetWidth) / 2),
      behavior: 'auto',
    })
  }, [location.pathname])
  return <nav ref={ref} className="mc-domain-nav" aria-label={ariaLabel}>
    {items.map((item) => {
      const active = location.pathname === item.path.split('?')[0]
      return <Link key={item.id} to={item.path} className="mc-domain-nav__link" data-active={active} aria-current={active ? 'page' : undefined}>
        <Icon name={item.icon} size={17} /><span>{t(item.labelKey)}</span>
      </Link>
    })}
  </nav>
}
