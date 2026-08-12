import type { HTMLAttributes, ReactNode } from 'react'

interface ToolbarProps extends HTMLAttributes<HTMLDivElement> {
  summary?: ReactNode
  actions?: ReactNode
}

/** Compact task context plus actions. Use after the active section heading. */
export default function Toolbar({ summary, actions, children, className = '', ...props }: ToolbarProps) {
  const actionContent = actions ?? children
  return (
    <div {...props} className={`mc-toolbar ${className}`.trim()}>
      {summary && <div className="mc-toolbar__summary">{summary}</div>}
      {actionContent && <div className="mc-toolbar__actions">{actionContent}</div>}
    </div>
  )
}
