import type { GpsData } from '../../shared/types'

const EARTH_RADIUS_METERS = 6_378_137
const DEFAULT_MAX_POINTS = 600
const DEFAULT_MIN_INTERVAL_MS = 250

export interface GpsTrackPoint {
  lat: number
  lon: number
  alt: number
  capturedAt: number
}

export interface LocalGpsPoint extends GpsTrackPoint {
  east: number
  north: number
}

export type GpsTrackOrigin = Pick<GpsTrackPoint, 'lat' | 'lon'>

const toRadians = (degrees: number) => degrees * Math.PI / 180

const wrappedLongitudeDelta = (longitude: number, originLongitude: number): number => {
  const delta = longitude - originLongitude
  return ((delta + 540) % 360) - 180
}

export const isTrackableGpsFix = (gps: GpsData | null): gps is GpsData => Boolean(
  gps
  && gps.fix_type >= 2
  && Number.isFinite(gps.lat)
  && Number.isFinite(gps.lon)
  && Math.abs(gps.lat) <= 90
  && Math.abs(gps.lon) <= 180,
)

/** Convert WGS84 coordinates to a small local tangent plane around origin. */
export const gpsOffsetMeters = (
  origin: GpsTrackOrigin,
  point: Pick<GpsTrackPoint, 'lat' | 'lon'>,
): Pick<LocalGpsPoint, 'east' | 'north'> => {
  const latitudeDelta = toRadians(point.lat - origin.lat)
  const longitudeDelta = toRadians(wrappedLongitudeDelta(point.lon, origin.lon))
  const meanLatitude = toRadians((point.lat + origin.lat) / 2)
  return {
    east: longitudeDelta * Math.cos(meanLatitude) * EARTH_RADIUS_METERS,
    north: latitudeDelta * EARTH_RADIUS_METERS,
  }
}

export const projectGpsTrack = (
  points: readonly GpsTrackPoint[],
  origin: GpsTrackOrigin | null,
): LocalGpsPoint[] => {
  if (!origin) return []
  return points.map((point) => ({ ...point, ...gpsOffsetMeters(origin, point) }))
}

/** Append one valid GPS frame while bounding memory and high-rate duplicates. */
export const appendGpsTrackPoint = (
  points: GpsTrackPoint[],
  gps: GpsData | null,
  capturedAt = Date.now(),
  maxPoints = DEFAULT_MAX_POINTS,
  minIntervalMs = DEFAULT_MIN_INTERVAL_MS,
): GpsTrackPoint[] => {
  if (!isTrackableGpsFix(gps) || maxPoints <= 0) return points
  const last = points[points.length - 1]
  if (last && capturedAt - last.capturedAt < minIntervalMs) return points
  if (last && last.lat === gps.lat && last.lon === gps.lon && last.alt === gps.alt) return points
  const next = [...points, { lat: gps.lat, lon: gps.lon, alt: gps.alt, capturedAt }]
  return next.slice(-maxPoints)
}
