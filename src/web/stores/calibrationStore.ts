import { create } from 'zustand'
import type { CalibrationSnapshot } from '../../shared/types'

const TERMINAL_PHASES: ReadonlySet<CalibrationSnapshot['phase']> =
  new Set(['accepted', 'done', 'failed', 'cancelled'])

interface CalibrationState {
  /** Latest applied snapshot; the sole source of truth for the wizard. */
  snapshot: CalibrationSnapshot | null
  /** Apply a Worker snapshot, dropping stale/duplicate (sessionId, seq). */
  applySnapshot: (snapshot: CalibrationSnapshot) => void
  /** True while the current snapshot is a terminal phase. */
  isTerminal: () => boolean
  /** True when the current snapshot is owned by the given client id. */
  isOwner: (clientId: string | null) => boolean
  /** Clear the live tab-local snapshot. */
  reset: () => void
}

/**
 * Calibration state driven entirely by idempotent Worker snapshots. seq is
 * strictly increasing within one sessionId, so a dropped or reordered frame
 * cannot corrupt the wizard: the store keeps only the newest snapshot and
 * ignores anything not newer than what it already holds.
 */
export const useCalibrationStore = create<CalibrationState>((set, get) => ({
  snapshot: null,

  applySnapshot: (snapshot) => {
    let applied = false
    set((state) => {
      const current = state.snapshot
      if (
        current
        && current.sessionId === snapshot.sessionId
        && snapshot.seq <= current.seq
      ) {
        return state
      }
      applied = true
      return { snapshot }
    })
    void applied
  },

  isTerminal: () => {
    const snapshot = get().snapshot
    return snapshot ? TERMINAL_PHASES.has(snapshot.phase) : false
  },

  isOwner: (clientId) => {
    const snapshot = get().snapshot
    return Boolean(clientId && snapshot && snapshot.ownerClientId === clientId)
  },

  reset: () => set({ snapshot: null }),
}))
