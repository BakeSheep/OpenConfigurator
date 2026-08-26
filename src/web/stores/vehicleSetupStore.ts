import { create } from 'zustand'
import type { RadioCalibrationSnapshot, RuntimeEvent } from '../../shared/types'

type ConfigResult = Extract<RuntimeEvent, { type: 'vehicle_config_set_result' }>['data'] & { time: number }
type AirframeStatus = Extract<RuntimeEvent, { type: 'airframe_apply_status' }>['data'] & { time: number }

interface VehicleSetupState {
  configResults: Map<string, ConfigResult>
  airframeStatus: AirframeStatus | null
  radioSnapshot: RadioCalibrationSnapshot | null
  applyConfigResult: (result: Omit<ConfigResult, 'time'>) => void
  setAirframeStatus: (status: Omit<AirframeStatus, 'time'>) => void
  applyRadioSnapshot: (snapshot: RadioCalibrationSnapshot) => void
  reset: () => void
}

export const useVehicleSetupStore = create<VehicleSetupState>((set) => ({
  configResults: new Map(),
  airframeStatus: null,
  radioSnapshot: null,
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
    return { radioSnapshot: snapshot }
  }),
  reset: () => set({
    configResults: new Map(),
    airframeStatus: null,
    radioSnapshot: null,
  }),
}))
