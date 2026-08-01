import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import type { CalibrationSide } from '../../../shared/types'
import AccelOrientationVisual from './AccelOrientationVisual'

const accelMarkup = renderToStaticMarkup(
  <AccelOrientationVisual side="down" label="水平正放" instruction="保持静止" />,
)
assert.match(accelMarkup, /assets\/calibration\/accel-down\.png/)

const sides: CalibrationSide[] = ['down', 'left', 'right', 'front', 'back', 'up']
for (const side of sides) {
  const magMarkup = renderToStaticMarkup(
    <AccelOrientationVisual
      side={side}
      label={side}
      instruction="按箭头方向缓慢旋转"
      usePx4MagRotationImage
    />,
  )
  assert.match(magMarkup, new RegExp(`assets/calibration/px4-mag-${side}\\.png`))
  assert.doesNotMatch(magMarkup, /mc-orientation-visual__rotation/)
}

console.log('AccelOrientationVisual image variant checks passed')
