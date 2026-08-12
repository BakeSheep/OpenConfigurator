import assert from 'node:assert/strict'
import test from 'node:test'
import { useConnectionStore } from './connectionStore'

test('an already-open transport snapshot does not close a user-opened connection dialog', () => {
  useConnectionStore.setState({
    status: 'connected',
    transportOpen: true,
    vehicleReady: true,
    connectDialogOpen: true,
  })
  useConnectionStore.getState().setConnectionSnapshot({
    status: 'connected',
    transportOpen: true,
    vehicleReady: true,
    rawSessionActive: false,
    safetyEpoch: 1,
    safetyAuthorityId: '00000000-0000-4000-8000-000000000001',
  })
  assert.equal(useConnectionStore.getState().connectDialogOpen, true)

  useConnectionStore.setState({ transportOpen: false, connectDialogOpen: true })
  useConnectionStore.getState().setConnectionSnapshot({
    status: 'connected',
    transportOpen: true,
    vehicleReady: false,
    rawSessionActive: false,
    safetyEpoch: 2,
    safetyAuthorityId: '00000000-0000-4000-8000-000000000001',
  })
  assert.equal(useConnectionStore.getState().connectDialogOpen, false)
})
