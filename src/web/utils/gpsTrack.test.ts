import assert from 'node:assert/strict'
import type { GpsData } from '../../shared/types'
import { appendGpsTrackPoint, gpsOffsetMeters, isTrackableGpsFix, projectGpsTrack } from './gpsTrack'

const fix: GpsData = {
  fix_type: 3,
  lat: 31.2304,
  lon: 121.4737,
  alt: 12.5,
  eph: 0.8,
  epv: 1.1,
  vel: 0,
  cog: 0,
  satellites_visible: 14,
}

assert.equal(isTrackableGpsFix({ ...fix, fix_type: 1 }), false)
assert.equal(isTrackableGpsFix(fix), true)

const north = gpsOffsetMeters(fix, { lat: fix.lat + 0.00001, lon: fix.lon })
assert.ok(Math.abs(north.north - 1.113) < 0.01)
assert.ok(Math.abs(north.east) < 0.001)

const acrossDateLine = gpsOffsetMeters(
  { lat: 0, lon: 179.99999 },
  { lat: 0, lon: -179.99999 },
)
assert.ok(acrossDateLine.east > 2 && acrossDateLine.east < 2.3, 'longitude projection must wrap at the date line')

const first = appendGpsTrackPoint([], fix, 1_000)
assert.equal(first.length, 1)
assert.equal(appendGpsTrackPoint(first, { ...fix, lon: fix.lon + 0.00001 }, 1_100).length, 1)
const second = appendGpsTrackPoint(first, { ...fix, lon: fix.lon + 0.00001 }, 1_300)
assert.equal(second.length, 2)
assert.equal(appendGpsTrackPoint(second, { ...fix, lon: fix.lon + 0.00001 }, 1_600).length, 2)

const bounded = appendGpsTrackPoint(second, { ...fix, lon: fix.lon + 0.00002 }, 1_900, 2)
assert.equal(bounded.length, 2)
assert.equal(bounded[0]?.lon, fix.lon + 0.00001)

const projected = projectGpsTrack(second, first[0]!)
assert.equal(projected[0]?.east, 0)
assert.ok((projected[1]?.east ?? 0) > 0)

console.log('GPS track projection and sampling checks passed')
