import assert from 'node:assert/strict'
import { MAVLINK_COMMANDS } from '../../shared/constants'
import type { AutotuneSnapshot } from '../../shared/types'
import {
  ARDUPILOT_ACTION_MAX_RESENDS,
  ARDUPILOT_ACTION_TIMEOUT_MS,
  AUTOTUNE_POLL_INTERVAL_MS,
  AutotuneSession,
  type AutotuneSessionOptions,
} from './AutotuneSession'

type TimerRecord = { at: number; fn: () => void }

class FakeClock {
  nowMs = 0
  private readonly timers = new Set<TimerRecord>()
  readonly now = (): number => this.nowMs
  readonly setTimer = (fn: () => void, ms: number): unknown => {
    const timer = { at: this.nowMs + ms, fn }
    this.timers.add(timer)
    return timer
  }
  readonly clearTimer = (handle: unknown): void => {
    this.timers.delete(handle as TimerRecord)
  }
  advance(ms: number): void {
    const target = this.nowMs + ms
    for (;;) {
      const due = [...this.timers].filter((timer) => timer.at <= target)
        .sort((a, b) => a.at - b.at)[0]
      if (!due) break
      this.timers.delete(due)
      this.nowMs = due.at
      due.fn()
    }
    this.nowMs = target
  }
  get pending(): number { return this.timers.size }
}

function makeSession(overrides: Partial<AutotuneSessionOptions> = {}) {
  const clock = new FakeClock()
  const commands: Array<{ commandId: number; params: number[] }> = []
  const modes: number[] = []
  const snapshots: AutotuneSnapshot[] = []
  const session = new AutotuneSession({
    sessionId: 'session-1',
    requestId: 'request-1',
    family: 'px4',
    initialModeId: 4,
    baselineParameters: { MC_ROLLRATE_P: 0.12 },
    sendCommand: (commandId, params) => {
      commands.push({ commandId, params: [...params] })
      return true
    },
    setMode: (modeId) => {
      modes.push(modeId)
      return true
    },
    emitSnapshot: (snapshot) => snapshots.push(structuredClone(snapshot)),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    ...overrides,
  })
  return { session, clock, commands, modes, snapshots }
}

function last(values: AutotuneSnapshot[]): AutotuneSnapshot {
  assert.ok(values.length > 0)
  return values[values.length - 1]
}

// PX4 command 212 is polled at a bounded interval and ACK progress is semantic.
{
  const h = makeSession()
  h.session.start()
  assert.deepEqual(h.commands[0], {
    commandId: MAVLINK_COMMANDS.MAV_CMD_DO_AUTOTUNE_ENABLE,
    params: [1, 0, 0, 0, 0, 0, 0],
  })
  h.clock.advance(AUTOTUNE_POLL_INTERVAL_MS)
  assert.equal(h.commands.length, 2)
  h.session.handleCommandAck(MAVLINK_COMMANDS.MAV_CMD_DO_AUTOTUNE_ENABLE, 5, 20)
  assert.equal(last(h.snapshots).phase, 'tuning')
  assert.equal(last(h.snapshots).axis, 'roll')
  h.session.handleCommandAck(MAVLINK_COMMANDS.MAV_CMD_DO_AUTOTUNE_ENABLE, 5, 85)
  assert.equal(last(h.snapshots).phase, 'applying')
  h.session.handleCommandAck(MAVLINK_COMMANDS.MAV_CMD_DO_AUTOTUNE_ENABLE, 0, 100)
  assert.equal(last(h.snapshots).phase, 'completed')
  assert.equal(last(h.snapshots).verification, 'firmware_completed')
  assert.equal(h.clock.pending, 0)
  const sends = h.commands.length
  h.clock.advance(AUTOTUNE_POLL_INTERVAL_MS * 2)
  assert.equal(h.commands.length, sends)
}

// PX4 cannot advertise a fake remote cancel.
{
  const h = makeSession()
  h.session.start()
  assert.equal(h.session.cancelSupported, false)
  assert.deepEqual(h.session.action('abort'), { ok: false, code: 'action_unsupported' })
}

// ArduCopter: tune -> success -> test gains -> disarm/save confirmation.
{
  const h = makeSession({ family: 'ardupilot', initialModeId: 5 })
  h.session.start()
  assert.deepEqual(h.modes, [15])
  h.session.handleVehicleStatus({ armed: true, modeId: 15 })
  assert.equal(last(h.snapshots).phase, 'tuning')
  h.session.handleStatustext('AutoTune: Paused: Pilot Override Active')
  assert.equal(last(h.snapshots).phase, 'paused')
  h.session.handleStatustext('AutoTune: Success')
  assert.equal(last(h.snapshots).phase, 'completed')
  assert.equal(h.session.terminal, false)

  assert.deepEqual(h.session.action('test_gains'), { ok: true })
  assert.deepEqual(h.modes, [15, 5])
  h.session.handleVehicleStatus({ armed: true, modeId: 5 })
  assert.deepEqual(h.modes, [15, 5, 15])
  h.session.handleStatustext('AutoTune: Pilot Testing gains')
  assert.equal(last(h.snapshots).phase, 'testing')
  h.session.handleVehicleStatus({ armed: false, modeId: 15 })
  assert.equal(last(h.snapshots).phase, 'save_pending')
  h.session.handleStatustext('AutoTune: Saved gains')
  assert.equal(last(h.snapshots).phase, 'saved')
  assert.equal(last(h.snapshots).verification, 'parameters_saved')
  assert.equal(h.session.terminal, true)
  assert.equal(h.clock.pending, 0)
}

