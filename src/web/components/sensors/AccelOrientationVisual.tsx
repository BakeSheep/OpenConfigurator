import type { CalibrationSide } from '../../../shared/types'

const ORIENTATION_IMAGE: Record<CalibrationSide, string> = {
  down: 'assets/calibration/accel-down.png',
  up: 'assets/calibration/accel-up.png',
  left: 'assets/calibration/accel-left.png',
  right: 'assets/calibration/accel-right.png',
  front: 'assets/calibration/accel-front.png',
  back: 'assets/calibration/accel-back.png',
}

const PX4_MAG_ROTATION_IMAGE: Record<CalibrationSide, string> = {
  down: 'assets/calibration/px4-mag-down.png',
  up: 'assets/calibration/px4-mag-up.png',
  left: 'assets/calibration/px4-mag-left.png',
  right: 'assets/calibration/px4-mag-right.png',
  front: 'assets/calibration/px4-mag-front.png',
  back: 'assets/calibration/px4-mag-back.png',
}

export default function AccelOrientationVisual({
  side,
  label,
  instruction,
  usePx4MagRotationImage = false,
}: {
  side: CalibrationSide
  label: string
  instruction: string
  usePx4MagRotationImage?: boolean
}) {
  const image = usePx4MagRotationImage ? PX4_MAG_ROTATION_IMAGE[side] : ORIENTATION_IMAGE[side]

  return (
    <span className="mc-orientation-visual">
      <img
        className="mc-orientation-visual__image"
        src={image}
        alt={`${label}：${instruction}`}
        title={`${label}：${instruction}`}
        draggable={false}
      />
    </span>
  )
}
