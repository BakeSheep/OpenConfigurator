import assert from 'node:assert/strict'
import { initI18n } from '../i18n/config'
import { formatGpsCoordinate, gpsFixLabel, gpsHasPosition } from './gpsTelemetry'

initI18n('zh')

assert.equal(gpsFixLabel(0), '无 GPS')
assert.equal(gpsFixLabel(3), '3D 定位')
assert.equal(gpsFixLabel(6), 'RTK 固定解')
assert.equal(gpsFixLabel(null), '无数据')

assert.equal(gpsHasPosition(null), false)
assert.equal(gpsHasPosition({
  fix_type: 2,
  lat: 31.2304,
  lon: 121.4737,
  alt: 10,
  eph: null,
  epv: null,
  vel: null,
  cog: null,
  satellites_visible: 8,
}), true)

assert.equal(formatGpsCoordinate(31.2304), '31.2304000')
assert.equal(formatGpsCoordinate(Number.NaN), '—')

console.log('GPS telemetry presentation checks passed')
