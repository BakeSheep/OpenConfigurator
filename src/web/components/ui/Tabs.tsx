import { useId, useRef, type HTMLAttributes, type KeyboardEvent } from 'react'

export interface TabItem { id: string; label: string; disabled?: boolean }

interface TabsProps {
  tabs: TabItem[]
  active: string
  onChange: (id: string) => void
  ariaLabel?: string
  idBase?: string
  panelId?: string
  className?: string
}

export function tabElementId(idBase: string, tabId: string) {
  return `${idBase}-tab-${tabId}`
}

export function tabPanelElementId(idBase: string, tabId: string) {
  return `${idBase}-panel-${tabId}`
}

export function Tabs({ tabs, active, onChange, ariaLabel, idBase, panelId, className = '' }: TabsProps) {
  const generatedId = useId()
  const refs = useRef<Array<HTMLButtonElement | null>>([])
  const resolvedIdBase = idBase ?? `tabs-${generatedId.replace(/[^a-zA-Z0-9_-]/g, '')}`

  const move = (event: KeyboardEvent<HTMLButtonElement>, currentIndex: number) => {
    const enabled = tabs.map((tab, index) => ({ tab, index })).filter(({ tab }) => !tab.disabled)
    if (enabled.length === 0) return
    const position = Math.max(0, enabled.findIndex(({ index }) => index === currentIndex))
    let nextPosition = position
    if (event.key === 'ArrowRight') nextPosition = (position + 1) % enabled.length
    else if (event.key === 'ArrowLeft') nextPosition = (position - 1 + enabled.length) % enabled.length
    else if (event.key === 'Home') nextPosition = 0
    else if (event.key === 'End') nextPosition = enabled.length - 1
    else return
    event.preventDefault()
    const next = enabled[nextPosition]
    onChange(next.tab.id)
    refs.current[next.index]?.focus()
  }

  return (
    <div className={`mc-tabbar ${className}`.trim()} role="tablist" aria-label={ariaLabel}>
      {tabs.map((tab, index) => {
        const selected = tab.id === active
        const tabId = tabElementId(resolvedIdBase, tab.id)
        return (
          <button
            key={tab.id}
            ref={(node) => { refs.current[index] = node }}
            id={tabId}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={panelId ?? (idBase ? tabPanelElementId(resolvedIdBase, tab.id) : undefined)}
            tabIndex={selected ? 0 : -1}
            data-active={selected}
            className="mc-tab"
            disabled={tab.disabled}
            onKeyDown={(event) => move(event, index)}
            onClick={() => onChange(tab.id)}
          >
            {tab.label}
          </button>
        )
      })}
    </div>
  )
}

interface TabPanelProps extends HTMLAttributes<HTMLDivElement> {
  idBase?: string
  tabId?: string
  activeTabId?: string
}

export function TabPanel({
  idBase,
  tabId,
  activeTabId,
  className = '',
  id,
  tabIndex,
  'aria-labelledby': ariaLabelledBy,
  ...props
}: TabPanelProps) {
  const resolvedTabId = tabId ?? activeTabId
  return (
    <div
      {...props}
      id={id ?? (idBase && resolvedTabId ? tabPanelElementId(idBase, resolvedTabId) : undefined)}
      className={`mc-tabpanel ${className}`.trim()}
      role="tabpanel"
      aria-labelledby={ariaLabelledBy ?? (idBase && resolvedTabId ? tabElementId(idBase, resolvedTabId) : undefined)}
      tabIndex={tabIndex ?? 0}
      data-tab={resolvedTabId}
    />
  )
}
