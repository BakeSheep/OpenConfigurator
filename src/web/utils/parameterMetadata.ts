import i18next from 'i18next'
import type { VehicleIdentity } from '../../shared/types'
import { boardOrientationField, ekfSourceFields, pidGroups } from './parameterProfiles'

const t = i18next.t.bind(i18next)

export interface ParameterMetadata {
  groupLabel: string
  title: string
  description: string
  unit?: string
  source: 'curated' | 'profile' | 'inferred'
}

interface GroupMetadata {
  label: string
  purpose: string
}

const GROUPS: Record<string, GroupMetadata> = {
  ACRO: { label: 'metadata.param.group.ACRO.label', purpose: 'metadata.param.group.ACRO.purpose' },
  ADSB: { label: 'metadata.param.group.ADSB.label', purpose: 'metadata.param.group.ADSB.purpose' },
  AFS: { label: 'metadata.param.group.AFS.label', purpose: 'metadata.param.group.AFS.purpose' },
  AHRS: { label: 'metadata.param.group.AHRS.label', purpose: 'metadata.param.group.AHRS.purpose' },
  ASPD: { label: 'metadata.param.group.ASPD.label', purpose: 'metadata.param.group.ASPD.purpose' },
  ATC: { label: 'metadata.param.group.ATC.label', purpose: 'metadata.param.group.ATC.purpose' },
  BAT: { label: 'metadata.param.group.BAT.label', purpose: 'metadata.param.group.BAT.purpose' },
  BAT1: { label: 'metadata.param.group.BAT1.label', purpose: 'metadata.param.group.BAT1.purpose' },
  BATT: { label: 'metadata.param.group.BATT.label', purpose: 'metadata.param.group.BATT.purpose' },
  BARO: { label: 'metadata.param.group.BARO.label', purpose: 'metadata.param.group.BARO.purpose' },
  BRD: { label: 'metadata.param.group.BRD.label', purpose: 'metadata.param.group.BRD.purpose' },
  CAL: { label: 'metadata.param.group.CAL.label', purpose: 'metadata.param.group.CAL.purpose' },
  CAM: { label: 'metadata.param.group.CAM.label', purpose: 'metadata.param.group.CAM.purpose' },
  CAN: { label: 'metadata.param.group.CAN.label', purpose: 'metadata.param.group.CAN.purpose' },
  CBRK: { label: 'metadata.param.group.CBRK.label', purpose: 'metadata.param.group.CBRK.purpose' },
  COM: { label: 'metadata.param.group.COM.label', purpose: 'metadata.param.group.COM.purpose' },
  COMPASS: { label: 'metadata.param.group.COMPASS.label', purpose: 'metadata.param.group.COMPASS.purpose' },
  CRUISE: { label: 'metadata.param.group.CRUISE.label', purpose: 'metadata.param.group.CRUISE.purpose' },
  EK2: { label: 'metadata.param.group.EK2.label', purpose: 'metadata.param.group.EK2.purpose' },
  EK3: { label: 'metadata.param.group.EK3.label', purpose: 'metadata.param.group.EK3.purpose' },
  EKF2: { label: 'metadata.param.group.EKF2.label', purpose: 'metadata.param.group.EKF2.purpose' },
  FLTMODE: { label: 'metadata.param.group.FLTMODE.label', purpose: 'metadata.param.group.FLTMODE.purpose' },
  FENCE: { label: 'metadata.param.group.FENCE.label', purpose: 'metadata.param.group.FENCE.purpose' },
  FLOW: { label: 'metadata.param.group.FLOW.label', purpose: 'metadata.param.group.FLOW.purpose' },
  FRAME: { label: 'metadata.param.group.FRAME.label', purpose: 'metadata.param.group.FRAME.purpose' },
  FS: { label: 'metadata.param.group.FS.label', purpose: 'metadata.param.group.FS.purpose' },
  FW: { label: 'metadata.param.group.FW.label', purpose: 'metadata.param.group.FW.purpose' },
  GPS: { label: 'metadata.param.group.GPS.label', purpose: 'metadata.param.group.GPS.purpose' },
  IMU: { label: 'metadata.param.group.IMU.label', purpose: 'metadata.param.group.IMU.purpose' },
  INS: { label: 'metadata.param.group.INS.label', purpose: 'metadata.param.group.INS.purpose' },
  LOG: { label: 'metadata.param.group.LOG.label', purpose: 'metadata.param.group.LOG.purpose' },
  LAND: { label: 'metadata.param.group.LAND.label', purpose: 'metadata.param.group.LAND.purpose' },
  LND: { label: 'metadata.param.group.LND.label', purpose: 'metadata.param.group.LND.purpose' },
  MAV: { label: 'metadata.param.group.MAV.label', purpose: 'metadata.param.group.MAV.purpose' },
  MC: { label: 'metadata.param.group.MC.label', purpose: 'metadata.param.group.MC.purpose' },
  MIS: { label: 'metadata.param.group.MIS.label', purpose: 'metadata.param.group.MIS.purpose' },
  MOT: { label: 'metadata.param.group.MOT.label', purpose: 'metadata.param.group.MOT.purpose' },
  MPC: { label: 'metadata.param.group.MPC.label', purpose: 'metadata.param.group.MPC.purpose' },
  NAV: { label: 'metadata.param.group.NAV.label', purpose: 'metadata.param.group.NAV.purpose' },
  NTF: { label: 'metadata.param.group.NTF.label', purpose: 'metadata.param.group.NTF.purpose' },
  OA: { label: 'metadata.param.group.OA.label', purpose: 'metadata.param.group.OA.purpose' },
  PILOT: { label: 'metadata.param.group.PILOT.label', purpose: 'metadata.param.group.PILOT.purpose' },
  PSC: { label: 'metadata.param.group.PSC.label', purpose: 'metadata.param.group.PSC.purpose' },
  PWM: { label: 'metadata.param.group.PWM.label', purpose: 'metadata.param.group.PWM.purpose' },
  RC: { label: 'metadata.param.group.RC.label', purpose: 'metadata.param.group.RC.purpose' },
  RNGFND: { label: 'metadata.param.group.RNGFND.label', purpose: 'metadata.param.group.RNGFND.purpose' },
  RPM: { label: 'metadata.param.group.RPM.label', purpose: 'metadata.param.group.RPM.purpose' },
  RTL: { label: 'metadata.param.group.RTL.label', purpose: 'metadata.param.group.RTL.purpose' },
  SENS: { label: 'metadata.param.group.SENS.label', purpose: 'metadata.param.group.SENS.purpose' },
  SER: { label: 'metadata.param.group.SER.label', purpose: 'metadata.param.group.SER.purpose' },
  SERIAL: { label: 'metadata.param.group.SERIAL.label', purpose: 'metadata.param.group.SERIAL.purpose' },
  SERVO: { label: 'metadata.param.group.SERVO.label', purpose: 'metadata.param.group.SERVO.purpose' },
  SDLOG: { label: 'metadata.param.group.SDLOG.label', purpose: 'metadata.param.group.SDLOG.purpose' },
  UXRCE: { label: 'metadata.param.group.UXRCE.label', purpose: 'metadata.param.group.UXRCE.purpose' },
  UAVCAN: { label: 'metadata.param.group.UAVCAN.label', purpose: 'metadata.param.group.UAVCAN.purpose' },
  SYS: { label: 'metadata.param.group.SYS.label', purpose: 'metadata.param.group.SYS.purpose' },
  TERRAIN: { label: 'metadata.param.group.TERRAIN.label', purpose: 'metadata.param.group.TERRAIN.purpose' },
  VISO: { label: 'metadata.param.group.VISO.label', purpose: 'metadata.param.group.VISO.purpose' },
  VT: { label: 'metadata.param.group.VT.label', purpose: 'metadata.param.group.VT.purpose' },
  VTX: { label: 'metadata.param.group.VTX.label', purpose: 'metadata.param.group.VTX.purpose' },
  WPNAV: { label: 'metadata.param.group.WPNAV.label', purpose: 'metadata.param.group.WPNAV.purpose' },
}

