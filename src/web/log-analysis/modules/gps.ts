import type { AnalysisModule, AnalysisContext, ResolvedSample, ModuleResult } from '../engine/AnalysisModule.js'

interface GpsState {
  sampleCount: number
  maxSatellites: number
  minFixType: number
}

interface GpsResult {
  totalSamples: number
  maxSatellites: number
  minFixType: number
}

/**
 * GPS analysis module — tracks satellite count and fix type.
 */
export const gpsModule: AnalysisModule<GpsState, GpsResult> = {
  id: 'gps',
  section: 'navigation',
  requirements: [
    {
      aliases: ['vehicle_gps_position', 'sensor_gps'],
      required: false,
      bindAs: 'gpsPosition',
    },
  ],

  create(_context: AnalysisContext): GpsState {
    return { sampleCount: 0, maxSatellites: 0, minFixType: Infinity }
  },

  consume(state: GpsState, sample: ResolvedSample, _bindName: string): void {
    state.sampleCount++
    const sats = sample.values['satellites_used']
    if (typeof sats === 'number' && sats > state.maxSatellites) {
      state.maxSatellites = sats
    }
    const fix = sample.values['fix_type']
    if (typeof fix === 'number' && fix < state.minFixType) {
      state.minFixType = fix
    }
  },

  finalize(state: GpsState, _context: AnalysisContext): ModuleResult<GpsState, GpsResult> {
    return {
      chartFamilies: [],
      metrics: {
        gpsSamples: state.sampleCount,
        maxSatellites: state.maxSatellites,
      },
      findings: [],
      consumedTopics: [],
      missingRequirements: [],
      warnings: [],
      result: {
        totalSamples: state.sampleCount,
        maxSatellites: state.maxSatellites,
        minFixType: state.minFixType === Infinity ? 0 : state.minFixType,
      },
    }
  },
}
