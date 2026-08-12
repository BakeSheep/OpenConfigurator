import { useEffect, useRef } from 'react'
import { Link, type To } from 'react-router-dom'
import Icon, { type IconName } from '../ui/Icon'

export interface SectionNavItem<SectionId extends string = string> {
  id: SectionId
  label: string
  icon: IconName
  to: To
}

interface SectionNavProps<SectionId extends string = string> {
  ariaLabel: string
  items: Array<SectionNavItem<SectionId>>
  activeId: SectionId
}

/** A compact link-based navigator shared by multi-section workspaces. */
export default function SectionNav<SectionId extends string>({
  ariaLabel,
  items,
  activeId,
}: SectionNavProps<SectionId>) {
  const navRef = useRef<HTMLElement | null>(null)
  const activeRef = useRef<HTMLAnchorElement | null>(null)

  useEffect(() => {
    const nav = navRef.current
    const active = activeRef.current
    if (!nav || !active || nav.scrollWidth <= nav.clientWidth) return
    nav.scrollTo({
      left: Math.max(0, active.offsetLeft - (nav.clientWidth - active.offsetWidth) / 2),
      behavior: 'auto',
    })
  }, [activeId])

  return (
    <nav ref={navRef} className="mc-section-nav" aria-label={ariaLabel}>
      <div className="mc-section-nav__items">
        {items.map((item) => {
          const active = item.id === activeId
          return (
            <Link
              ref={active ? activeRef : undefined}
              key={item.id}
              to={item.to}
              className="mc-section-nav__link"
              data-active={active}
              aria-current={active ? 'page' : undefined}
              title={item.label}
            >
              <span className="mc-section-nav__icon" aria-hidden="true">
                <Icon name={item.icon} size={18} />
              </span>
              <span className="mc-section-nav__label">{item.label}</span>
            </Link>
          )
        })}
      </div>
    </nav>
  )
}

/**
 * Build a section link without discarding unrelated query state. Task tabs
 * belong to the current section, so changing section clears only those keys.
 * The default section is omitted for stable legacy URLs.
 */
export function sectionLocation(
  pathname: string,
  searchParams: URLSearchParams,
  sectionId: string,
  defaultSectionId: string,
): To {
  const next = new URLSearchParams(searchParams)
  const currentSection = searchParams.get('section') ?? defaultSectionId
  if (currentSection !== sectionId) {
    next.delete('tab')
    next.delete('mode')
  }
  if (sectionId === defaultSectionId) next.delete('section')
  else next.set('section', sectionId)

  const search = next.toString()
  return { pathname, search: search ? `?${search}` : '' }
}
