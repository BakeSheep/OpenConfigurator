import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { UlogFixtureBuilder } from './testing/ulogFixtureBuilder.js'
import { UlogDocument } from './parser/UlogDocument.js'
import { expandFieldPaths, isNumericType, baseType, arrayLength } from './parser/fieldPaths.js'

describe('ULog fixture builder', () => {
  it('encodes two instances of one topic', () => {
    const buf = new UlogFixtureBuilder()
      .addFormat(100, 'sensor_combined', [
        { type: 'uint64_t', fieldName: 'timestamp' },
        { type: 'float[3]', fieldName: 'accelerometer_m_s2' },
        { type: 'float[3]', fieldName: 'gyro_rad' },
      ])
      .addSubscription(100, 0)
      .addSubscription(100, 1)
      .addData(100, 1000n, {
        timestamp: 1000,
        'accelerometer_m_s2[0]': 0.1,
        'accelerometer_m_s2[1]': 0.2,
        'accelerometer_m_s2[2]': 9.8,
        'gyro_rad[0]': 0.01,
        'gyro_rad[1]': 0.02,
        'gyro_rad[2]': 0.03,
      })
      .build()

    assert.ok(buf.byteLength > 16, 'buffer should be larger than header')

    // Verify the buffer starts with ULog magic
    const magic = new Uint8Array(buf, 0, 7)
    assert.deepEqual([...magic], [0x55, 0x4c, 0x6f, 0x67, 0x01, 0x12, 0x35])
  })
})

// ─── fieldPaths unit tests ──────────────────────────────────────────────────

describe('fieldPaths', () => {
  it('baseType extracts the base from array types', () => {
    assert.equal(baseType('float[3]'), 'float')
    assert.equal(baseType('uint64_t'), 'uint64_t')
    assert.equal(baseType('char[10]'), 'char')
  })

  it('arrayLength returns length or null', () => {
    assert.equal(arrayLength('float[3]'), 3)
    assert.equal(arrayLength('uint64_t'), null)
    assert.equal(arrayLength('char[20]'), 20)
  })

  it('isNumericType identifies plottable types', () => {
    assert.equal(isNumericType('float'), true)
    assert.equal(isNumericType('float[3]'), true)
    assert.equal(isNumericType('int32_t'), true)
    assert.equal(isNumericType('uint64_t'), true)
    assert.equal(isNumericType('double'), true)
    assert.equal(isNumericType('bool'), false)
    assert.equal(isNumericType('char'), false)
    assert.equal(isNumericType('char[10]'), false)
  })

  it('expandFieldPaths expands scalars, arrays, and structs', () => {
    assert.deepEqual(expandFieldPaths('float', 'speed'), ['speed'])
    assert.deepEqual(expandFieldPaths('float[3]', 'accel'), [
      'accel[0]',
      'accel[1]',
      'accel[2]',
    ])

    const structDefs = new Map<string, Array<{ type: string; name: string }>>()
    structDefs.set('Vec2', [
      { type: 'float', name: 'x' },
      { type: 'float', name: 'y' },
    ])
    assert.deepEqual(expandFieldPaths('Vec2', 'pos', structDefs), [
      'pos.x',
      'pos.y',
    ])
  })
})

// ─── UlogDocument catalog tests ─────────────────────────────────────────────

