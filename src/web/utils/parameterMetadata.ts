import type { VehicleIdentity } from '../../shared/types'
import { boardOrientationField, ekfSourceFields, pidGroups } from './parameterProfiles'

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
  ACRO: { label: '特技模式', purpose: '特技模式手感、角速度与油门行为' },
  ADSB: { label: 'ADS-B 避障', purpose: 'ADS-B 交通目标与避让行为' },
  AFS: { label: '高级失效保护', purpose: '高级失效保护与终止条件' },
  AHRS: { label: '姿态航向参考', purpose: '姿态解算、航向参考与机体安装方向' },
  ASPD: { label: '空速', purpose: '空速传感器与空速估计' },
  ATC: { label: '姿态控制', purpose: '姿态和角速度控制器' },
  BAT: { label: '电池', purpose: '电池监测、剩余容量与低电量保护' },
  BAT1: { label: '第二电池', purpose: '第二路电池监测与容量估算' },
  BATT: { label: '电池', purpose: '电池监测、剩余容量与低电量保护' },
  BARO: { label: '气压计', purpose: '气压计选择、补偿与健康检查' },
  BRD: { label: '飞控硬件', purpose: '飞控板级接口与外设' },
  CAL: { label: '传感器校准', purpose: '传感器校准结果与设备标识' },
  CAM: { label: '相机', purpose: '相机触发与反馈' },
  CAN: { label: 'CAN 总线', purpose: 'CAN 接口、节点与外设协议' },
  CBRK: { label: '安全熔断', purpose: '禁用特定安全检查或保护功能' },
  COM: { label: '系统行为', purpose: '解锁、失控保护和飞行器通用行为' },
  COMPASS: { label: '磁罗盘', purpose: '磁罗盘选择、安装、校准与融合' },
  CRUISE: { label: '巡航控制', purpose: '巡航速度、油门与转向行为' },
  EK2: { label: 'EKF2 估计器', purpose: 'ArduPilot EKF2 状态估计' },
  EK3: { label: 'EKF3 估计器', purpose: 'ArduPilot EKF3 状态估计与数据源' },
  EKF2: { label: 'EKF2 估计器', purpose: 'PX4 状态估计、传感器融合与创新检查' },
  FLTMODE: { label: '飞行模式', purpose: '遥控开关对应的飞行模式' },
  FENCE: { label: '地理围栏', purpose: '围栏边界、动作与启用条件' },
  FLOW: { label: '光流', purpose: '光流传感器选择、比例与质量检查' },
  FRAME: { label: '机架', purpose: '机架类型、布局与执行器几何' },
  FS: { label: '失效保护', purpose: '遥控、地面站与传感器失效保护' },
  FW: { label: '固定翼控制', purpose: '固定翼姿态、速度与位置控制' },
  GPS: { label: 'GNSS / GPS', purpose: '卫星导航接收机、协议与质量检查' },
  IMU: { label: '惯性传感器', purpose: '陀螺仪、加速度计与滤波' },
  INS: { label: '惯性导航', purpose: '惯性传感器实例、滤波与校准' },
  LOG: { label: '日志', purpose: '机载日志记录、存储与下载行为' },
  LAND: { label: '降落', purpose: '着陆速度与着陆检测' },
  LND: { label: '降落检测', purpose: '着陆状态检测' },
  MAV: { label: 'MAVLink', purpose: 'MAVLink 实例、模式与转发' },
  MC: { label: '多旋翼控制', purpose: '多旋翼姿态与角速度控制器' },
  MIS: { label: '任务', purpose: '航线任务执行与任务检查' },
  MOT: { label: '电机', purpose: '电机输出、油门曲线与推力模型' },
  MPC: { label: '多旋翼位置控制', purpose: '位置、速度、加速度和起降控制' },
  NAV: { label: '导航', purpose: '航点、返航和导航限制' },
  NTF: { label: '通知', purpose: '蜂鸣器、指示灯与状态提示' },
  OA: { label: '避障', purpose: '避障算法、路径规划与安全距离' },
  PILOT: { label: '飞手输入', purpose: '飞手输入响应、速度与限制' },
  PSC: { label: '位置控制', purpose: 'ArduPilot 位置、速度与加速度控制器' },
  PWM: { label: 'PWM 输出', purpose: '执行器输出通道、频率与限位' },
  RC: { label: '遥控输入', purpose: '遥控通道校准、映射与失控保护' },
  RNGFND: { label: '测距仪', purpose: '测距仪实例、方向与量程' },
  RPM: { label: '转速传感器', purpose: '转速传感器实例、比例与质量' },
  RTL: { label: '返航', purpose: '返航高度、速度和着陆行为' },
  SENS: { label: '传感器', purpose: '传感器选择、方向与板级配置' },
  SER: { label: '串口驱动', purpose: '串行总线与驱动层配置' },
  SERIAL: { label: '串口', purpose: '串口协议与波特率' },
  SERVO: { label: '舵机输出', purpose: '输出功能、限位、反向与故障保护' },
  SDLOG: { label: 'SD 卡日志', purpose: 'PX4 SD 卡日志记录与配置' },
  UXRCE: { label: 'uXRCE-DDS', purpose: 'ROS 2 uXRCE-DDS 客户端与传输' },
  UAVCAN: { label: 'UAVCAN', purpose: 'UAVCAN/DroneCAN 节点与外设配置' },
  SYS: { label: '系统', purpose: '系统标识、启动与运行行为' },
  TERRAIN: { label: '地形', purpose: '地形数据、跟随与安全高度' },
  VISO: { label: '视觉里程计', purpose: '视觉位置、速度与姿态融合' },
  VT: { label: '垂直起降', purpose: 'VTOL 转换与多旋翼阶段控制' },
  VTX: { label: '图传', purpose: '视频发射机频段、频道与功率' },
  WPNAV: { label: '航点导航', purpose: '航点飞行速度、加速度与到达半径' },
}

