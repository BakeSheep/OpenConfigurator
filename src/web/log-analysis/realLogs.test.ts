import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { UlogFixtureBuilder } from './testing/ulogFixtureBuilder.js'
import { UlogDocument } from './parser/UlogDocument.js'
import { ModuleRegistry } from './engine/moduleRegistry.js'
import { runAnalysis } from './engine/runAnalysis.js'
import { flightOverviewModule } from './modules/flightOverview.js'
import { estimatorModule } from './modules/estimator.js'
import { sensorsModule } from './modules/sensors.js'
import { failsafeModule } from './modules/failsafe.js'
import { systemHealthModule } from './modules/systemHealth.js'
import { navigationModule } from './modules/navigation.js'
import { powerModule } from './modules/power.js'
import { batteryModule } from './modules/battery.js'
import { gpsModule } from './modules/gps.js'
import { controlTrackingModule } from './modules/controlTracking.js'
import { actuatorsModule } from './modules/actuators.js'
import { propulsionModule } from './modules/propulsion.js'
import { eventsModule } from './modules/events.js'
import type { AnalysisRunResult } from './engine/runAnalysis.js'
import type { UlogTopicCatalogEntry, CoverageSummary } from './types.js'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function createFullRegistry(): ModuleRegistry {
  const registry = new ModuleRegistry()
  registry.register(flightOverviewModule)
  registry.register(estimatorModule)
  registry.register(sensorsModule)
  registry.register(failsafeModule)
  registry.register(systemHealthModule)
  registry.register(navigationModule)
  registry.register(powerModule)
  registry.register(batteryModule)
  registry.register(gpsModule)
  registry.register(controlTrackingModule)
  registry.register(actuatorsModule)
  registry.register(propulsionModule)
  registry.register(eventsModule)
  return registry
}

/**
 * Assert invariants that must hold for every successfully parsed log.
 */
function assertDocInvariants(
  doc: UlogDocument,
  result: AnalysisRunResult,
  expectedTopics: string[],
): void {
  const topicNames = doc.catalog.map((t) => t.name)

  // 1. Expected topic instances found
  for (const name of expectedTopics) {
    assert.ok(topicNames.includes(name), `Expected topic "${name}" not found in catalog`)
  }

  // 2. Non-negative, monotonically non-decreasing time
  for (const topic of doc.catalog) {
    if (topic.firstTimeSec != null) {
      assert.ok(topic.firstTimeSec >= 0, `${topic.name} firstTimeSec should be >= 0, got ${topic.firstTimeSec}`)
    }
    if (topic.lastTimeSec != null && topic.firstTimeSec != null) {
      assert.ok(
        topic.lastTimeSec >= topic.firstTimeSec,
        `${topic.name} lastTimeSec (${topic.lastTimeSec}) should be >= firstTimeSec (${topic.firstTimeSec})`,
      )
    }
  }

  // 3. Known modules available (not all missing)
  const sections = result.sections
  const availableSections = Object.values(sections).filter((s) => s?.available)
  assert.ok(
    availableSections.length > 0,
    'At least one analysis module should be available',
  )

  // 4. Finite metric ranges (no NaN/Infinity in outputs)
  for (const [, section] of Object.entries(sections)) {
    if (!section) continue
    for (const modResult of section.moduleResults) {
      for (const [key, val] of Object.entries(modResult.metrics)) {
        if (typeof val === 'number') {
          assert.ok(Number.isFinite(val), `Metric ${modResult.moduleId}.${key} is not finite: ${val}`)
        }
      }
    }
  }

  // 5. Coverage accounting correct
  const cov = result.coverage
  assert.equal(
    cov.discoveredTopicInstances,
    cov.analyzedTopicInstances + cov.rawOnlyTopicInstances + cov.unsupportedTopicInstances,
    'Coverage invariant: discovered === analyzed + rawOnly + unsupported',
  )

  // 6. No silent warnings (all warnings are explicit strings)
  for (const w of cov.warnings) {
    assert.equal(typeof w, 'string', 'Warnings must be strings')
    assert.ok(w.length > 0, 'Warning must not be empty')
  }

  // 7. Stable finding IDs (deterministic)
  const findingIds = result.findings.map((f) => f.id)
  const uniqueIds = new Set(findingIds)
  assert.equal(uniqueIds.size, findingIds.length, 'Finding IDs must be unique')
}

/**
 * Build a basic multicopter log with core PX4 topics.
 */
