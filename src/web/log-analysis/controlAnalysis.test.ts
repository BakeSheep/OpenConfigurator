import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { controlTrackingModule } from './modules/controlTracking.js'
import { actuatorsModule } from './modules/actuators.js'
import { flightOverviewModule } from './modules/flightOverview.js'
import type { AnalysisContext, ResolvedSample, ResolvedTopic } from './engine/AnalysisModule.js'

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeTopic(name: string, multiId: number, msgId: number, fields: string[]): ResolvedTopic {
  const fieldMap = new Map<string, string>()
  for (const f of fields) fieldMap.set(f, f)
  return { name, multiId, msgId, fieldMap }
}

function makeCtx(overrides?: Partial<AnalysisContext>): AnalysisContext {
  return {
    resolvedTopics: new Map(),
    logStartSec: 0,
    logEndSec: 100,
    logDuration: 100,
    allSubscriptions: [],
    parameters: [],
    metadata: { vehicleType: null, firmwareVersion: null, airframeName: null },
    ...overrides,
  }
}

function feedControlSamples(
  state: ReturnType<typeof controlTrackingModule.create>,
  samples: Array<{ sample: ResolvedSample; bindName: string }>,
): void {
  for (const { sample, bindName } of samples) {
    controlTrackingModule.consume(state, sample, bindName)
  }
}

// ─── Control Tracking: Quaternion attitude ──────────────────────────────────

describe('controlTracking – quaternion attitude', () => {
  it('computes tracking metrics from quaternion data', () => {
    const attTopic = makeTopic('vehicle_attitude', 0, 10, ['timestamp', 'q[0]', 'q[1]', 'q[2]', 'q[3]'])
    const spTopic = makeTopic('vehicle_attitude_setpoint', 0, 11, [
      'timestamp', 'q_d[0]', 'q_d[1]', 'q_d[2]', 'q_d[3]',
    ])

    const ctx = makeCtx()
    ctx.resolvedTopics.set('attitude', attTopic)
    ctx.resolvedTopics.set('attitudeSetpoint', spTopic)

    const state = controlTrackingModule.create(ctx)

    // Armed throughout (0-10 s)
    const samples: Array<{ sample: ResolvedSample; bindName: string }> = []
    for (let i = 0; i <= 100; i++) {
      const t = i * 0.1
      samples.push({
        sample: { topic: attTopic, timeSec: t, values: { 'q[0]': 0.99, 'q[1]': 0.01, 'q[2]': 0, 'q[3]': 0 } },
        bindName: 'attitude',
      })
      samples.push({
        sample: { topic: spTopic, timeSec: t, values: { 'q_d[0]': 1, 'q_d[1]': 0, 'q_d[2]': 0, 'q_d[3]': 0 } },
        bindName: 'attitudeSetpoint',
      })
    }
    feedControlSamples(state, samples)

    const result = controlTrackingModule.finalize(state, ctx)

    assert.ok(typeof result.metrics.rollRmsError === 'number')
    assert.ok(typeof result.metrics.pitchRmsError === 'number')
    assert.ok(typeof result.metrics.yawRmsError === 'number')
    // Roll should have a small non-zero error (q[1]=0.01 vs 0)
    assert.ok((result.metrics.rollRmsError as number) > 0)
    // Pitch / yaw should be ~0
    assert.ok((result.metrics.pitchRmsError as number) < 0.01)
    assert.ok((result.metrics.yawRmsError as number) < 0.01)
    // Chart family present with one axis-pair view per axis
    assert.ok(result.chartFamilies.length > 0)
    const trackingFamily = result.chartFamilies.find(f => f.id === 'control-tracking')
    assert.ok(trackingFamily, 'control-tracking family exists')
    const rollView = trackingFamily!.views.find(v => v.id === 'att-roll')
    assert.ok(rollView, 'roll attitude view exists')
    assert.deepEqual(
      rollView!.defaultVisibleSeriesIds,
      ['att-roll-actual', 'att-roll-setpoint'],
      'roll view defaults to the actual + setpoint pair',
    )
  })
})

// ─── Control Tracking: Euler fallback ───────────────────────────────────────

