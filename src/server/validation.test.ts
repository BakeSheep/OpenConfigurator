import assert from 'node:assert/strict'
import { InputValidationError, parseClientMessage } from './validation'

// ---------------------------------------------------------------------------
// Boundary validation for calibration session messages. The parser must be a
// strict discriminated-union check: wrong actions, missing session ids, bad
// positions and unexpected fields are all rejected before reaching the bridge.
// ---------------------------------------------------------------------------

function expectFail(value: unknown, code: string, label: string): void {
  try {
    parseClientMessage(value)
  } catch (error) {
    assert.ok(error instanceof InputValidationError, `${label}: expected InputValidationError`)
    assert.equal(error.code, code, `${label}: expected code ${code}, got ${error.code}`)
    return
  }
  assert.fail(`${label}: expected rejection with ${code}`)
}

const SESSION_ID = 'a1b2c3d4-e5f6-4711-8123-456789abcdef'
const RECOVERY_TOKEN = 'tok_ABCDEF0123456789'

// Calibration protocol commands are session-manager-only. The generic
// command surface must not bypass stack, armed-state or owner gates.
for (const cmd of [
  'MAV_CMD_DO_START_MAG_CAL',
  'MAV_CMD_DO_ACCEPT_MAG_CAL',
  'MAV_CMD_DO_CANCEL_MAG_CAL',
  'MAV_CMD_ACCELCAL_VEHICLE_POS',
]) {
  expectFail(
    { type: 'command', cmd, params: [0, 0, 0, 0, 0, 0, 0] },
    'restricted_command',
    `generic ${cmd}`,
  )
}

// -- start_calibration: all six kinds are accepted verbatim ------------------
for (const kind of ['accel', 'accel_simple', 'gyro', 'mag', 'baro', 'level']) {
  const parsed = parseClientMessage({
    type: 'start_calibration',
    requestId: `cal-${kind}`,
    data: { kind },
  })
  assert.equal(parsed.type, 'start_calibration')
  if (parsed.type === 'start_calibration') assert.equal(parsed.data.kind, kind)
}

// Unknown kinds and lookalike strings are rejected as a set membership check,
// not a string-length heuristic.
expectFail(
  { type: 'start_calibration', requestId: 'cal-x', data: { kind: 'esc' } },
  'invalid_calibration_kind',
  'unknown kind',
)
expectFail(
  { type: 'start_calibration', requestId: 'cal-x', data: { kind: 'accel_' } },
  'invalid_calibration_kind',
  'prefix lookalike kind',
)
expectFail(
  { type: 'start_calibration', requestId: 'cal-x', data: { kind: 42 } },
  'invalid_type',
  'non-string kind',
)
expectFail(
  { type: 'start_calibration', data: { kind: 'accel' } },
  'missing_request_id',
  'start without requestId',
)

// -- calibration_action: strict per-action shape -----------------------------
const cancel = parseClientMessage({
  type: 'calibration_action',
  requestId: 'act-1',
  data: { sessionId: SESSION_ID, action: 'cancel' },
})
assert.equal(cancel.type, 'calibration_action')
if (cancel.type === 'calibration_action') {
  assert.equal(cancel.data.action, 'cancel')
  assert.equal(cancel.data.sessionId, SESSION_ID)
}

const acceptMag = parseClientMessage({
  type: 'calibration_action',
  requestId: 'act-2',
  data: { sessionId: SESSION_ID, action: 'accept_mag' },
})
assert.equal(acceptMag.type, 'calibration_action')

for (const position of [1, 2, 3, 4, 5, 6]) {
  const confirm = parseClientMessage({
    type: 'calibration_action',
    requestId: `act-pos-${position}`,
    data: { sessionId: SESSION_ID, action: 'confirm_position', position },
  })
  assert.equal(confirm.type, 'calibration_action')
  if (confirm.type === 'calibration_action' && confirm.data.action === 'confirm_position') {
    assert.equal(confirm.data.position, position)
  }
}

