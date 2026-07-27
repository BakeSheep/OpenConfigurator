import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  resolveMotorLayout,
  classifyInvalidGap,
  motorLabel,
  GAP_MIN_DURATION_SEC,
  GAP_SUSTAINED_DURATION_SEC,
  type ChannelEvidence,
} from './px4/actuatorLayout.js'

function evidence(overrides: Partial<ChannelEvidence> & { channelIndex: number }): ChannelEvidence {
  return { finiteSamples: 0, finiteArmedSamples: 0, ...overrides }
}

describe('resolveMotorLayout – precedence', () => {
  it('uses a valid CA_ROTOR_COUNT before any data evidence', () => {
    const layout = resolveMotorLayout(
      [{ name: 'CA_ROTOR_COUNT', value: 4 }],
      // Data evidence would suggest 6 — parameter wins
      [0, 1, 2, 3, 4, 5].map((i) => evidence({ channelIndex: i, finiteSamples: 10, finiteArmedSamples: 10 })),
    )
    assert.equal(layout.motorCount, 4)
    assert.deepEqual(layout.configuredChannels, [0, 1, 2, 3])
    assert.equal(layout.source, 'ca-rotor-count')
    assert.equal(layout.inferred, false)
  })

  it('ignores out-of-range CA_ROTOR_COUNT values', () => {
    const layout = resolveMotorLayout(
      [{ name: 'CA_ROTOR_COUNT', value: 0 }],
      [evidence({ channelIndex: 0, finiteSamples: 5, finiteArmedSamples: 5 })],
    )
    assert.equal(layout.source, 'armed-finite')
    assert.equal(layout.motorCount, 1)

    const tooMany = resolveMotorLayout(
      [{ name: 'CA_ROTOR_COUNT', value: 99 }],
      [evidence({ channelIndex: 0, finiteSamples: 5 })],
    )
    assert.notEqual(tooMany.source, 'ca-rotor-count')
  })

  it('uses output-function parameters naming Motor 1–12', () => {
    const layout = resolveMotorLayout(
      [
        { name: 'PWM_MAIN_FUNC1', value: 101 }, // Motor 1
        { name: 'PWM_MAIN_FUNC2', value: 102 }, // Motor 2
        { name: 'PWM_MAIN_FUNC3', value: 201 }, // Servo — not a motor
        { name: 'PWM_MAIN_FUNC4', value: 0 },   // Disabled
      ],
      [],
    )
    assert.equal(layout.motorCount, 2)
    assert.deepEqual(layout.configuredChannels, [0, 1])
    assert.equal(layout.source, 'output-function')
    assert.equal(layout.inferred, false)
  })

  it('falls back to channels finite while armed, marked inferred', () => {
    const layout = resolveMotorLayout(
      [],
      [
        evidence({ channelIndex: 0, finiteSamples: 100, finiteArmedSamples: 90 }),
        evidence({ channelIndex: 1, finiteSamples: 100, finiteArmedSamples: 90 }),
        // Finite only while disarmed (e.g. bench test) — excluded here
        evidence({ channelIndex: 2, finiteSamples: 5, finiteArmedSamples: 0 }),
        // All-NaN slot — never a motor
        evidence({ channelIndex: 3 }),
      ],
    )
    assert.equal(layout.motorCount, 2)
    assert.deepEqual(layout.configuredChannels, [0, 1])
    assert.equal(layout.source, 'armed-finite')
    assert.equal(layout.inferred, true)
  })

  it('falls back to channels finite anywhere when no armed info exists', () => {
    const layout = resolveMotorLayout(
      [],
      [
        evidence({ channelIndex: 0, finiteSamples: 10 }),
        evidence({ channelIndex: 1, finiteSamples: 10 }),
        evidence({ channelIndex: 2 }),
      ],
    )
    assert.equal(layout.motorCount, 2)
    assert.equal(layout.source, 'finite')
    assert.equal(layout.inferred, true)
  })

  it('reports zero motors when no evidence exists', () => {
    const layout = resolveMotorLayout([], [evidence({ channelIndex: 0 })])
    assert.equal(layout.motorCount, 0)
    assert.deepEqual(layout.configuredChannels, [])
    assert.equal(layout.source, 'none')
  })
})

describe('classifyInvalidGap', () => {
  const base = {
    configured: true,
    hadFiniteBefore: true,
    armedDurationSec: 1.0,
    invalidRatio: 0.1,
    isFinalDisarmTransition: false,
    corroborated: false,
  }

  it('never reports unconfigured channels', () => {
    assert.equal(classifyInvalidGap({ ...base, configured: false }), 'none')
  })

  it('never reports channels without prior finite data', () => {
    assert.equal(classifyInvalidGap({ ...base, hadFiniteBefore: false }), 'none')
  })

  it('never reports gaps outside armed intervals', () => {
    assert.equal(classifyInvalidGap({ ...base, armedDurationSec: 0 }), 'none')
  })

  it('never reports the final disarm transition', () => {
    assert.equal(classifyInvalidGap({ ...base, isFinalDisarmTransition: true }), 'none')
  })

  it('a single NaN (tiny duration + ratio) is not reportable', () => {
    assert.equal(
      classifyInvalidGap({
        ...base,
        armedDurationSec: GAP_MIN_DURATION_SEC / 10,
        invalidRatio: 0.001,
      }),
      'none',
    )
  })

  it('short/low-ratio gaps are notices, not critical', () => {
    assert.equal(
      classifyInvalidGap({ ...base, armedDurationSec: 0.5, invalidRatio: 0.06 }),
      'notice',
    )
  })

  it('sustained gaps are warnings without corroboration', () => {
    assert.equal(
      classifyInvalidGap({ ...base, armedDurationSec: GAP_SUSTAINED_DURATION_SEC + 1 }),
      'warning',
    )
  })

  it('critical requires sustained loss plus corroborating evidence', () => {
    assert.equal(
      classifyInvalidGap({
        ...base,
        armedDurationSec: GAP_SUSTAINED_DURATION_SEC + 1,
        corroborated: true,
      }),
      'critical',
    )
  })
})

describe('motorLabel', () => {
  it('formats 1-based user-facing labels from 0-based indices', () => {
    assert.equal(motorLabel(0), '电机 1')
    assert.equal(motorLabel(11), '电机 12')
  })
})
