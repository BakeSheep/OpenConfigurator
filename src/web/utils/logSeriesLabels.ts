import type { TFunction } from 'i18next'
import type { SeriesData } from './ulogAnalysis'

const SERIES_LABEL_KEYS: Record<string, string> = {
  'attitude.roll': 'logAnalysis.label.roll',
  'attitude.rollSp': 'logAnalysis.label.rollSp',
  'attitude.pitch': 'logAnalysis.label.pitch',
  'attitude.pitchSp': 'logAnalysis.label.pitchSp',
  'attitude.yaw': 'logAnalysis.label.yaw',
  'attitude.yawSp': 'logAnalysis.label.yawSp',
  'rates.roll': 'logAnalysis.label.rollRate',
  'rates.rollSp': 'logAnalysis.label.rollRateSp',
  'rates.pitch': 'logAnalysis.label.pitchRate',
  'rates.pitchSp': 'logAnalysis.label.pitchRateSp',
  'rates.yaw': 'logAnalysis.label.yawRate',
  'rates.yawSp': 'logAnalysis.label.yawRateSp',
  'battery.voltage': 'logAnalysis.label.voltage',
  'battery.current': 'logAnalysis.label.current',
  'battery.power': 'logAnalysis.label.power',
  'gps.satellites': 'logAnalysis.label.satellites',
  'gps.hdop': 'logAnalysis.label.hdop',
  'gps.vdop': 'logAnalysis.label.vdop',
  'gps.fix': 'logAnalysis.label.fix',
  'altitude.relative': 'logAnalysis.label.relAlt',
  'altitude.baro': 'logAnalysis.label.baroAlt',
  'altitude.gps': 'logAnalysis.label.gpsAlt',
  'velocity.north': 'logAnalysis.label.velNorth',
  'velocity.east': 'logAnalysis.label.velEast',
  'velocity.down': 'logAnalysis.label.vz',
  'velocity.ground': 'logAnalysis.label.groundSpeed',
  'rawAccel.x': 'logAnalysis.label.accelX',
  'rawAccel.y': 'logAnalysis.label.accelY',
  'rawAccel.z': 'logAnalysis.label.accelZ',
}

const LOOP_LABEL_KEYS: Record<string, string> = {
  roll: 'common.roll',
  pitch: 'common.pitch',
  yaw: 'common.yaw',
}

export function logLoopLabel(id: string, fallback: string, t: TFunction): string {
  const key = LOOP_LABEL_KEYS[id]
  return key ? t(key) : fallback
}

export function logSeriesLabel(series: SeriesData, t: TFunction): string {
  const key = SERIES_LABEL_KEYS[series.id]
  if (key) return t(key)

  const motorMatch = /^actuator\.motor(Us)?:([1-9]\d*)$/.exec(series.id)
  if (motorMatch) {
    return t(motorMatch[1] ? 'logAnalysis.label.motorUs' : 'logAnalysis.label.motor', {
      channel: Number(motorMatch[2]),
    })
  }

  const pidMatch = /^pid:([^:]+):(target|actual|error)$/.exec(series.id)
  if (pidMatch) {
    const loopLabel = logLoopLabel(pidMatch[1], series.label.split(' ')[0] || pidMatch[1], t)
    return t(`logAnalysis.label.${pidMatch[2]}`, { label: loopLabel })
  }

  return series.label
}

export function localizeLogSeries(series: readonly SeriesData[], t: TFunction): SeriesData[] {
  return series.map((entry) => ({ ...entry, label: logSeriesLabel(entry, t) }))
}
