import assert from 'node:assert/strict'
import { InputValidationError, parseRuntimeCommand } from './validation'

// ---------------------------------------------------------------------------
// Boundary validation for calibration session messages. The parser must be a
// strict discriminated-union check: wrong actions, missing session ids, bad
// positions and unexpected fields are all rejected before reaching the bridge.
// ---------------------------------------------------------------------------

function expectFail(value: unknown, code: string, label: string): void {
  try {
    parseRuntimeCommand(value)
  } catch (error) {
    assert.ok(error instanceof InputValidationError, `${label}: expected InputValidationError`)
    assert.equal(error.code, code, `${label}: expected code ${code}, got ${error.code}`)
    return
  }
  assert.fail(`${label}: expected rejection with ${code}`)
}

const SESSION_ID = 'a1b2c3d4-e5f6-4711-8123-456789abcdef'
const SAFETY_AUTHORITY_ID = '123e4567-e89b-42d3-a456-426614174000'

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
  const parsed = parseRuntimeCommand({
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
const cancel = parseRuntimeCommand({
  type: 'calibration_action',
  requestId: 'act-1',
  data: { sessionId: SESSION_ID, action: 'cancel' },
})
assert.equal(cancel.type, 'calibration_action')
if (cancel.type === 'calibration_action') {
  assert.equal(cancel.data.action, 'cancel')
  assert.equal(cancel.data.sessionId, SESSION_ID)
}

const acceptMag = parseRuntimeCommand({
  type: 'calibration_action',
  requestId: 'act-2',
  data: { sessionId: SESSION_ID, action: 'accept_mag' },
})
assert.equal(acceptMag.type, 'calibration_action')

for (const position of [1, 2, 3, 4, 5, 6]) {
  const confirm = parseRuntimeCommand({
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

const messageRates = parseRuntimeCommand({
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

const shellOpen = parseRuntimeCommand({ type: 'shell_open', requestId: 'shell-1' })
assert.equal(shellOpen.type, 'shell_open')
const shellWrite = parseRuntimeCommand({ type: 'shell_write', data: { text: 'ver hw\r' } })
assert.equal(shellWrite.type, 'shell_write')
if (shellWrite.type === 'shell_write') assert.equal(shellWrite.data.text, 'ver hw\r')
assert.equal(parseRuntimeCommand({ type: 'shell_close' }).type, 'shell_close')
expectFail(
  { type: 'shell_write', data: { text: 'bad\0input' } },
  'invalid_format',
  'shell input containing NUL',
)
expectFail(
  { type: 'shell_write', data: { text: '' } },
  'out_of_range',
  'empty shell input',
)

const configSet = parseRuntimeCommand({
  type: 'vehicle_config_set',
  requestId: 'cfg-1',
  feature: 'safety',
  data: { id: 'NAV_RCL_ACT', value: 0 },
  safetyConfirmation: 'reduce_failsafe_protection',
  expectedSafetyEpoch: 4,
  expectedSafetyAuthorityId: SAFETY_AUTHORITY_ID,
})
assert.equal(configSet.type, 'vehicle_config_set')
if (configSet.type === 'vehicle_config_set') {
  assert.equal(configSet.data.id, 'NAV_RCL_ACT')
  assert.equal(configSet.expectedSafetyEpoch, 4)
}
expectFail(
  {
    type: 'vehicle_config_set', requestId: 'cfg-x', feature: 'safety',
    data: { id: 'NAV_RCL_ACT', value: 0 },
    safetyConfirmation: 'reduce_failsafe_protection',
  },
  'safety_epoch_required',
  'safety reduction without authority context',
)
expectFail(
  { type: 'vehicle_config_set', requestId: 'cfg-x', feature: 'camera', data: { id: 'X', value: 1 } },
  'invalid_feature',
  'unknown vehicle config feature',
)

const px4Airframe = parseRuntimeCommand({
  type: 'airframe_apply',
  requestId: 'frame-1',
  safetyConfirmation: 'apply_airframe',
  expectedSafetyEpoch: 5,
  expectedSafetyAuthorityId: SAFETY_AUTHORITY_ID,
  data: { family: 'px4', autostartId: 4001 },
})
assert.equal(px4Airframe.type, 'airframe_apply')
expectFail(
  {
    type: 'airframe_apply', requestId: 'frame-x', safetyConfirmation: 'apply_airframe',
    data: { family: 'px4', autostartId: 4001 },
  },
  'safety_epoch_required',
  'airframe without authority context',
)

assert.equal(parseRuntimeCommand({
  type: 'radio_calibration_start',
  requestId: 'radio-1',
  expectedSafetyEpoch: 6,
  expectedSafetyAuthorityId: SAFETY_AUTHORITY_ID,
  data: { transmitterMode: 2 },
}).type, 'radio_calibration_start')
expectFail(
  { type: 'radio_calibration_start', requestId: 'radio-x', data: { transmitterMode: 2 } },
  'safety_epoch_required',
  'radio calibration without authority context',
)

console.log('calibration boundary validation checks passed')
