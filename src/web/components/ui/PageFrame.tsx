import type { ReactNode } from 'react'
import Icon, { type IconName } from './Icon'

interface PageHeaderProps {
  title: string
  description: string
  actions?: ReactNode
}

export function PageHeader({ title, description, actions }: PageHeaderProps) {
  return (
    <header className="mc-page-header">
      <div>
        <h1 className="mc-page-title">{title}</h1>
        <p className="mc-page-subtitle">{description}</p>
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  )
}

interface PageTabsProps {
  tabs: Array<{ id: string; label: string }>
  active: string
  onChange: (id: string) => void
}

export function PageTabs({ tabs, active, onChange }: PageTabsProps) {
  return (
    <div className="mc-tabbar" role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={tab.id === active}
          data-active={tab.id === active}
          className="mc-tab"
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  )
}

interface EmptyStateProps {
  title?: string
  description?: string
  icon?: IconName
  action?: ReactNode
}

export function EmptyState({
  title = '请先连接飞控',
  description,
  icon = 'external',
  action,
}: EmptyStateProps) {
  return (
    <section className="mc-empty-state">
      <div>
        <span className="mc-empty-state__icon"><Icon name={icon} size={22} /></span>
        <p className="mc-empty-state__title">{title}</p>
        {description && <p className="mc-empty-state__description">{description}</p>}
        {action && <div className="mt-5 flex justify-center">{action}</div>}
      </div>
    </section>
  )
}
