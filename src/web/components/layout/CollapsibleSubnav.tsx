import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import Icon from '../ui/Icon'

interface CollapsibleSubnavProps {
  ariaLabel: string
  storageKey: string
  children: ReactNode
}

function loadCollapsed(storageKey: string): boolean {
  try {
    return localStorage.getItem(storageKey) === 'true'
  } catch {
    return false
  }
}

export default function CollapsibleSubnav({
  ariaLabel,
  storageKey,
  children,
}: CollapsibleSubnavProps) {
  const { t } = useTranslation()
  const [collapsed, setCollapsed] = useState(() => loadCollapsed(storageKey))

  const toggle = () => {
    setCollapsed((current) => {
      const next = !current
      try { localStorage.setItem(storageKey, String(next)) } catch { /* ignore */ }
      return next
    })
  }

  return (
    <nav
      className={`mc-subnav${collapsed ? ' is-collapsed' : ''}`}
      aria-label={ariaLabel}
      data-collapsed={collapsed}
    >
      <div className="mc-subnav__items">{children}</div>
      <button
        type="button"
        className="mc-subnav__collapse"
        aria-label={collapsed ? t('subnav.expandSubnav') : t('subnav.collapseSubnav')}
        title={collapsed ? t('subnav.expand') : t('subnav.iconOnly')}
        onClick={toggle}
      >
        <span><Icon name={collapsed ? 'arrowRight' : 'arrowLeft'} size={16} /></span>
        <span><strong>{collapsed ? t('subnav.expandBtn') : t('subnav.collapseBtn')}</strong></span>
      </button>
    </nav>
  )
}
