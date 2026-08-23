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

test('scanConnections stores per-kind results and keeps stale candidates on failure', async () => {
  const originalFetch = globalThis.fetch
  const devices = [{ path: '/dev/ttyACM0', transport: 'serial' as const, deviceId: 'serial:1', displayName: 'Pixhawk' }]
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('kind=serial')) {
      return new Response(JSON.stringify({
        success: true,
        data: {
          kind: 'serial', scope: 'recommended', scanGeneration: 1, cached: false,
          devices, warnings: [],
        },
      }), { status: 200 })
    }
    if (url.includes('kind=bluetooth&scope=quick&fail')) {
      return new Response(JSON.stringify({ success: false, error: { message: 'boom' } }), { status: 500 })
    }
    return new Response(JSON.stringify({
      success: true,
      data: { kind: 'bluetooth', scope: 'quick', scanGeneration: 2, cached: false, devices: [], warnings: [] },
    }), { status: 200 })
  }) as typeof fetch

  try {
    await useConnectionStore.getState().scanConnections('serial')
    const state = useConnectionStore.getState()
    assert.equal(state.serialScan.devices.length, 1)
    assert.equal(state.serialScan.stale, false)
    assert.deepEqual(state.serialPorts, devices)

    // A failed refresh keeps the previous candidates but flags them stale.
    useConnectionStore.setState({ showAllSerialPorts: true })
    await useConnectionStore.getState().scanConnections('bluetooth')
    useConnectionStore.getState().setConnectionError(null)
    // simulate bluetooth failure by throwing network error
    globalThis.fetch = (async () => { throw new Error('network down') }) as typeof fetch
    await useConnectionStore.getState().scanConnections('bluetooth')
    const after = useConnectionStore.getState()
    assert.equal(after.bluetoothScan.stale, true)
    assert.equal(after.bluetoothScan.error, 'network down')
  } finally {
    globalThis.fetch = originalFetch
    useConnectionStore.setState({ showAllSerialPorts: false })
  }
})

test('a late scan response from an older generation is ignored', async () => {
  const originalFetch = globalThis.fetch
  const gate: { release: (() => void) | null } = { release: null }
  let call = 0
  globalThis.fetch = (async () => {
    call += 1
    if (call === 1) {
      await new Promise<void>((resolve) => { gate.release = resolve })
      return new Response(JSON.stringify({
        success: true,
        data: { kind: 'serial', scope: 'recommended', scanGeneration: 1, cached: false, devices: [{ path: 'OLD' }], warnings: [] },
      }), { status: 200 })
    }
    return new Response(JSON.stringify({
      success: true,
      data: { kind: 'serial', scope: 'recommended', scanGeneration: 2, cached: false, devices: [{ path: 'NEW' }], warnings: [] },
    }), { status: 200 })
  }) as typeof fetch

  try {
    const first = useConnectionStore.getState().scanConnections('serial')
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    const second = useConnectionStore.getState().scanConnections('serial')
    await second
    gate.release?.()
    await first
    assert.deepEqual(
      useConnectionStore.getState().serialScan.devices.map((device) => device.path),
      ['NEW'],
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})
