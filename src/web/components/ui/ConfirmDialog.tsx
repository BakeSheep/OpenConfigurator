import { useCallback, useId, useRef, useState, type ReactNode } from 'react'
import { Button } from './Button'
import Dialog from './Dialog'
import Icon from './Icon'

export type ConfirmDialogTone = 'warning' | 'danger'

export interface ConfirmDialogProps {
  open: boolean
  title: string
  consequence: ReactNode
  commitmentLabel: string
  confirmLabel: string
  cancelLabel: string
  closeLabel: string
  onConfirm: () => void
  onCancel: () => void
  details?: ReactNode
  confirmIcon?: ReactNode
  tone?: ConfirmDialogTone
  busy?: boolean
  busyLabel?: string
  /**
   * Identity of the target and object being confirmed. Changing it while the
   * dialog remains open invalidates the previous commitment.
   */
  confirmationKey?: string
}

/**
 * Confirmation flow for consequential actions. The consequence is stated once,
 * while the separate commitment checkbox records an explicit user decision.
 */
export default function ConfirmDialog({
  open,
  title,
  consequence,
  commitmentLabel,
  confirmLabel,
  cancelLabel,
  closeLabel,
  onConfirm,
  onCancel,
  details,
  confirmIcon,
  tone = 'danger',
  busy = false,
  busyLabel,
  confirmationKey = '',
}: ConfirmDialogProps) {
  const consequenceId = useId()
  const commitmentId = useId()
  const openCycleRef = useRef(0)
  const wasOpenRef = useRef(false)
  const confirmStartedRef = useRef(false)
  const [commitment, setCommitment] = useState({ cycle: 0, key: '', checked: false })

  if (open && !wasOpenRef.current) {
    openCycleRef.current += 1
    confirmStartedRef.current = false
  }
  wasOpenRef.current = open
  const committed = commitment.cycle === openCycleRef.current
    && commitment.key === confirmationKey
    && commitment.checked

  const cancel = useCallback(() => {
    if (busy) return
    setCommitment({ cycle: openCycleRef.current, key: confirmationKey, checked: false })
    onCancel()
  }, [busy, confirmationKey, onCancel])

  const confirm = () => {
    if (!committed || busy || confirmStartedRef.current) return
    confirmStartedRef.current = true
    setCommitment({ cycle: openCycleRef.current, key: confirmationKey, checked: false })
    onConfirm()
  }

  return (
    <Dialog
      open={open}
      title={title}
      describedBy={consequenceId}
      closeLabel={closeLabel}
      closeDisabled={busy}
      className={`mc-confirm-dialog mc-confirm-dialog--${tone}`}
      onClose={cancel}
      footer={(
        <>
          <Button data-autofocus tone="quiet" disabled={busy} onClick={cancel}>
            {cancelLabel}
          </Button>
          <Button
            tone={tone === 'danger' ? 'danger' : 'primary'}
            loading={busy}
            disabled={!committed}
            leadingIcon={confirmIcon}
            onClick={confirm}
          >
            {busy ? (busyLabel ?? confirmLabel) : confirmLabel}
          </Button>
        </>
      )}
    >
      <div id={consequenceId} className="mc-confirm-dialog__consequence">
        <Icon name="warning" size={18} aria-hidden="true" />
        <div>{consequence}</div>
      </div>
      {details && <div className="mc-confirm-dialog__details">{details}</div>}
      <label className="mc-confirm-dialog__commitment" htmlFor={commitmentId}>
        <input
          id={commitmentId}
          type="checkbox"
          checked={committed}
          disabled={busy}
          onChange={(event) => setCommitment({
            cycle: openCycleRef.current,
            key: confirmationKey,
            checked: event.target.checked,
          })}
        />
        <span>{commitmentLabel}</span>
      </label>
    </Dialog>
  )
}