const WORDS: Record<string, string> = {
  ACC: '加速度', ACCEL: '加速度', ACT: '动作', ANG: '角度', ANGLE: '角度',
  AUTO: '自动', AVG: '平均', AVRG: '平均', BAUD: '波特率', BOARD: '飞控板',
  CAL: '校准', CH: '通道', CHAN: '通道', CHECK: '检查', COMP: '补偿',
  CRIT: '严重低电量', CURR: '电流', CURRENT: '电流', D: '微分增益',
  DELAY: '延时', DN: '下降', ENABLE: '启用', EN: '启用', EMERGEN: '紧急低电量',
  FAIL: '失效保护', FF: '前馈增益', FILT: '滤波', FILTER: '滤波', FREQ: '频率',
  GPS: 'GPS', GYRO: '陀螺仪', HGT: '高度', HOVER: '悬停', I: '积分增益',
  ID: '设备标识', IMAX: '积分限幅', LAND: '着陆', LIM: '限制', LIMIT: '限制',
  LOW: '低值', MAN: '手动', MAX: '最大值', MIN: '最小值', MODE: '模式',
  OFFS: '偏移量', OFFSET: '偏移量', P: '比例增益', PIT: '俯仰', PITCH: '俯仰',
  POS: '位置', PRESS: '压力', PROTOCOL: '协议', RATE: '速率', RLL: '横滚',
  ROLL: '横滚', ROT: '安装方向', SCALE: '比例系数', SENS: '传感器',
  SOURCE: '数据源', SPD: '速度', SPEED: '速度', SRC: '数据源', TEMP: '温度',
  THR: '油门/阈值', THRESH: '阈值', THRESHOLD: '阈值', TIME: '时间',
  TKO: '起飞', TYPE: '类型', UP: '上升', VEL: '速度', VOLT: '电压',
  WEIGHT: '权重', XY: '水平轴', YAW: '偏航', Z: '垂直轴',
}

