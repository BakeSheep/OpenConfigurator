import { create } from 'zustand'
import type { RadioCalibrationSnapshot, ServerMessage } from '../../shared/types'

type ConfigResult = Extract<ServerMessage, { type: 'vehicle_config_set_result' }>['data'] & { time: number }
type AirframeStatus = Extract<ServerMessage, { type: 'airframe_apply_status' }>['data'] & { time: number }

interface RadioRecovery {
  sessionId: string
  recoveryToken: string
}

const RADIO_RECOVERY_KEY = 'openconfigurator.radioCalibrationRecovery'

function loadRadioRecovery(): RadioRecovery | null {
  if (typeof sessionStorage === 'undefined') return null
  try {
    const value = JSON.parse(sessionStorage.getItem(RADIO_RECOVERY_KEY) ?? 'null') as Partial<RadioRecovery> | null
    return value && typeof value.sessionId === 'string' && typeof value.recoveryToken === 'string'
      ? { sessionId: value.sessionId, recoveryToken: value.recoveryToken }
      : null
  } catch { return null }
}

function persistRadioRecovery(value: RadioRecovery | null): void {
  if (typeof sessionStorage === 'undefined') return
  try {
    if (value) sessionStorage.setItem(RADIO_RECOVERY_KEY, JSON.stringify(value))
    else sessionStorage.removeItem(RADIO_RECOVERY_KEY)
  } catch { /* Storage may be unavailable in privacy-restricted contexts. */ }
}

interface VehicleSetupState {
  configResults: Map<string, ConfigResult>
  airframeStatus: AirframeStatus | null
  radioSnapshot: RadioCalibrationSnapshot | null
  radioRecovery: RadioRecovery | null
  applyConfigResult: (result: Omit<ConfigResult, 'time'>) => void
  setAirframeStatus: (status: Omit<AirframeStatus, 'time'>) => void
  applyRadioSnapshot: (snapshot: RadioCalibrationSnapshot) => void
  setRadioRecovery: (recovery: RadioRecovery) => void
  clearRadioRecovery: () => void
  reset: () => void
}

export const useVehicleSetupStore = create<VehicleSetupState>((set) => ({
  configResults: new Map(),
  airframeStatus: null,
  radioSnapshot: null,
  radioRecovery: loadRadioRecovery(),
  applyConfigResult: (result) => set((state) => {
    const configResults = new Map(state.configResults)
    configResults.set(result.requestId, { ...result, time: Date.now() })
    // Bound retained request results: pages only need recent transactions.
    while (configResults.size > 128) configResults.delete(configResults.keys().next().value!)
    return { configResults }
  }),
  setAirframeStatus: (status) => set({ airframeStatus: { ...status, time: Date.now() } }),
  applyRadioSnapshot: (snapshot) => set((state) => {
    const current = state.radioSnapshot
    if (current?.sessionId === snapshot.sessionId && current.seq >= snapshot.seq) return state
    if (['done', 'failed', 'cancelled'].includes(snapshot.phase)) persistRadioRecovery(null)
    return { radioSnapshot: snapshot, ...(['done', 'failed', 'cancelled'].includes(snapshot.phase) ? { radioRecovery: null } : {}) }
  }),
  setRadioRecovery: (radioRecovery) => { persistRadioRecovery(radioRecovery); set({ radioRecovery }) },
  clearRadioRecovery: () => { persistRadioRecovery(null); set({ radioRecovery: null }) },
  reset: () => set({
    configResults: new Map(),
    airframeStatus: null,
    radioSnapshot: null,
  }),
}))
