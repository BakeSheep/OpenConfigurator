import type { ButtonHTMLAttributes, ReactNode } from 'react'

export type ButtonTone = 'primary' | 'secondary' | 'quiet' | 'success' | 'danger'
export type ButtonSize = 'compact' | 'default' | 'prominent'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  tone?: ButtonTone
  size?: ButtonSize
  loading?: boolean
  leadingIcon?: ReactNode
}

export function Button({
  tone = 'secondary',
  size = 'compact',
  loading = false,
  leadingIcon,
  className = '',
  disabled,
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      type={props.type ?? 'button'}
      className={`mc-button ${className}`.trim()}
      data-tone={tone}
      data-size={size}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
    >
      {leadingIcon}
      <span>{children}</span>
    </button>
  )
}

type IconButtonProps = Omit<ButtonProps, 'children' | 'leadingIcon'> & {
  label: string
  icon: ReactNode
}

export function IconButton({ label, icon, className = '', ...props }: IconButtonProps) {
  return (
    <Button
      {...props}
      className={`mc-icon-btn ${className}`.trim()}
      aria-label={label}
      title={props.title ?? label}
    >
      <span aria-hidden="true">{icon}</span>
    </Button>
  )
}