describe('controlTracking – Euler fallback', () => {
  it('falls back to Euler when quaternion unavailable', () => {
    const attTopic = makeTopic('vehicle_attitude', 0, 10, ['timestamp', 'roll', 'pitch', 'yaw'])
    const spTopic = makeTopic('vehicle_attitude_setpoint', 0, 11, [
      'timestamp', 'roll_body', 'pitch_body', 'yaw_body',
    ])

    const ctx = makeCtx()
    ctx.resolvedTopics.set('attitude', attTopic)
    ctx.resolvedTopics.set('attitudeSetpoint', spTopic)

    const state = controlTrackingModule.create(ctx)
    const samples: Array<{ sample: ResolvedSample; bindName: string }> = []
    for (let i = 0; i <= 50; i++) {
      const t = i * 0.2
      samples.push({
        sample: { topic: attTopic, timeSec: t, values: { roll: 0.1, pitch: 0.05, yaw: 0 } },
        bindName: 'attitude',
      })
      samples.push({
        sample: { topic: spTopic, timeSec: t, values: { roll_body: 0.15, pitch_body: 0.05, yaw_body: 0 } },
        bindName: 'attitudeSetpoint',
      })
    }
    feedControlSamples(state, samples)

    const result = controlTrackingModule.finalize(state, ctx)

    // Roll error = |0.1 - 0.15| = 0.05 -> RMS ~ 0.05
    assert.ok(Math.abs((result.metrics.rollRmsError as number) - 0.05) < 0.01)
    // Pitch error = 0
    assert.ok((result.metrics.pitchRmsError as number) < 0.01)
    // Provenance
    assert.equal(result.metrics.attitudeProvenance, 'euler')
    assert.equal(result.metrics.setpointProvenance, 'euler')
  })
})

// ─── Control Tracking: Armed-only filtering ─────────────────────────────────

describe('controlTracking – armed-only filtering', () => {
  it('does not calculate tracking scores while disarmed', () => {
    const attTopic = makeTopic('vehicle_attitude', 0, 10, ['timestamp', 'roll', 'pitch', 'yaw'])
    const spTopic = makeTopic('vehicle_attitude_setpoint', 0, 11, [
      'timestamp', 'roll_body', 'pitch_body', 'yaw_body',
    ])
    const vsTopic = makeTopic('vehicle_status', 0, 14, ['timestamp', 'arming_state'])

    const ctx = makeCtx({ logEndSec: 10, logDuration: 10 })
    ctx.resolvedTopics.set('attitude', attTopic)
    ctx.resolvedTopics.set('attitudeSetpoint', spTopic)
    ctx.resolvedTopics.set('vehicleStatus', vsTopic)

    const state = controlTrackingModule.create(ctx)
    const samples: Array<{ sample: ResolvedSample; bindName: string }> = []

    // Disarmed samples (0-4.9 s) — large error
    for (let i = 0; i < 50; i++) {
      const t = i * 0.1
      samples.push({
        sample: { topic: attTopic, timeSec: t, values: { roll: 0.5, pitch: 0, yaw: 0 } },
        bindName: 'attitude',
      })
      samples.push({
        sample: { topic: spTopic, timeSec: t, values: { roll_body: 0, pitch_body: 0, yaw_body: 0 } },
        bindName: 'attitudeSetpoint',
      })
      samples.push({
        sample: { topic: vsTopic, timeSec: t, values: { arming_state: 1 } },
        bindName: 'vehicleStatus',
      })
    }
    // Armed samples (5-10 s) — zero error
    for (let i = 0; i <= 50; i++) {
      const t = 5 + i * 0.1
      samples.push({
        sample: { topic: attTopic, timeSec: t, values: { roll: 0.1, pitch: 0, yaw: 0 } },
        bindName: 'attitude',
      })
      samples.push({
        sample: { topic: spTopic, timeSec: t, values: { roll_body: 0.1, pitch_body: 0, yaw_body: 0 } },
        bindName: 'attitudeSetpoint',
      })
      samples.push({
        sample: { topic: vsTopic, timeSec: t, values: { arming_state: 2 } },
        bindName: 'vehicleStatus',
      })
    }
    feedControlSamples(state, samples)

    const result = controlTrackingModule.finalize(state, ctx)

    // Disarmed samples should be excluded, so RMS should be much less than 0.5
    // (which it would be if disarmed samples were included)
    assert.ok(result.metrics.rollRmsError != null, 'rollRmsError should not be null')
    assert.ok(
      (result.metrics.rollRmsError as number) < 0.15,
      `rollRmsError should be small (armed only), got ${result.metrics.rollRmsError}`,
    )
  })
})

