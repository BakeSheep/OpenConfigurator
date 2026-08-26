import { create } from 'zustand'
import {
  ESC_LOG_CAPACITY,
  type EscDeviceInfo,
  type EscJobProgressSnapshot,
  type EscJobResult,
  type EscLogEntry,
  type EscOperationError,
  type EscSessionSnapshot,
  type EscSettingsSnapshot,
} from '../../shared/esc'

interface EscState {
  session: EscSessionSnapshot | null
  devices: EscDeviceInfo[]
  settings: Map<number, EscSettingsSnapshot>
  activeJob: EscJobProgressSnapshot | null
  lastJobResult: EscJobResult | null
  lastError: EscOperationError | null
  log: EscLogEntry[]

  applySession: (snapshot: EscSessionSnapshot) => void
  applyDevices: (sessionId: string, escs: EscDeviceInfo[]) => void
  applySettings: (snapshot: EscSettingsSnapshot) => void
  applyProgress: (snapshot: EscJobProgressSnapshot) => void
  applyJobDone: (result: EscJobResult) => void
  applyOpError: (error: EscOperationError) => void
  appendLog: (sessionId: string, entries: EscLogEntry[]) => void
  reset: () => void
}

const INITIAL = {
  session: null as EscSessionSnapshot | null,
  devices: [] as EscDeviceInfo[],
  activeJob: null as EscJobProgressSnapshot | null,
  lastJobResult: null as EscJobResult | null,
  lastError: null as EscOperationError | null,
}

/**
 * ESC session state driven entirely by Worker snapshots. Progress and settings
 * are absolute (never deltas), so a dropped frame cannot corrupt the view; the
 * store simply keeps the latest snapshot per ESC.
 */
export const useEscStore = create<EscState>((set, get) => ({
  ...INITIAL,
  settings: new Map(),
  log: [],

  applySession: (snapshot) => {
    // Session id / mode changes invalidate device + settings state.
    const previous = get().session
    const changed = previous?.sessionId !== snapshot.sessionId
    set((state) => ({
      session: snapshot,
      devices: changed ? [] : state.devices,
      settings: changed ? new Map() : state.settings,
      activeJob: snapshot.activeJobId === null ? null : state.activeJob,
      lastError: changed && snapshot.state !== 'idle' ? null : state.lastError,
    }))
    if (snapshot.state === 'idle') {
      // Keep the last error/log visible but drop live job/device state.
      set({ devices: [], settings: new Map(), activeJob: null })
    }
  },

  applyDevices: (sessionId, escs) => {
    // Ignore stale device lists from a prior session.
    if (get().session?.sessionId !== sessionId) return
    set({ devices: escs, lastError: null })
  },

  applySettings: (snapshot) => {
    if (get().session?.sessionId !== snapshot.sessionId) return
    set((state) => {
      const next = new Map(state.settings)
      next.set(snapshot.escIndex, snapshot)
      return { settings: next }
    })
  },

  applyProgress: (snapshot) => {
    if (get().session?.sessionId !== snapshot.sessionId) return
    set({ activeJob: snapshot })
  },

  applyJobDone: (result) => {
    if (get().session?.sessionId !== result.sessionId) return
    set({ activeJob: null, lastJobResult: result })
  },

  applyOpError: (error) => set({ lastError: error }),

  appendLog: (sessionId, entries) => {
    if (entries.length === 0) return
    // Accept logs for the active session (or when none is known yet).
    const active = get().session?.sessionId
    if (active && active !== sessionId) return
    set((state) => {
      const merged = state.log.concat(entries)
      const overflow = merged.length - ESC_LOG_CAPACITY
      return { log: overflow > 0 ? merged.slice(overflow) : merged }
    })
  },

  reset: () => set({ ...INITIAL, settings: new Map(), log: [] }),
}))