// Mode exit while tuning is a real interruption, not a successful cancel.
{
  const h = makeSession({ family: 'ardupilot', initialModeId: 5 })
  h.session.start()
  h.session.handleVehicleStatus({ armed: true, modeId: 15 })
  h.session.handleVehicleStatus({ armed: true, modeId: 5 })
  assert.equal(last(h.snapshots).phase, 'interrupted')
  assert.equal(last(h.snapshots).failureCode, 'mode_changed')
}

// OCSA-011: an abort whose SET_MODE frame never converges is resent a bounded
// number of times, then failed explicitly instead of pending for 30 minutes.
{
  const h = makeSession({ family: 'ardupilot', initialModeId: 5 })
  h.session.start()
  h.session.handleVehicleStatus({ armed: true, modeId: 15 })
  assert.equal(last(h.snapshots).phase, 'tuning')
  assert.deepEqual(h.session.action('abort'), { ok: true })
  assert.deepEqual(h.modes, [15, 5])
  // Each deadline expiry triggers exactly one automatic resend.
  h.clock.advance(ARDUPILOT_ACTION_TIMEOUT_MS)
  assert.deepEqual(h.modes, [15, 5, 5])
  assert.equal(last(h.snapshots).phase, 'tuning')
  h.clock.advance(ARDUPILOT_ACTION_TIMEOUT_MS)
  assert.deepEqual(h.modes, [15, 5, 5, 5])
  assert.equal(last(h.snapshots).phase, 'tuning')
  // Retry budget exhausted: explicit failure, session back under control.
  h.clock.advance(ARDUPILOT_ACTION_TIMEOUT_MS)
  const snap = last(h.snapshots)
  assert.equal(snap.phase, 'failed')
  assert.equal(snap.failureCode, 'action_timeout')
  assert.match(snap.failureReason ?? '', /多次发送/)
  assert.equal(h.session.terminal, true)
  assert.equal(h.clock.pending, 0)
  // No further resends once the budget is spent.
  h.clock.advance(ARDUPILOT_ACTION_TIMEOUT_MS * 4)
  assert.deepEqual(h.modes, [15, 5, 5, 5])
  // The dead session refuses new actions; a fresh session is the way back.
  assert.deepEqual(h.session.action('abort'), { ok: false, code: 'not_active' })
}

// OCSA-011: late frames answering the retired abort must not be credited as
// convergence evidence of any newer action or revive the failed session.
{
  const h = makeSession({ family: 'ardupilot', initialModeId: 5 })
  h.session.start()
  h.session.handleVehicleStatus({ armed: true, modeId: 15 })
  h.session.action('abort')
  h.clock.advance(ARDUPILOT_ACTION_TIMEOUT_MS * (ARDUPILOT_ACTION_MAX_RESENDS + 1))
  assert.equal(last(h.snapshots).phase, 'failed')
  const snapshotsAfterFailure = h.snapshots.length
  h.session.handleVehicleStatus({ armed: true, modeId: 5 }) // late old mode change
  h.session.handleStatustext('AutoTune: Stopped') // late old statustext
  h.session.handleStatustext('AutoTune: Success')
  assert.equal(h.snapshots.length, snapshotsAfterFailure)
  assert.equal(last(h.snapshots).phase, 'failed')
  assert.equal(last(h.snapshots).failureCode, 'action_timeout')
}

// OCSA-011: a resend must not break convergence evidence that arrives late.
{
  const h = makeSession({ family: 'ardupilot', initialModeId: 5 })
  h.session.start()
  h.session.handleVehicleStatus({ armed: true, modeId: 15 })
  assert.deepEqual(h.session.action('abort'), { ok: true })
  h.clock.advance(ARDUPILOT_ACTION_TIMEOUT_MS)
  assert.deepEqual(h.modes, [15, 5, 5])
  h.session.handleVehicleStatus({ armed: true, modeId: 5 })
  assert.equal(last(h.snapshots).phase, 'discarded')
  assert.equal(h.session.terminal, true)
  assert.equal(h.clock.pending, 0)
}

// OCSA-011: test_gains rides the same bounded, timer-clean resend path.
{
  const h = makeSession({ family: 'ardupilot', initialModeId: 5 })
  h.session.start()
  h.session.handleVehicleStatus({ armed: true, modeId: 15 })
  h.session.handleStatustext('AutoTune: Success')
  assert.equal(last(h.snapshots).phase, 'completed')
  assert.deepEqual(h.session.action('test_gains'), { ok: true })
  // Overall timeout plus the independent action deadline are both armed.
  assert.equal(h.clock.pending, 2)
  h.clock.advance(ARDUPILOT_ACTION_TIMEOUT_MS)
  assert.equal(h.modes[h.modes.length - 1], 5)
  assert.equal(h.clock.pending, 2)
  h.session.handleStatustext('AutoTune: Pilot Testing gains')
  assert.equal(last(h.snapshots).phase, 'testing')
  // Convergence disarms the action deadline; only the overall timer remains.
  assert.equal(h.clock.pending, 1)
}

// A rejected action write stays a synchronous rejection and reopens the lock.
{
  let acceptedModes = 0
  const h = makeSession({
    family: 'ardupilot',
    initialModeId: 5,
    setMode: (modeId) => {
      if (modeId === 5) return false
      acceptedModes += 1
      return true
    },
  })
  h.session.start()
  h.session.handleVehicleStatus({ armed: true, modeId: 15 })
  assert.equal(acceptedModes, 1)
  assert.deepEqual(h.session.action('abort'), { ok: false, code: 'write_rejected' })
  h.clock.advance(ARDUPILOT_ACTION_TIMEOUT_MS * 3)
  assert.equal(last(h.snapshots).phase, 'tuning')
  assert.equal(h.session.terminal, false)
  // The lock was released synchronously, so the action can be retried.
  assert.deepEqual(h.session.action('abort'), { ok: false, code: 'write_rejected' })
}

console.log('AutotuneSession tests passed')
