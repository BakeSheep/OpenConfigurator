import assert from 'node:assert/strict'
import { DEFAULT_MESSAGE_RATES } from '../../shared/constants'
import { useMessageRateStore } from './messageRateStore'

assert.deepEqual(useMessageRateStore.getState().rates, DEFAULT_MESSAGE_RATES)

useMessageRateStore.getState().setRates({
  attitude: 4,
  position: 1,
  sensors: 2,
  rc: 2,
  status: 1,
  hud: 1,
  auxiliary: 1,
})
assert.equal(useMessageRateStore.getState().rates.attitude, 4)
assert.equal(useMessageRateStore.getState().rates.auxiliary, 1)

useMessageRateStore.getState().reset()
assert.deepEqual(useMessageRateStore.getState().rates, DEFAULT_MESSAGE_RATES)

console.log('messageRateStore checks passed')
