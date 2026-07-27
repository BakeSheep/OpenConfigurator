// Central PX4 flight-state normalization shared by analysis modules.
//
// Field semantics come from the official message definitions:
// - VehicleStatus.msg:       arming_state — 1 = DISARMED, 2 = ARMED
//   (https://docs.px4.io/main/en/msg_docs/VehicleStatus)
// - ActuatorArmed.msg:       armed — bool
//   (https://docs.px4.io/main/en/msg_docs/ActuatorArmed)
// - VehicleLandDetected.msg: landed — bool
//
// Missing or unknown state yields null — never a coerced false/zero.

export const ARMING_STATE_DISARMED = 1
export const ARMING_STATE_ARMED = 2

/**
 * Read the armed state from one sample of a state topic.
 * Returns null when the sample carries no usable arming information.
 */
export function readArmedState(
  topicName: string,
  values: Readonly<Record<string, unknown>>,
): boolean | null {
  if (topicName === 'vehicle_status') {
    // Real vehicle_status has NO `armed` field — only arming_state counts.
    const armingState = values['arming_state']
    if (typeof armingState === 'number') return armingState === ARMING_STATE_ARMED
    return null
  }
  if (topicName === 'actuator_armed') {
    const armed = values['armed']
    if (typeof armed === 'boolean') return armed
    // ULog bool decodes as uint8 0/1 in some parsers
    if (typeof armed === 'number') return armed !== 0
    return null
  }
  // Old/custom topics (e.g. commander_state) — only when the field exists.
  if ('armed' in values) {
    const armed = values['armed']
    if (typeof armed === 'boolean') return armed
    if (typeof armed === 'number') return armed !== 0
  }
  return null
}

/**
 * Read the landed state from a vehicle_land_detected sample.
 * Returns null when the sample carries no usable landed information.
 */
export function readLandedState(
  topicName: string,
  values: Readonly<Record<string, unknown>>,
): boolean | null {
  if (topicName !== 'vehicle_land_detected') return null
  const landed = values['landed']
  if (typeof landed === 'boolean') return landed
  if (typeof landed === 'number') return landed !== 0
  return null
}

/**
 * Armed-source precedence: prefer vehicle_status.arming_state, then
 * actuator_armed.armed, then legacy/custom `armed` fields.
 */
export type ArmedSource = 'vehicle_status' | 'actuator_armed' | 'other'

export const ARMED_SOURCE_RANK: Record<ArmedSource, number> = {
  vehicle_status: 3,
  actuator_armed: 2,
  other: 1,
}
