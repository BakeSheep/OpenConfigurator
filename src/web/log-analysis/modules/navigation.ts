import type { AnalysisModule, AnalysisContext, ResolvedSample, ModuleResult } from '../engine/AnalysisModule.js'
import type { ChartFamily, ChartView, ChartSeries, DiagnosticFinding, DiagnosticEvidence } from '../types.js'

// ─── State ──────────────────────────────────────────────────────────────────

interface GpsInstanceState {
  fixTypes: Array<{ time: number; value: number }>
  satellites: Array<{ time: number; value: number }>
  ephs: Array<{ time: number; value: number }>
  epvs: Array<{ time: number; value: number }>
  sampleCount: number
  maxSatellites: number
  minFixType: number
  minEph: number
  maxEph: number
  minEpv: number
  maxEpv: number
}

interface NavState {
  gpsInstances: Map<number, GpsInstanceState>
  globalPosition: { sampleCount: number; lat: number; lon: number; alt: number } | null
  localPosition: { sampleCount: number; x: number; y: number; z: number } | null
  airData: { sampleCount: number; indicatedAirspeed: number | null; trueAirspeed: number | null; baroAlt: number | null } | null
  wind: { sampleCount: number; samples: Array<{ timeSec: number; speed: number }> } | null
  opticalFlow: { sampleCount: number; qualitySum: number; qualityCount: number } | null
  distanceSensor: { sampleCount: number; distances: number[]; qualitySum: number; qualityCount: number } | null
}

// ─── Result ─────────────────────────────────────────────────────────────────

interface GpsInstanceMetrics {
  instanceId: number
  sampleCount: number
  maxSatellites: number
  minFixType: number
  meanEph: number | null
  meanEpv: number | null
  maxEph: number | null
  maxEpv: number | null
}

interface NavigationResult {
  gpsInstances: GpsInstanceMetrics[]
  localPosition: { sampleCount: number } | null
  airData: { sampleCount: number } | null
  wind: { sampleCount: number } | null
  opticalFlow: { sampleCount: number; meanQuality: number | null } | null
  distanceSensor: { sampleCount: number; meanQuality: number | null } | null
}

// ─── Constants ──────────────────────────────────────────────────────────────

const MAX_CHART_POINTS = 5000
const HDOP_WARNING = 5.0
const VDOP_WARNING = 10.0
const OPTICAL_FLOW_LOW_QUALITY = 50

// ─── Helpers ────────────────────────────────────────────────────────────────

function downsample<T>(arr: T[], maxPoints: number): T[] {
  if (arr.length <= maxPoints) return arr
  const step = Math.ceil(arr.length / maxPoints)
  return arr.filter((_, i) => i % step === 0)
}

function makeEvidence(
  topicName: string,
  multiId: number,
  fields: string[],
  observed: string,
  threshold: string | null = null,
): DiagnosticEvidence {
  return { topic: topicName, multiId, fields, startSec: null, endSec: null, observed, threshold }
}

// ─── Module ─────────────────────────────────────────────────────────────────

