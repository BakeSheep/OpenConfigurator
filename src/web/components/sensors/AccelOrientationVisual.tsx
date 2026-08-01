import type { CalibrationSide } from '../../../shared/types'

const ORIENTATION_IMAGE: Record<CalibrationSide, string> = {
  down: 'assets/calibration/accel-down.png',
  up: 'assets/calibration/accel-up.png',
  left: 'assets/calibration/accel-left.png',
  right: 'assets/calibration/accel-right.png',
  front: 'assets/calibration/accel-front.png',
  back: 'assets/calibration/accel-back.png',
}

export default function AccelOrientationVisual({
  side,
  label,
  instruction,
  showRotationHint = false,
}: {
  side: CalibrationSide
  label: string
  instruction: string
  showRotationHint?: boolean
}) {
  return (
    <span className="mc-orientation-visual">
      <img
        className="mc-orientation-visual__image"
        src={ORIENTATION_IMAGE[side]}
        alt={`${label}：${instruction}`}
        title={`${label}：${instruction}`}
        draggable={false}
      />
      {showRotationHint && <i className="mc-orientation-visual__rotation" aria-hidden="true" />}
    </span>
  )
}
