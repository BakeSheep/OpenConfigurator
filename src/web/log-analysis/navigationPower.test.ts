import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { UlogFixtureBuilder } from './testing/ulogFixtureBuilder.js'
import { UlogDocument } from './parser/UlogDocument.js'
import { resolveTopics } from './engine/topicResolver.js'
import type { AnalysisModule, AnalysisContext, ResolvedSample, ResolvedTopic } from './engine/AnalysisModule.js'
import { powerModule } from './modules/power.js'
import { propulsionModule } from './modules/propulsion.js'
import { navigationModule } from './modules/navigation.js'
import { eventsModule } from './modules/events.js'

// ─── Helpers ────────────────────────────────────────────────────────────────

async function runModule(
  mod: AnalysisModule,
  doc: UlogDocument,
): Promise<{ result: ReturnType<AnalysisModule['finalize']>; context: AnalysisContext }> {
  const subs = doc.rawUlog.subscriptions
  const subArray: Array<{ name: string; multiId: number; msgId: number; fields: string[] }> = []
  for (const [msgId, sub] of subs) {
    subArray.push({ name: sub.name, multiId: sub.multiId, msgId, fields: [] })
  }
  for (const entry of doc.catalog) {
    const sub = subArray.find(s => s.msgId === entry.msgId)
    if (sub) sub.fields = entry.fields.map(f => f.path)
  }

  const resolution = resolveTopics(mod.requirements, subArray)
  const resolvedTopics = new Map<string, ResolvedTopic>()
  for (const [bindName, topics] of resolution.resolved) {
    if (topics.length > 0) resolvedTopics.set(bindName, topics[0])
  }

  const timeRange = doc.rawUlog.timeRange()
  const logStartSec = timeRange ? Number(timeRange[0]) / 1e6 : 0
  const logEndSec = timeRange ? Number(timeRange[1]) / 1e6 : 0

  const context: AnalysisContext = {
    resolvedTopics,
    logStartSec,
    logEndSec,
    logDuration: logEndSec - logStartSec,
    allSubscriptions: subArray.map(s => ({ name: s.name, multiId: s.multiId, msgId: s.msgId })),
    parameters: [],
    metadata: { vehicleType: null, firmwareVersion: null, airframeName: null },
  }

  const state = mod.create(context)

  // Build msgId → bindName mapping (data messages only carry msgId, not multiId)
  const msgIdToBinding = new Map<number, string>()
  const wantedMsgIds = new Set<number>()
  for (const [bindName, topics] of resolution.resolved) {
    for (const t of topics) {
      msgIdToBinding.set(t.msgId, bindName)
      wantedMsgIds.add(t.msgId)
    }
  }

  const logStart = doc.rawUlog.timeRange()?.[0] ?? 0n
  if (wantedMsgIds.size > 0) {
    for await (const message of doc.rawUlog.readMessages({ msgIds: wantedMsgIds })) {
      if ((message as any).type !== 68) continue // MessageType.Data
      const msgMsgId = (message as any).msgId as number
      const bindName = msgIdToBinding.get(msgMsgId)
      if (!bindName) continue
      const topics = resolution.resolved.get(bindName) ?? []
      const topic = topics.find(t => t.msgId === msgMsgId)
      if (!topic) continue

      const timeSec = Number((message as any).value.timestamp) / 1e6 - logStartSec
      const values: Record<string, number | string | boolean> = {}
      for (const [fieldPath] of topic.fieldMap) {
        // Handle array fields: "voltage_cell_v[0]" → value.voltage_cell_v[0]
        const arrayMatch = /^([^[]+)\[(\d+)\]$/.exec(fieldPath)
        let val: unknown
        if (arrayMatch) {
          const baseName = arrayMatch[1]!
          const idx = parseInt(arrayMatch[2]!)
          const arr = (message as any).value[baseName]
          if (Array.isArray(arr)) val = arr[idx]
        } else {
          val = (message as any).value[fieldPath]
        }
        if (val !== undefined) {
          if (typeof val === 'number' || typeof val === 'string' || typeof val === 'boolean') {
            values[fieldPath] = val
          } else if (typeof val === 'bigint') {
            values[fieldPath] = Number(val)
          }
        }
      }

      const sample: ResolvedSample = { topic, timeSec, values }
      mod.consume(state, sample, bindName)
    }
  }

  const result = mod.finalize(state, context)
  return { result: result as ReturnType<AnalysisModule['finalize']>, context }
}

function buildBatteryBuffer(opts: {
  instances: Array<{ multiId: number; samples: Array<{ ts: bigint; voltage: number; current: number; cellCount?: number; cellVoltages?: number[]; remaining?: number; discharged?: number }> }>
}): ArrayBuffer {
  const builder = new UlogFixtureBuilder()
  const baseMsgId = 100

  for (let idx = 0; idx < opts.instances.length; idx++) {
    const inst = opts.instances[idx]!
    const msgId = baseMsgId + idx
    builder.addFormat(msgId, 'battery_status', [
      { type: 'uint64_t', fieldName: 'timestamp' },
      { type: 'uint8_t', fieldName: 'id' },
      { type: 'uint8_t', fieldName: 'cell_count' },
      { type: 'float', fieldName: 'voltage_v' },
      { type: 'float', fieldName: 'current_a' },
      { type: 'float', fieldName: 'remaining' },
      { type: 'float', fieldName: 'discharged_mah' },
      { type: 'float[14]', fieldName: 'voltage_cell_v' },
    ])
    builder.addSubscription(msgId, inst.multiId)
    for (const s of inst.samples) {
      const fields: Record<string, number> = {
        timestamp: Number(s.ts),
        id: inst.multiId,
        cell_count: s.cellCount ?? 0,
        voltage_v: s.voltage,
        current_a: s.current,
        remaining: s.remaining ?? 0.5,
        discharged_mah: s.discharged ?? 0,
      }
      if (s.cellVoltages) {
        for (let i = 0; i < s.cellVoltages.length && i < 14; i++) {
          fields[`voltage_cell_v[${i}]`] = s.cellVoltages[i]!
        }
      }
      builder.addData(msgId, s.ts, fields)
    }
  }
  return builder.build()
}

function buildEscBuffer(opts: {
  instances: Array<{ multiId: number; samples: Array<{ ts: bigint; rpm: number; current?: number; voltage?: number; temperature?: number; errorFlags?: number }> }>
}): ArrayBuffer {
  const builder = new UlogFixtureBuilder()
  const baseMsgId = 200

  for (let idx = 0; idx < opts.instances.length; idx++) {
    const inst = opts.instances[idx]!
    const msgId = baseMsgId + idx
    builder.addFormat(msgId, 'esc_status', [
      { type: 'uint64_t', fieldName: 'timestamp' },
      { type: 'uint8_t', fieldName: 'index' },
      { type: 'float', fieldName: 'esc_rpm' },
      { type: 'float', fieldName: 'esc_current' },
      { type: 'float', fieldName: 'esc_voltage' },
      { type: 'float', fieldName: 'esc_temperature' },
      { type: 'uint16_t', fieldName: 'esc_errorflags' },
    ])
    builder.addSubscription(msgId, inst.multiId)
    for (const s of inst.samples) {
      builder.addData(msgId, s.ts, {
        timestamp: Number(s.ts),
        index: inst.multiId,
        esc_rpm: s.rpm,
        esc_current: s.current ?? 0,
        esc_voltage: s.voltage ?? 0,
        esc_temperature: s.temperature ?? 0,
        esc_errorflags: s.errorFlags ?? 0,
      })
    }
  }
  return builder.build()
}

// ─── Power module tests ─────────────────────────────────────────────────────

describe('powerModule', () => {
  it('tracks multiple battery instances separately', async () => {
    const buf = buildBatteryBuffer({
      instances: [
        { multiId: 0, samples: [{ ts: 1_000_000n, voltage: 14.8, current: 10, cellCount: 4, remaining: 0.8, discharged: 100 }] },
        { multiId: 1, samples: [{ ts: 1_000_000n, voltage: 11.1, current: 5, cellCount: 3, remaining: 0.6, discharged: 200 }] },
      ],
    })
    const doc = await UlogDocument.open(buf)
    const { result } = await runModule(powerModule, doc)

    const batteries = result.metrics.batteries as Record<string, unknown>[]
    assert.equal(batteries.length, 2)
    const b0 = batteries.find(b => (b.instanceId as number) === 0)!
    const b1 = batteries.find(b => (b.instanceId as number) === 1)!
    assert.ok(b0, 'battery 0 should exist')
    assert.ok(b1, 'battery 1 should exist')
    assert.ok(Math.abs((b0.minVoltage as number) - 14.8) < 0.01, `battery 0 minVoltage should be ~14.8, got ${b0.minVoltage}`)
    assert.ok(Math.abs((b1.minVoltage as number) - 11.1) < 0.01, `battery 1 minVoltage should be ~11.1, got ${b1.minVoltage}`)
  })

  it('detects low voltage', async () => {
    // 3S battery, 8.7V = 2.9V/cell → critical (below 3.0V/cell threshold)
    const buf = buildBatteryBuffer({
      instances: [
        { multiId: 0, samples: [{ ts: 1_000_000n, voltage: 8.7, current: 15, cellCount: 3, remaining: 0.1, discharged: 800 }] },
      ],
    })
    const doc = await UlogDocument.open(buf)
    const { result } = await runModule(powerModule, doc)

    const criticalFindings = result.findings.filter(f => f.severity === 'critical')
    assert.ok(criticalFindings.length > 0, 'should have critical low-voltage finding')
    assert.ok(criticalFindings.some(f => f.title.includes('电压')))
  })

  it('produces voltage and current chart series', async () => {
    const samples = Array.from({ length: 10 }, (_, i) => ({
      ts: BigInt((i + 1) * 1_000_000),
      voltage: 12.0 - i * 0.1,
      current: 5 + i,
      cellCount: 3,
    }))
    const buf = buildBatteryBuffer({
      instances: [{ multiId: 0, samples }],
    })
    const doc = await UlogDocument.open(buf)
    const { result } = await runModule(powerModule, doc)

    const voltageChart = result.chartSeries.find(s => s.id.includes('voltage'))
    const currentChart = result.chartSeries.find(s => s.id.includes('current'))
    assert.ok(voltageChart, 'should have voltage chart')
    assert.ok(currentChart, 'should have current chart')
    assert.ok(voltageChart!.series.length > 0, 'voltage chart should have series')
    assert.ok(currentChart!.series.length > 0, 'current chart should have series')
    // Series should be bounded
    assert.ok(voltageChart!.series[0]!.times.length <= 5000)
    assert.ok(currentChart!.series[0]!.times.length <= 5000)
  })

  it('detects cell imbalance', async () => {
    const buf = buildBatteryBuffer({
      instances: [
        {
          multiId: 0,
          samples: [{
            ts: 1_000_000n,
            voltage: 12.0,
            current: 0,
            cellCount: 4,
            cellVoltages: [3.8, 3.8, 3.8, 3.2], // last cell much lower
            remaining: 0.5,
            discharged: 500,
          }],
        },
      ],
    })
    const doc = await UlogDocument.open(buf)
    const { result } = await runModule(powerModule, doc)

    const imbalanceFindings = result.findings.filter(f => f.title.includes('不均衡'))
    assert.ok(imbalanceFindings.length > 0, 'should detect cell imbalance')
  })
})

// ─── Propulsion module tests ────────────────────────────────────────────────

describe('propulsionModule', () => {
  it('tracks ESC RPM per motor', async () => {
    const buf = buildEscBuffer({
      instances: [
        { multiId: 0, samples: [{ ts: 1_000_000n, rpm: 5000, current: 10, voltage: 12 }] },
        { multiId: 1, samples: [{ ts: 1_000_000n, rpm: 5100, current: 10, voltage: 12 }] },
        { multiId: 2, samples: [{ ts: 1_000_000n, rpm: 5050, current: 10, voltage: 12 }] },
        { multiId: 3, samples: [{ ts: 1_000_000n, rpm: 5080, current: 10, voltage: 12 }] },
      ],
    })
    const doc = await UlogDocument.open(buf)
    const { result } = await runModule(propulsionModule, doc)

    const escData = result.metrics.escInstances as Record<string, unknown>[]
    assert.ok(Array.isArray(escData))
    assert.equal(escData.length, 4)
  })

  it('detects motor imbalance', async () => {
    const buf = buildEscBuffer({
      instances: [
        { multiId: 0, samples: [{ ts: 1_000_000n, rpm: 5000 }] },
        { multiId: 1, samples: [{ ts: 1_000_000n, rpm: 5000 }] },
        { multiId: 2, samples: [{ ts: 1_000_000n, rpm: 5000 }] },
        { multiId: 3, samples: [{ ts: 1_000_000n, rpm: 3000 }] }, // one motor much slower
      ],
    })
    const doc = await UlogDocument.open(buf)
    const { result } = await runModule(propulsionModule, doc)

    const imbalanceFindings = result.findings.filter(f => f.title.includes('不均衡'))
    assert.ok(imbalanceFindings.length > 0, 'should detect motor RPM imbalance')
  })

  it('detects ESC errors', async () => {
    const buf = buildEscBuffer({
      instances: [
        { multiId: 0, samples: [{ ts: 1_000_000n, rpm: 5000, errorFlags: 1 }] },
      ],
    })
    const doc = await UlogDocument.open(buf)
    const { result } = await runModule(propulsionModule, doc)

    const errorFindings = result.findings.filter(f => f.title.includes('错误'))
    assert.ok(errorFindings.length > 0, 'should detect ESC error flags')
  })

  it('produces RPM chart series', async () => {
    const samples = Array.from({ length: 5 }, (_, i) => ({
      ts: BigInt((i + 1) * 1_000_000),
      rpm: 4000 + i * 100,
    }))
    const buf = buildEscBuffer({
      instances: [{ multiId: 0, samples }],
    })
    const doc = await UlogDocument.open(buf)
    const { result } = await runModule(propulsionModule, doc)

    const rpmChart = result.chartSeries.find(s => s.id.includes('rpm'))
    assert.ok(rpmChart, 'should have RPM chart')
    assert.ok(rpmChart!.series.length > 0)
  })
})

// ─── Navigation module tests ────────────────────────────────────────────────

describe('navigationModule', () => {
  it('tracks GPS fix type and satellites', async () => {
    const builder = new UlogFixtureBuilder()
      .addFormat(300, 'vehicle_gps_position', [
        { type: 'uint64_t', fieldName: 'timestamp' },
        { type: 'uint8_t', fieldName: 'fix_type' },
        { type: 'uint8_t', fieldName: 'satellites_used' },
        { type: 'float', fieldName: 'eph' },
        { type: 'float', fieldName: 'epv' },
        { type: 'double', fieldName: 'latitude_deg' },
        { type: 'double', fieldName: 'longitude_deg' },
        { type: 'float', fieldName: 'altitude_msl_m' },
        { type: 'float', fieldName: 'vel_m_s' },
      ])
      .addSubscription(300, 0)
      .addData(300, 1_000_000n, { timestamp: 1000000, fix_type: 3, satellites_used: 12, eph: 1.5, epv: 2.0 })
      .addData(300, 2_000_000n, { timestamp: 2000000, fix_type: 3, satellites_used: 14, eph: 1.2, epv: 1.8 })

    const doc = await UlogDocument.open(builder.build())
    const { result } = await runModule(navigationModule, doc)

    const gpsMetrics = (result.metrics.gpsInstances as Record<string, unknown>[]) ?? []
    assert.ok(gpsMetrics.length >= 1, 'should have at least one GPS instance')
    const g0 = gpsMetrics[0]!
    assert.equal(g0.maxSatellites, 14)
    assert.equal(g0.minFixType, 3)
  })

  it('handles multiple GPS instances', async () => {
    const builder = new UlogFixtureBuilder()
      .addFormat(300, 'vehicle_gps_position', [
        { type: 'uint64_t', fieldName: 'timestamp' },
        { type: 'uint8_t', fieldName: 'fix_type' },
        { type: 'uint8_t', fieldName: 'satellites_used' },
        { type: 'float', fieldName: 'eph' },
        { type: 'float', fieldName: 'epv' },
      ])
      .addFormat(301, 'vehicle_gps_position', [
        { type: 'uint64_t', fieldName: 'timestamp' },
        { type: 'uint8_t', fieldName: 'fix_type' },
        { type: 'uint8_t', fieldName: 'satellites_used' },
        { type: 'float', fieldName: 'eph' },
        { type: 'float', fieldName: 'epv' },
      ])
      .addSubscription(300, 0)
      .addSubscription(301, 1)
      .addData(300, 1_000_000n, { timestamp: 1000000, fix_type: 3, satellites_used: 12 })
      .addData(301, 2_000_000n, { timestamp: 2000000, fix_type: 1, satellites_used: 4 })

    const doc = await UlogDocument.open(builder.build())
    const { result } = await runModule(navigationModule, doc)

    const gpsInstances = (result.metrics.gpsInstances as Record<string, unknown>[]) ?? []
    assert.equal(gpsInstances.length, 2, 'should have 2 GPS instances')
  })

  it('tracks local position', async () => {
    const builder = new UlogFixtureBuilder()
      .addFormat(310, 'vehicle_local_position', [
        { type: 'uint64_t', fieldName: 'timestamp' },
        { type: 'float', fieldName: 'x' },
        { type: 'float', fieldName: 'y' },
        { type: 'float', fieldName: 'z' },
        { type: 'float', fieldName: 'vx' },
        { type: 'float', fieldName: 'vy' },
        { type: 'float', fieldName: 'vz' },
      ])
      .addSubscription(310, 0)
      .addData(310, 1_000_000n, { timestamp: 1000000, x: 10, y: 20, z: -50, vx: 1, vy: 2, vz: 0 })

    const doc = await UlogDocument.open(builder.build())
    const { result } = await runModule(navigationModule, doc)

    const localPos = result.metrics.localPosition as Record<string, unknown> | undefined
    assert.ok(localPos, 'should have local position metrics')
    assert.equal(localPos.sampleCount, 1)
  })

  it('tracks airspeed', async () => {
    const builder = new UlogFixtureBuilder()
      .addFormat(320, 'vehicle_air_data', [
        { type: 'uint64_t', fieldName: 'timestamp' },
        { type: 'float', fieldName: 'indicated_airspeed_m_s' },
        { type: 'float', fieldName: 'true_airspeed_m_s' },
        { type: 'float', fieldName: 'baro_alt_meter' },
      ])
      .addSubscription(320, 0)
      .addData(320, 1_000_000n, { timestamp: 1000000, indicated_airspeed_m_s: 15.0, true_airspeed_m_s: 16.5, baro_alt_meter: 100 })

    const doc = await UlogDocument.open(builder.build())
    const { result } = await runModule(navigationModule, doc)

    const airData = result.metrics.airData as Record<string, unknown> | undefined
    assert.ok(airData, 'should have air data metrics')
    assert.equal(airData.sampleCount, 1)
  })

  it('tracks wind estimation', async () => {
    const builder = new UlogFixtureBuilder()
      .addFormat(330, 'wind', [
        { type: 'uint64_t', fieldName: 'timestamp' },
        { type: 'float', fieldName: 'windspeed' },
        { type: 'float', fieldName: 'wind_from_north' },
        { type: 'float', fieldName: 'wind_from_east' },
      ])
      .addSubscription(330, 0)
      .addData(330, 1_000_000n, { timestamp: 1000000, windspeed: 5.0, wind_from_north: 3.0, wind_from_east: 4.0 })

    const doc = await UlogDocument.open(builder.build())
    const { result } = await runModule(navigationModule, doc)

    const wind = result.metrics.wind as Record<string, unknown> | undefined
    assert.ok(wind, 'should have wind metrics')
    assert.equal(wind.sampleCount, 1)
  })

  it('tracks optical flow quality', async () => {
    const builder = new UlogFixtureBuilder()
      .addFormat(340, 'optical_flow', [
        { type: 'uint64_t', fieldName: 'timestamp' },
        { type: 'float', fieldName: 'pixel_flow_x_integral' },
        { type: 'float', fieldName: 'pixel_flow_y_integral' },
        { type: 'uint8_t', fieldName: 'quality' },
      ])
      .addSubscription(340, 0)
      .addData(340, 1_000_000n, { timestamp: 1000000, pixel_flow_x_integral: 0.1, pixel_flow_y_integral: 0.2, quality: 100 })
      .addData(340, 2_000_000n, { timestamp: 2000000, pixel_flow_x_integral: 0.05, pixel_flow_y_integral: 0.1, quality: 50 })

    const doc = await UlogDocument.open(builder.build())
    const { result } = await runModule(navigationModule, doc)

    const flow = result.metrics.opticalFlow as Record<string, unknown> | undefined
    assert.ok(flow, 'should have optical flow metrics')
    assert.equal(flow.sampleCount, 2)
  })

  it('tracks range finder', async () => {
    const builder = new UlogFixtureBuilder()
      .addFormat(350, 'distance_sensor', [
        { type: 'uint64_t', fieldName: 'timestamp' },
        { type: 'float', fieldName: 'current_distance' },
        { type: 'uint8_t', fieldName: 'quality' },
        { type: 'float', fieldName: 'max_range' },
        { type: 'float', fieldName: 'min_range' },
      ])
      .addSubscription(350, 0)
      .addData(350, 1_000_000n, { timestamp: 1000000, current_distance: 2.5, quality: 80, max_range: 10, min_range: 0.1 })

    const doc = await UlogDocument.open(builder.build())
    const { result } = await runModule(navigationModule, doc)

    const dist = result.metrics.distanceSensor as Record<string, unknown> | undefined
    assert.ok(dist, 'should have distance sensor metrics')
    assert.equal(dist.sampleCount, 1)
  })

  it('produces navigation chart series', async () => {
    const builder = new UlogFixtureBuilder()
      .addFormat(300, 'vehicle_gps_position', [
        { type: 'uint64_t', fieldName: 'timestamp' },
        { type: 'uint8_t', fieldName: 'fix_type' },
        { type: 'uint8_t', fieldName: 'satellites_used' },
        { type: 'float', fieldName: 'eph' },
        { type: 'float', fieldName: 'epv' },
      ])
      .addSubscription(300, 0)

    for (let i = 0; i < 5; i++) {
      builder.addData(300, BigInt((i + 1) * 1_000_000), {
        timestamp: (i + 1) * 1000000,
        fix_type: 3,
        satellites_used: 10 + i,
        eph: 2.0 - i * 0.1,
        epv: 3.0 - i * 0.1,
      })
    }

    const doc = await UlogDocument.open(builder.build())
    const { result } = await runModule(navigationModule, doc)

    const fixChart = result.chartSeries.find(s => s.id.includes('fix'))
    assert.ok(fixChart, 'should have GPS fix quality chart')
    assert.ok(fixChart!.series.length > 0)
  })
})

// ─── Events module tests ────────────────────────────────────────────────────

describe('eventsModule', () => {
  it('has correct module id and section', () => {
    assert.equal(eventsModule.id, 'events')
    assert.equal(eventsModule.section, 'events-raw')
  })

  it('finalizes with empty result when no events consumed', () => {
    const ctx: AnalysisContext = {
      resolvedTopics: new Map(),
      logStartSec: 0,
      logEndSec: 10,
      logDuration: 10,
      allSubscriptions: [],
      parameters: [],
      metadata: { vehicleType: null, firmwareVersion: null, airframeName: null },
    }
    const state = eventsModule.create(ctx)
    const result = eventsModule.finalize(state, ctx)

    assert.equal(result.chartSeries.length, 0)
    assert.equal(result.findings.length, 0)
    assert.equal(result.consumedTopics.length, 0)
  })
})

// ─── Log string tests ───────────────────────────────────────────────────────

describe('log strings in documents', () => {
  it('captures standard log strings', async () => {
    const builder = new UlogFixtureBuilder()
      .addFormat(100, 'sensor_combined', [
        { type: 'uint64_t', fieldName: 'timestamp' },
        { type: 'float', fieldName: 'value' },
      ])
      .addSubscription(100, 0)
      .addData(100, 1_000_000n, { timestamp: 1000000, value: 1.0 })
      .addLog(2_000_000n, 0, 'INFO: System boot')
      .addLog(3_000_000n, 1, 'WARNING: Low memory')

    const doc = await UlogDocument.open(builder.build())
    assert.ok(doc.events.length >= 2, `should have >= 2 events, got ${doc.events.length}`)
    assert.equal(doc.events[0]!.message, 'INFO: System boot')
    assert.equal(doc.events[0]!.isStructured, false)
    assert.equal(doc.events[1]!.message, 'WARNING: Low memory')
  })

  it('captures tagged log strings', async () => {
    const builder = new UlogFixtureBuilder()
      .addFormat(100, 'sensor_combined', [
        { type: 'uint64_t', fieldName: 'timestamp' },
        { type: 'float', fieldName: 'value' },
      ])
      .addSubscription(100, 0)
      .addData(100, 1_000_000n, { timestamp: 1000000, value: 1.0 })
      .addTaggedLog(2_000_000n, 0, 42, 'Tagged message')

    const doc = await UlogDocument.open(builder.build())
    assert.ok(doc.events.length >= 1)
    const tagged = doc.events.find(e => e.tag !== null)
    assert.ok(tagged, 'should have a tagged event')
    assert.equal(tagged!.tag, '42')
    assert.equal(tagged!.message, 'Tagged message')
  })

  it('structured event topic without metadata shows metadata unavailable', async () => {
    // The events module cannot decode structured events without metadata.
    // When no event metadata is available in the log, events should be
    // reported with metadataAvailable: false.
    const builder = new UlogFixtureBuilder()
      .addFormat(100, 'sensor_combined', [
        { type: 'uint64_t', fieldName: 'timestamp' },
        { type: 'float', fieldName: 'value' },
      ])
      .addSubscription(100, 0)
      .addData(100, 1_000_000n, { timestamp: 1000000, value: 1.0 })
      .addLog(2_000_000n, 0, 'Normal log string')

    const doc = await UlogDocument.open(builder.build())
    // All log-string events should have metadataAvailable: false
    for (const evt of doc.events) {
      assert.equal(evt.metadataAvailable, false)
      assert.equal(evt.isStructured, false)
    }
  })
})
