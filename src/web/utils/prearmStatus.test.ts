import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  latestTargetSessionBoundary,
  PREARM_FAILURE_TTL_MS,
  resolveRecentPrearmFailure,
  type TimedStatusText,
} from './prearmStatus'

const NOW = 100_000
const entry = (id: number, text: string, time: number): TimedStatusText => ({ id, text, time })

describe('resolveRecentPrearmFailure', () => {
  test('lets the newest successful PreArm status clear an older failure', () => {
    const logs = [
      entry(2, 'PreArm: All checks passed', NOW - 1_000),
      entry(1, 'PreArm: GPS 1: Bad fix', NOW - 2_000),
    ]
    assert.equal(resolveRecentPrearmFailure(logs, { now: NOW }), null)
  })

  test('recognizes the explicit ArduPilot Healthy success text', () => {
    assert.equal(
      resolveRecentPrearmFailure([entry(1, 'PreArm: Healthy', NOW - 100)], { now: NOW }),
      null,
    )
  })

  test('returns the newest relevant failure even when entries are not sorted', () => {
    const newest = entry(3, 'Pre-arm: Throttle below failsafe', NOW - 500)
    const logs = [
      entry(1, 'PreArm: EKF not healthy', NOW - 2_000),
      newest,
      entry(2, 'Unrelated warning', NOW - 1_000),
    ]
    assert.equal(resolveRecentPrearmFailure(logs, { now: NOW }), newest)
  })

  test('expires an unresolved failure after the TTL', () => {
    const failure = entry(1, 'PreArm: Compass not calibrated', NOW - PREARM_FAILURE_TTL_MS)
    assert.equal(resolveRecentPrearmFailure([failure], { now: NOW }), null)
  })

  test('does not treat a negative OK phrase as success', () => {
    const failure = entry(1, 'PreArm: Not OK - waiting for GPS', NOW - 1_000)
    assert.equal(resolveRecentPrearmFailure([failure], { now: NOW }), failure)
  })

  test('isolates failures from a previous target session', () => {
    const logs = [
      entry(5, 'PreArm: All checks failed', NOW - 500),
      entry(4, '已选定飞控目标 system 2 / component 1', NOW - 1_000),
      entry(3, 'PreArm: Compass not calibrated', NOW - 2_000),
      entry(2, '已选定飞控目标 system 1 / component 1', NOW - 3_000),
    ]
    const boundary = latestTargetSessionBoundary(logs)
    assert.deepEqual(boundary, { id: 4, time: NOW - 1_000 })
    assert.equal(resolveRecentPrearmFailure(logs, { now: NOW, sessionBoundary: boundary }), logs[0])

    assert.equal(
      resolveRecentPrearmFailure(logs.slice(1), {
        now: NOW,
        sessionBoundary: boundary,
      }),
      null,
    )
  })

  test('uses monotonic status ids to separate same-millisecond sessions', () => {
    const logs = [
      entry(11, 'PreArm: checks passed', NOW),
      entry(10, '已选定飞控目标 system 2 / component 1', NOW),
      entry(9, 'PreArm: Compass not calibrated', NOW),
    ]
    const boundary = latestTargetSessionBoundary(logs)
    assert.equal(resolveRecentPrearmFailure(logs, { now: NOW, sessionBoundary: boundary }), null)

    const currentFailure = entry(12, 'PreArm: GPS 1: Bad fix', NOW)
    assert.equal(
      resolveRecentPrearmFailure([currentFailure, ...logs], {
        now: NOW,
        sessionBoundary: boundary,
      }),
      currentFailure,
    )
  })
})