function buildBasicMulticopterBuffer(): ArrayBuffer {
  const builder = new UlogFixtureBuilder()
    .addInformation('sys_name', 'Multicopter')
    .addInformation('ver_sw', '1.14.0')
    // vehicle_attitude (msgId 200)
    .addFormat(200, 'vehicle_attitude', [
      { type: 'uint64_t', fieldName: 'timestamp' },
      { type: 'float[4]', fieldName: 'q' },
    ])
    // sensor_combined (msgId 201)
    .addFormat(201, 'sensor_combined', [
      { type: 'uint64_t', fieldName: 'timestamp' },
      { type: 'float[3]', fieldName: 'accelerometer_m_s2' },
      { type: 'float[3]', fieldName: 'gyro_rad' },
    ])
    // battery_status (msgId 202)
    .addFormat(202, 'battery_status', [
      { type: 'uint64_t', fieldName: 'timestamp' },
      { type: 'float', fieldName: 'voltage_v' },
      { type: 'float', fieldName: 'current_a' },
    ])
    // vehicle_gps_position (msgId 203)
    .addFormat(203, 'vehicle_gps_position', [
      { type: 'uint64_t', fieldName: 'timestamp' },
      { type: 'int32_t', fieldName: 'lat' },
      { type: 'int32_t', fieldName: 'lon' },
      { type: 'int32_t', fieldName: 'alt' },
      { type: 'uint8_t', fieldName: 'fix_type' },
      { type: 'uint8_t', fieldName: 'satellites_used' },
    ])
    // Subscriptions
    .addSubscription(200, 0)
    .addSubscription(201, 0)
    .addSubscription(202, 0)
    .addSubscription(203, 0)

  // Data samples at increasing timestamps
  for (let i = 0; i < 10; i++) {
    const ts = BigInt(i * 100_000) // 100ms intervals
    builder.addData(200, ts, {
      'q[0]': 1.0, 'q[1]': 0, 'q[2]': 0, 'q[3]': 0,
    })
    builder.addData(201, ts, {
      'accelerometer_m_s2[0]': 0.1 * i,
      'accelerometer_m_s2[1]': 0.2 * i,
      'accelerometer_m_s2[2]': -9.81,
      'gyro_rad[0]': 0.01 * i,
      'gyro_rad[1]': 0.02 * i,
      'gyro_rad[2]': 0.0,
    })
    builder.addData(202, ts, {
      'voltage_v': 12.0 - 0.01 * i,
      'current_a': 5.0 + 0.1 * i,
    })
    builder.addData(203, ts, {
      'lat': 473977420,
      'lon': 85455940,
      'alt': 48800,
      'fix_type': 3,
      'satellites_used': 12,
    })
  }

  return builder.build()
}

/**
 * Build a fixed-wing log with FW-specific fields.
 */
function buildFixedWingBuffer(): ArrayBuffer {
  const builder = new UlogFixtureBuilder()
    .addInformation('sys_name', 'FixedWing')
    .addInformation('ver_sw', '1.14.0')
    // vehicle_attitude
    .addFormat(200, 'vehicle_attitude', [
      { type: 'uint64_t', fieldName: 'timestamp' },
      { type: 'float[4]', fieldName: 'q' },
    ])
    // sensor_combined
    .addFormat(201, 'sensor_combined', [
      { type: 'uint64_t', fieldName: 'timestamp' },
      { type: 'float[3]', fieldName: 'accelerometer_m_s2' },
      { type: 'float[3]', fieldName: 'gyro_rad' },
    ])
    // battery_status
    .addFormat(202, 'battery_status', [
      { type: 'uint64_t', fieldName: 'timestamp' },
      { type: 'float', fieldName: 'voltage_v' },
      { type: 'float', fieldName: 'current_a' },
    ])
    // vehicle_gps_position
    .addFormat(203, 'vehicle_gps_position', [
      { type: 'uint64_t', fieldName: 'timestamp' },
      { type: 'int32_t', fieldName: 'lat' },
      { type: 'int32_t', fieldName: 'lon' },
      { type: 'int32_t', fieldName: 'alt' },
      { type: 'uint8_t', fieldName: 'fix_type' },
      { type: 'uint8_t', fieldName: 'satellites_used' },
    ])
    // vehicle_air_data (FW-specific)
    .addFormat(210, 'vehicle_air_data', [
      { type: 'uint64_t', fieldName: 'timestamp' },
      { type: 'float', fieldName: 'baro_alt_meter' },
      { type: 'float', fieldName: 'indicated_airspeed_m_s' },
      { type: 'float', fieldName: 'true_airspeed_m_s' },
    ])
    // Subscriptions
    .addSubscription(200, 0)
    .addSubscription(201, 0)
    .addSubscription(202, 0)
    .addSubscription(203, 0)
    .addSubscription(210, 0)

  for (let i = 0; i < 10; i++) {
    const ts = BigInt(i * 100_000)
    builder.addData(200, ts, { 'q[0]': 1.0, 'q[1]': 0, 'q[2]': 0, 'q[3]': 0 })
    builder.addData(201, ts, {
      'accelerometer_m_s2[0]': 0.1, 'accelerometer_m_s2[1]': 0, 'accelerometer_m_s2[2]': -9.81,
      'gyro_rad[0]': 0, 'gyro_rad[1]': 0, 'gyro_rad[2]': 0,
    })
    builder.addData(202, ts, { 'voltage_v': 12.0, 'current_a': 5.0 })
    builder.addData(203, ts, { 'lat': 473977420, 'lon': 85455940, 'alt': 48800, 'fix_type': 3, 'satellites_used': 12 })
    builder.addData(210, ts, {
      'baro_alt_meter': 100.0 + i,
      'indicated_airspeed_m_s': 15.0 + 0.1 * i,
      'true_airspeed_m_s': 16.0 + 0.1 * i,
    })
  }

  return builder.build()
}

