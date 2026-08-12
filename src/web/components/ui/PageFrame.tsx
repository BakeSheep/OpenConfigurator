import {
  useEffect,
  useId,
  useRef,
  type ReactNode,
} from 'react'
import { useTranslation } from 'react-i18next'
import Icon, { type IconName } from './Icon'
import { Tabs, type TabItem } from './Tabs'

function classes(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(' ')
}

interface PageHeaderProps {
  title: string
  description?: string
  actions?: ReactNode
}

export function PageHeader({ title, description, actions }: PageHeaderProps) {
  return (
    <header className="mc-page-header">
      <div>
        <h1 className="mc-page-title" tabIndex={-1}>{title}</h1>
        {description && <p className="mc-page-subtitle">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  )
}

interface WorkspaceFrameProps extends PageHeaderProps {
  children: ReactNode
  className?: string
}

/** The shared outer frame for a routed workspace. It owns the page's only h1. */
export function WorkspaceFrame({
  title,
  description,
  actions,
  children,
  className,
}: WorkspaceFrameProps) {
  return (
    <div className={classes('mc-workspace-frame', 'mc-fade-in', className)}>
      <PageHeader title={title} description={description} actions={actions} />
      {children}
    </div>
  )
}

interface SectionFrameProps {
  title: string
  children: ReactNode
  description?: string
  status?: ReactNode
  actions?: ReactNode
  tabs?: ReactNode
  toolbar?: ReactNode
  notices?: ReactNode
  focusKey?: string
  className?: string
}

/**
 * Shared frame for one active workspace section. Changing focusKey moves the
 * scroll position and keyboard focus to the new section heading.
 */
export function SectionFrame({
  title,
  children,
  description,
  status,
  actions,
  tabs,
  toolbar,
  notices,
  focusKey,
  className,
}: SectionFrameProps) {
  const headingId = useId()
  const frameRef = useRef<HTMLElement>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const previousFocusKey = useRef(focusKey)

  useEffect(() => {
    if (previousFocusKey.current === focusKey) return
    previousFocusKey.current = focusKey

    const animationFrame = window.requestAnimationFrame(() => {
      frameRef.current?.scrollIntoView({ block: 'start', behavior: 'auto' })
      headingRef.current?.focus({ preventScroll: true })
    })

    return () => window.cancelAnimationFrame(animationFrame)
  }, [focusKey])

  return (
    <section
      ref={frameRef}
      className={classes('mc-section-frame', className)}
      aria-labelledby={headingId}
    >
      <header className="mc-section-frame__header">
        <div className="mc-section-frame__heading">
          <div className="mc-section-frame__title-row">
            <h2 ref={headingRef} id={headingId} tabIndex={-1}>{title}</h2>
            {status && <div className="mc-section-frame__status">{status}</div>}
          </div>
          {description && <p>{description}</p>}
        </div>
        {actions && <div className="mc-section-frame__actions">{actions}</div>}
      </header>
      {tabs && <div className="mc-section-frame__tabs">{tabs}</div>}
      {toolbar && <div className="mc-section-frame__toolbar">{toolbar}</div>}
      {notices && <div className="mc-section-frame__notices">{notices}</div>}
      <div className="mc-section-frame__content">{children}</div>
    </section>
  )
}

interface PageTabsProps {
  tabs: TabItem[]
  active: string
  onChange: (id: string) => void
  ariaLabel?: string
  idBase?: string
  panelId?: string
}

export function PageTabs({ tabs, active, onChange, ariaLabel, idBase, panelId }: PageTabsProps) {
  return (
    <Tabs
      tabs={tabs}
      active={active}
      onChange={onChange}
      ariaLabel={ariaLabel}
      idBase={idBase}
      panelId={panelId}
    />
  )
}

interface EmptyStateProps {
  title?: string
  description?: string
  icon?: IconName
  action?: ReactNode
}

export function EmptyState({
  title,
  description,
  icon = 'external',
  action,
}: EmptyStateProps) {
  const { t } = useTranslation()
  return (
    <section className="mc-empty-state">
      <div>
        <span className="mc-empty-state__icon"><Icon name={icon} size={22} /></span>
        <p className="mc-empty-state__title">{title ?? t('pageFrame.emptyStateTitle')}</p>
        {description && <p className="mc-empty-state__description">{description}</p>}
        {action && <div className="mt-5 flex justify-center">{action}</div>}
      </div>
    </section>
  )
}