// ─── Control Tracking: Missing setpoints ────────────────────────────────────

describe('controlTracking – missing setpoints', () => {
  it('reports missing requirements when setpoint topics absent', () => {
    const attTopic = makeTopic('vehicle_attitude', 0, 10, ['timestamp', 'roll', 'pitch', 'yaw'])
    const ctx = makeCtx()
    ctx.resolvedTopics.set('attitude', attTopic)
    // No setpoint topics resolved

    const state = controlTrackingModule.create(ctx)
    const result = controlTrackingModule.finalize(state, ctx)

    assert.ok(result.missingRequirements.length > 0)
  })
})

// ─── Control Tracking: Rate tracking ────────────────────────────────────────

describe('controlTracking – rate tracking', () => {
  it('computes rate tracking metrics', () => {
    const ratesTopic = makeTopic('vehicle_rates_setpoint', 0, 12, ['timestamp', 'roll', 'pitch', 'yaw'])
    const angVelTopic = makeTopic('vehicle_angular_velocity', 0, 13, ['timestamp', 'xyz[0]', 'xyz[1]', 'xyz[2]'])
    const vsTopic = makeTopic('vehicle_status', 0, 14, ['timestamp', 'arming_state'])

    const ctx = makeCtx({ logEndSec: 10, logDuration: 10 })
    ctx.resolvedTopics.set('ratesSetpoint', ratesTopic)
    ctx.resolvedTopics.set('angularVelocity', angVelTopic)
    ctx.resolvedTopics.set('vehicleStatus', vsTopic)

    const state = controlTrackingModule.create(ctx)
    const samples: Array<{ sample: ResolvedSample; bindName: string }> = []
    for (let i = 0; i <= 50; i++) {
      const t = i * 0.2
      samples.push({
        sample: { topic: ratesTopic, timeSec: t, values: { roll: 1.0, pitch: 0, yaw: 0 } },
        bindName: 'ratesSetpoint',
      })
      samples.push({
        sample: { topic: angVelTopic, timeSec: t, values: { 'xyz[0]': 0.9, 'xyz[1]': 0, 'xyz[2]': 0 } },
        bindName: 'angularVelocity',
      })
      samples.push({
        sample: { topic: vsTopic, timeSec: t, values: { arming_state: 2 } },
        bindName: 'vehicleStatus',
      })
    }
    feedControlSamples(state, samples)

    const result = controlTrackingModule.finalize(state, ctx)

    // Rate roll error ~ 0.1 -> RMS ~ 0.1
    assert.ok(typeof result.metrics.rollRateRmsError === 'number')
    assert.ok(Math.abs((result.metrics.rollRateRmsError as number) - 0.1) < 0.02)
  })
})

// ─── Actuators: Motor statistics ────────────────────────────────────────────