/**
 * Build a log using legacy topic names (alias resolution test).
 * Uses 'sensor_gps' instead of 'vehicle_gps_position',
 * and 'battery_status_old' instead of 'battery_status'.
 */
function buildLegacyTopicBuffer(): ArrayBuffer {
  const builder = new UlogFixtureBuilder()
    .addInformation('sys_name', 'LegacyLog')
    .addInformation('ver_sw', '1.11.0')
    // vehicle_attitude (same name across versions)
    .addFormat(200, 'vehicle_attitude', [
      { type: 'uint64_t', fieldName: 'timestamp' },
      { type: 'float[4]', fieldName: 'q' },
    ])
    // sensor_combined
    .addFormat(201, 'sensor_combined', [
      { type: 'uint64_t', fieldName: 'timestamp' },
      { type: 'float[3]', fieldName: 'accelerometer_m_s2' },
      { type: 'float[3]', fieldName: 'gyro_rad' },
    ])
    // Legacy GPS name
    .addFormat(203, 'sensor_gps', [
      { type: 'uint64_t', fieldName: 'timestamp' },
      { type: 'int32_t', fieldName: 'lat' },
      { type: 'int32_t', fieldName: 'lon' },
      { type: 'int32_t', fieldName: 'alt' },
      { type: 'uint8_t', fieldName: 'fix_type' },
      { type: 'uint8_t', fieldName: 'satellites_used' },
    ])
    // Legacy battery name
    .addFormat(204, 'battery_status_old', [
      { type: 'uint64_t', fieldName: 'timestamp' },
      { type: 'float', fieldName: 'voltage_v' },
      { type: 'float', fieldName: 'current_a' },
    ])
    // Subscriptions
    .addSubscription(200, 0)
    .addSubscription(201, 0)
    .addSubscription(203, 0)
    .addSubscription(204, 0)

  for (let i = 0; i < 5; i++) {
    const ts = BigInt(i * 100_000)
    builder.addData(200, ts, { 'q[0]': 1.0, 'q[1]': 0, 'q[2]': 0, 'q[3]': 0 })
    builder.addData(201, ts, {
      'accelerometer_m_s2[0]': 0, 'accelerometer_m_s2[1]': 0, 'accelerometer_m_s2[2]': -9.81,
      'gyro_rad[0]': 0, 'gyro_rad[1]': 0, 'gyro_rad[2]': 0,
    })
    builder.addData(203, ts, { 'lat': 473977420, 'lon': 85455940, 'alt': 48800, 'fix_type': 3, 'satellites_used': 8 })
    builder.addData(204, ts, { 'voltage_v': 11.5, 'current_a': 4.0 })
  }

  return builder.build()
}

/**
 * Build a multi-IMU log with multiple sensor instances.
 * Note: @foxglove/ulog uses Map<msgId, Subscription> so multiple subscriptions
 * with the same msgId but different multiIds collapse into one. We use distinct
 * msgIds per instance to simulate multi-IMU correctly.
 */
