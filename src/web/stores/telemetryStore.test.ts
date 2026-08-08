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