const WORDS: Record<string, string> = {
  ACC: 'metadata.param.word.ACC', ACCEL: 'metadata.param.word.ACCEL', ACT: 'metadata.param.word.ACT',
  ANG: 'metadata.param.word.ANG', ANGLE: 'metadata.param.word.ANGLE',
  AUTO: 'metadata.param.word.AUTO', AVG: 'metadata.param.word.AVG', AVRG: 'metadata.param.word.AVRG',
  BAUD: 'metadata.param.word.BAUD', BOARD: 'metadata.param.word.BOARD',
  CAL: 'metadata.param.word.CAL', CH: 'metadata.param.word.CH', CHAN: 'metadata.param.word.CHAN',
  CHECK: 'metadata.param.word.CHECK', COMP: 'metadata.param.word.COMP',
  CRIT: 'metadata.param.word.CRIT', CURR: 'metadata.param.word.CURR', CURRENT: 'metadata.param.word.CURRENT',
  D: 'metadata.param.word.D',
  DELAY: 'metadata.param.word.DELAY', DN: 'metadata.param.word.DN', ENABLE: 'metadata.param.word.ENABLE',
  EN: 'metadata.param.word.EN', EMERGEN: 'metadata.param.word.EMERGEN',
  FAIL: 'metadata.param.word.FAIL', FF: 'metadata.param.word.FF', FILT: 'metadata.param.word.FILT',
  FILTER: 'metadata.param.word.FILTER', FREQ: 'metadata.param.word.FREQ',
  GPS: 'metadata.param.word.GPS', GYRO: 'metadata.param.word.GYRO', HGT: 'metadata.param.word.HGT',
  HOVER: 'metadata.param.word.HOVER', I: 'metadata.param.word.I',
  ID: 'metadata.param.word.ID', IMAX: 'metadata.param.word.IMAX', LAND: 'metadata.param.word.LAND',
  LIM: 'metadata.param.word.LIM', LIMIT: 'metadata.param.word.LIMIT',
  LOW: 'metadata.param.word.LOW', MAN: 'metadata.param.word.MAN', MAX: 'metadata.param.word.MAX',
  MIN: 'metadata.param.word.MIN', MODE: 'metadata.param.word.MODE',
  OFFS: 'metadata.param.word.OFFS', OFFSET: 'metadata.param.word.OFFSET', P: 'metadata.param.word.P',
  PIT: 'metadata.param.word.PIT', PITCH: 'metadata.param.word.PITCH',
  POS: 'metadata.param.word.POS', PRESS: 'metadata.param.word.PRESS', PROTOCOL: 'metadata.param.word.PROTOCOL',
  RATE: 'metadata.param.word.RATE', RLL: 'metadata.param.word.RLL',
  ROLL: 'metadata.param.word.ROLL', ROT: 'metadata.param.word.ROT', SCALE: 'metadata.param.word.SCALE',
  SENS: 'metadata.param.word.SENS',
  SOURCE: 'metadata.param.word.SOURCE', SPD: 'metadata.param.word.SPD', SPEED: 'metadata.param.word.SPEED',
  SRC: 'metadata.param.word.SRC', TEMP: 'metadata.param.word.TEMP',
  THR: 'metadata.param.word.THR', THRESH: 'metadata.param.word.THRESH', THRESHOLD: 'metadata.param.word.THRESHOLD',
  TIME: 'metadata.param.word.TIME',
  TKO: 'metadata.param.word.TKO', TYPE: 'metadata.param.word.TYPE', UP: 'metadata.param.word.UP',
  VEL: 'metadata.param.word.VEL', VOLT: 'metadata.param.word.VOLT',
  WEIGHT: 'metadata.param.word.WEIGHT', XY: 'metadata.param.word.XY', YAW: 'metadata.param.word.YAW',
  Z: 'metadata.param.word.Z',
}

