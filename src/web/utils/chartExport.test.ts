import assert from 'node:assert/strict'
import test from 'node:test'
import { buildChartCsv, chartExportBaseName } from './chartExport'

test('chart export file names preserve readable text and remove unsafe suffixes', () => {
  assert.equal(chartExportBaseName('姿态跟踪: roll?.csv'), '姿态跟踪- roll')
  assert.equal(chartExportBaseName('  .png  '), 'flight-chart')
  assert.equal(chartExportBaseName('CON'), '_CON')
})

test('chart CSV aligns visible series and preserves special numeric values', () => {
  const csv = buildChartCsv([
    { id: 'roll.actual', label: 'Roll, actual', times: [0, 1, 2], values: [1, NaN, Infinity] },
    { id: 'roll.target', label: 'Roll target', times: [0, 2], values: [3, -Infinity] },
  ], { unit: '°' })
  assert.equal(csv, [
    '\uFEFFtime_s,"Roll, actual [°] (roll.actual)",Roll target [°] (roll.target)',
    '0,1,3',
    '1,NaN,',
    '2,Infinity,-Infinity',
    '',
  ].join('\r\n'))
})
