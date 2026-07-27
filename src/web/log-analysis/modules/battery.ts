import type { AnalysisModule, AnalysisContext, ResolvedSample, ModuleResult } from '../engine/AnalysisModule.js'

interface BatteryState {
  minVoltage: number
  maxVoltage: number
  sampleCount: number
}

interface BatteryResult {
  minVoltage: number
  maxVoltage: number
  averageVoltage: number | null
}

/**
 * Battery analysis module — tracks voltage statistics.
 */
export const batteryModule: AnalysisModule<BatteryState, BatteryResult> = {
  id: 'battery',
  section: 'sensors-power',
  requirements: [
    {
      aliases: ['battery_status', 'battery_status_old'],
      required: false,
      bindAs: 'batteryStatus',
    },
  ],

  create(_context: AnalysisContext): BatteryState {
    return { minVoltage: Infinity, maxVoltage: -Infinity, sampleCount: 0 }
  },

  consume(state: BatteryState, sample: ResolvedSample, _bindName: string): void {
    const voltage = sample.values['voltage_v']
    if (typeof voltage === 'number' && Number.isFinite(voltage)) {
      state.sampleCount++
      if (voltage < state.minVoltage) state.minVoltage = voltage
      if (voltage > state.maxVoltage) state.maxVoltage = voltage
    }
  },

  finalize(state: BatteryState, _context: AnalysisContext): ModuleResult<BatteryState, BatteryResult> {
    const hasData = state.sampleCount > 0
    return {
      chartSeries: [],
      metrics: {
        minVoltage: hasData ? state.minVoltage : null,
        maxVoltage: hasData ? state.maxVoltage : null,
      },
      findings: [],
      consumedTopics: [],
      missingRequirements: [],
      warnings: [],
      result: {
        minVoltage: hasData ? state.minVoltage : 0,
        maxVoltage: hasData ? state.maxVoltage : 0,
        averageVoltage: null,
      },
    }
  },
}
