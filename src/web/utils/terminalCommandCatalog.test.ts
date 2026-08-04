import assert from 'node:assert/strict'
import { ARDUPILOT_MAVPROXY_COMMANDS, PX4_NSH_COMMANDS } from './terminalCommandCatalog'

assert.ok(PX4_NSH_COMMANDS.length >= 4)
assert.ok(PX4_NSH_COMMANDS.flatMap((category) => category.commands).some((entry) => entry.command === 'uorb top'))
assert.ok(PX4_NSH_COMMANDS.flatMap((category) => category.commands).some((entry) => entry.command === 'mavlink status'))
assert.ok(ARDUPILOT_MAVPROXY_COMMANDS.length >= 4)
assert.ok(ARDUPILOT_MAVPROXY_COMMANDS.flatMap((category) => category.commands).some((entry) => entry.command === 'status'))
assert.equal(
  ARDUPILOT_MAVPROXY_COMMANDS.flatMap((category) => category.commands).some((entry) => entry.command.startsWith('arm')),
  false,
  'quick reference must not advertise an arming bypass',
)

console.log('terminalCommandCatalog checks passed')
