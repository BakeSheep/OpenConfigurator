import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { smoothGamepadThrottle } from './gamepadThrottle'

describe('smoothGamepadThrottle', () => {
  test('uses the current centered-zero throttle on the first active frame', () => {
    assert.deepEqual(
      smoothGamepadThrottle(-1, null, 0.1, true),
      { output: -1, next: -1 },
    )
  })

  test('uses the current physical throttle after state is reset and re-enabled', () => {
    const beforeDisable = smoothGamepadThrottle(0.8, 0.7, 0.1, true)
    assert.ok(Math.abs(beforeDisable.output - 0.8) < 1e-12)

    // Disabling, losing control, or disconnecting resets the hook's previous
    // value to null. The next active frame therefore snaps to the new stick
    // position instead of slewing from the stale 0.8 value.
    const afterReEnable = smoothGamepadThrottle(-0.65, null, 0.1, true)
    assert.equal(afterReEnable.output, -0.65)
  })

  test('slews only after an active-frame value has been established', () => {
    const result = smoothGamepadThrottle(1, -1, 0.1, true)
    assert.ok(Math.abs(result.output - -0.9) < 1e-12)
    assert.equal(result.next, result.output)
  })

  test('tracks the current input directly when smoothing is disabled', () => {
    assert.deepEqual(
      smoothGamepadThrottle(-0.4, 0.9, 0.1, false),
      { output: -0.4, next: -0.4 },
    )
  })
})
