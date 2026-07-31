import assert from 'node:assert/strict'
import { parseCalText, PX4_CAL_PROTOCOL_VERSION, type CalProtocolEvent } from './calProtocol'

// ---------------------------------------------------------------------------
// PX4 [cal] STATUSTEXT protocol parser (QGC-compatible). Table-driven: each
// complete reassembled STATUSTEXT line maps to exactly one structured event
// or null. The parser is stateless; version gating is the caller's concern
// except that started events carry the announced version.
// ---------------------------------------------------------------------------

const cases: Array<[string, CalProtocolEvent | null, string]> = [
  // -- started -----------------------------------------------------------------
  [
    '[cal] calibration started: 2 accel',
    { kind: 'started', version: 2, target: 'accel' },
    'accel started',
  ],
  [
    '[cal] calibration started: 2 gyro',
    { kind: 'started', version: 2, target: 'gyro' },
    'gyro started',
  ],
  [
    '[cal] calibration started: 2 mag',
    { kind: 'started', version: 2, target: 'mag' },
    'mag started',
  ],
  [
    '[cal] calibration started: 2 level',
    { kind: 'started', version: 2, target: 'level' },
    'level started',
  ],
  [
    '[cal] calibration started: 3 accel',
    { kind: 'started', version: 3, target: 'accel' },
    'unknown future version still reports started',
  ],
  // -- orientation lifecycle ----------------------------------------------------
  [
    '[cal] down orientation detected',
    { kind: 'orientation_detected', side: 'down' },
    'down detected',
  ],
  [
    '[cal] up orientation detected',
    { kind: 'orientation_detected', side: 'up' },
    'up detected',
  ],
  [
    '[cal] left orientation detected',
    { kind: 'orientation_detected', side: 'left' },
    'left detected',
  ],
  [
    '[cal] right orientation detected',
    { kind: 'orientation_detected', side: 'right' },
    'right detected',
  ],
  [
    '[cal] front orientation detected',
    { kind: 'orientation_detected', side: 'front' },
    'front detected',
  ],
  [
    '[cal] back orientation detected',
    { kind: 'orientation_detected', side: 'back' },
    'back detected',
  ],
  [
    '[cal] down side done, rotate to a different side',
    { kind: 'side_done', side: 'down' },
    'down side done',
  ],
  [
    '[cal] back side done, rotate to a different side',
    { kind: 'side_done', side: 'back' },
    'back side done',
  ],
  [
    '[cal] up side already completed',
    { kind: 'side_already_completed' },
    'side already completed',
  ],
  // -- progress -------------------------------------------------------------
  ['[cal] progress <0>', { kind: 'progress', pct: 0 }, 'progress 0'],
  ['[cal] progress <55>', { kind: 'progress', pct: 55 }, 'progress 55'],
  ['[cal] progress <100>', { kind: 'progress', pct: 100 }, 'progress 100'],
  // -- terminal ---------------------------------------------------------------
  [
    '[cal] calibration done: accel',
    { kind: 'done', target: 'accel' },
    'done accel',
  ],
  [
    '[cal] calibration done: mag',
    { kind: 'done', target: 'mag' },
    'done mag',
  ],
  ['[cal] calibration failed', { kind: 'failed' }, 'failed'],
  [
    '[cal] calibration failed: [cal] motion, moved to [-0.2 0.1 9.8]',
    { kind: 'failed' },
    'failed with reason text',
  ],
  ['[cal] calibration cancelled', { kind: 'cancelled' }, 'cancelled'],
  // -- non-events -------------------------------------------------------------
  ['plain status line without prefix', null, 'no prefix'],
  ['[CAL] down orientation detected', null, 'wrong prefix case is not the protocol'],
  ['[cal] progress <abc>', null, 'non-numeric progress'],
  ['[cal] progress <101>', null, 'progress above 100'],
  ['[cal] progress <-5>', null, 'negative progress'],
  ['[cal] diagonal orientation detected', null, 'unknown side'],
  ['[cal] something entirely different', null, 'unknown [cal] line'],
  ['calibration done: accel', null, 'terminal line without prefix'],
]

for (const [line, expected, label] of cases) {
  const actual = parseCalText(line)
  assert.deepEqual(actual, expected, `${label}: ${line}`)
}

// Supported protocol version constant matches QGC's supported firmware cal version.
assert.equal(PX4_CAL_PROTOCOL_VERSION, 2)

// Parser only accepts strings that are already fully reassembled - it never
// throws on arbitrary junk.
assert.equal(parseCalText(''), null)
assert.equal(parseCalText('[cal]'), null)
assert.equal(parseCalText('[cal] '), null)

console.log('PX4 [cal] protocol parser checks passed')
