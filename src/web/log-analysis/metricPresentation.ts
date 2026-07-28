import type { SectionModuleResult } from './types.js'

export interface PresentedMetric {
  id: string
  label: string
  value: string
}

interface MetricDescriptor {
  label: string
  unit?: string
  decimals?: number
  format?: (value: number | string | boolean) => string
}

function duration(value: number | string | boolean): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  if (value < 60) return `${value.toFixed(1).replace(/\.0$/, '')} 秒`
  const minutes = Math.floor(value / 60)
  const seconds = Math.round(value - minutes * 60)
  return `${minutes} 分 ${seconds} 秒`
}

const provenanceNames: Record<string, string> = {
  quaternion: '四元数',
  euler: '欧拉角',
  unavailable: '不可用',
  none: '不可用',
}

const sourceName = (value: number | string | boolean): string => {
  const raw = String(value)
  return provenanceNames[raw] ?? raw
}

const motorLayoutNames: Record<string, string> = {
  'ca-rotor-count': '机架电机数量参数',
  'output-function': '输出功能参数',
  'armed-finite': '解锁期间有效通道推断',
  finite: '有效通道推断',
  none: '未识别',
}

const motorLayoutName = (value: number | string | boolean): string => {
  const raw = String(value)
  return motorLayoutNames[raw] ?? '未知来源'
}
const controlAngles: Record<string, MetricDescriptor> = {
  attitudeProvenance: { label: '姿态数据来源', format: sourceName },
  setpointProvenance: { label: '设定值来源', format: sourceName },
  rollRmsError: { label: '横滚 RMS 误差', unit: '°', decimals: 2 },
  pitchRmsError: { label: '俯仰 RMS 误差', unit: '°', decimals: 2 },
  yawRmsError: { label: '偏航 RMS 误差', unit: '°', decimals: 2 },
  rollP95Error: { label: '横滚 P95 误差', unit: '°', decimals: 2 },
  pitchP95Error: { label: '俯仰 P95 误差', unit: '°', decimals: 2 },
  yawP95Error: { label: '偏航 P95 误差', unit: '°', decimals: 2 },
  rollMaxOvershoot: { label: '横滚最大超调', unit: '°', decimals: 2 },
  pitchMaxOvershoot: { label: '俯仰最大超调', unit: '°', decimals: 2 },
  yawMaxOvershoot: { label: '偏航最大超调', unit: '°', decimals: 2 },
  rollRateRmsError: { label: '横滚角速度 RMS 误差', unit: '°/s', decimals: 2 },
  pitchRateRmsError: { label: '俯仰角速度 RMS 误差', unit: '°/s', decimals: 2 },
  yawRateRmsError: { label: '偏航角速度 RMS 误差', unit: '°/s', decimals: 2 },
  rollRateP95Error: { label: '横滚角速度 P95 误差', unit: '°/s', decimals: 2 },
  pitchRateP95Error: { label: '俯仰角速度 P95 误差', unit: '°/s', decimals: 2 },
  yawRateP95Error: { label: '偏航角速度 P95 误差', unit: '°/s', decimals: 2 },
}

const descriptors: Record<string, Record<string, MetricDescriptor>> = {
  'flight-overview': {
    logDurationSec: { label: '日志时长', format: duration },
    armedDurationSec: { label: '解锁时长', format: duration },
    flightDurationSec: { label: '飞行时长', format: duration },
    vehicleType: { label: '机型' },
    firmwareVersion: { label: '固件版本' },
    hardwareVersion: { label: '硬件版本' },
    logQuality: { label: '日志质量' },
  },
  'control-tracking': controlAngles,
  actuators: {
    motorCount: { label: '已配置电机' },
    motorLayoutSource: { label: '电机布局来源', format: motorLayoutName },
    outputCount: { label: '输出通道' },
  },
  sensors: {
    combinedSamples: { label: '组合传感器采样' },
    accelInstanceCount: { label: '加速度计实例' },
    gyroInstanceCount: { label: '陀螺仪实例' },
    magInstanceCount: { label: '磁力计实例' },
    baroInstanceCount: { label: '气压计实例' },
  },
  failsafe: {
    totalSamples: { label: '故障保护采样' },
    landDetectedSamples: { label: '着陆状态采样' },
    eventCount: { label: '故障保护事件' },
  },
  gps: {
    gpsSamples: { label: 'GPS 采样' },
    maxSatellites: { label: '最大卫星数' },
  },
  events: {
    structuredEventCount: { label: '结构化事件' },
  },
  'system-health': {
    maxCpuLoad: { label: '最大 CPU 负载', unit: '%', decimals: 1 },
    maxRamUsage: { label: '最大内存占用', unit: '%', decimals: 1 },
    sustainedHighCpuSec: { label: '高 CPU 持续时间', format: duration },
  },
  estimator: {
    totalInstances: { label: '估计器实例' },
  },
  battery: {
    minVoltage: { label: '最低电压', unit: 'V', decimals: 2 },
    maxVoltage: { label: '最高电压', unit: 'V', decimals: 2 },
  },
}

function formatValue(value: number | string | boolean, descriptor: MetricDescriptor): string {
  if (descriptor.format) return descriptor.format(value)
  if (typeof value === 'boolean') return value ? '是' : '否'
  if (typeof value !== 'number') return value
  if (!Number.isFinite(value)) return '—'
  const decimals = descriptor.decimals ?? (Number.isInteger(value) ? 0 : 2)
  const rendered = value.toFixed(decimals).replace(/\.0+$/, '')
  return `${rendered}${descriptor.unit ? ` ${descriptor.unit}` : ''}`
}

export function buildSectionMetrics(
  moduleResults: SectionModuleResult[],
  limit = 10,
): PresentedMetric[] {
  const result: PresentedMetric[] = []
  for (const moduleResult of moduleResults) {
    const moduleDescriptors = descriptors[moduleResult.moduleId]
    if (!moduleDescriptors) continue
    for (const [key, value] of Object.entries(moduleResult.metrics)) {
      const descriptor = moduleDescriptors[key]
      if (!descriptor || value == null) continue
      if (typeof value !== 'number' && typeof value !== 'string' && typeof value !== 'boolean') continue
      result.push({
        id: `${moduleResult.moduleId}:${key}`,
        label: descriptor.label,
        value: formatValue(value, descriptor),
      })
      if (result.length >= limit) return result
    }
  }
  return result
}