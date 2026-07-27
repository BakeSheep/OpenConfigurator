import { useState, type ReactNode } from 'react'
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
        aria-label={collapsed ? '展开子页面侧边栏' : '收起子页面侧边栏'}
        title={collapsed ? '展开侧边栏' : '仅显示图标'}
        onClick={toggle}
      >
        <span><Icon name={collapsed ? 'arrowRight' : 'arrowLeft'} size={16} /></span>
        <span><strong>{collapsed ? '展开' : '收起侧栏'}</strong></span>
      </button>
    </nav>
  )
}
