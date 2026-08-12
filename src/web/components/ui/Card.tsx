import type { HTMLAttributes, ReactNode } from 'react'

interface CardProps extends HTMLAttributes<HTMLElement> {
  density?: 'compact' | 'default'
  as?: 'section' | 'article' | 'div' | 'aside'
}

export function Card({ as: Component = 'section', density = 'default', className = '', ...props }: CardProps) {
  return <Component {...props} className={`mc-card ${className}`.trim()} data-density={density} />
}

interface CardHeaderProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
  headingLevel?: 2 | 3
}

export function CardHeader({ title, description, actions, headingLevel = 3, className = '', ...props }: CardHeaderProps) {
  const Heading = `h${headingLevel}` as const
  return (
    <header {...props} className={`mc-card__header ${className}`.trim()}>
      <div>
        <Heading>{title}</Heading>
        {description && <p>{description}</p>}
      </div>
      {actions && <div>{actions}</div>}
    </header>
  )
}

export function CardBody({ className = '', ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={`mc-card__body ${className}`.trim()} />
}

export function CardFooter({ className = '', ...props }: HTMLAttributes<HTMLElement>) {
  return <footer {...props} className={`mc-card__footer ${className}`.trim()} />
}
