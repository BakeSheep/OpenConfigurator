import assert from 'node:assert/strict'
import test from 'node:test'
import { useTelemetryStore } from './telemetryStore'

test('zero and non-finite battery voltages are normalized to unknown', () => {
  useTelemetryStore.getState().setBattery({
    id: 0,
    voltage: 0,
    cell_voltages: [0, Number.NaN, 4.1],
    current: null,
    remaining: 99,
    consumed_mah: null,
  })
  assert.equal(useTelemetryStore.getState().battery?.voltage, null)
  assert.deepEqual(useTelemetryStore.getState().battery?.cell_voltages, [null, null, 4.1])

  useTelemetryStore.setState((state) => ({
    battery: null,
    batterySource: null,
    lastUpdate: { ...state.lastUpdate, battery: 0 },
  }))
  useTelemetryStore.getState().setSysStatus({
    voltageBattery: 0,
    currentBattery: null,
    batteryRemaining: 99,
    cpuLoad: 0,
    sensorsPresent: 0,
    sensorsEnabled: 0,
    sensorsHealth: 0,
    sensorsHealthy: null,
    preflightCheck: null,
    unhealthySensorMask: 0,
    unhealthySensors: [],
  })
  assert.equal(useTelemetryStore.getState().battery, null)
})

test('battery telemetry preserves each instance and selects battery zero as primary', () => {
  useTelemetryStore.setState({
    battery: null,
    batteries: new Map(),
    batteryLastUpdate: new Map(),
    batterySource: null,
  })
  useTelemetryStore.getState().setBattery({
    id: 2,
    voltage: 24.2,
    cell_voltages: [4.04, 4.04, 4.03, 4.03, 4.03, 4.03],
    current: 3.2,
    remaining: 72,
    consumed_mah: 420,
  })
  assert.equal(useTelemetryStore.getState().battery?.id, 2)
  useTelemetryStore.getState().setBattery({
    id: 0,
    voltage: 16.4,
    cell_voltages: [4.1, 4.1, 4.1, 4.1],
    current: 2.1,
    remaining: 83,
    consumed_mah: 220,
  })
  const state = useTelemetryStore.getState()
  assert.equal(state.batteries.size, 2)
  assert.equal(state.batteries.get(2)?.voltage, 24.2)
  assert.equal(state.battery?.id, 0)
  assert.equal(state.isBatteryStale(0), false)

  state.setVehicleIdentity(null)
  assert.equal(useTelemetryStore.getState().batteries.size, 0)
  assert.equal(useTelemetryStore.getState().battery, null)
})
