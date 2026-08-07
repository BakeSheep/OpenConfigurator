import i18next from 'i18next'
import type { GpsData } from '../../shared/types'

const t = i18next.t.bind(i18next)

const GPS_FIX_KEYS = [
  'sensor.gps.fix.noGps',
  'sensor.gps.fix.noFix',
  'sensor.gps.fix.fix2D',
  'sensor.gps.fix.fix3D',
  'sensor.gps.fix.dgps',
  'sensor.gps.fix.rtkFloat',
  'sensor.gps.fix.rtkFixed',
  'sensor.gps.fix.static',
  'sensor.gps.fix.ppp',
] as const

export const gpsFixLabel = (fixType: number | null | undefined): string => {
  if (fixType == null || !Number.isFinite(fixType)) return t('sensor.gps.fix.noData')
  const key = GPS_FIX_KEYS[fixType]
  return key ? t(key) : t('sensor.gps.fix.unknownType', { type: fixType })
}

export const gpsHasPosition = (gps: GpsData | null): boolean => Boolean(gps && gps.fix_type >= 2)

export const formatGpsCoordinate = (value: number | null | undefined): string =>
  value == null || !Number.isFinite(value) ? '—' : value.toFixed(7)
