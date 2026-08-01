import assert from 'node:assert/strict'
import { MessageRateLimiter } from './messageRateLimiter'

const limiter = new MessageRateLimiter()
const optical = { type: 'sensor', msgType: 'OPTICAL_FLOW_RAD', data: {} } as const
assert.equal(limiter.shouldForward(optical, 0), true)
assert.equal(limiter.shouldForward(optical, 100), false)
assert.equal(limiter.shouldForward(optical, 499), false)
assert.equal(limiter.shouldForward(optical, 500), true)

limiter.setRates({ attitude: 8, position: 2, sensors: 2, rc: 2, status: 1, hud: 1, auxiliary: 1 })
assert.equal(limiter.shouldForward(optical, 600), true)
assert.equal(limiter.shouldForward(optical, 1_599), false)
assert.equal(limiter.shouldForward(optical, 1_600), true)

const attitude = { type: 'telemetry', msgType: 'ATTITUDE', data: {} } as const
assert.equal(limiter.shouldForward(attitude, 2_000), true)
assert.equal(limiter.shouldForward(attitude, 2_124), false)
assert.equal(limiter.shouldForward(attitude, 2_125), true)

assert.equal(
  limiter.shouldForward({ type: 'statustext', data: { severity: 4, text: 'event' } }, 2_126),
  true,
)

console.log('messageRateLimiter checks passed')
