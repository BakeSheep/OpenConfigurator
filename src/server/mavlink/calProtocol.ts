// PX4 [cal] STATUSTEXT calibration protocol parser.
//
// PX4 reports calibration lifecycle through STATUSTEXT lines prefixed with
// "[cal] " (QGC: SensorsComponentController::_handleUASTextMessage). This
// module is a stateless pure function that maps one complete, reassembled
// STATUSTEXT line to a structured event; the calibration session state
// machine owns all sequencing, version gating and timeout policy.
//
// Protocol lines (firmware cal version 2):
//   [cal] calibration started: <version> <target>
//   [cal] <side> orientation detected
//   [cal] <side> side done, rotate to a different side
//   [cal] <side> side already completed
//   [cal] progress <pct>
//   [cal] calibration done: <target>
//   [cal] calibration failed[: reason]
//   [cal] calibration cancelled
import type { CalibrationSide } from '../../shared/types'

/** Firmware calibration protocol version this GCS fully understands. */
export const PX4_CAL_PROTOCOL_VERSION = 2

export type CalProtocolEvent =
  | { kind: 'started'; version: number; target: string }
  | { kind: 'orientation_detected'; side: CalibrationSide }
  | { kind: 'side_done'; side: CalibrationSide }
  | { kind: 'side_already_completed' }
  | { kind: 'progress'; pct: number }
  | { kind: 'done'; target: string }
  | { kind: 'failed' }
  | { kind: 'cancelled' }

const CAL_PREFIX = '[cal] '
const STARTED_PATTERN = /^calibration started: (\d{1,3}) ([a-z_]+)$/
const ORIENTATION_PATTERN = /^(down|up|left|right|front|back) orientation detected$/
const SIDE_DONE_PATTERN = /^(down|up|left|right|front|back) side done, rotate to a different side$/
const SIDE_ALREADY_PATTERN = /^(down|up|left|right|front|back) side already completed$/
const PROGRESS_PATTERN = /^progress <(\d{1,3})>$/
const DONE_PATTERN = /^calibration done: ([a-z_]+)$/

/**
 * Parse one full [cal] line. Returns null for anything that is not an exact
 * protocol line - unknown lines must never be guessed into events, and the
 * parser never throws on junk input.
 */
export function parseCalText(text: string): CalProtocolEvent | null {
  if (!text.startsWith(CAL_PREFIX)) return null
  const line = text.slice(CAL_PREFIX.length)

  const started = STARTED_PATTERN.exec(line)
  if (started) {
    return { kind: 'started', version: Number(started[1]), target: started[2] }
  }

  const orientation = ORIENTATION_PATTERN.exec(line)
  if (orientation) {
    return { kind: 'orientation_detected', side: orientation[1] as CalibrationSide }
  }

  const sideDone = SIDE_DONE_PATTERN.exec(line)
  if (sideDone) {
    return { kind: 'side_done', side: sideDone[1] as CalibrationSide }
  }

  if (SIDE_ALREADY_PATTERN.test(line)) {
    return { kind: 'side_already_completed' }
  }

  const progress = PROGRESS_PATTERN.exec(line)
  if (progress) {
    const pct = Number(progress[1])
    if (pct > 100) return null
    return { kind: 'progress', pct }
  }

  const done = DONE_PATTERN.exec(line)
  if (done) {
    return { kind: 'done', target: done[1] }
  }

  // Failure/cancel lines may carry free-form reason suffixes; match by prefix
  // exactly like QGC does.
  if (line.startsWith('calibration failed')) return { kind: 'failed' }
  if (line.startsWith('calibration cancelled')) return { kind: 'cancelled' }

  return null
}
