import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import AccelOrientationVisual from './AccelOrientationVisual'

const accelMarkup = renderToStaticMarkup(
  <AccelOrientationVisual side="down" label="水平正放" instruction="保持静止" />,
)
assert.doesNotMatch(accelMarkup, /mc-orientation-visual__rotation/)

const magMarkup = renderToStaticMarkup(
  <AccelOrientationVisual
    side="left"
    label="左侧朝下"
    instruction="按箭头方向缓慢旋转"
    showRotationHint
  />,
)
assert.match(magMarkup, /mc-orientation-visual__rotation/)
assert.match(magMarkup, /assets\/calibration\/accel-left\.png/)

console.log('AccelOrientationVisual rotation hint checks passed')
