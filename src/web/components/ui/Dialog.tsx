import { useEffect, useId, useRef, type MouseEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import Icon from './Icon'

interface DialogProps {
  open: boolean
  title: string
  description?: string
  describedBy?: string
  children: ReactNode
  footer?: ReactNode
  onClose: () => void
  closeLabel: string
  closeDisabled?: boolean
  className?: string
}

const focusableSelector = [
  '[data-autofocus]:not([disabled])','button:not([disabled])','a[href]','input:not([disabled])',
  'select:not([disabled])','textarea:not([disabled])','[tabindex]:not([tabindex="-1"])',
].join(',')

export default function Dialog({
  open,
  title,
  description,
  describedBy,
  children,
  footer,
  onClose,
  closeLabel,
  closeDisabled = false,
  className = '',
}: DialogProps) {
  const titleId = useId()
  const descriptionId = useId()
  const panelRef = useRef<HTMLDivElement>(null)
  const restoreFocusRef = useRef<HTMLElement | null>(null)
  const onCloseRef = useRef(onClose)
  const closeDisabledRef = useRef(closeDisabled)

  useEffect(() => {
    onCloseRef.current = onClose
    closeDisabledRef.current = closeDisabled
  }, [closeDisabled, onClose])

  useEffect(() => {
    if (!open) return
    restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const frame = window.requestAnimationFrame(() => {
      const preferred = panelRef.current?.querySelector<HTMLElement>('[data-autofocus]:not([disabled])')
      const first = preferred ?? panelRef.current?.querySelector<HTMLElement>(focusableSelector)
      first?.focus()
    })

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (closeDisabledRef.current) return
        event.preventDefault()
        onCloseRef.current()
        return
      }
      if (event.key !== 'Tab') return
      const focusable = [...(panelRef.current?.querySelectorAll<HTMLElement>(focusableSelector) ?? [])]
        .filter((element) => !element.hidden && element.getAttribute('aria-hidden') !== 'true')
      if (focusable.length === 0) {
        event.preventDefault()
        panelRef.current?.focus()
        return
      }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      window.cancelAnimationFrame(frame)
      document.removeEventListener('keydown', handleKeyDown)
      restoreFocusRef.current?.focus()
    }
  }, [open])

  if (!open) return null

  const closeBackdrop = (event: MouseEvent<HTMLDivElement>) => {
    if (!closeDisabled && event.target === event.currentTarget) onClose()
  }

  return createPortal(
    <div className="mc-dialog-backdrop" onMouseDown={closeBackdrop}>
      <div
        ref={panelRef}
        className={`mc-dialog ${className}`.trim()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : describedBy}
        tabIndex={-1}
      >
        <header className="mc-dialog__header">
          <div>
            <h2 id={titleId}>{title}</h2>
            {description && <p id={descriptionId}>{description}</p>}
          </div>
          <button
            type="button"
            className="mc-icon-btn"
            aria-label={closeLabel}
            disabled={closeDisabled}
            onClick={onClose}
          >
            <Icon name="close" size={17} />
          </button>
        </header>
        <div className="mc-dialog__body">{children}</div>
        {footer && <footer className="mc-dialog__footer">{footer}</footer>}
      </div>
    </div>,
    document.body,
  )
}
