import { create } from 'zustand'
import type { ParamData } from '../../shared/types'

interface ParameterState {
  params: Map<string, ParamData>
  loading: boolean
  totalCount: number
  receivedCount: number
  retryCount: number
  missingCount: number
  error: string | null
  receivedIndices: Set<number>
  addParam: (param: ParamData) => void
  addParams: (params: ParamData[]) => void
  setParamComplete: (count: number) => void
  setParamRetry: (attempt: number, missing: number, total: number) => void
  setParamFailed: (received: number, total: number) => void
  setLoading: (loading: boolean) => void
  clear: () => void
}

export const useParameterStore = create<ParameterState>((set) => ({
  params: new Map(),
  loading: false,
  totalCount: 0,
  receivedCount: 0,
  retryCount: 0,
  missingCount: 0,
  error: null,
  receivedIndices: new Set(),
  addParam: (param) => set((state) => {
    const newMap = new Map(state.params)
    newMap.set(param.id, param)
    const receivedIndices = new Set(state.receivedIndices)
    const hasValidListIndex = param.param_index >= 0 && param.param_index < param.param_count
    const totalCount = state.totalCount || (
      hasValidListIndex && param.param_count > 0 && param.param_count < 0xffff
        ? param.param_count
        : 0
    )
    if (totalCount > 0 && param.param_index < totalCount) receivedIndices.add(param.param_index)
    return { params: newMap, receivedIndices, receivedCount: receivedIndices.size, totalCount }
  }),
  addParams: (params) => set((state) => {
    if (params.length === 0) return state
    const newMap = new Map(state.params)
    const receivedIndices = new Set(state.receivedIndices)
    let totalCount = state.totalCount
    for (const param of params) {
      newMap.set(param.id, param)
      if (
        totalCount === 0
        && param.param_count > 0
        && param.param_count < 0xffff
        && param.param_index >= 0
        && param.param_index < param.param_count
      ) {
        totalCount = param.param_count
      }
      if (totalCount > 0 && param.param_index < totalCount) receivedIndices.add(param.param_index)
    }
    return { params: newMap, receivedIndices, receivedCount: receivedIndices.size, totalCount }
  }),
  setParamComplete: (count) => set({
    loading: false,
    totalCount: count,
    receivedCount: count,
    retryCount: 0,
    missingCount: 0,
    error: null,
  }),
  setParamRetry: (attempt, missing, total) => set((state) => ({
    loading: true,
    retryCount: attempt,
    missingCount: missing,
    totalCount: total || state.totalCount,
    error: null,
  })),
  setParamFailed: (received, total) => set({
    loading: false,
    receivedCount: received,
    totalCount: total,
    missingCount: Math.max(0, total - received),
    error: total > 0
      ? `参数读取未完成，还缺 ${Math.max(0, total - received)} 项`
      : '飞控未响应参数请求',
  }),
  setLoading: (loading) => set({
    loading,
    ...(loading ? { retryCount: 0, missingCount: 0, error: null } : {}),
  }),
  clear: () => set({
    params: new Map(),
    loading: false,
    receivedCount: 0,
    totalCount: 0,
    retryCount: 0,
    missingCount: 0,
    error: null,
    receivedIndices: new Set(),
  }),
}))
