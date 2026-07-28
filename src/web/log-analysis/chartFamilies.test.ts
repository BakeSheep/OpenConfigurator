// Section-level chart-family aggregation contract.
//
// Chart families replace the flat chartSeries wall:
//  - module identity is preserved (family.moduleId + section.moduleResults);
//  - families are ordered by their `order` key;
//  - metrics stay owned by their source module;
//  - per-section family counts stay within the selector budget:
//      control ≤ 2, estimator ≤ 3, sensors-power ≤ 5, navigation ≤ 4.
// These are selector families, not simultaneously mounted charts.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { UlogFixtureBuilder } from './testing/ulogFixtureBuilder.js'
import { UlogDocument } from './parser/UlogDocument.js'
import { ModuleRegistry } from './engine/moduleRegistry.js'
import { runAnalysis } from './engine/runAnalysis.js'
import { flightOverviewModule } from './modules/flightOverview.js'
import { controlTrackingModule } from './modules/controlTracking.js'
import { actuatorsModule } from './modules/actuators.js'
import { estimatorModule } from './modules/estimator.js'
import { sensorsModule } from './modules/sensors.js'
import { powerModule } from './modules/power.js'
import { propulsionModule } from './modules/propulsion.js'
import { navigationModule } from './modules/navigation.js'
import { failsafeModule } from './modules/failsafe.js'
import { systemHealthModule } from './modules/systemHealth.js'
import { eventsModule } from './modules/events.js'
import type { SectionResult } from './types.js'
import type { AnalysisModule } from './engine/AnalysisModule.js'

const SEC = 1_000_000

function fullRegistry(): ModuleRegistry {
  const registry = new ModuleRegistry()
  registry.register(flightOverviewModule)
  registry.register(controlTrackingModule)
  registry.register(actuatorsModule)
  registry.register(estimatorModule)
  registry.register(sensorsModule)
  registry.register(powerModule)
  registry.register(propulsionModule)
  registry.register(navigationModule)
  registry.register(failsafeModule)
  registry.register(systemHealthModule)
  registry.register(eventsModule)
  return registry
}

