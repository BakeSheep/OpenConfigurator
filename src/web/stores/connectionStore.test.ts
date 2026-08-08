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
  })
  assert.equal(useConnectionStore.getState().connectDialogOpen, true)

  useConnectionStore.setState({ transportOpen: false, connectDialogOpen: true })
  useConnectionStore.getState().setConnectionSnapshot({
    status: 'connected',
    transportOpen: true,
    vehicleReady: false,
    rawSessionActive: false,
  })
  assert.equal(useConnectionStore.getState().connectDialogOpen, false)
})
