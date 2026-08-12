import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
} from 'react'
import { useTranslation } from 'react-i18next'

interface ArmSafetyControlProps {
  armed: boolean
  canArm: boolean
  canChangeArmState: boolean
  onArm: () => void
  onDisarm: () => void
  describedBy?: string
  safetyKey: string
}

/**
 * Shared confirmation control for every UI surface that can change the
 * vehicle arm state. A completed gesture only sends a request; the rendered
 * state continues to come from observed vehicle telemetry.
 */
export default function ArmSafetyControl({
  armed,
  canArm,
  canChangeArmState,
  onArm,
  onDisarm,
  describedBy,
  safetyKey,
}: ArmSafetyControlProps) {
  const { t } = useTranslation()
  const [progress, setProgress] = useState(0)
  const [dragging, setDragging] = useState(false)
  const sliderRef = useRef<HTMLButtonElement | null>(null)
  const draggingRef = useRef(false)
  const currentSafetyKeyRef = useRef(safetyKey)
  const gestureSafetyKeyRef = useRef<string | null>(null)
  currentSafetyKeyRef.current = safetyKey
  const enabled = canChangeArmState && (armed || canArm)

  const reset = () => {
    draggingRef.current = false
    gestureSafetyKeyRef.current = null
    setDragging(false)
    setProgress(0)
  }

  useEffect(reset, [armed, canArm, canChangeArmState, safetyKey])

  const commit = () => {
    if (!enabled || gestureSafetyKeyRef.current !== currentSafetyKeyRef.current) {
      reset()
      return
    }
    if (armed) onDisarm()
    else onArm()
    reset()
  }

  const progressFromPointer = (clientX: number) => {
    const rect = sliderRef.current?.getBoundingClientRect()
    if (!rect) return 0
    const thumbCenter = 25
    const travel = Math.max(1, rect.width - thumbCenter * 2)
    return Math.max(0, Math.min(1, (clientX - rect.left - thumbCenter) / travel))
  }

  const startDrag = (event: PointerEvent<HTMLButtonElement>) => {
    if (!enabled) return
    const next = progressFromPointer(event.clientX)
    if (next > 0.18) return
    event.currentTarget.setPointerCapture(event.pointerId)
    draggingRef.current = true
    gestureSafetyKeyRef.current = currentSafetyKeyRef.current
    setDragging(true)
    setProgress(next)
  }

  const moveDrag = (event: PointerEvent<HTMLButtonElement>) => {
    if (!draggingRef.current) return
    if (gestureSafetyKeyRef.current !== currentSafetyKeyRef.current) {
      reset()
      return
    }
    setProgress(progressFromPointer(event.clientX))
  }

  const finishDrag = (event: PointerEvent<HTMLButtonElement>) => {
    if (!draggingRef.current) return
    if (gestureSafetyKeyRef.current !== currentSafetyKeyRef.current) {
      reset()
      return
    }
    const next = progressFromPointer(event.clientX)
    draggingRef.current = false
    setDragging(false)
    if (next >= 0.88) commit()
    else setProgress(0)
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft' && event.key !== 'Home') return
    event.preventDefault()
    if (progress === 0) gestureSafetyKeyRef.current = currentSafetyKeyRef.current
    if (gestureSafetyKeyRef.current !== currentSafetyKeyRef.current) {
      reset()
      return
    }
    const next = event.key === 'Home'
      ? 0
      : Math.max(0, Math.min(1, progress + (event.key === 'ArrowRight' ? 0.2 : -0.2)))
    if (next >= 0.99) commit()
    else setProgress(next)
  }

  if (armed) {
    return (
      <button
        type="button"
        className="mc-arm-emergency-disarm"
        disabled={!canChangeArmState}
        aria-describedby={describedBy}
        onClick={onDisarm}
      >
        {t('flight.disarmNow')}
      </button>
    )
  }

  return (
    <button
      ref={sliderRef}
      type="button"
      role="slider"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(progress * 100)}
      aria-label={armed ? t('topbar.arm.slideToDisarm') : t('topbar.arm.slideToArm')}
      aria-describedby={describedBy}
      className="mc-arm-slider"
      data-armed={armed}
      data-dragging={dragging}
      disabled={!enabled}
      onPointerDown={startDrag}
      onPointerMove={moveDrag}
      onPointerUp={finishDrag}
      onPointerCancel={reset}
      onLostPointerCapture={() => { if (draggingRef.current) reset() }}
      onKeyDown={handleKeyDown}
      style={{
        '--arm-slide-progress': progress,
        '--arm-slide-tone': 'var(--mc-color-info-solid)',
        '--arm-slide-on-tone': 'var(--mc-color-on-info)',
      } as CSSProperties}
    >
      <span className="mc-arm-slider__fill" />
      <i aria-hidden="true">››</i>
    </button>
  )
}