describe('actuators – motor statistics', () => {
  it('computes per-motor statistics and records invalid samples without false alarms', () => {
    const motorsTopic = makeTopic('actuator_motors', 0, 20, [
      'timestamp', 'control[0]', 'control[1]', 'control[2]', 'control[3]',
    ])

    const ctx = makeCtx()
    ctx.resolvedTopics.set('motors', motorsTopic)

    const state = actuatorsModule.create(ctx)

    // 10 samples, motor 2 has NaN in some
    const samples: Array<{ sample: ResolvedSample; bindName: string }> = []
    for (let i = 0; i < 10; i++) {
      const t = i * 0.5
      const values: Record<string, number> = {
        'control[0]': 0.5,
        'control[1]': 0.6,
        'control[2]': i < 5 ? 0.3 : NaN,
        'control[3]': 0.4,
      }
      samples.push({
        sample: { topic: motorsTopic, timeSec: t, values },
        bindName: 'motors',
      })
    }
    for (const { sample, bindName } of samples) {
      actuatorsModule.consume(state, sample, bindName)
    }

    const result = actuatorsModule.finalize(state, ctx)

    // All four channels produced finite data → inferred as 4 motors
    assert.equal(result.metrics.motorCount, 4)
    const stats = (result.metrics.motorStats as Array<{ channelIndex: number; min: number; max: number; invalidSamples: number }>)
    assert.deepEqual(stats.map(s => s.channelIndex), [0, 1, 2, 3])
    // The NaN stretch on motor 3 (index 2) is recorded as evidence…
    assert.ok(stats[2]!.invalidSamples > 0)
    // …but without armed intervals it must NOT become a finding
    assert.equal(result.findings.filter(f => f.id.includes('nan-gap')).length, 0)
    assert.ok(result.chartFamilies.length > 0)
  })

  it('reports a sustained armed invalid gap as warning, never critical without corroboration', () => {
    const motorsTopic = makeTopic('actuator_motors', 0, 20, [
      'timestamp', 'control[0]', 'control[1]',
    ])
    const vsTopic = makeTopic('vehicle_status', 0, 21, ['timestamp', 'arming_state'])

    const ctx = makeCtx({ logEndSec: 20, logDuration: 20 })
    ctx.resolvedTopics.set('motors', motorsTopic)
    ctx.resolvedTopics.set('vehicleStatus', vsTopic)

    const state = actuatorsModule.create(ctx)
    // Armed 0–20s
    for (let t = 0; t <= 20; t++) {
      actuatorsModule.consume(state, {
        topic: vsTopic, timeSec: t, values: { arming_state: t < 19 ? 2 : 1 },
      }, 'vehicleStatus')
    }
    // Motor 2 (index 1) produces data 0–5s, then NaN 5–15s (sustained, armed), then recovers
    for (let i = 0; i <= 200; i++) {
      const t = i * 0.1
      actuatorsModule.consume(state, {
        topic: motorsTopic, timeSec: t,
        values: {
          'control[0]': 0.5,
          'control[1]': t < 5 || t > 15 ? 0.5 : NaN,
        },
      }, 'motors')
    }

    const result = actuatorsModule.finalize(state, ctx)
    const gapFindings = result.findings.filter(f => f.id.includes('nan-gap'))
    assert.equal(gapFindings.length, 1, 'exactly one sustained gap finding')
    assert.equal(gapFindings[0]!.severity, 'warning', 'sustained gap without ESC evidence is warning, not critical')
    assert.ok(gapFindings[0]!.title.includes('电机 2'), 'labels are 1-based')
  })
})

// ─── Actuators: PWM outputs with servos ─────────────────────────────────────

describe('actuators – PWM outputs with servos', () => {
  it('handles actuator_outputs as generic outputs', () => {
    const outputsTopic = makeTopic('actuator_outputs', 0, 21, [
      'timestamp', 'output[0]', 'output[1]', 'output[2]', 'output[3]',
    ])

    const ctx = makeCtx()
    ctx.resolvedTopics.set('outputs', outputsTopic)

    const state = actuatorsModule.create(ctx)
    const samples: Array<{ sample: ResolvedSample; bindName: string }> = []
    for (let i = 0; i < 10; i++) {
      samples.push({
        sample: {
          topic: outputsTopic,
          timeSec: i * 0.5,
          values: { 'output[0]': 1200, 'output[1]': 1300, 'output[2]': 1500, 'output[3]': 1700 },
        },
        bindName: 'outputs',
      })
    }
    for (const { sample, bindName } of samples) {
      actuatorsModule.consume(state, sample, bindName)
    }

    const result = actuatorsModule.finalize(state, ctx)
    assert.ok((result.metrics.outputCount as number) >= 4)
  })
})

// ─── Actuators: Saturation detection ────────────────────────────────────────