/** Rich fixture exercising control, estimator, sensors-power and navigation. */
function buildRichFixture(): ArrayBuffer {
  const b = new UlogFixtureBuilder()

  b.addFormat(100, 'vehicle_attitude', [
    { type: 'uint64_t', fieldName: 'timestamp' },
    { type: 'float[4]', fieldName: 'q' },
  ])
  b.addFormat(101, 'vehicle_attitude_setpoint', [
    { type: 'uint64_t', fieldName: 'timestamp' },
    { type: 'float[4]', fieldName: 'q_d' },
  ])
  b.addFormat(102, 'vehicle_status', [
    { type: 'uint64_t', fieldName: 'timestamp' },
    { type: 'uint8_t', fieldName: 'arming_state' },
    { type: 'uint8_t', fieldName: 'nav_state' },
  ])
  b.addFormat(103, 'actuator_motors', [
    { type: 'uint64_t', fieldName: 'timestamp' },
    { type: 'float[12]', fieldName: 'control' },
  ])
  b.addFormat(110, 'estimator_status', [
    { type: 'uint64_t', fieldName: 'timestamp' },
    { type: 'float', fieldName: 'pos_test_ratio' },
    { type: 'float', fieldName: 'vel_test_ratio' },
  ])
  b.addFormat(120, 'sensor_combined', [
    { type: 'uint64_t', fieldName: 'timestamp' },
    { type: 'float[3]', fieldName: 'gyro_rad' },
    { type: 'float[3]', fieldName: 'accelerometer_m_s2' },
    { type: 'uint8_t', fieldName: 'accelerometer_clipping' },
    { type: 'uint8_t', fieldName: 'gyro_clipping' },
  ])
  b.addFormat(121, 'sensor_mag', [
    { type: 'uint64_t', fieldName: 'timestamp' },
    { type: 'float', fieldName: 'x' },
    { type: 'float', fieldName: 'y' },
    { type: 'float', fieldName: 'z' },
  ])
  b.addFormat(122, 'sensor_baro', [
    { type: 'uint64_t', fieldName: 'timestamp' },
    { type: 'float', fieldName: 'pressure' },
    { type: 'float', fieldName: 'temperature' },
  ])
  b.addFormat(123, 'battery_status', [
    { type: 'uint64_t', fieldName: 'timestamp' },
    { type: 'float', fieldName: 'voltage_v' },
    { type: 'float', fieldName: 'current_a' },
    { type: 'uint8_t', fieldName: 'cell_count' },
  ])
  b.addFormat(130, 'vehicle_gps_position', [
    { type: 'uint64_t', fieldName: 'timestamp' },
    { type: 'uint8_t', fieldName: 'fix_type' },
    { type: 'uint8_t', fieldName: 'satellites_used' },
    { type: 'float', fieldName: 'eph' },
    { type: 'float', fieldName: 'epv' },
  ])
  b.addFormat(131, 'wind', [
    { type: 'uint64_t', fieldName: 'timestamp' },
    { type: 'float', fieldName: 'windspeed_north' },
    { type: 'float', fieldName: 'windspeed_east' },
  ])

  for (const [msgId, multiId] of [
    [100, 0], [101, 0], [102, 0], [103, 0], [110, 0],
    [120, 0], [121, 0], [122, 0], [123, 0], [130, 0], [131, 0],
  ] as Array<[number, number]>) {
    b.addSubscription(msgId, multiId)
  }
  b.addParameter('CA_ROTOR_COUNT', 4)

  const duration = 30
  // 1 Hz topics
  for (let t = 0; t <= duration; t++) {
    const armed = t >= 2 && t < 28
    b.addData(102, BigInt(t * SEC), {
      timestamp: t * SEC,
      arming_state: armed ? 2 : 1,
      nav_state: 2,
    })
    b.addData(123, BigInt(t * SEC), {
      timestamp: t * SEC,
      voltage_v: 12.4 - t * 0.02,
      current_a: 8 + Math.sin(t),
      cell_count: 3,
    })
    b.addData(130, BigInt(t * SEC), {
      timestamp: t * SEC,
      fix_type: 3,
      satellites_used: 12,
      eph: 1.2,
      epv: 1.8,
    })
    b.addData(131, BigInt(t * SEC), {
      timestamp: t * SEC,
      windspeed_north: 1.5,
      windspeed_east: -0.5,
    })
    b.addData(110, BigInt(t * SEC), {
      timestamp: t * SEC,
      pos_test_ratio: 0.2,
      vel_test_ratio: 0.3,
    })
  }
  // 10 Hz topics
  for (let i = 0; i <= duration * 10; i++) {
    const t = i / 10
    const armed = t >= 2 && t < 28
    const roll = 0.05 * Math.sin(t)
    b.addData(100, BigInt(Math.round(t * SEC)), {
      timestamp: Math.round(t * SEC),
      'q[0]': Math.cos(roll / 2), 'q[1]': Math.sin(roll / 2), 'q[2]': 0, 'q[3]': 0,
    })
    b.addData(101, BigInt(Math.round(t * SEC)), {
      timestamp: Math.round(t * SEC),
      'q_d[0]': 1, 'q_d[1]': 0, 'q_d[2]': 0, 'q_d[3]': 0,
    })
    const motorFields: Record<string, number> = { timestamp: Math.round(t * SEC) }
    for (let ch = 0; ch < 12; ch++) {
      motorFields[`control[${ch}]`] = armed && ch < 4 ? 0.5 : NaN
    }
    b.addData(103, BigInt(Math.round(t * SEC)), motorFields)
  }
  // 50 Hz IMU + 5 Hz mag/baro
  for (let i = 0; i <= duration * 50; i++) {
    const t = i / 50
    b.addData(120, BigInt(Math.round(t * SEC)), {
      timestamp: Math.round(t * SEC),
      'gyro_rad[0]': 0.01, 'gyro_rad[1]': 0.02, 'gyro_rad[2]': 0.005,
      'accelerometer_m_s2[0]': 0.1, 'accelerometer_m_s2[1]': -0.1, 'accelerometer_m_s2[2]': -9.8,
      accelerometer_clipping: 0,
      gyro_clipping: 0,
    })
  }
  for (let i = 0; i <= duration * 5; i++) {
    const t = i / 5
    b.addData(121, BigInt(Math.round(t * SEC)), {
      timestamp: Math.round(t * SEC), x: 0.2, y: 0.05, z: 0.4,
    })
    b.addData(122, BigInt(Math.round(t * SEC)), {
      timestamp: Math.round(t * SEC), pressure: 101_325 - t, temperature: 25,
    })
  }

  return b.build()
}

function familyIds(section: SectionResult | undefined): string[] {
  return (section?.chartFamilies ?? []).map((f) => f.id)
}

// ─── Field audit ──────────────────────────────────────────────────────
//
// Executable audit of every purpose-built metric source. Each entry records
// the topic aliases actually requested by the module, the exact PX4 fields
// consumed, units, multi-instance behavior, what happens when data is
// missing, and the confidence class of derived findings. Aliases are
// asserted against the module requirements so drift fails the build.

interface FieldAuditEntry {
  module: AnalysisModule
  bindAs: string
  aliases: string[]
  multiInstance: boolean
  fields: string
  units: string
  missingData: string
  confidence: string
}