expectFail(
  {
    type: 'calibration_action',
    requestId: 'act-x',
    data: { sessionId: SESSION_ID, action: 'confirm_position', position: 0 },
  },
  'out_of_range',
  'position below range',
)
expectFail(
  {
    type: 'calibration_action',
    requestId: 'act-x',
    data: { sessionId: SESSION_ID, action: 'confirm_position', position: 7 },
  },
  'out_of_range',
  'position above range',
)
expectFail(
  {
    type: 'calibration_action',
    requestId: 'act-x',
    data: { sessionId: SESSION_ID, action: 'confirm_position', position: 2.5 },
  },
  'invalid_integer',
  'fractional position',
)
expectFail(
  {
    type: 'calibration_action',
    requestId: 'act-x',
    data: { sessionId: SESSION_ID, action: 'confirm_position' },
  },
  'invalid_number',
  'confirm without position',
)
expectFail(
  {
    type: 'calibration_action',
    requestId: 'act-x',
    data: { sessionId: SESSION_ID, action: 'cancel', position: 1 },
  },
  'unexpected_field',
  'cancel with extra position field',
)
expectFail(
  {
    type: 'calibration_action',
    requestId: 'act-x',
    data: { sessionId: SESSION_ID, action: 'accept_mag', extra: true },
  },
  'unexpected_field',
  'accept_mag with unknown field',
)
expectFail(
  {
    type: 'calibration_action',
    requestId: 'act-x',
    data: { sessionId: SESSION_ID, action: 'format_eeprom' },
  },
  'invalid_calibration_action',
  'unknown action',
)
expectFail(
  { type: 'calibration_action', requestId: 'act-x', data: { action: 'cancel' } },
  'invalid_type',
  'missing sessionId',
)
expectFail(
  {
    type: 'calibration_action',
    requestId: 'act-x',
    data: { sessionId: 'short', action: 'cancel' },
  },
  'out_of_range',
  'sessionId too short',
)
expectFail(
  {
    type: 'calibration_action',
    requestId: 'act-x',
    data: { sessionId: 'zzzzzzzzzzzz!!', action: 'cancel' },
  },
  'invalid_format',
  'sessionId bad characters',
)
expectFail(
  { type: 'calibration_action', data: { sessionId: SESSION_ID, action: 'cancel' } },
  'missing_request_id',
  'action without requestId',
)

// -- calibration_reclaim ------------------------------------------------------
const reclaim = parseClientMessage({
  type: 'calibration_reclaim',
  requestId: 'rec-1',
  data: { sessionId: SESSION_ID, recoveryToken: RECOVERY_TOKEN },
})
assert.equal(reclaim.type, 'calibration_reclaim')
if (reclaim.type === 'calibration_reclaim') {
  assert.equal(reclaim.data.sessionId, SESSION_ID)
  assert.equal(reclaim.data.recoveryToken, RECOVERY_TOKEN)
}

expectFail(
  {
    type: 'calibration_reclaim',
    requestId: 'rec-x',
    data: { sessionId: SESSION_ID, recoveryToken: 'short' },
  },
  'out_of_range',
  'recovery token too short',
)
expectFail(
  {
    type: 'calibration_reclaim',
    requestId: 'rec-x',
    data: { sessionId: SESSION_ID, recoveryToken: 'bad token with spaces!' },
  },
  'invalid_format',
  'recovery token bad characters',
)
expectFail(
  {
    type: 'calibration_reclaim',
    requestId: 'rec-x',
    data: { recoveryToken: RECOVERY_TOKEN },
  },
  'invalid_type',
  'reclaim missing sessionId',
)
expectFail(
  {
    type: 'calibration_reclaim',
    data: { sessionId: SESSION_ID, recoveryToken: RECOVERY_TOKEN },
  },
  'missing_request_id',
  'reclaim without requestId',
)
expectFail(
  {
    type: 'calibration_reclaim',
    requestId: 'rec-x',
    data: { sessionId: SESSION_ID, recoveryToken: RECOVERY_TOKEN, extra: 1 },
  },
  'unexpected_field',
  'reclaim with unknown field',
)

const messageRates = parseClientMessage({
  type: 'message_rates_set',
  requestId: 'rates-1',
  data: { attitude: 8, position: 2, sensors: 2, rc: 2, status: 1, hud: 1, auxiliary: 2 },
})
assert.equal(messageRates.type, 'message_rates_set')
if (messageRates.type === 'message_rates_set') assert.equal(messageRates.data.auxiliary, 2)
expectFail(
  {
    type: 'message_rates_set',
    data: { attitude: 8, position: 2, sensors: 2, rc: 2, status: 1, hud: 1, auxiliary: 60 },
  },
  'out_of_range',
  'message rate above supported range',
)
expectFail(
  {
    type: 'message_rates_set',
    data: { attitude: 8, position: 2, sensors: 3, rc: 2, status: 1, hud: 1, auxiliary: 2 },
  },
  'unsupported_message_rate',
  'message rate outside the select options',
)

console.log('calibration boundary validation checks passed')
