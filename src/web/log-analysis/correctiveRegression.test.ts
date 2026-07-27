// Corrective-refactor regression contract.
//
// These tests reproduce the user-visible defects of the first ULog
// implementation using REAL PX4 message shapes (official field names from
// https://docs.px4.io/main/en/msg_docs/). They freeze the target contract:
//
//  1. actuator_motors.control[12] with 4 finite + 8 all-NaN slots → exactly
//     4 configured motors, zero invalid-gap findings, 1-based labels.
//  2. vehicle_status.arming_state === 2 opens an armed interval; === 1
//     closes it. No module may rely on an invented vehicle_status.armed.
//  3. A sensor_combined-only log produces acceleration XYZ and angular-rate
//     XYZ chart views covering the complete log duration.
//  4. The presentation model exposes chart families/views behind selectors
//     and mounts exactly one active view — not one card per view.
//
// Do NOT weaken these assertions to make an implementation pass.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { MessageType } from '@foxglove/ulog'
import { UlogFixtureBuilder } from './testing/ulogFixtureBuilder.js'
import { UlogDocument } from './parser/UlogDocument.js'
import { resolveTopics } from './engine/topicResolver.js'
import type { AnalysisModule, AnalysisContext, ResolvedSample, ResolvedTopic } from './engine/AnalysisModule.js'
import { actuatorsModule } from './modules/actuators.js'
import { flightOverviewModule } from './modules/flightOverview.js'
import { controlTrackingModule } from './modules/controlTracking.js'
import { sensorsModule } from './modules/sensors.js'
import * as chartModel from './chartModel.js'

// ─── Target chart-family contract (structural, pre-implementation) ──────────
// Once Task 5 lands these shapes move into types.ts; the structural copies
// here let the test compile before the implementation exists.

interface RegressionChartSeries {
  id?: string
  label: string
  times: number[]
  values: number[]
}

interface RegressionChartView {
  id: string
  title: string
  unit: string
  series: RegressionChartSeries[]
  defaultVisibleSeriesIds?: string[]
  xAxis?: string
}

interface RegressionChartFamily {
  id: string
  moduleId?: string
  title: string
  views: RegressionChartView[]
  defaultViewId?: string
}

function getChartFamilies(result: unknown): RegressionChartFamily[] {
  const families = (result as { chartFamilies?: unknown }).chartFamilies
  return Array.isArray(families) ? (families as RegressionChartFamily[]) : []
}

function findView(families: RegressionChartFamily[], viewId: string): RegressionChartView | null {
  for (const family of families) {
    for (const view of family.views ?? []) {
      if (view.id === viewId) return view
    }
  }
  return null
}

function lastTime(view: RegressionChartView): number {
  let last = -Infinity
  for (const s of view.series) {
    if (s.times.length > 0) last = Math.max(last, s.times[s.times.length - 1]!)
  }
  return last
}

// ─── Module runner (streams a real fixture document through one module) ─────

