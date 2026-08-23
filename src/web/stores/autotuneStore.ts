import { create } from 'zustand'
import type { AutotuneSnapshot } from '../../shared/types'

export interface AutotuneRecovery {
  sessionId: string
  recoveryToken: string
}

const STORAGE_KEY = 'openconfigurator.autotuneRecovery'

function terminal(snapshot: AutotuneSnapshot): boolean {
  return snapshot.phase === 'saved'
    || snapshot.phase === 'discarded'
    || snapshot.phase === 'failed'
    || snapshot.phase === 'interrupted'
    || (snapshot.family === 'px4' && snapshot.phase === 'completed')
}

function loadRecovery(): AutotuneRecovery | null {
  if (typeof sessionStorage === 'undefined') return null
  try {
    const value = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? 'null') as Partial<AutotuneRecovery> | null
    return value && typeof value.sessionId === 'string' && typeof value.recoveryToken === 'string'
      ? { sessionId: value.sessionId, recoveryToken: value.recoveryToken }
      : null
  } catch {
    return null
  }
}

function persist(recovery: AutotuneRecovery | null): void {
  if (typeof sessionStorage === 'undefined') return
  try {
    if (recovery) sessionStorage.setItem(STORAGE_KEY, JSON.stringify(recovery))
    else sessionStorage.removeItem(STORAGE_KEY)
  } catch {
    // sessionStorage can be disabled by browser privacy settings.
  }
}

interface AutotuneState {
  snapshot: AutotuneSnapshot | null
  recovery: AutotuneRecovery | null
  applySnapshot: (snapshot: AutotuneSnapshot) => void
  setRecovery: (recovery: AutotuneRecovery) => void
  clearRecovery: () => void
  reset: () => void
}

export const useAutotuneStore = create<AutotuneState>((set, get) => ({
  snapshot: null,
  recovery: loadRecovery(),
  applySnapshot: (snapshot) => {
    let applied = false
    set((state) => {
      if (state.snapshot?.sessionId === snapshot.sessionId
        && snapshot.seq <= state.snapshot.seq) return state
      applied = true
      return { snapshot }
    })
    if (applied && terminal(snapshot)) get().clearRecovery()
  },
  setRecovery: (recovery) => { persist(recovery); set({ recovery }) },
  clearRecovery: () => { persist(null); set({ recovery: null }) },
  reset: () => set({ snapshot: null }),
}))