const CURATED: Record<string, Omit<ParameterMetadata, 'groupLabel' | 'source'>> = {
  BAT_AVRG_CURRENT: {
    title: 'metadata.param.curated.BAT_AVRG_CURRENT.title', unit: 'A',
    description: 'metadata.param.curated.BAT_AVRG_CURRENT.description',
  },
  BAT_CRIT_THR: {
    title: 'metadata.param.curated.BAT_CRIT_THR.title', unit: 'norm',
    description: 'metadata.param.curated.BAT_CRIT_THR.description',
  },
  BAT_EMERGEN_THR: {
    title: 'metadata.param.curated.BAT_EMERGEN_THR.title', unit: 'norm',
    description: 'metadata.param.curated.BAT_EMERGEN_THR.description',
  },
  BAT_LOW_THR: {
    title: 'metadata.param.curated.BAT_LOW_THR.title', unit: 'norm',
    description: 'metadata.param.curated.BAT_LOW_THR.description',
  },
  MPC_THR_HOVER: {
    title: 'metadata.param.curated.MPC_THR_HOVER.title', unit: 'norm',
    description: 'metadata.param.curated.MPC_THR_HOVER.description',
  },
  SENS_BOARD_ROT: {
    title: 'metadata.param.curated.SENS_BOARD_ROT.title',
    description: 'metadata.param.curated.SENS_BOARD_ROT.description',
  },
  AHRS_ORIENTATION: {
    title: 'metadata.param.curated.AHRS_ORIENTATION.title',
    description: 'metadata.param.curated.AHRS_ORIENTATION.description',
  },
}