export const navigationModule: AnalysisModule<NavState, NavigationResult> = {
  id: 'navigation',
  section: 'navigation',
  requirements: [
    {
      aliases: ['vehicle_gps_position', 'sensor_gps'],
      required: false,
      bindAs: 'gps',
      multiInstance: true,
    },
    {
      aliases: ['vehicle_global_position'],
      required: false,
      bindAs: 'globalPosition',
    },
    {
      aliases: ['vehicle_local_position'],
      required: false,
      bindAs: 'localPosition',
    },
    {
      aliases: ['vehicle_air_data'],
      required: false,
      bindAs: 'airData',
    },
    {
      aliases: ['wind'],
      required: false,
      bindAs: 'wind',
    },
    {
      aliases: ['optical_flow'],
      required: false,
      bindAs: 'opticalFlow',
    },
    {
      aliases: ['distance_sensor'],
      required: false,
      bindAs: 'distanceSensor',
    },
  ],

  create(_context: AnalysisContext): NavState {
    return {
      gpsInstances: new Map(),
      globalPosition: null,
      localPosition: null,
      airData: null,
      wind: null,
      opticalFlow: null,
      distanceSensor: null,
    }
  },

  consume(state: NavState, sample: ResolvedSample, bindName: string): void {
    switch (bindName) {
      case 'gps': {
        const instanceId = sample.topic.multiId
        let gps = state.gpsInstances.get(instanceId)
        if (!gps) {
          gps = {
            fixTypes: [],
            satellites: [],
            ephs: [],
            epvs: [],
            sampleCount: 0,
            maxSatellites: 0,
            minFixType: Infinity,
            minEph: Infinity,
            maxEph: 0,
            minEpv: Infinity,
            maxEpv: 0,
          }
          state.gpsInstances.set(instanceId, gps)
        }
        gps.sampleCount++

        const fix = sample.values['fix_type']
        if (typeof fix === 'number') {
          gps.fixTypes.push({ time: sample.timeSec, value: fix })
          if (fix < gps.minFixType) gps.minFixType = fix
        }

        const sats = sample.values['satellites_used']
        if (typeof sats === 'number') {
          gps.satellites.push({ time: sample.timeSec, value: sats })
          if (sats > gps.maxSatellites) gps.maxSatellites = sats
        }

        const eph = sample.values['eph']
        if (typeof eph === 'number' && Number.isFinite(eph)) {
          gps.ephs.push({ time: sample.timeSec, value: eph })
          if (eph < gps.minEph) gps.minEph = eph
          if (eph > gps.maxEph) gps.maxEph = eph
        }

        const epv = sample.values['epv']
        if (typeof epv === 'number' && Number.isFinite(epv)) {
          gps.epvs.push({ time: sample.timeSec, value: epv })
          if (epv < gps.minEpv) gps.minEpv = epv
          if (epv > gps.maxEpv) gps.maxEpv = epv
        }
        break
      }

      case 'globalPosition': {
        if (!state.globalPosition) {
          state.globalPosition = { sampleCount: 0, lat: 0, lon: 0, alt: 0 }
        }
        state.globalPosition.sampleCount++
        const lat = sample.values['lat']
        const lon = sample.values['lon']
        const alt = sample.values['alt']
        if (typeof lat === 'number') state.globalPosition.lat = lat
        if (typeof lon === 'number') state.globalPosition.lon = lon
        if (typeof alt === 'number') state.globalPosition.alt = alt
        break
      }

      case 'localPosition': {
        if (!state.localPosition) {
          state.localPosition = { sampleCount: 0, x: 0, y: 0, z: 0 }
        }
        state.localPosition.sampleCount++
        const x = sample.values['x']
        const y = sample.values['y']
        const z = sample.values['z']
        if (typeof x === 'number') state.localPosition.x = x
        if (typeof y === 'number') state.localPosition.y = y
        if (typeof z === 'number') state.localPosition.z = z
        break
      }

      case 'airData': {
        if (!state.airData) {
          state.airData = { sampleCount: 0, indicatedAirspeed: null, trueAirspeed: null, baroAlt: null }
        }
        state.airData.sampleCount++
        const ias = sample.values['indicated_airspeed_m_s']
        const tas = sample.values['true_airspeed_m_s']
        const baro = sample.values['baro_alt_meter']
        if (typeof ias === 'number') state.airData.indicatedAirspeed = ias
        if (typeof tas === 'number') state.airData.trueAirspeed = tas
        if (typeof baro === 'number') state.airData.baroAlt = baro
        break
      }

      case 'wind': {
        if (!state.wind) {
          state.wind = { sampleCount: 0, samples: [] }
        }
        state.wind.sampleCount++
        // Official Wind.msg fields: windspeed_north / windspeed_east (m/s)
        const wn = sample.values['windspeed_north']
        const we = sample.values['windspeed_east']
        if (
          typeof wn === 'number' && typeof we === 'number' &&
          Number.isFinite(wn) && Number.isFinite(we)
        ) {
          state.wind.samples.push({ timeSec: sample.timeSec, speed: Math.hypot(wn, we) })
        }
        break
      }

      case 'opticalFlow': {
        if (!state.opticalFlow) {
          state.opticalFlow = { sampleCount: 0, qualitySum: 0, qualityCount: 0 }
        }
        state.opticalFlow.sampleCount++
        const q = sample.values['quality']
        if (typeof q === 'number') {
          state.opticalFlow.qualitySum += q
          state.opticalFlow.qualityCount++
        }
        break
      }

      case 'distanceSensor': {
        if (!state.distanceSensor) {
          state.distanceSensor = { sampleCount: 0, distances: [], qualitySum: 0, qualityCount: 0 }
        }
        state.distanceSensor.sampleCount++
        const dist = sample.values['current_distance']
        if (typeof dist === 'number') state.distanceSensor.distances.push(dist)
        const dq = sample.values['quality']
        if (typeof dq === 'number') {
          state.distanceSensor.qualitySum += dq
          state.distanceSensor.qualityCount++
        }
        break
      }
    }
  },

  finalize(state: NavState, _context: AnalysisContext): ModuleResult<NavState, NavigationResult> {
    const findings: DiagnosticFinding[] = []

    // ── GPS metrics ──
    const gpsMetrics: GpsInstanceMetrics[] = []
    for (const [instanceId, gps] of state.gpsInstances) {
      if (gps.sampleCount === 0) continue

      const meanEph = gps.ephs.length > 0 ? gps.ephs.reduce((a, b) => a + b.value, 0) / gps.ephs.length : null
      const meanEpv = gps.epvs.length > 0 ? gps.epvs.reduce((a, b) => a + b.value, 0) / gps.epvs.length : null

      gpsMetrics.push({
        instanceId,
        sampleCount: gps.sampleCount,
        maxSatellites: gps.maxSatellites,
        minFixType: gps.minFixType === Infinity ? 0 : gps.minFixType,
        meanEph,
        meanEpv,
        maxEph: gps.maxEph > 0 ? gps.maxEph : null,
        maxEpv: gps.maxEpv > 0 ? gps.maxEpv : null,
      })

      // GPS fix loss
      const hasFixLoss = gps.fixTypes.some(f => f.value < 1)
      if (hasFixLoss) {
        findings.push({
          id: `navigation:gps${instanceId}:fix-loss`,
          moduleId: 'navigation',
          section: 'navigation',
          severity: 'critical',
          confidence: 'measured',
          title: `GPS ${instanceId} 定位丢失`,
          summary: `GPS 实例 ${instanceId} 的定位类型曾低于 1（无定位）`,
          recommendation: '请检查 GPS 天线位置和天空可见度。',
          evidence: [makeEvidence('vehicle_gps_position', instanceId, ['fix_type'], `min fix_type: ${gps.minFixType}`, '>=1')],
        })
      }

      // High HDOP
      if (gps.maxEph > HDOP_WARNING) {
        findings.push({
          id: `navigation:gps${instanceId}:high-hdop`,
          moduleId: 'navigation',
          section: 'navigation',
          severity: 'warning',
          confidence: 'measured',
          title: `GPS ${instanceId} 水平精度较差`,
          summary: `最大水平位置误差估计 ${gps.maxEph.toFixed(1)}m，超过警告阈值 ${HDOP_WARNING}m`,
          recommendation: '飞行期间 GPS 水平定位精度有所下降。',
          evidence: [makeEvidence('vehicle_gps_position', instanceId, ['eph'], `${gps.maxEph.toFixed(1)}m`, `>${HDOP_WARNING}m`)],
        })
      }

      // High VDOP
      if (gps.maxEpv > VDOP_WARNING) {
        findings.push({
          id: `navigation:gps${instanceId}:high-vdop`,
          moduleId: 'navigation',
          section: 'navigation',
          severity: 'warning',
          confidence: 'measured',
          title: `GPS ${instanceId} 垂直精度较差`,
          summary: `最大垂直位置误差估计 ${gps.maxEpv.toFixed(1)}m，超过警告阈值 ${VDOP_WARNING}m`,
          recommendation: '飞行期间 GPS 垂直定位精度有所下降。',
          evidence: [makeEvidence('vehicle_gps_position', instanceId, ['epv'], `${gps.maxEpv.toFixed(1)}m`, `>${VDOP_WARNING}m`)],
        })
      }
    }

    // ── Optical flow quality ──
    let opticalFlowResult: { sampleCount: number; meanQuality: number | null } | null = null
    if (state.opticalFlow && state.opticalFlow.sampleCount > 0) {
      const meanQuality = state.opticalFlow.qualityCount > 0
        ? state.opticalFlow.qualitySum / state.opticalFlow.qualityCount
        : null
      opticalFlowResult = { sampleCount: state.opticalFlow.sampleCount, meanQuality }

      if (meanQuality !== null && meanQuality < OPTICAL_FLOW_LOW_QUALITY) {
        findings.push({
          id: 'navigation:optical-flow:low-quality',
          moduleId: 'navigation',
          section: 'navigation',
          severity: 'notice',
          confidence: 'measured',
          title: '光流质量偏低',
          summary: `平均光流质量 ${meanQuality.toFixed(0)}，低于阈值 ${OPTICAL_FLOW_LOW_QUALITY}`,
          recommendation: '请检查光流传感器是否被遮挡，以及地面纹理是否足够。',
          evidence: [makeEvidence('optical_flow', 0, ['quality'], `${meanQuality.toFixed(0)}`, `>=${OPTICAL_FLOW_LOW_QUALITY}`)],
        })
      }
    }

    // ── Distance sensor ──
    let distSensorResult: { sampleCount: number; meanQuality: number | null } | null = null
    if (state.distanceSensor && state.distanceSensor.sampleCount > 0) {
      const meanQuality = state.distanceSensor.qualityCount > 0
        ? state.distanceSensor.qualitySum / state.distanceSensor.qualityCount
        : null
      distSensorResult = { sampleCount: state.distanceSensor.sampleCount, meanQuality }
    }

    // ── Chart families ──

    // GPS quality: fix type + accuracy, one series per instance
    const fixTypeSeries: ChartSeries[] = []
    for (const [instanceId, gps] of state.gpsInstances) {
      if (gps.fixTypes.length === 0) continue
      const downsampled = downsample(gps.fixTypes, MAX_CHART_POINTS)
      fixTypeSeries.push({
        id: `gps-${instanceId}-fix-type`,
        label: `GPS ${instanceId}`,
        times: downsampled.map(s => s.time),
        values: downsampled.map(s => s.value),
      })
    }

    const ephSeries: ChartSeries[] = []
    for (const [instanceId, gps] of state.gpsInstances) {
      if (gps.ephs.length === 0) continue
      const downsampled = downsample(gps.ephs, MAX_CHART_POINTS)
      ephSeries.push({
        id: `gps-${instanceId}-eph`,
        label: `GPS ${instanceId}`,
        times: downsampled.map(s => s.time),
        values: downsampled.map(s => s.value),
      })
    }

    const gpsViews: ChartView[] = []
    if (fixTypeSeries.length > 0) {
      gpsViews.push({
        id: 'gps-fix-type',
        title: '定位类型',
        description: 'GPS 定位类型随时间的变化（3=3D，4=DGPS，5=RTK 浮点解，6=RTK 固定解）',
        unit: 'fix type',
        series: fixTypeSeries,
        defaultVisibleSeriesIds: fixTypeSeries.slice(0, 6).map(s => s.id),
        thresholds: [
          { value: 1, label: '无定位', severity: 'critical' },
          { value: 3, label: '3D 定位', severity: 'healthy' },
        ],
        xAxis: 'time',
        hasGaps: false,
      })
    }
    if (ephSeries.length > 0) {
      gpsViews.push({
        id: 'gps-eph',
        title: '水平定位精度',
        description: '水平位置精度估计（eph）随时间的变化',
        unit: 'm',
        series: ephSeries,
        defaultVisibleSeriesIds: ephSeries.slice(0, 6).map(s => s.id),
        thresholds: [
          { value: HDOP_WARNING, label: '警告阈值', severity: 'warning' },
        ],
        xAxis: 'time',
        hasGaps: false,
      })
    }

    const chartFamilies: ChartFamily[] = []
    if (gpsViews.length > 0) {
      chartFamilies.push({
        id: 'gps-quality',
        moduleId: 'navigation',
        title: 'GPS 质量',
        description: '定位类型与精度',
        views: gpsViews,
        defaultViewId: gpsViews[0]!.id,
        order: 10,
      })
    }

    // Wind (real timestamps from the wind topic)
    if (state.wind && state.wind.samples.length > 0) {
      const windDs = downsample(
        state.wind.samples.map(s => ({ time: s.timeSec, value: s.speed })),
        MAX_CHART_POINTS,
      )
      chartFamilies.push({
        id: 'air-wind',
        moduleId: 'navigation',
        title: '风速估计',
        description: '风速估计（windspeed_north/east 合成）',
        views: [{
          id: 'wind-speed',
          title: '风速',
          description: '估算风速随时间的变化',
          unit: 'm/s',
          series: [{
            id: 'wind-speed-magnitude',
            label: '风速',
            times: windDs.map(s => s.time),
            values: windDs.map(s => s.value),
          }],
          defaultVisibleSeriesIds: ['wind-speed-magnitude'],
          xAxis: 'time',
          hasGaps: false,
        }],
        defaultViewId: 'wind-speed',
        order: 20,
      })
    }

    return {
      chartFamilies,
      metrics: {
        gpsInstances: gpsMetrics,
        globalPosition: state.globalPosition ? { sampleCount: state.globalPosition.sampleCount } : null,
        localPosition: state.localPosition ? { sampleCount: state.localPosition.sampleCount } : null,
        airData: state.airData ? { sampleCount: state.airData.sampleCount } : null,
        wind: state.wind ? { sampleCount: state.wind.sampleCount } : null,
        opticalFlow: opticalFlowResult,
        distanceSensor: distSensorResult,
      },
      findings,
      consumedTopics: [],
      missingRequirements: [],
      warnings: [],
      result: {
        gpsInstances: gpsMetrics,
        localPosition: state.localPosition ? { sampleCount: state.localPosition.sampleCount } : null,
        airData: state.airData ? { sampleCount: state.airData.sampleCount } : null,
        wind: state.wind ? { sampleCount: state.wind.sampleCount } : null,
        opticalFlow: opticalFlowResult,
        distanceSensor: distSensorResult,
      },
    }
  },
}