describe('actuators – saturation detection', () => {
  it('detects sustained saturation with configured PWM limits', () => {
    const motorsTopic = makeTopic('actuator_motors', 0, 20, [
      'timestamp', 'control[0]', 'control[1]',
    ])

    const ctx = makeCtx({
      parameters: [
        { name: 'PWM_MIN', value: 1000 },
        { name: 'PWM_MAX', value: 2000 },
      ],
    })
    ctx.resolvedTopics.set('motors', motorsTopic)

    const state = actuatorsModule.create(ctx)
    const samples: Array<{ sample: ResolvedSample; bindName: string }> = []
    // Motor 0 at max for 5 seconds (sustained saturation)
    for (let i = 0; i < 50; i++) {
      samples.push({
        sample: {
          topic: motorsTopic,
          timeSec: i * 0.1,
          values: { 'control[0]': 1.0, 'control[1]': 0.5 },
        },
        bindName: 'motors',
      })
    }
    for (const { sample, bindName } of samples) {
      actuatorsModule.consume(state, sample, bindName)
    }

    const result = actuatorsModule.finalize(state, ctx)
    // Should have a saturation finding
    const satFinding = result.findings.find(f => f.id.includes('saturation'))
    assert.ok(satFinding, 'should have saturation finding')
  })
})

// ─── Actuators: Missing requirements ────────────────────────────────────────

describe('actuators – missing requirements', () => {
  it('reports missing when no motor or output topics available', () => {
    const ctx = makeCtx()
    // No motor or output topics

    const state = actuatorsModule.create(ctx)
    const result = actuatorsModule.finalize(state, ctx)

    assert.ok(result.missingRequirements.length > 0)
  })
})

// ─── Flight Overview: Basic metrics ─────────────────────────────────────────

describe('flightOverview – basic metrics', () => {
  it('computes armed and flight duration', () => {
    const vsTopic = makeTopic('vehicle_status', 0, 30, ['timestamp', 'arming_state', 'nav_state'])
    const ldTopic = makeTopic('vehicle_land_detected', 0, 31, ['timestamp', 'landed'])

    const ctx = makeCtx({ logDuration: 100, logEndSec: 100 })
    ctx.resolvedTopics.set('vehicleStatus', vsTopic)
    ctx.resolvedTopics.set('landDetected', ldTopic)

    const state = flightOverviewModule.create(ctx)

    // Armed at t=10, not landed from t=15 to t=80, landed at t=80, disarm at t=90
    const samples: Array<{ sample: ResolvedSample; bindName: string }> = []
    for (let t = 0; t <= 100; t += 1) {
      samples.push({
        sample: {
          topic: vsTopic, timeSec: t,
          values: { arming_state: t >= 10 && t <= 90 ? 2 : 1, nav_state: t < 30 ? 0 : 1 },
        },
        bindName: 'vehicleStatus',
      })
      samples.push({
        sample: {
          topic: ldTopic, timeSec: t,
          values: { landed: t < 15 || t >= 80 ? 1 : 0 },
        },
        bindName: 'landDetected',
      })
    }
    for (const { sample, bindName } of samples) {
      flightOverviewModule.consume(state, sample, bindName)
    }

    const result = flightOverviewModule.finalize(state, ctx)

    assert.ok((result.metrics.armedDurationSec as number) > 0)
    assert.ok((result.metrics.flightDurationSec as number) > 0)
    // Armed 10-90 = 80s
    assert.ok(Math.abs((result.metrics.armedDurationSec as number) - 80) < 3)
    // Flight (armed + not landed): 15-80 = 65s
    assert.ok(Math.abs((result.metrics.flightDurationSec as number) - 65) < 3)
  })
})

// ─── Flight Overview: Mode timeline ─────────────────────────────────────────

describe('flightOverview – mode timeline', () => {
  it('detects mode transitions', () => {
    const vsTopic = makeTopic('vehicle_status', 0, 30, ['timestamp', 'arming_state', 'nav_state'])
    const ctx = makeCtx()
    ctx.resolvedTopics.set('vehicleStatus', vsTopic)

    const state = flightOverviewModule.create(ctx)
    const samples: Array<{ sample: ResolvedSample; bindName: string }> = []
    // Mode 0 for t=0-30, mode 1 for t=31-60, mode 3 for t=61-100
    for (let t = 0; t <= 100; t += 1) {
      const mode = t <= 30 ? 0 : t <= 60 ? 1 : 3
      samples.push({
        sample: { topic: vsTopic, timeSec: t, values: { arming_state: 1, nav_state: mode } },
        bindName: 'vehicleStatus',
      })
    }
    for (const { sample, bindName } of samples) {
      flightOverviewModule.consume(state, sample, bindName)
    }

    const result = flightOverviewModule.finalize(state, ctx)
    const timeline = result.metrics.modeTimeline as Array<{ timeSec: number; mode: string }>
    assert.ok(timeline.length >= 2, `expected >= 2 mode transitions, got ${timeline.length}`)
    // Should be chronologically sorted
    for (let i = 1; i < timeline.length; i++) {
      assert.ok(timeline[i]!.timeSec >= timeline[i - 1]!.timeSec)
    }
  })
})