async function runModule(
  mod: AnalysisModule,
  doc: UlogDocument,
): Promise<{ result: ReturnType<AnalysisModule['finalize']>; context: AnalysisContext }> {
  const subs = doc.rawUlog.subscriptions
  const subArray: Array<{ name: string; multiId: number; msgId: number; fields: string[] }> = []
  for (const [msgId, sub] of subs) {
    subArray.push({ name: sub.name, multiId: sub.multiId, msgId, fields: [] })
  }
  for (const entry of doc.catalog) {
    const sub = subArray.find(s => s.msgId === entry.msgId)
    if (sub) sub.fields = entry.fields.map(f => f.path)
  }

  const resolution = resolveTopics(mod.requirements, subArray)
  const resolvedTopics = new Map<string, ResolvedTopic>()
  for (const [bindName, topics] of resolution.resolved) {
    if (topics.length > 0) resolvedTopics.set(bindName, topics[0])
  }

  const timeRange = doc.rawUlog.timeRange()
  const logStartSec = timeRange ? Number(timeRange[0]) / 1e6 : 0
  const logEndSec = timeRange ? Number(timeRange[1]) / 1e6 : 0

  const context: AnalysisContext = {
    resolvedTopics,
    logStartSec,
    logEndSec,
    logDuration: logEndSec - logStartSec,
    allSubscriptions: subArray.map(s => ({ name: s.name, multiId: s.multiId, msgId: s.msgId })),
    parameters: doc.parameters.map(p => ({ name: p.name, value: p.value })),
    metadata: { vehicleType: null, firmwareVersion: null, airframeName: null },
  }

  const state = mod.create(context)

  const msgIdToBinding = new Map<number, string>()
  const wantedMsgIds = new Set<number>()
  for (const [bindName, topics] of resolution.resolved) {
    for (const t of topics) {
      msgIdToBinding.set(t.msgId, bindName)
      wantedMsgIds.add(t.msgId)
    }
  }

  if (wantedMsgIds.size > 0) {
    for await (const message of doc.rawUlog.readMessages({ msgIds: wantedMsgIds })) {
      if (message.type !== MessageType.Data) continue
      const bindName = msgIdToBinding.get(message.msgId)
      if (!bindName) continue
      const topics = resolution.resolved.get(bindName) ?? []
      const topic = topics.find(t => t.msgId === message.msgId)
      if (!topic) continue

      const timeSec = Number(message.value.timestamp) / 1e6 - logStartSec
      const values: Record<string, number | string | boolean> = {}
      for (const [fieldPath] of topic.fieldMap) {
        const arrayMatch = /^([^[]+)\[(\d+)\]$/.exec(fieldPath)
        let val: unknown
        if (arrayMatch) {
          const arr = (message.value as Record<string, unknown>)[arrayMatch[1]!]
          if (Array.isArray(arr)) val = arr[parseInt(arrayMatch[2]!)]
        } else {
          val = (message.value as Record<string, unknown>)[fieldPath]
        }
        if (val !== undefined) {
          if (typeof val === 'number' || typeof val === 'string' || typeof val === 'boolean') {
            values[fieldPath] = val
          } else if (typeof val === 'bigint') {
            values[fieldPath] = Number(val)
          }
        }
      }

      const sample: ResolvedSample = { topic, timeSec, values }
      mod.consume(state, sample, bindName)
    }
  }

  const result = mod.finalize(state, context)
  return { result: result as ReturnType<AnalysisModule['finalize']>, context }
}

// ─── Fixture builders (official PX4 message shapes only) ────────────────────

const SEC = 1_000_000 // µs

/** vehicle_status format per https://docs.px4.io/main/en/msg_docs/VehicleStatus
 *  Note: there is deliberately NO `armed` field — real logs don't have one. */
function addVehicleStatusFormat(b: UlogFixtureBuilder, msgId: number): void {
  b.addFormat(msgId, 'vehicle_status', [
    { type: 'uint64_t', fieldName: 'timestamp' },
    { type: 'uint64_t', fieldName: 'armed_time' },
    { type: 'uint64_t', fieldName: 'takeoff_time' },
    { type: 'uint8_t', fieldName: 'arming_state' },
    { type: 'uint8_t', fieldName: 'nav_state' },
  ])
}

/** ARMING_STATE_DISARMED = 1, ARMING_STATE_ARMED = 2 (VehicleStatus.msg) */
const ARMING_STATE_DISARMED = 1
const ARMING_STATE_ARMED = 2

/**
 * Twelve-slot quad fixture: actuator_motors.control[12] with indices 0–3
 * finite while armed and indices 4–11 always IEEE NaN (unused slots).
 * Armed from t=2s to t=58s via vehicle_status.arming_state.
 */
function buildQuadFixture(opts: { rotorCountParam: boolean }): ArrayBuffer {
  const b = new UlogFixtureBuilder()
  b.addFormat(100, 'actuator_motors', [
    { type: 'uint64_t', fieldName: 'timestamp' },
    { type: 'uint64_t', fieldName: 'timestamp_sample' },
    { type: 'uint16_t', fieldName: 'reversible_flags' },
    { type: 'float[12]', fieldName: 'control' },
  ])
  addVehicleStatusFormat(b, 101)
  b.addSubscription(100, 0)
  b.addSubscription(101, 0)
  if (opts.rotorCountParam) {
    b.addParameter('CA_ROTOR_COUNT', 4)
  }

  const armedStart = 2
  const armedEnd = 58
  const logEnd = 60

  // vehicle_status at 1 Hz
  for (let t = 0; t <= logEnd; t++) {
    const armed = t >= armedStart && t < armedEnd
    b.addData(101, BigInt(t * SEC), {
      timestamp: t * SEC,
      armed_time: armed ? armedStart * SEC : 0,
      takeoff_time: 0,
      arming_state: armed ? ARMING_STATE_ARMED : ARMING_STATE_DISARMED,
      nav_state: 2,
    })
  }

  // actuator_motors at 10 Hz. While disarmed ALL slots are NaN (real PX4
  // behavior); while armed slots 0–3 are finite and 4–11 stay NaN.
  for (let i = 0; i <= logEnd * 10; i++) {
    const t = i / 10
    const armed = t >= armedStart && t < armedEnd
    const fields: Record<string, number> = {
      timestamp: Math.round(t * SEC),
      timestamp_sample: Math.round(t * SEC),
      reversible_flags: 0,
    }
    for (let ch = 0; ch < 12; ch++) {
      if (armed && ch < 4) {
        fields[`control[${ch}]`] = 0.4 + 0.05 * ch + 0.02 * Math.sin(t + ch)
      } else {
        fields[`control[${ch}]`] = NaN
      }
    }
    b.addData(100, BigInt(Math.round(t * SEC)), fields)
  }

  return b.build()
}

/** vehicle_status-only fixture: disarmed 0–10s, armed 10–70s, disarmed 70–80s. */
function buildArmingFixture(): ArrayBuffer {
  const b = new UlogFixtureBuilder()
  addVehicleStatusFormat(b, 101)
  b.addSubscription(101, 0)

  for (let t = 0; t <= 80; t++) {
    const armed = t >= 10 && t < 70
    b.addData(101, BigInt(t * SEC), {
      timestamp: t * SEC,
      armed_time: armed ? 10 * SEC : 0,
      takeoff_time: 0,
      arming_state: armed ? ARMING_STATE_ARMED : ARMING_STATE_DISARMED,
      nav_state: 2,
    })
  }
  return b.build()
}

/**
 * sensor_combined-only fixture per
 * https://docs.px4.io/main/en/msg_docs/SensorCombined — official fields,
 * more samples than the chart point budget (2000), and a recognizable
 * accel-Z burst near the end of the log.
 */
function buildSensorCombinedFixture(): { buffer: ArrayBuffer; durationSec: number } {
  const b = new UlogFixtureBuilder()
  b.addFormat(100, 'sensor_combined', [
    { type: 'uint64_t', fieldName: 'timestamp' },
    { type: 'float[3]', fieldName: 'gyro_rad' },
    { type: 'uint32_t', fieldName: 'gyro_integral_dt' },
    { type: 'int32_t', fieldName: 'accelerometer_timestamp_relative' },
    { type: 'float[3]', fieldName: 'accelerometer_m_s2' },
    { type: 'uint32_t', fieldName: 'accelerometer_integral_dt' },
    { type: 'uint8_t', fieldName: 'accelerometer_clipping' },
    { type: 'uint8_t', fieldName: 'gyro_clipping' },
  ])
  b.addSubscription(100, 0)

  const rateHz = 100
  const durationSec = 60
  const n = durationSec * rateHz // 6000 samples > 2000 budget
  for (let i = 0; i <= n; i++) {
    const t = i / rateHz
    // Recognizable burst in the last 3 seconds of the log
    const burst = t > durationSec - 3 ? 3 * Math.sin(2 * Math.PI * 30 * t) : 0
    b.addData(100, BigInt(Math.round(t * SEC)), {
      timestamp: Math.round(t * SEC),
      'gyro_rad[0]': 0.01 * Math.sin(t),
      'gyro_rad[1]': 0.01 * Math.cos(t),
      'gyro_rad[2]': 0.005,
      gyro_integral_dt: 10000,
      accelerometer_timestamp_relative: 0,
      'accelerometer_m_s2[0]': 0.1,
      'accelerometer_m_s2[1]': -0.05,
      'accelerometer_m_s2[2]': -9.8 + burst,
      accelerometer_integral_dt: 10000,
      accelerometer_clipping: 0,
      gyro_clipping: 0,
    })
  }
  return { buffer: b.build(), durationSec }
}

// ─── 1. Quad motor discovery ─────────────────────────────────────────────────

describe('corrective regression – actuator_motors quad with 12 control slots', () => {
  it('reports exactly 4 configured motors with CA_ROTOR_COUNT=4 and no NaN-gap findings', async () => {
    const doc = await UlogDocument.open(buildQuadFixture({ rotorCountParam: true }))
    const { result } = await runModule(actuatorsModule as AnalysisModule, doc)

    assert.equal(result.metrics.motorCount, 4, 'motorCount must be 4 (configured), not 12 (array slots)')

    const motorStats = (result.result as { motorStats: Array<{ channelIndex: number }> }).motorStats
    assert.deepEqual(
      motorStats.map((m) => m.channelIndex),
      [0, 1, 2, 3],
      'motorStats must carry zero-based channelIndex for exactly the configured motors',
    )

    assert.equal(
      result.findings.filter((f) => f.id.includes('nan-gap')).length,
      0,
      'unused all-NaN slots 5–12 must not produce invalid-gap findings',
    )
  })

  it('shows 1-based motor labels 电机 1 … 电机 4 in the motor output view', async () => {
    const doc = await UlogDocument.open(buildQuadFixture({ rotorCountParam: true }))
    const { result } = await runModule(actuatorsModule as AnalysisModule, doc)

    const families = getChartFamilies(result)
    const motorView = findView(families, 'motor-outputs')
    assert.ok(motorView, 'actuators must expose a motor-outputs chart view')
    assert.deepEqual(
      motorView!.series.map((s) => s.label),
      ['电机 1', '电机 2', '电机 3', '电机 4'],
      'user-facing motor labels are 1-based; internal indices stay 0-based',
    )
    // 1–6 motors → all configured motors visible by default
    assert.equal(motorView!.defaultVisibleSeriesIds?.length, 4)
  })

  it('infers 4 motors from finite armed samples when CA_ROTOR_COUNT is absent', async () => {
    const doc = await UlogDocument.open(buildQuadFixture({ rotorCountParam: false }))
    const { result } = await runModule(actuatorsModule as AnalysisModule, doc)

    assert.equal(result.metrics.motorCount, 4, 'finite-value inference must find 4 motors')
    assert.equal(
      result.findings.filter((f) => f.id.includes('nan-gap')).length,
      0,
      'inference must not turn unused slots into gap findings',
    )
  })
})

// ─── 2. Real vehicle_status arming semantics ─────────────────────────────────

describe('corrective regression – vehicle_status.arming_state semantics', () => {
  it('flight overview builds an armed interval from arming_state 2→1 without an armed field', async () => {
    const doc = await UlogDocument.open(buildArmingFixture())
    const { result } = await runModule(flightOverviewModule as AnalysisModule, doc)

    const armedSec = result.metrics.armedDurationSec as number
    assert.ok(
      armedSec > 50 && armedSec < 70,
      `armed duration must be ≈60s from arming_state transitions, got ${armedSec}`,
    )
    const armingTime = result.metrics.armingTimeSec as number | null
    assert.ok(
      armingTime !== null && Math.abs(armingTime - 10) < 2,
      `arming time must be ≈10s, got ${armingTime}`,
    )
  })

  it('control tracking restricts scoring to the arming_state armed interval', async () => {
    // Disarmed 0–5s with large error, armed 5–10s with small error.
    const b = new UlogFixtureBuilder()
    b.addFormat(100, 'vehicle_attitude', [
      { type: 'uint64_t', fieldName: 'timestamp' },
      { type: 'float[4]', fieldName: 'q' },
    ])
    b.addFormat(101, 'vehicle_attitude_setpoint', [
      { type: 'uint64_t', fieldName: 'timestamp' },
      { type: 'float', fieldName: 'roll_body' },
      { type: 'float', fieldName: 'pitch_body' },
      { type: 'float', fieldName: 'yaw_body' },
    ])
    addVehicleStatusFormat(b, 102)
    b.addSubscription(100, 0)
    b.addSubscription(101, 0)
    b.addSubscription(102, 0)

    for (let i = 0; i <= 100; i++) {
      const t = i / 10
      const armed = t >= 5
      const roll = armed ? 0.05 : 0.5 // rad
      // Quaternion for pure roll rotation
      const q0 = Math.cos(roll / 2)
      const q1 = Math.sin(roll / 2)
      b.addData(100, BigInt(Math.round(t * SEC)), {
        timestamp: Math.round(t * SEC),
        'q[0]': q0, 'q[1]': q1, 'q[2]': 0, 'q[3]': 0,
      })
      b.addData(101, BigInt(Math.round(t * SEC)), {
        timestamp: Math.round(t * SEC),
        roll_body: 0, pitch_body: 0, yaw_body: 0,
      })
      if (i % 10 === 0) {
        b.addData(102, BigInt(Math.round(t * SEC)), {
          timestamp: Math.round(t * SEC),
          armed_time: armed ? 5 * SEC : 0,
          takeoff_time: 0,
          arming_state: armed ? ARMING_STATE_ARMED : ARMING_STATE_DISARMED,
          nav_state: 2,
        })
      }
    }

    const doc = await UlogDocument.open(b.build())
    const { result } = await runModule(controlTrackingModule as AnalysisModule, doc)

    const rollRms = result.metrics.rollRmsError as number | null | undefined
    assert.ok(
      typeof rollRms === 'number' && rollRms > 0.01,
      `rollRmsError must be computed from the armed interval, got ${rollRms}`,
    )
    assert.ok(
      rollRms! < 0.15,
      `rollRmsError must exclude the disarmed 0.5rad error, got ${rollRms}`,
    )
  })
})

// ─── 3. sensor_combined recovery ─────────────────────────────────────────────

describe('corrective regression – sensor_combined-only inertial data', () => {
  it('produces acceleration and angular-rate XYZ views spanning the full log', async () => {
    const { buffer, durationSec } = buildSensorCombinedFixture()
    const doc = await UlogDocument.open(buffer)
    const { result } = await runModule(sensorsModule as AnalysisModule, doc)

    const families = getChartFamilies(result)
    const accelView = findView(families, 'imu-acceleration')
    const rateView = findView(families, 'imu-angular-rate')

    assert.ok(accelView, 'imu-acceleration view must exist for sensor_combined-only logs')
    assert.ok(rateView, 'imu-angular-rate view must exist for sensor_combined-only logs')

    assert.deepEqual(
      accelView!.series.map((s) => s.label),
      ['X', 'Y', 'Z'],
      'acceleration view must select accelerometer_m_s2[0..2] semantically',
    )
    assert.deepEqual(
      rateView!.series.map((s) => s.label),
      ['X', 'Y', 'Z'],
      'angular-rate view must select gyro_rad[0..2] semantically',
    )

    assert.ok(
      lastTime(accelView!) > durationSec * 0.95,
      `acceleration view must cover the log end (first-N retention forbidden), last=${lastTime(accelView!)}`,
    )
    assert.ok(
      lastTime(rateView!) > durationSec * 0.95,
      `angular-rate view must cover the log end, last=${lastTime(rateView!)}`,
    )
  })
})

// ─── 4. Presentation: one workspace, selector-driven views ──────────────────

describe('corrective regression – chart workspace presentation model', () => {
  function makeFamilies(): RegressionChartFamily[] {
    const view = (id: string, labels: string[]): RegressionChartView => ({
      id,
      title: id,
      unit: 'rad',
      series: labels.map((label, i) => ({
        id: `${id}-${i}`,
        label,
        times: [0, 1],
        values: [0, 1],
      })),
      defaultVisibleSeriesIds: labels.map((_, i) => `${id}-${i}`),
      xAxis: 'time',
    })
    return [
      {
        id: 'control-tracking',
        moduleId: 'control-tracking',
        title: '控制跟踪',
        views: [view('att-roll', ['实际', '设定']), view('att-pitch', ['实际', '设定'])],
        defaultViewId: 'att-roll',
      },
      {
        id: 'actuators',
        moduleId: 'actuators',
        title: '执行器',
        views: [view('motor-outputs', ['电机 1', '电机 2'])],
        defaultViewId: 'motor-outputs',
      },
    ]
  }

  it('returns exactly one active view with families/views available via selectors', () => {
    const buildWorkspace = (chartModel as Record<string, unknown>).buildChartWorkspaceModel as
      | ((families: unknown, familyId?: string | null, viewId?: string | null) => {
          families: RegressionChartFamily[]
          activeFamilyId: string
          activeViewId: string
          activeView: RegressionChartView | null
        })
      | undefined

    assert.ok(
      typeof buildWorkspace === 'function',
      'chartModel must export buildChartWorkspaceModel',
    )

    const families = makeFamilies()
    const model = buildWorkspace!(families)

    // All families reachable via the selector, none pre-rendered as cards.
    assert.equal(model.families.length, 2)
    // Exactly one active view (family default), not an array of mounted views.
    assert.equal(model.activeFamilyId, 'control-tracking')
    assert.equal(model.activeViewId, 'att-roll')
    assert.ok(model.activeView && !Array.isArray(model.activeView))
    assert.equal(model.activeView!.id, 'att-roll')

    // Switching family uses that family's explicit default view.
    const switched = buildWorkspace!(families, 'actuators')
    assert.equal(switched.activeViewId, 'motor-outputs')

    // Invalid view falls back to the family default, never to card-per-view.
    const fallback = buildWorkspace!(families, 'control-tracking', 'nonexistent')
    assert.equal(fallback.activeViewId, 'att-roll')
  })
})