export function parameterGroupKey(id: string): string {
  const [first = id] = id.split('_')
  if (/^SERIAL\d+$/.test(first)) return 'SERIAL'
  if (/^FLTMODE\d+$/.test(first)) return 'FLTMODE'
  if (/^RC\d+$/.test(first)) return 'RC'
  if (/^SERVO\d+$/.test(first)) return 'SERVO'
  if (/^COMPASS\d+$/.test(first)) return 'COMPASS'
  if (/^RNGFND\d+$/.test(first)) return 'RNGFND'
  if (/^BARO\d+$/.test(first)) return 'BARO'
  if (/^BATT\d+$/.test(first)) return 'BATT'
  // New firmware families sometimes introduce another numbered instance
  // before the GCS knows its semantics. Group those instances together while
  // preserving well-known numeric families such as EK2/EK3 and BAT1.
  if (!GROUPS[first]) return first.replace(/\d+$/, '') || first
  return first
}

function describeTokens(id: string): string {
  const translated = id
    .split('_')
    .slice(1)
    .map((token) => {
      const key = WORDS[token]
      return key ? t(key) : (/^\d+$/.test(token) ? t('metadata.param.instance', { n: token }) : token)
    })
  return translated.length > 0 ? translated.join(' · ') : t('metadata.param.basicSettings')
}

const PROFILE_METADATA_CACHE = new Map<string, Map<string, ParameterMetadata>>()

function profileMetadata(identity: VehicleIdentity | null): Map<string, ParameterMetadata> {
  // Key the cache by language so a language switch rebuilds translated values.
  const cacheKey = `${i18next.language ?? 'zh'}:${identity ? `${identity.family}:${identity.vehicleClass}` : 'unknown'}`
  const cached = PROFILE_METADATA_CACHE.get(cacheKey)
  if (cached) return cached
  const result = new Map<string, ParameterMetadata>()
  for (const group of pidGroups(identity)) {
    for (const field of group.params) {
      result.set(field.id, {
        groupLabel: group.title,
        title: field.label,
        description: field.hint,
        ...(field.unit ? { unit: field.unit } : {}),
        source: 'profile',
      })
    }
  }
  for (const field of ekfSourceFields(identity)) {
    result.set(field.id, {
      groupLabel: t('metadata.param.ekfSourceGroup'),
      title: field.label,
      description: field.hint ?? t('metadata.param.ekfSourceDefaultHint'),
      source: 'profile',
    })
  }
  const orientation = boardOrientationField(identity)
  if (orientation) {
    result.set(orientation.id, {
      groupLabel: t('metadata.param.sensorMountGroup'),
      title: orientation.label,
      description: orientation.hint ?? t('metadata.param.sensorMountDefaultHint'),
      source: 'profile',
    })
  }
  PROFILE_METADATA_CACHE.set(cacheKey, result)
  return result
}

export function parameterMetadata(id: string, identity: VehicleIdentity | null): ParameterMetadata {
  const prefix = parameterGroupKey(id)
  const groupMeta = GROUPS[prefix]
  const group = groupMeta
    ? { label: t(groupMeta.label), purpose: t(groupMeta.purpose) }
    : { label: t('metadata.param.fallbackGroupLabel', { prefix }), purpose: t('metadata.param.fallbackGroupPurpose', { prefix }) }
  const curated = CURATED[id]
  if (curated) {
    return {
      groupLabel: group.label,
      title: t(curated.title),
      description: t(curated.description),
      ...(curated.unit ? { unit: curated.unit } : {}),
      source: 'curated',
    }
  }

  const profile = profileMetadata(identity).get(id)
  if (profile) return profile

  const title = describeTokens(id)
  const caution = prefix === 'CBRK'
    ? t('metadata.param.cbrkCaution')
    : t('metadata.param.generalCaution')
  return {
    groupLabel: group.label,
    title,
    description: t('metadata.param.inferredDescription', { groupLabel: group.label, groupPurpose: group.purpose, title, caution }),
    source: 'inferred',
  }
}

export function parameterSearchText(id: string, identity: VehicleIdentity | null): string {
  const metadata = parameterMetadata(id, identity)
  return `${id} ${metadata.groupLabel} ${metadata.title} ${metadata.description}`.toUpperCase()
}

export function parameterGroupLabel(prefix: string): string {
  const group = GROUPS[prefix]
  return group ? t(group.label) : t('metadata.param.fallbackGroupLabel', { prefix })
}