const CURATED: Record<string, Omit<ParameterMetadata, 'groupLabel' | 'source'>> = {
  BAT_AVRG_CURRENT: {
    title: '飞行期望电池电流', unit: 'A',
    description: '用于初始化飞行中的平均电流估计；该估计会参与剩余飞行时间计算和返航判断。',
  },
  BAT_CRIT_THR: {
    title: '严重低电量阈值', unit: 'norm',
    description: '电量低于此值时报告严重低电量。该值应低于低电量阈值，飞控通常会触发返航。',
  },
  BAT_EMERGEN_THR: {
    title: '紧急低电量阈值', unit: 'norm',
    description: '电量低于此值时报告危险低电量。该值应低于严重低电量阈值，飞控通常会触发降落。',
  },
  BAT_LOW_THR: {
    title: '低电量阈值', unit: 'norm',
    description: '电量低于此值时报告低电量。该值必须高于严重低电量阈值。',
  },
  MPC_THR_HOVER: {
    title: '悬停油门', unit: 'norm',
    description: '飞控估计的稳定悬停油门，用于垂直控制与推力线性化。',
  },
  SENS_BOARD_ROT: {
    title: '飞控安装方向',
    description: '定义飞控板相对机体的旋转方向。设置错误会导致姿态解算错误，修改后需要重启。',
  },
  AHRS_ORIENTATION: {
    title: '飞控安装方向',
    description: '定义飞控板相对机体的旋转方向。设置错误会导致姿态解算错误，修改后需要重启。',
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
    .map((token) => WORDS[token] ?? (/^\d+$/.test(token) ? `实例 ${token}` : token))
  return translated.length > 0 ? translated.join(' · ') : '基础设置'
}

const PROFILE_METADATA_CACHE = new Map<string, Map<string, ParameterMetadata>>()

function profileMetadata(identity: VehicleIdentity | null): Map<string, ParameterMetadata> {
  const cacheKey = identity ? `${identity.family}:${identity.vehicleClass}` : 'unknown'
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
      groupLabel: 'EKF 数据源',
      title: field.label,
      description: field.hint ?? '选择该状态量使用的传感器或外部数据源。',
      source: 'profile',
    })
  }
  const orientation = boardOrientationField(identity)
  if (orientation) {
    result.set(orientation.id, {
      groupLabel: '传感器安装',
      title: orientation.label,
      description: orientation.hint ?? '定义飞控板相对机体的安装方向。',
      source: 'profile',
    })
  }
  PROFILE_METADATA_CACHE.set(cacheKey, result)
  return result
}

export function parameterMetadata(id: string, identity: VehicleIdentity | null): ParameterMetadata {
  const prefix = parameterGroupKey(id)
  const group = GROUPS[prefix] ?? { label: `${prefix} 参数`, purpose: `${prefix} 功能` }
  const curated = CURATED[id]
  if (curated) return { groupLabel: group.label, ...curated, source: 'curated' }

  const profile = profileMetadata(identity).get(id)
  if (profile) return profile

  const title = describeTokens(id)
  const caution = prefix === 'CBRK'
    ? '这是安全熔断参数，写入可能直接关闭保护功能。'
    : `具体范围、枚举值与是否需要重启由当前飞控固件定义。`
  return {
    groupLabel: group.label,
    title,
    description: `属于${group.label}，用于${group.purpose}中的“${title}”设置。${caution}`,
    source: 'inferred',
  }
}

export function parameterSearchText(id: string, identity: VehicleIdentity | null): string {
  const metadata = parameterMetadata(id, identity)
  return `${id} ${metadata.groupLabel} ${metadata.title} ${metadata.description}`.toUpperCase()
}

export function parameterGroupLabel(prefix: string): string {
  return GROUPS[prefix]?.label ?? `${prefix} 参数`
}