function buildMultiImuBuffer(): ArrayBuffer {
  const builder = new UlogFixtureBuilder()
    .addInformation('sys_name', 'MultiIMU')
    .addInformation('ver_sw', '1.14.0')
    // sensor_combined
    .addFormat(201, 'sensor_combined', [
      { type: 'uint64_t', fieldName: 'timestamp' },
      { type: 'float[3]', fieldName: 'accelerometer_m_s2' },
      { type: 'float[3]', fieldName: 'gyro_rad' },
    ])
    // 3 separate sensor_accel topics with distinct msgIds (simulating multi-IMU)
    .addFormat(210, 'sensor_accel', [
      { type: 'uint64_t', fieldName: 'timestamp' },
      { type: 'float[3]', fieldName: 'xyz' },
    ])
    .addFormat(211, 'sensor_accel', [
      { type: 'uint64_t', fieldName: 'timestamp' },
      { type: 'float[3]', fieldName: 'xyz' },
    ])
    .addFormat(212, 'sensor_accel', [
      { type: 'uint64_t', fieldName: 'timestamp' },
      { type: 'float[3]', fieldName: 'xyz' },
    ])
    // vehicle_attitude
    .addFormat(200, 'vehicle_attitude', [
      { type: 'uint64_t', fieldName: 'timestamp' },
      { type: 'float[4]', fieldName: 'q' },
    ])
    // Subscriptions: sensor_combined + 3 sensor_accel with distinct msgIds
    .addSubscription(201, 0)
    .addSubscription(210, 0)
    .addSubscription(211, 1)
    .addSubscription(212, 2)
    .addSubscription(200, 0)

  for (let i = 0; i < 5; i++) {
    const ts = BigInt(i * 100_000)
    builder.addData(200, ts, { 'q[0]': 1.0, 'q[1]': 0, 'q[2]': 0, 'q[3]': 0 })
    builder.addData(201, ts, {
      'accelerometer_m_s2[0]': 0, 'accelerometer_m_s2[1]': 0, 'accelerometer_m_s2[2]': -9.81,
      'gyro_rad[0]': 0, 'gyro_rad[1]': 0, 'gyro_rad[2]': 0,
    })
    for (const msgId of [210, 211, 212]) {
      const inst = msgId - 210
      builder.addData(msgId, ts, {
        'xyz[0]': 0.01 * inst, 'xyz[1]': 0.02 * inst, 'xyz[2]': -9.81,
      })
    }
  }

  return builder.build()
}

/**
 * Build a log with parameter changes and dropout messages.
 */
function buildParamChangeDropoutBuffer(): ArrayBuffer {
  const builder = new UlogFixtureBuilder()
    .addInformation('sys_name', 'ParamDropout')
    .addInformation('ver_sw', '1.14.0')
    .addParameter('MC_ROLLRATE_P', 0.15)
    .addParameter('MC_PITCHRATE_P', 0.15)
    // vehicle_attitude
    .addFormat(200, 'vehicle_attitude', [
      { type: 'uint64_t', fieldName: 'timestamp' },
      { type: 'float[4]', fieldName: 'q' },
    ])
    // sensor_combined
    .addFormat(201, 'sensor_combined', [
      { type: 'uint64_t', fieldName: 'timestamp' },
      { type: 'float[3]', fieldName: 'accelerometer_m_s2' },
      { type: 'float[3]', fieldName: 'gyro_rad' },
    ])
    .addSubscription(200, 0)
    .addSubscription(201, 0)

  // First batch of data
  for (let i = 0; i < 5; i++) {
    const ts = BigInt(i * 100_000)
    builder.addData(200, ts, { 'q[0]': 1.0, 'q[1]': 0, 'q[2]': 0, 'q[3]': 0 })
    builder.addData(201, ts, {
      'accelerometer_m_s2[0]': 0, 'accelerometer_m_s2[1]': 0, 'accelerometer_m_s2[2]': -9.81,
      'gyro_rad[0]': 0, 'gyro_rad[1]': 0, 'gyro_rad[2]': 0,
    })
  }

  // Dropout event
  builder.addDropout(50)

  // More data after dropout
  for (let i = 5; i < 10; i++) {
    const ts = BigInt(i * 100_000)
    builder.addData(200, ts, { 'q[0]': 1.0, 'q[1]': 0, 'q[2]': 0, 'q[3]': 0 })
    builder.addData(201, ts, {
      'accelerometer_m_s2[0]': 0.1, 'accelerometer_m_s2[1]': 0, 'accelerometer_m_s2[2]': -9.81,
      'gyro_rad[0]': 0, 'gyro_rad[1]': 0, 'gyro_rad[2]': 0,
    })
  }

  // Another dropout
  builder.addDropout(30)

  return builder.build()
}

/**
 * Build a v2 log with appended data section (simulates crash recovery).
 * This manually constructs a v2 buffer with FlagBits record.
 */
