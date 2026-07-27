import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  readArmedState,
  readLandedState,
  ARMING_STATE_ARMED,
  ARMING_STATE_DISARMED,
} from './px4/flightState.js'

describe('readArmedState – vehicle_status', () => {
  it('arming_state === 2 means armed', () => {
    assert.equal(readArmedState('vehicle_status', { arming_state: ARMING_STATE_ARMED }), true)
  })

  it('arming_state === 1 means disarmed', () => {
    assert.equal(readArmedState('vehicle_status', { arming_state: ARMING_STATE_DISARMED }), false)
  })

  it('other arming_state values are not armed', () => {
    assert.equal(readArmedState('vehicle_status', { arming_state: 0 }), false)
    assert.equal(readArmedState('vehicle_status', { arming_state: 3 }), false)
  })

  it('missing arming_state returns null, not false', () => {
    assert.equal(readArmedState('vehicle_status', {}), null)
    assert.equal(readArmedState('vehicle_status', { nav_state: 2 }), null)
  })

  it('never relies on an invented vehicle_status.armed field', () => {
    // Even if a custom log had such a field, arming_state is authoritative
    // for vehicle_status and its absence yields null.
    assert.equal(readArmedState('vehicle_status', { armed: 1 }), null)
    assert.equal(readArmedState('vehicle_status', { armed: true }), null)
  })
})

describe('readArmedState – actuator_armed fallback', () => {
  it('reads the boolean armed field', () => {
    assert.equal(readArmedState('actuator_armed', { armed: true }), true)
    assert.equal(readArmedState('actuator_armed', { armed: false }), false)
  })

  it('accepts uint8-decoded bools', () => {
    assert.equal(readArmedState('actuator_armed', { armed: 1 }), true)
    assert.equal(readArmedState('actuator_armed', { armed: 0 }), false)
  })

  it('missing armed returns null', () => {
    assert.equal(readArmedState('actuator_armed', {}), null)
  })
})

describe('readArmedState – legacy/custom fallback', () => {
  it('uses commander_state.armed only when the field actually exists', () => {
    assert.equal(readArmedState('commander_state', { armed: true }), true)
    assert.equal(readArmedState('commander_state', { armed: 0 }), false)
    // Real commander_state has no armed field → null
    assert.equal(readArmedState('commander_state', { main_state: 2 }), null)
  })

  it('unknown topics without armed data return null', () => {
    assert.equal(readArmedState('some_topic', { value: 42 }), null)
  })
})

describe('readLandedState – vehicle_land_detected', () => {
  it('reads landed transitions', () => {
    assert.equal(readLandedState('vehicle_land_detected', { landed: true }), true)
    assert.equal(readLandedState('vehicle_land_detected', { landed: false }), false)
    assert.equal(readLandedState('vehicle_land_detected', { landed: 1 }), true)
    assert.equal(readLandedState('vehicle_land_detected', { landed: 0 }), false)
  })

  it('missing landed returns null, not a default', () => {
    assert.equal(readLandedState('vehicle_land_detected', {}), null)
  })

  it('other topics return null', () => {
    assert.equal(readLandedState('vehicle_status', { landed: 1 }), null)
  })
})