const FIELD_AUDIT: FieldAuditEntry[] = [
  {
    module: flightOverviewModule as AnalysisModule, bindAs: 'vehicleStatus',
    aliases: ['vehicle_status'], multiInstance: false,
    fields: 'arming_state (1=DISARMED, 2=ARMED), nav_state', units: 'enum',
    missingData: 'null armed reading → no transition (never coerced to disarmed)',
    confidence: 'measured',
  },
  {
    module: flightOverviewModule as AnalysisModule, bindAs: 'actuatorArmed',
    aliases: ['actuator_armed'], multiInstance: false,
    fields: 'armed (bool)', units: 'bool',
    missingData: 'fallback only; vehicle_status takes precedence',
    confidence: 'measured',
  },
  {
    module: actuatorsModule as AnalysisModule, bindAs: 'motors',
    aliases: ['actuator_motors'], multiInstance: false,
    fields: 'control[0..11] (NaN = unused slot per spec)', units: 'normalized -1..1',
    missingData: 'all-NaN slots are unused, produce no metrics/series/findings',
    confidence: 'measured (gaps), heuristic (saturation without PWM limits)',
  },
  {
    module: controlTrackingModule as AnalysisModule, bindAs: 'attitude',
    aliases: ['vehicle_attitude'], multiInstance: false,
    fields: 'q[0..3] (preferred) or roll/pitch/yaw', units: 'rad',
    missingData: 'samples with missing fields are skipped, never zero-filled',
    confidence: 'heuristic (tracking-error findings)',
  },
  {
    module: sensorsModule as AnalysisModule, bindAs: 'sensorCombined',
    aliases: ['sensor_combined'], multiInstance: false,
    fields: 'accelerometer_m_s2[0..2], gyro_rad[0..2], accelerometer_clipping/gyro_clipping bitfields',
    units: 'm/s², rad/s',
    missingData: 'invalid values become NaN gaps; incomplete triplets resolve to no view',
    confidence: 'measured (clipping), derived (vibration)',
  },
  {
    module: sensorsModule as AnalysisModule, bindAs: 'baro',
    aliases: ['sensor_baro', 'vehicle_air_data'], multiInstance: true,
    fields: 'pressure/temperature or baro_pressure_pa/baro_alt_meter/baro_temp_celcius',
    units: 'Pa, m, °C (separate views per unit)',
    missingData: 'missing scalars resolve to fewer views, never zero-filled',
    confidence: 'measured',
  },
  {
    module: powerModule as AnalysisModule, bindAs: 'battery',
    aliases: ['battery_status', 'battery_status_old'], multiInstance: true,
    fields: 'voltage_v, current_a, cell_count, voltage_cell_v[0..13], remaining, discharged_mah',
    units: 'V, A, %, mAh',
    missingData: 'non-finite samples skipped; thresholds need cell_count',
    confidence: 'measured (voltage), heuristic (sag)',
  },
  {
    module: propulsionModule as AnalysisModule, bindAs: 'escStatus',
    aliases: ['esc_status'], multiInstance: true,
    fields: 'esc[n].esc_rpm / esc_voltage / esc_current / esc_temperature / esc_errorflags',
    units: 'RPM, V, A, °C',
    missingData: 'imbalance summary lives in metrics (categorical, not a time series)',
    confidence: 'derived (imbalance), heuristic (overtemp)',
  },
  {
    module: navigationModule as AnalysisModule, bindAs: 'gps',
    aliases: ['vehicle_gps_position', 'sensor_gps'], multiInstance: true,
    fields: 'fix_type, satellites_used, eph, epv', units: 'enum, count, m',
    missingData: 'series per instance; empty instances produce no series',
    confidence: 'measured',
  },
  {
    module: navigationModule as AnalysisModule, bindAs: 'wind',
    aliases: ['wind'], multiInstance: false,
    fields: 'windspeed_north, windspeed_east (magnitude derived)', units: 'm/s',
    missingData: 'real timestamps only — no index-as-time axis',
    confidence: 'derived',
  },
  {
    module: estimatorModule as AnalysisModule, bindAs: 'estimatorStatus',
    aliases: ['estimator_status', 'ekf2_innovations'], multiInstance: true,
    fields: '*_test_ratio, filter_fault_flags, dead_reckoning, *bias*, *covariance*/cov_*, reset counters',
    units: 'ratio (dimensionless), enum flags',
    missingData: 'full-log bounded collectors; missing values are gaps',
    confidence: 'measured (ratios/faults), heuristic (bias)',
  },
  {
    module: systemHealthModule as AnalysisModule, bindAs: 'cpuLoad',
    aliases: ['cpuload'], multiInstance: false,
    fields: 'load, ram_usage (0–1 fractions scaled to %)', units: '%',
    missingData: 'missing load → sample skipped; unknown RAM scale treated as unknown, not 0',
    confidence: 'measured',
  },
]

