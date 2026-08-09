import assert from 'node:assert/strict'
import test from 'node:test'
import { hasCompleteRotorGeometry } from './motorGeometry'

test('rotor geometry accepts only a complete finite CA_ROTOR position set', () => {
  assert.equal(hasCompleteRotorGeometry([
    { px: 1, py: 1 }, { px: -1, py: -1 }, { px: 1, py: -1 }, { px: -1, py: 1 },
  ]), true)
  assert.equal(hasCompleteRotorGeometry([
    { px: 0.15, py: 0.22 }, { px: undefined, py: undefined },
  ]), false)
  assert.equal(hasCompleteRotorGeometry([{ px: Number.NaN, py: 1 }]), false)
  assert.equal(hasCompleteRotorGeometry([]), false)
})