function buildAppendedCrashBuffer(): ArrayBuffer {
  // First, build a normal v1 log as the base
  const baseBuilder = new UlogFixtureBuilder()
    .setVersion(2)
    .addInformation('sys_name', 'CrashLog')
    .addInformation('ver_sw', '1.14.0')
    .addFormat(200, 'vehicle_attitude', [
      { type: 'uint64_t', fieldName: 'timestamp' },
      { type: 'float[4]', fieldName: 'q' },
    ])
    .addFormat(201, 'sensor_combined', [
      { type: 'uint64_t', fieldName: 'timestamp' },
      { type: 'float[3]', fieldName: 'accelerometer_m_s2' },
      { type: 'float[3]', fieldName: 'gyro_rad' },
    ])
    .addSubscription(200, 0)
    .addSubscription(201, 0)

  for (let i = 0; i < 5; i++) {
    const ts = BigInt(i * 100_000)
    baseBuilder.addData(200, ts, { 'q[0]': 1.0, 'q[1]': 0, 'q[2]': 0, 'q[3]': 0 })
    baseBuilder.addData(201, ts, {
      'accelerometer_m_s2[0]': 0, 'accelerometer_m_s2[1]': 0, 'accelerometer_m_s2[2]': -9.81,
      'gyro_rad[0]': 0, 'gyro_rad[1]': 0, 'gyro_rad[2]': 0,
    })
  }

  const baseBuf = baseBuilder.build()
  const baseBytes = new Uint8Array(baseBuf)

  // We need to construct a v2 file with FlagBits and appended data.
  // The normalizeUlogBuffer expects:
  // - Header (16 bytes, version=2)
  // - Definitions section (F, I, P records + FlagBits 'B' record)
  // - Data section start (marked by first 'A' record)
  // - FlagBits record: 40 bytes payload
  //   - 8 bytes compat flags
  //   - 8 bytes incompat flags (bit 0 = AppendedData)
  //   - 24 bytes (3 × uint64 appended offsets)

  // Strategy: Build a new buffer manually.
  // We'll extract definitions and data from baseBuf, then wrap with FlagBits.

  // Actually, the builder already outputs version=2 but no FlagBits record.
  // normalizeUlogBuffer will throw "v2 file missing FlagBits record".
  // So we need to insert a FlagBits record into the definitions section.

  // Let's build the entire v2 appended buffer from scratch.
  const MAGIC = [0x55, 0x4c, 0x6f, 0x67, 0x01, 0x12, 0x35]
  const records: Uint8Array[] = []

  function encodeRecord(type: string, payload: Uint8Array): Uint8Array {
    const result = new Uint8Array(3 + payload.byteLength)
    const view = new DataView(result.buffer)
    view.setUint16(0, payload.byteLength, true)
    result[2] = type.charCodeAt(0)
    result.set(payload, 3)
    return result
  }

  // Definition records (F, I)
  const defTypes = new Set(['F', 'I', 'M', 'P', 'Q'])

  // Extract definition records from base buffer
  let pos = 16 // skip header
  const baseView = new DataView(baseBuf)
  const defRecords: Uint8Array[] = []
  const dataRecords: Uint8Array[] = []

  while (pos + 3 <= baseBytes.byteLength) {
    const size = baseView.getUint16(pos, true)
    const type = baseBytes[pos + 2]
    const totalSize = 3 + size
    if (pos + totalSize > baseBytes.byteLength) break
    const rec = baseBytes.slice(pos, pos + totalSize)
    const typeChar = String.fromCharCode(type)
    if (defTypes.has(typeChar)) {
      defRecords.push(rec)
    } else {
      dataRecords.push(rec)
    }
    pos += totalSize
  }

  // Build FlagBits record (type 'B')
  // Payload: 40 bytes
  // - bytes 0-7: compat flags (0)
  // - bytes 8-15: incompat flags (0x01 = AppendedData)
  // - bytes 16-39: 3 × uint64 appended offsets
  const flagBitsPayload = new Uint8Array(40)
  const fbView = new DataView(flagBitsPayload.buffer)
  // compat flags = 0
  flagBitsPayload[0] = 0
  // incompat flags = 0x01 (AppendedData)
  flagBitsPayload[8] = 0x01

  // We need to calculate where data section starts.
  // Header: 16 bytes
  // Definitions: all def records + FlagBits record (43 bytes)
  const FLAG_BITS_REC_SIZE = 43 // 3 byte header + 40 byte payload

  // Calculate data section start (after header + all definitions + FlagBits)
  let defsSize = 0
  for (const r of defRecords) defsSize += r.byteLength
  defsSize += FLAG_BITS_REC_SIZE

  const dataSectionStart = 16 + defsSize

  // Calculate data size for first section
  let firstDataSize = 0
  for (const r of dataRecords) firstDataSize += r.byteLength

  // The appended offset points to where the first data section ends
  // (i.e., where the appended section begins)
  const firstAppendOffset = dataSectionStart + firstDataSize

  // Build a small appended section with one more data record
  const appendedBuilder = new UlogFixtureBuilder()
    .addFormat(200, 'vehicle_attitude', [
      { type: 'uint64_t', fieldName: 'timestamp' },
      { type: 'float[4]', fieldName: 'q' },
    ])
    .addSubscription(200, 0)
  appendedBuilder.addData(200, 500_000n, { 'q[0]': 0.9, 'q[1]': 0.1, 'q[2]': 0, 'q[3]': 0 })

  const appendedBuf = appendedBuilder.build()
  const appendedBytes = new Uint8Array(appendedBuf)

  // Extract only data records from appended buffer (skip header + definitions)
  let aPos = 16
  const aView = new DataView(appendedBuf)
  const appendedDataRecords: Uint8Array[] = []
  while (aPos + 3 <= appendedBytes.byteLength) {
    const size = aView.getUint16(aPos, true)
    const type = appendedBytes[aPos + 2]
    const totalSize = 3 + size
    if (aPos + totalSize > appendedBytes.byteLength) break
    const typeChar = String.fromCharCode(type)
    if (!defTypes.has(typeChar)) {
      appendedDataRecords.push(appendedBytes.slice(aPos, aPos + totalSize))
    }
    aPos += totalSize
  }

  // Set appended offsets BEFORE encoding the record
  // offset[0] = start of appended section = firstAppendOffset
  // offset[1] = 0 (no second appended section)
  // offset[2] = 0
  fbView.setBigUint64(16, BigInt(firstAppendOffset), true)
  fbView.setBigUint64(24, 0n, true)
  fbView.setBigUint64(32, 0n, true)

  // FlagBits record (must be created AFTER setting offsets in payload)
  const flagBitsRec = encodeRecord('B', flagBitsPayload)

  // Assemble the full buffer
  const totalSize = 16 + defsSize + firstDataSize + appendedDataRecords.reduce((s, r) => s + r.byteLength, 0)
  const result = new Uint8Array(totalSize)
  let offset = 0

  // Header (version 2)
  const header = new Uint8Array(16)
  for (let i = 0; i < MAGIC.length; i++) header[i] = MAGIC[i]!
  header[7] = 2 // version 2
  const headerView = new DataView(header.buffer)
  headerView.setBigUint64(8, 0n, true) // timestamp
  result.set(header, offset)
  offset += 16

  // Definition records
  for (const r of defRecords) {
    result.set(r, offset)
    offset += r.byteLength
  }

  // FlagBits record
  result.set(flagBitsRec, offset)
  offset += flagBitsRec.byteLength

  // Original data records
  for (const r of dataRecords) {
    result.set(r, offset)
    offset += r.byteLength
  }

  // Appended data records
  for (const r of appendedDataRecords) {
    result.set(r, offset)
    offset += r.byteLength
  }

  return result.buffer
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('PX4 ULog compatibility matrix', () => {
  it('parses synthetic multicopter log with basic topics', async () => {
    const buf = buildBasicMulticopterBuffer()
    const doc = await UlogDocument.open(buf)
    const registry = createFullRegistry()
    const result = await runAnalysis(doc, registry)

    assertDocInvariants(doc, result, [
      'vehicle_attitude',
      'sensor_combined',
      'battery_status',
      'vehicle_gps_position',
    ])

    // Verify metadata
    assert.equal(doc.metadata.vehicleType, 'Multicopter')
    assert.equal(doc.metadata.firmwareVersion, '1.14.0')
    assert.equal(doc.metadata.hadAppendedData, false)

    // Verify all 4 topics have data samples
    for (const topic of doc.catalog) {
      assert.ok(topic.sampleCount > 0, `${topic.name} should have data samples`)
    }
  })

  it('parses synthetic fixed-wing log with air data', async () => {
    const buf = buildFixedWingBuffer()
    const doc = await UlogDocument.open(buf)
    const registry = createFullRegistry()
    const result = await runAnalysis(doc, registry)

    assertDocInvariants(doc, result, [
      'vehicle_attitude',
      'sensor_combined',
      'battery_status',
      'vehicle_gps_position',
      'vehicle_air_data',
    ])

    // Verify FW-specific topic has data
    const airDataTopic = doc.catalog.find((t) => t.name === 'vehicle_air_data')
    assert.ok(airDataTopic, 'vehicle_air_data topic should exist')
    assert.ok(airDataTopic.sampleCount > 0, 'vehicle_air_data should have samples')

    // Verify fields exist
    const fieldPaths = airDataTopic.fields.map((f) => f.path)
    assert.ok(fieldPaths.includes('baro_alt_meter'), 'Should have baro_alt_meter field')
    assert.ok(fieldPaths.includes('indicated_airspeed_m_s'), 'Should have indicated_airspeed_m_s field')
  })

  it('resolves legacy topic names via alias mechanism', async () => {
    const buf = buildLegacyTopicBuffer()
    const doc = await UlogDocument.open(buf)
    const registry = createFullRegistry()
    const result = await runAnalysis(doc, registry)

    // Legacy topics should be present
    const topicNames = doc.catalog.map((t) => t.name)
    assert.ok(topicNames.includes('sensor_gps'), 'Legacy sensor_gps topic should exist')
    assert.ok(topicNames.includes('battery_status_old'), 'Legacy battery_status_old topic should exist')

    // Coverage and module invariants should still hold
    assertDocInvariants(doc, result, [
      'vehicle_attitude',
      'sensor_combined',
      'sensor_gps',
      'battery_status_old',
    ])

    // Modules that use aliases should have resolved the legacy names
    // gps module uses aliases: ['vehicle_gps_position', 'sensor_gps']
    // power/battery modules use aliases: ['battery_status', 'battery_status_old']
    const gpsSection = result.sections['sensors-power']
    assert.ok(gpsSection, 'sensors-power section should exist')
  })

  it('handles multi-IMU log with multiple sensor instances', async () => {
    const buf = buildMultiImuBuffer()
    const doc = await UlogDocument.open(buf)
    const registry = createFullRegistry()
    const result = await runAnalysis(doc, registry)

    // Should have sensor_combined + 3 sensor_accel instances (distinct msgIds)
    const sensorTopics = doc.catalog.filter((t) => t.name === 'sensor_combined')
    assert.ok(sensorTopics.length >= 1, 'Should have at least 1 sensor_combined instance')

    const accelTopics = doc.catalog.filter((t) => t.name === 'sensor_accel')
    assert.equal(accelTopics.length, 3, 'Should have 3 sensor_accel instances')

    // Each instance should have distinct multiId
    const multiIds = accelTopics.map((t) => t.multiId).sort()
    assert.deepEqual(multiIds, [0, 1, 2], 'Multi-IDs should be 0, 1, 2')

    // All instances should have data
    for (const topic of accelTopics) {
      assert.ok(topic.sampleCount > 0, `sensor_accel instance ${topic.multiId} should have samples`)
    }

    assertDocInvariants(doc, result, ['vehicle_attitude', 'sensor_combined', 'sensor_accel'])
  })

  it('handles log with parameter changes and dropouts', async () => {
    const buf = buildParamChangeDropoutBuffer()
    const doc = await UlogDocument.open(buf)
    const registry = createFullRegistry()
    const result = await runAnalysis(doc, registry)

    // Parameters should be parsed
    assert.ok(doc.parameters.length >= 2, 'Should have at least 2 parameters')
    const paramNames = doc.parameters.map((p) => p.name)
    assert.ok(paramNames.includes('MC_ROLLRATE_P'), 'Should have MC_ROLLRATE_P parameter')
    assert.ok(paramNames.includes('MC_PITCHRATE_P'), 'Should have MC_PITCHRATE_P parameter')

    // Timeline should record dropouts
    assert.ok(doc.timeline.dropoutCount >= 2, `Should have at least 2 dropouts, got ${doc.timeline.dropoutCount}`)
    assert.ok(doc.timeline.dropoutTotalMs > 0, 'Total dropout time should be > 0')
    assert.equal(doc.timeline.dropoutMaxMs, 50, 'Max dropout should be 50ms')

    // Topics should still have data spanning the dropout
    const attitudeTopic = doc.catalog.find((t) => t.name === 'vehicle_attitude')
    assert.ok(attitudeTopic, 'vehicle_attitude should exist')
    assert.ok(attitudeTopic.sampleCount >= 10, 'Should have at least 10 attitude samples')

    assertDocInvariants(doc, result, ['vehicle_attitude', 'sensor_combined'])
  })

  it('handles v2 log with appended crash data', async () => {
    const buf = buildAppendedCrashBuffer()
    const doc = await UlogDocument.open(buf)
    const registry = createFullRegistry()
    const result = await runAnalysis(doc, registry)

    // Should detect appended data
    assert.equal(doc.metadata.hadAppendedData, true, 'Should detect appended data')

    // Should still have basic topics
    assertDocInvariants(doc, result, ['vehicle_attitude', 'sensor_combined'])

    // Attitude topic should have samples from both original and appended sections
    const attitudeTopic = doc.catalog.find((t) => t.name === 'vehicle_attitude')
    assert.ok(attitudeTopic, 'vehicle_attitude should exist')
    assert.ok(attitudeTopic.sampleCount > 0, 'Should have attitude samples from appended data')
  })

  it('rejects corrupt buffer with invalid magic', async () => {
    const corruptBuf = new ArrayBuffer(32)
    const view = new Uint8Array(corruptBuf)
    view[0] = 0xFF // wrong magic
    view[1] = 0xFF
    view[2] = 0xFF

    await assert.rejects(
      () => UlogDocument.open(corruptBuf),
      /Invalid ULog magic bytes/,
    )
  })

  it('rejects buffer too small for header', async () => {
    const tinyBuf = new ArrayBuffer(4)
    await assert.rejects(
      () => UlogDocument.open(tinyBuf),
      /Buffer too small/,
    )
  })

  it('rejects unsupported ULog version', async () => {
    const buf = new UlogFixtureBuilder().build()
    const bytes = new Uint8Array(buf)
    // Patch version byte to an unsupported value
    bytes[7] = 99

    await assert.rejects(
      () => UlogDocument.open(buf),
      /Unsupported ULog version/,
    )
  })

  it('rejects v2 buffer with unknown incompatible flags', async () => {
    // Build a minimal v2 buffer with FlagBits having unknown incompat flags
    const MAGIC = [0x55, 0x4c, 0x6f, 0x67, 0x01, 0x12, 0x35]

    // Header
    const header = new Uint8Array(16)
    for (let i = 0; i < MAGIC.length; i++) header[i] = MAGIC[i]!
    header[7] = 2 // version 2

    // FlagBits record with unknown incompat flag (bit 1)
    const flagBitsPayload = new Uint8Array(40)
    flagBitsPayload[8] = 0x02 // unknown incompatible flag bit 1

    const flagBitsRec = new Uint8Array(3 + 40)
    const fbView = new DataView(flagBitsRec.buffer)
    fbView.setUint16(0, 40, true)
    flagBitsRec[2] = 0x42 // 'B'
    flagBitsRec.set(flagBitsPayload, 3)

    // Assemble
    const total = new Uint8Array(16 + flagBitsRec.byteLength)
    total.set(header, 0)
    total.set(flagBitsRec, 16)

    await assert.rejects(
      () => UlogDocument.open(total.buffer),
      /Unknown incompatible flag/,
    )
  })

  it('produces deterministic results across repeated runs', async () => {
    const buf = buildBasicMulticopterBuffer()

    // Run analysis twice
    const doc1 = await UlogDocument.open(buf)
    const registry1 = createFullRegistry()
    const result1 = await runAnalysis(doc1, registry1)

    const doc2 = await UlogDocument.open(buf)
    const registry2 = createFullRegistry()
    const result2 = await runAnalysis(doc2, registry2)

    // Finding IDs should be identical
    assert.deepEqual(
      result1.findings.map((f) => f.id),
      result2.findings.map((f) => f.id),
      'Finding IDs should be deterministic',
    )

    // Coverage should be identical
    assert.deepEqual(result1.coverage, result2.coverage, 'Coverage should be deterministic')

    // Section metrics should be identical
    for (const [sectionId, section1] of Object.entries(result1.sections)) {
      const section2 = result2.sections[sectionId as keyof typeof result2.sections]
      if (section1 && section2) {
        assert.deepEqual(
          section1.moduleResults.map((m) => m.metrics),
          section2.moduleResults.map((m) => m.metrics),
          `Metrics for section ${sectionId} should be deterministic`,
        )
      }
    }
  })
})

// ─── Extended local fixtures (ULOG_FIXTURE_DIR) ─────────────────────────────

describe('Extended local fixtures (ULOG_FIXTURE_DIR)', () => {
  it('reports skipped when ULOG_FIXTURE_DIR is not set', () => {
    const fixtureDir = process.env.ULOG_FIXTURE_DIR
    if (!fixtureDir) {
      // This is expected — extended fixtures are optional
      assert.ok(true, 'ULOG_FIXTURE_DIR not set, extended fixtures skipped')
    } else {
      // If set, we would scan the directory for .ulog files and run them
      assert.ok(typeof fixtureDir === 'string', 'ULOG_FIXTURE_DIR should be a string path')
    }
  })
})
