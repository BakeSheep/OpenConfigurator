import type { GpsData } from '../../shared/types'

const GPS_FIX_LABELS = [
  '无 GPS',
  '无定位',
  '2D 定位',
  '3D 定位',
  'DGPS',
  'RTK 浮点解',
  'RTK 固定解',
  '静态定位',
  'PPP',
] as const

export const gpsFixLabel = (fixType: number | null | undefined): string => {
  if (fixType == null || !Number.isFinite(fixType)) return '无数据'
  return GPS_FIX_LABELS[fixType] ?? `定位类型 ${fixType}`
}

export const gpsHasPosition = (gps: GpsData | null): boolean => Boolean(gps && gps.fix_type >= 2)

export const formatGpsCoordinate = (value: number | null | undefined): string =>
  value == null || !Number.isFinite(value) ? '—' : value.toFixed(7)
