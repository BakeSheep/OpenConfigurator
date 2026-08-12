import type { ReactNode } from 'react'
import Icon, { type IconName } from './Icon'

export type StatePanelKind = 'loading' | 'disconnected' | 'read-only' | 'unsupported' | 'empty' | 'error'

interface StatePanelProps {
  kind: StatePanelKind
  title: string
  description?: string
  action?: ReactNode
  icon?: IconName
  headingLevel?: 1 | 2 | 3
}

const stateIcons: Record<StatePanelKind, IconName> = {
  loading: 'refresh',
  disconnected: 'plug',
  'read-only': 'warning',
  unsupported: 'warning',
  empty: 'folder',
  error: 'warning',
}

export default function StatePanel({ kind, title, description, action, icon = stateIcons[kind], headingLevel = 3 }: StatePanelProps) {
  const Heading = `h${headingLevel}` as const
  return (
    <section className="mc-state-panel" data-kind={kind} role={kind === 'error' ? 'alert' : 'status'}>
      <div className="mc-state-panel__content">
        <span className="mc-state-panel__icon"><Icon name={icon} size={20} /></span>
        <Heading>{title}</Heading>
        {description && <p>{description}</p>}
        {action && <div className="mc-state-panel__actions">{action}</div>}
      </div>
    </section>
  )
}
