import { create } from 'zustand'
import type { CalibrationSnapshot } from '../../shared/types'

/** Recovery token issued by calibration_session_started, kept for reclaim. */
export interface CalibrationRecovery {
  sessionId: string
  recoveryToken: string
}

const CALIBRATION_RECOVERY_STORAGE_KEY = 'openconfigurator.calibrationRecovery'

const TERMINAL_PHASES: ReadonlySet<CalibrationSnapshot['phase']> =
  new Set(['accepted', 'done', 'failed', 'cancelled'])

function loadRecovery(): CalibrationRecovery | null {
  if (typeof sessionStorage === 'undefined') return null
  try {
    const value = JSON.parse(
      sessionStorage.getItem(CALIBRATION_RECOVERY_STORAGE_KEY) ?? 'null',
    ) as Partial<CalibrationRecovery> | null
    return value && typeof value.sessionId === 'string' && typeof value.recoveryToken === 'string'
      ? { sessionId: value.sessionId, recoveryToken: value.recoveryToken }
      : null
  } catch {
    return null
  }
}

function persistRecovery(recovery: CalibrationRecovery | null): void {
  if (typeof sessionStorage === 'undefined') return
  try {
    if (recovery) {
      sessionStorage.setItem(CALIBRATION_RECOVERY_STORAGE_KEY, JSON.stringify(recovery))
    } else {
      sessionStorage.removeItem(CALIBRATION_RECOVERY_STORAGE_KEY)
    }
  } catch {
    // Storage can be unavailable in privacy-restricted browser contexts.
  }
}

interface CalibrationState {
  /** Latest applied snapshot; the sole source of truth for the wizard. */
  snapshot: CalibrationSnapshot | null
  /** Owner-only recovery token, persisted for reclaim across reloads. */
  recovery: CalibrationRecovery | null

  /** Apply a server snapshot, dropping stale/duplicate (sessionId, seq). */
  applySnapshot: (snapshot: CalibrationSnapshot) => void
  setRecovery: (recovery: CalibrationRecovery) => void
  clearRecovery: () => void
  /** True while the current snapshot is a terminal phase. */
  isTerminal: () => boolean
  /** True when the current snapshot is owned by the given client id. */
  isOwner: (clientId: string | null) => boolean
  /** Clear the live snapshot while preserving the token for WS reconnect. */
  reset: () => void
}

/**
 * Calibration state driven entirely by idempotent server snapshots. seq is
 * strictly increasing within one sessionId, so a dropped or reordered frame
 * cannot corrupt the wizard: the store keeps only the newest snapshot and
 * ignores anything not newer than what it already holds. The recovery token
 * is tracked separately (and in sessionStorage) so broadcast snapshots never
 * overwrite it and it survives a page reload for reclaim.
 */
export const useCalibrationStore = create<CalibrationState>((set, get) => ({
  snapshot: null,
  recovery: loadRecovery(),

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
    if (applied && TERMINAL_PHASES.has(snapshot.phase)) get().clearRecovery()
  },

  setRecovery: (recovery) => {
    persistRecovery(recovery)
    set({ recovery })
  },

  clearRecovery: () => {
    persistRecovery(null)
    set({ recovery: null })
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
