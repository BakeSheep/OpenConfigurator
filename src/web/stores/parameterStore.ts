import { create } from 'zustand'
import type { ParamData } from '../../shared/types'

interface ParameterState {
  params: Map<string, ParamData>
  loading: boolean
  totalCount: number
  receivedCount: number
  addParam: (param: ParamData) => void
  setParamComplete: (count: number) => void
  setLoading: (loading: boolean) => void
  updateParam: (id: string, value: number) => void
  clear: () => void
}

export const useParameterStore = create<ParameterState>((set) => ({
  params: new Map(),
  loading: false,
  totalCount: 0,
  receivedCount: 0,
  addParam: (param) => set((state) => {
    const newMap = new Map(state.params)
    newMap.set(param.id, param)
    return { params: newMap, receivedCount: newMap.size, totalCount: param.param_count }
  }),
  setParamComplete: (count) => set({ loading: false, totalCount: count }),
  setLoading: (loading) => set({ loading }),
  updateParam: (id, value) => set((state) => {
    const newMap = new Map(state.params)
    const existing = newMap.get(id)
    if (existing) {
      newMap.set(id, { ...existing, value })
    }
    return { params: newMap }
  }),
  clear: () => set({ params: new Map(), receivedCount: 0, totalCount: 0 }),
}))
