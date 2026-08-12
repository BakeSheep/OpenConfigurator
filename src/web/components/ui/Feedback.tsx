import type { HTMLAttributes, ReactNode } from 'react'
import Icon, { type IconName } from './Icon'

export type FeedbackTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: FeedbackTone | 'accent'
}

export function Badge({ tone = 'neutral', className = '', ...props }: BadgeProps) {
  return <span {...props} className={`mc-badge ${className}`.trim()} data-tone={tone} />
}

interface NoticeProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  tone?: FeedbackTone
  title?: ReactNode
  icon?: IconName
  actions?: ReactNode
}

const noticeIcons: Record<FeedbackTone, IconName> = {
  neutral: 'message',
  info: 'message',
  success: 'check',
  warning: 'warning',
  danger: 'warning',
}

export function Notice({
  tone = 'neutral',
  title,
  icon = noticeIcons[tone],
  actions,
  children,
  className = '',
  ...props
}: NoticeProps) {
  const liveRole = tone === 'danger' ? 'alert' : 'status'
  return (
    <section {...props} className={`mc-notice ${className}`.trim()} data-tone={tone} role={props.role ?? liveRole}>
      <Icon name={icon} size={16} aria-hidden="true" />
      <div className="mc-notice__content">
        {title && <strong>{title}</strong>}
        {children && <p>{children}</p>}
      </div>
      {actions}
    </section>
  )
}
