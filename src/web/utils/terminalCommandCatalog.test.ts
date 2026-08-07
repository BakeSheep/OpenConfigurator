import assert from 'node:assert/strict'
import { getArduPilotMavproxyCommands, getPx4NshCommands } from './terminalCommandCatalog'
import i18next from 'i18next'

const t = i18next.t.bind(i18next)
const PX4_NSH_COMMANDS = getPx4NshCommands(t)
const ARDUPILOT_MAVPROXY_COMMANDS = getArduPilotMavproxyCommands(t)

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