// ─── Flight Overview: Findings ──────────────────────────────────────────────

describe('flightOverview – findings', () => {
  it('reports very short log', () => {
    const vsTopic = makeTopic('vehicle_status', 0, 30, ['timestamp', 'arming_state', 'nav_state'])
    const ctx = makeCtx({ logDuration: 10, logEndSec: 10 })
    ctx.resolvedTopics.set('vehicleStatus', vsTopic)

    const state = flightOverviewModule.create(ctx)
    for (let t = 0; t <= 10; t += 1) {
      flightOverviewModule.consume(state, {
        topic: vsTopic, timeSec: t, values: { arming_state: 1, nav_state: 0 },
      }, 'vehicleStatus')
    }

    const result = flightOverviewModule.finalize(state, ctx)
    const finding = result.findings.find(f => f.id.includes('short-log'))
    assert.ok(finding, 'should have short log finding')
    assert.equal(finding!.severity, 'notice')
  })

  it('reports no armed period', () => {
    const vsTopic = makeTopic('vehicle_status', 0, 30, ['timestamp', 'arming_state', 'nav_state'])
    const ctx = makeCtx({ logDuration: 60, logEndSec: 60 })
    ctx.resolvedTopics.set('vehicleStatus', vsTopic)

    const state = flightOverviewModule.create(ctx)
    for (let t = 0; t <= 60; t += 1) {
      flightOverviewModule.consume(state, {
        topic: vsTopic, timeSec: t, values: { arming_state: 1, nav_state: 0 },
      }, 'vehicleStatus')
    }

    const result = flightOverviewModule.finalize(state, ctx)
    const finding = result.findings.find(f => f.id.includes('no-armed'))
    assert.ok(finding, 'should have no-armed finding')
    assert.equal(finding!.severity, 'notice')
  })
})

// ─── Flight Overview: Takeoff / landing ─────────────────────────────────────

describe('flightOverview – takeoff and landing', () => {
  it('detects takeoff and landing times', () => {
    const vsTopic = makeTopic('vehicle_status', 0, 30, ['timestamp', 'arming_state', 'nav_state'])
    const ldTopic = makeTopic('vehicle_land_detected', 0, 31, ['timestamp', 'landed'])

    const ctx = makeCtx({ logDuration: 100, logEndSec: 100 })
    ctx.resolvedTopics.set('vehicleStatus', vsTopic)
    ctx.resolvedTopics.set('landDetected', ldTopic)

    const state = flightOverviewModule.create(ctx)
    // Armed at t=10, takeoff (landed->not-landed) at t=20, landing at t=80
    for (let t = 0; t <= 100; t += 1) {
      flightOverviewModule.consume(state, {
        topic: vsTopic, timeSec: t,
        values: { arming_state: t >= 10 ? 2 : 1, nav_state: 0 },
      }, 'vehicleStatus')
      flightOverviewModule.consume(state, {
        topic: ldTopic, timeSec: t,
        values: { landed: t < 20 || t >= 80 ? 1 : 0 },
      }, 'landDetected')
    }

    const result = flightOverviewModule.finalize(state, ctx)
    assert.ok(result.metrics.takeoffTimeSec != null, 'should detect takeoff')
    assert.ok((result.metrics.takeoffTimeSec as number) >= 19 && (result.metrics.takeoffTimeSec as number) <= 22)
    assert.ok(result.metrics.landTimeSec != null, 'should detect landing')
    assert.ok((result.metrics.landTimeSec as number) >= 79 && (result.metrics.landTimeSec as number) <= 82)
  })
})
