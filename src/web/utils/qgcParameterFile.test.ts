import assert from 'node:assert/strict'
import test from 'node:test'
import type { ParamData, VehicleIdentity } from '../../shared/types'
import {
  buildQgcParameterPreview,
  isDangerousParameter,
  parseQgcParameterFile,
  serializeQgcParameterFile,
} from './qgcParameterFile'

const identity: VehicleIdentity = {
  family: 'px4',
  vehicleClass: 'copter',
  autopilotId: 12,
  vehicleTypeId: 2,
}

const liveParams = new Map<string, ParamData>([
  ['FLOAT_PARAM', { id: 'FLOAT_PARAM', value: Math.fround(0.1), type: 9, param_count: 4, param_index: 0 }],
  ['INT_PARAM', { id: 'INT_PARAM', value: 10, type: 6, param_count: 4, param_index: 1 }],
  ['TYPE_PARAM', { id: 'TYPE_PARAM', value: 2, type: 4, param_count: 4, param_index: 2 }],
  ['CBRK_TEST', { id: 'CBRK_TEST', value: 0, type: 6, param_count: 4, param_index: 3 }],
])

test('serializes the official QGC header and sorted tab-delimited rows', () => {
  const content = serializeQgcParameterFile({
    systemId: 7,
    componentId: 1,
    params: [liveParams.get('INT_PARAM')!, liveParams.get('FLOAT_PARAM')!],
    identity,
    firmwareVersion: '1.15.2',
  })

  assert.match(content, /^# Onboard parameters for Vehicle 7\n#\n# Stack: PX4\n# Vehicle: Multi-Rotor\n# Version: 1\.15\.2\n#\n# Vehicle-Id Component-Id Name Value Type\n/)
  const rows = content.split('\n').filter((line) => /^7\t/.test(line))
  assert.deepEqual(rows, [
    `7\t1\tFLOAT_PARAM\t${String(Math.fround(0.1))}\t9`,
    '7\t1\tINT_PARAM\t10\t6',
  ])
})

test('parses QGC comments plus tab, comma, and whitespace separated rows', () => {
  const result = parseQgcParameterFile(`
    # QGC backup
    7\t1\tFLOAT_PARAM\t0.1\t9
    7, 1, INT_PARAM, 12, 6
    7 1 CBRK_TEST 1 6
  `)

  assert.deepEqual(result.issues, [])
  assert.deepEqual(result.rows.map(({ name, value, type }) => ({ name, value, type })), [
    { name: 'FLOAT_PARAM', value: 0.1, type: 9 },
    { name: 'INT_PARAM', value: 12, type: 6 },
    { name: 'CBRK_TEST', value: 1, type: 6 },
  ])
})

test('reports malformed, invalid, and duplicate rows without accepting them', () => {
  const result = parseQgcParameterFile(`
    7 1 ONLY_FOUR 1
    0 1 BAD_SYSTEM 1 6
    7 999 BAD_COMPONENT 1 6
    7 1 PARAMETER_NAME_IS_TOO_LONG 1 6
    7 1 BAD_VALUE nope 6
    7 1 BAD_TYPE 1 99
    7 1 INT_PARAM 11 6
    7 1 INT_PARAM 12 6
  `)

  assert.equal(result.rows.length, 1)
  assert.deepEqual(result.issues.map((issue) => issue.reason), [
    'column_count',
    'invalid_system_id',
    'invalid_component_id',
    'invalid_name',
    'invalid_value',
    'invalid_type',
    'duplicate_parameter',
  ])
})

test('classifies writable changes, float32 equality, target/type/value failures, and missing parameters', () => {
  const parsed = parseQgcParameterFile(`
    7 1 FLOAT_PARAM 0.1 9
    7 1 INT_PARAM 12 6
    8 1 CBRK_TEST 1 6
    7 1 TYPE_PARAM 3 6
    7 1 UNKNOWN 1 6
    7 1 CBRK_TEST 1.5 6
  `)
  const preview = buildQgcParameterPreview(parsed, liveParams, 7, 1)

  assert.deepEqual(preview.entries.map((entry) => [entry.row.name, entry.status]), [
    ['FLOAT_PARAM', 'unchanged'],
    ['INT_PARAM', 'write'],
    ['CBRK_TEST', 'target_mismatch'],
    ['TYPE_PARAM', 'type_mismatch'],
    ['UNKNOWN', 'missing'],
    ['CBRK_TEST', 'invalid_value'],
  ])
  assert.deepEqual(preview.writable.map((entry) => entry.row.name), ['INT_PARAM'])
  assert.equal(preview.dangerousCount, 0)
})

test('flags circuit-breaker writes for an additional acknowledgement', () => {
  const preview = buildQgcParameterPreview(
    parseQgcParameterFile('7 1 CBRK_TEST 1 6'),
    liveParams,
    7,
    1,
  )

  assert.equal(isDangerousParameter('CBRK_TEST'), true)
  assert.equal(isDangerousParameter('SAFE_PARAM'), false)
  assert.equal(preview.dangerousCount, 1)
  assert.equal(preview.writable[0]?.dangerous, true)
})