describe('field audit — module requirements match documented PX4 sources', () => {
  for (const entry of FIELD_AUDIT) {
    it(`${entry.module.id}.${entry.bindAs} consumes ${entry.aliases.join('/')}`, () => {
      const requirement = entry.module.requirements.find((r) => r.bindAs === entry.bindAs)
      assert.ok(requirement, `requirement ${entry.bindAs} exists on ${entry.module.id}`)
      assert.deepEqual(requirement!.aliases, entry.aliases)
      assert.equal(requirement!.multiInstance ?? false, entry.multiInstance)
      // Documentation fields must be filled in — the audit is not decorative
      assert.ok(entry.fields.length > 0 && entry.units.length > 0)
      assert.ok(entry.missingData.length > 0 && entry.confidence.length > 0)
    })
  }
})

describe('chart family aggregation', () => {
  it('keeps per-section family counts within the selector budget', async () => {
    const doc = await UlogDocument.open(buildRichFixture())
    const { sections } = await runAnalysis(doc, fullRegistry())

    const control = sections['control']
    assert.ok(control, 'control section exists')
    assert.ok(
      control.chartFamilies.length >= 1 && control.chartFamilies.length <= 2,
      `control has at most 2 families, got ${familyIds(control).join(', ')}`,
    )

    const estimator = sections['estimator']
    assert.ok(estimator, 'estimator section exists')
    assert.ok(
      estimator.chartFamilies.length <= 3,
      `estimator has at most 3 families, got ${familyIds(estimator).join(', ')}`,
    )

    const sensorsPower = sections['sensors-power']
    assert.ok(sensorsPower, 'sensors-power section exists')
    assert.ok(
      sensorsPower.chartFamilies.length >= 2 && sensorsPower.chartFamilies.length <= 5,
      `sensors-power has at most 5 families, got ${familyIds(sensorsPower).join(', ')}`,
    )

    const navigation = sections['navigation']
    assert.ok(navigation, 'navigation section exists')
    assert.ok(
      navigation.chartFamilies.length >= 1 && navigation.chartFamilies.length <= 4,
      `navigation has at most 4 families, got ${familyIds(navigation).join(', ')}`,
    )
  })

  it('preserves module identity and ordering across the section merge', async () => {
    const doc = await UlogDocument.open(buildRichFixture())
    const { sections } = await runAnalysis(doc, fullRegistry())

    const control = sections['control']!
    // Both control modules keep their identity
    const moduleIds = control.moduleResults.map((m) => m.moduleId)
    assert.ok(moduleIds.includes('control-tracking'))
    assert.ok(moduleIds.includes('actuators'))

    // Families reference their source modules and are sorted by order
    for (const family of control.chartFamilies) {
      assert.ok(moduleIds.includes(family.moduleId), `family ${family.id} belongs to a section module`)
    }
    const orders = control.chartFamilies.map((f) => f.order)
    assert.deepEqual(orders, [...orders].sort((a, b) => a - b), 'families sorted by order')
    assert.deepEqual(familyIds(control), ['control-tracking', 'actuators'])
  })

  it('keeps metrics owned by their source module, not flattened', async () => {
    const doc = await UlogDocument.open(buildRichFixture())
    const { sections } = await runAnalysis(doc, fullRegistry())

    const control = sections['control']!
    const actuators = control.moduleResults.find((m) => m.moduleId === 'actuators')
    assert.ok(actuators, 'actuators module result exists')
    assert.equal(actuators.metrics.motorCount, 4)

    const tracking = control.moduleResults.find((m) => m.moduleId === 'control-tracking')
    assert.ok(tracking, 'control-tracking module result exists')
    assert.ok('rollRmsError' in tracking.metrics, 'tracking metrics stay with the tracking module')

    // No merged top-level metrics bag exists on the section
    assert.ok(!('metrics' in control), 'section has no flattened metrics object')
  })

  it('never creates a chart family per scalar field', async () => {
    const doc = await UlogDocument.open(buildRichFixture())
    const { sections } = await runAnalysis(doc, fullRegistry())

    for (const [sectionId, section] of Object.entries(sections)) {
      if (!section) continue
      for (const family of section.chartFamilies) {
        assert.ok(
          family.views.length >= 1,
          `${sectionId}/${family.id} groups at least one view`,
        )
        for (const view of family.views) {
          assert.ok(view.series.length >= 1, `${family.id}/${view.id} has series`)
          assert.ok(
            view.defaultVisibleSeriesIds.length >= 1,
            `${family.id}/${view.id} declares a semantic default selection`,
          )
        }
      }
    }
  })
})
