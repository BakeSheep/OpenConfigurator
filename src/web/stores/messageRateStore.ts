import { create } from 'zustand'
import { DEFAULT_MESSAGE_RATES } from '../../shared/constants'
import type { MessageRateConfig } from '../../shared/types'

interface MessageRateState {
  rates: MessageRateConfig
  setRates: (rates: MessageRateConfig) => void
  reset: () => void
}

export const useMessageRateStore = create<MessageRateState>((set) => ({
  rates: { ...DEFAULT_MESSAGE_RATES },
  setRates: (rates) => set({ rates: { ...rates } }),
  reset: () => set({ rates: { ...DEFAULT_MESSAGE_RATES } }),
}))
