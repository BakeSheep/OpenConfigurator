import { useId, type ReactNode } from 'react'

interface FieldProps {
  label: string
  children: ReactNode
  controlId?: string
  helper?: string
  error?: string
  required?: boolean
  className?: string
}

/**
 * Form field anatomy. Controls should use the supplied helperId/errorId as
 * aria-describedby when the browser control is built outside this component.
 */
export default function Field({ label, children, controlId, helper, error, required, className = '' }: FieldProps) {
  const generatedId = useId()
  const id = controlId ?? generatedId
  return (
    <div className={`mc-field ${className}`.trim()} data-invalid={Boolean(error) || undefined}>
      <label className="mc-field__label" htmlFor={id}>
        {label}{required && <span className="mc-field__required" aria-hidden="true">*</span>}
      </label>
      {children}
      {helper && <p id={`${id}-helper`} className="mc-field__helper">{helper}</p>}
      {error && <p id={`${id}-error`} className="mc-field__error" role="alert">{error}</p>}
    </div>
  )
}
