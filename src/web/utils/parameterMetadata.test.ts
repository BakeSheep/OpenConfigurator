import assert from 'node:assert/strict'
import { initI18n } from '../i18n/config'
import { parameterGroupKey, parameterMetadata, parameterSearchText } from './parameterMetadata'

initI18n('zh')

const battery = parameterMetadata('BAT_CRIT_THR', null)
assert.equal(battery.title, '严重低电量阈值')
assert.match(battery.description, /返航/)

const inferred = parameterMetadata('GPS_1_BAUD', null)
assert.equal(inferred.groupLabel, 'GNSS / GPS')
assert.match(inferred.description, /波特率/)

assert.match(parameterSearchText('MPC_THR_HOVER', null), /悬停油门/)
assert.match(parameterMetadata('CBRK_IO_SAFETY', null).description, /关闭保护功能/)

// Version- and board-independent fallback contract: every parameter returned
// by either stack remains grouped and annotated, including new/unknown names.
const crossFirmwareIds = [
  'RC1_MIN', 'RC16_MAX', 'SERIAL7_PROTOCOL', 'COMPASS2_OFS_X',
  'RNGFND10_TYPE', 'BARO3_DEVID', 'BATT2_MONITOR', 'UXRCE_DDS_CFG',
  'EK3_SRC1_POSXY', 'MAV_2_CONFIG', 'VENDOR9_EXPERIMENTAL', 'FORMAT_VERSION',
]
for (const id of crossFirmwareIds) {
  const metadata = parameterMetadata(id, null)
  assert.ok(parameterGroupKey(id).length > 0, `${id} must have a group key`)
  assert.ok(metadata.groupLabel.length > 0, `${id} must have a group label`)
  assert.ok(metadata.title.length > 0, `${id} must have a title`)
  assert.ok(metadata.description.length > 0, `${id} must have a description`)
}
assert.equal(parameterGroupKey('RC1_MIN'), 'RC')
assert.equal(parameterGroupKey('SERVO12_FUNCTION'), 'SERVO')
assert.equal(parameterGroupKey('EK3_SRC1_POSXY'), 'EK3')
assert.equal(parameterGroupKey('VENDOR9_EXPERIMENTAL'), 'VENDOR')

console.log('parameterMetadata unit tests passed')