describe('UlogDocument catalog', () => {
  it('builds complete catalog from a rich fixture', async () => {
    const buf = new UlogFixtureBuilder()
      // Formats — each subscription needs a unique msgId (@foxglove/ulog
      // keys subscriptions by msgId, so multi-instance topics need separate formats)
      .addFormat(100, 'sensor_combined', [
        { type: 'uint64_t', fieldName: 'timestamp' },
        { type: 'float[3]', fieldName: 'accelerometer_m_s2' },
        { type: 'float[3]', fieldName: 'gyro_rad' },
      ])
      .addFormat(101, 'sensor_combined', [
        { type: 'uint64_t', fieldName: 'timestamp' },
        { type: 'float[3]', fieldName: 'accelerometer_m_s2' },
        { type: 'float[3]', fieldName: 'gyro_rad' },
      ])
      .addFormat(102, 'vehicle_temperature', [
        { type: 'uint64_t', fieldName: 'timestamp' },
        { type: 'float', fieldName: 'board_temp_c' },
      ])
      // Subscriptions — each with unique msgId
      .addSubscription(100, 0)
      .addSubscription(101, 1)
      .addSubscription(102, 0)
      // Information (string value uses char[N] key format automatically)
      .addInformation('sys_name', 'test_vehicle')
      // Information (numeric value)
      .addInformation('boot_time_us', 12345)
      // Multi-information — use a DIFFERENT key from info to avoid library quirk
      // where multi-info is stored under raw key instead of field name
      .addMultiInformation('ver_multi', '1.0.0')
      // Parameters
      .addParameter('TEST_GAIN', 42)
      // Data: sensor_combined instance 0 — 2 samples
      .addData(100, 1000n, {
        timestamp: 1000,
        'accelerometer_m_s2[0]': 0.1,
        'accelerometer_m_s2[1]': 0.2,
        'accelerometer_m_s2[2]': 9.8,
        'gyro_rad[0]': 0.01,
        'gyro_rad[1]': 0.02,
        'gyro_rad[2]': 0.03,
      })
      .addData(100, 2000n, {
        timestamp: 2000,
        'accelerometer_m_s2[0]': 0.4,
        'accelerometer_m_s2[1]': 0.5,
        'accelerometer_m_s2[2]': 9.7,
        'gyro_rad[0]': 0.04,
        'gyro_rad[1]': 0.05,
        'gyro_rad[2]': 0.06,
      })
      // Data: sensor_combined instance 1 — 1 sample (msgId=101)
      .addData(101, 3000n, {
        timestamp: 3000,
        'accelerometer_m_s2[0]': 1.0,
        'accelerometer_m_s2[1]': 2.0,
        'accelerometer_m_s2[2]': 3.0,
        'gyro_rad[0]': 0.1,
        'gyro_rad[1]': 0.2,
        'gyro_rad[2]': 0.3,
      })
      // Data: temperature — 1 sample (msgId=102)
      .addData(102, 1500n, {
        timestamp: 1500,
        board_temp_c: 35.5,
      })
      // Log messages
      .addLog(500n, 7, 'debug test message') // LogLevel.Debug = 7
      .addTaggedLog(600n, 4, 42, 'tagged warning') // LogLevel.Warning = 4
      // Dropouts
      .addDropout(100)
      .addDropout(200)
      .build()

    const doc = await UlogDocument.open(buf)

    // ── Information preserves value types ───────────────────────────────
    assert.equal(doc.metadata.information['sys_name'], 'test_vehicle')
    assert.equal(doc.metadata.information['boot_time_us'], 12345)

    // ── Multi-information stored separately ─────────────────────────────
    assert.ok(doc.metadata.multiInformation.length > 0)

    // ── Parameters: initial values preserved ────────────────────────────
    const param = doc.parameters.find((p) => p.name === 'TEST_GAIN')
    assert.ok(param, 'parameter TEST_GAIN should exist')
    assert.equal(param!.value, 42)
    assert.equal(param!.defaultValue, null)
    assert.deepEqual(param!.runtimeChanges, [])

    // ── Both topic instances appear independently ───────────────────────
    const sc0 = doc.catalog.find(
      (t) => t.name === 'sensor_combined' && t.multiId === 0,
    )
    const sc1 = doc.catalog.find(
      (t) => t.name === 'sensor_combined' && t.multiId === 1,
    )
    assert.ok(sc0, 'sensor_combined instance 0 should exist')
    assert.ok(sc1, 'sensor_combined instance 1 should exist')
    assert.notEqual(sc0!.msgId, sc1!.msgId)

    // ── Field paths are expanded correctly ──────────────────────────────
    const fieldPaths = sc0!.fields.map((f) => f.path)
    assert.ok(fieldPaths.includes('timestamp'))
    assert.ok(fieldPaths.includes('accelerometer_m_s2[0]'))
    assert.ok(fieldPaths.includes('accelerometer_m_s2[1]'))
    assert.ok(fieldPaths.includes('accelerometer_m_s2[2]'))
    assert.ok(fieldPaths.includes('gyro_rad[0]'))
    assert.ok(fieldPaths.includes('gyro_rad[1]'))
    assert.ok(fieldPaths.includes('gyro_rad[2]'))

    // ── Sample count and time range per instance ────────────────────────
    assert.equal(sc0!.sampleCount, 2)
    assert.equal(sc1!.sampleCount, 1)

    // Global logStart includes log messages (500us), so relative times
    // are offset from 500us, not from the first data timestamp (1000us).
    // sc0 timestamps: 1000us and 2000us
    assert.equal(sc0!.firstTimeSec, 0.0005) // (1000-500)/1e6
    assert.equal(sc0!.lastTimeSec, 0.0015)  // (2000-500)/1e6

    // sc1 timestamps: 3000us
    assert.equal(sc1!.firstTimeSec, 0.0025) // (3000-500)/1e6
    assert.equal(sc1!.lastTimeSec, 0.0025)

    // ── Log events preserve tag and level ───────────────────────────────
    const debugEvent = doc.events.find((e) => e.message === 'debug test message')
    assert.ok(debugEvent, 'debug event should exist')
    assert.equal(debugEvent!.level, 'debug')
    assert.equal(debugEvent!.tag, null)

    const taggedEvent = doc.events.find((e) => e.message === 'tagged warning')
    assert.ok(taggedEvent, 'tagged event should exist')
    assert.equal(taggedEvent!.level, 'warning')
    assert.equal(taggedEvent!.tag, '42')

    // ── Dropout statistics ──────────────────────────────────────────────
    assert.equal(doc.timeline.dropoutCount, 2)
    assert.equal(doc.timeline.dropoutTotalMs, 300)
    assert.equal(doc.timeline.dropoutMaxMs, 200)
    assert.equal(doc.timeline.dropoutMeanMs, 150)

    // ── Coverage invariant ──────────────────────────────────────────────
    const c = doc.coverage
    assert.equal(
      c.discoveredTopicInstances,
      c.analyzedTopicInstances +
        c.rawOnlyTopicInstances +
        c.unsupportedTopicInstances,
      'discovered === analyzed + rawOnly + unsupported',
    )
    assert.equal(c.discoveredTopicInstances, 3) // sc0 + sc1 + temp
    assert.equal(c.analyzedTopicInstances, 0)
    assert.equal(c.rawOnlyTopicInstances, 3)
    assert.equal(c.unsupportedTopicInstances, 0)

    // Field counts: sensor_combined has 7 fields (timestamp + 3 accel + 3 gyro)
    // temperature has 2 fields (timestamp + board_temp_c)
    // Total: 7*2 + 2 = 16
    assert.equal(c.discoveredFields, 16)
    // Plottable: all are numeric (uint64_t and float)
    assert.equal(c.plottableFields, 16)
  })

  it('propagates normalization warnings into coverage', async () => {
    // Build a valid buffer then truncate to trigger a normalization warning
    const fullBuf = new UlogFixtureBuilder()
      .addFormat(100, 'sensor_combined', [
        { type: 'uint64_t', fieldName: 'timestamp' },
        { type: 'float[3]', fieldName: 'accelerometer_m_s2' },
        { type: 'float[3]', fieldName: 'gyro_rad' },
      ])
      .addSubscription(100, 0)
      .addData(100, 1000n, {
        timestamp: 1000,
        'accelerometer_m_s2[0]': 0.1,
        'accelerometer_m_s2[1]': 0.2,
        'accelerometer_m_s2[2]': 9.8,
        'gyro_rad[0]': 0.01,
        'gyro_rad[1]': 0.02,
        'gyro_rad[2]': 0.03,
      })
      .build()

    // Truncate last 2 bytes to trigger truncation repair warning
    const truncated = fullBuf.slice(0, fullBuf.byteLength - 2)
    const doc = await UlogDocument.open(truncated)

    assert.ok(
      doc.coverage.warnings.length > 0,
      'coverage should include normalization warnings',
    )
    assert.ok(
      doc.coverage.warnings.some((w) => w.includes('不完整')),
      'warning should mention truncation',
    )
  })
})
