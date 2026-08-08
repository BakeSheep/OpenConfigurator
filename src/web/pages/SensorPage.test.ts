import assert from 'node:assert/strict'
import type { CalibrationSnapshot } from '../../shared/types'
import { initI18n } from '../i18n/config'
import {
  appendLiveSample,
  calibrationAvailabilityReason,
  calibrationResultNotice,
  canRequestCalibrationExit,
  magPrecheckStatus,
  normalizeOpticalFlow,
  resolveAccelGuideSide,
  calibrationSideInstruction,
  resolveCalibrationProgress,
  shouldShowCalibrationWizard,
  displayImuValue,
  imuDisplayUnit,
} from './SensorPage'

initI18n('zh')

const initialHistory = [{ t: 1, x: 2 }]
assert.equal(
  appendLiveSample(initialHistory, null),
  initialHistory,
  'a missing telemetry frame must not refresh or mutate a live chart',
)

assert.equal(displayImuValue('accel', 2048, 'raw'), 2048)
assert.equal(displayImuValue('gyro', -512, 'raw'), -512)
assert.equal(imuDisplayUnit('accel', 'raw'), 'raw')
assert.equal(imuDisplayUnit('gyro', 'raw'), 'raw')
assert.ok(Math.abs(displayImuValue('accel', 1, 'normalized') - 9.80665) < 1e-9)
assert.deepEqual(
  appendLiveSample(initialHistory, { x: 3 }, 2),
  [{ t: 1, x: 2 }, { t: 2, x: 3 }],
  'a real telemetry frame appends exactly one chart point',
)
assert.equal(
  appendLiveSample(Array.from({ length: 90 }, (_, index) => ({ t: index, x: index })), { x: 90 }, 90).length,
  90,
  'live chart history remains bounded',
)

assert.deepEqual(
  normalizeOpticalFlow({
    source: 'OPTICAL_FLOW_RAD',
    integration_time_us: 20_000,
    integrated_x_rad: 0.01,
    integrated_y_rad: -0.02,
    // Simulate an older/partial cached payload missing gyro extension fields.
  }),
  {
    source: 'OPTICAL_FLOW_RAD',
    flowX: 0.01,
    flowY: -0.02,
  },
  'partial optical-flow frames must render missing fields as empty instead of throwing',
)

assert.deepEqual(
  normalizeOpticalFlow({ flow_x: 12, flow_y: -7, quality: 180, ground_distance: 1.4 }),
  {
    source: 'OPTICAL_FLOW',
    flowX: 12,
    flowY: -7,
  },
  'legacy optical flow is inferred safely when source metadata is absent',
)

const activeSnapshot: CalibrationSnapshot = {
  sessionId: 'active-calibration',
  requestId: 'request-1',
  ownerClientId: 'client-1',
  recoverUntil: null,
  seq: 1,
  family: 'ardupilot',
  kind: 'accel',
  phase: 'waiting_position',
  verification: 'not_applicable',
  progress: 16,
  updatedAt: 1,
  rebootRequired: false,
  cancelSupported: false,
}

assert.equal(
  shouldShowCalibrationWizard(activeSnapshot, activeSnapshot.sessionId),
  true,
  'an active calibration must never be hidden by local dismissal state',
)

assert.deepEqual(
  magPrecheckStatus({ fieldGauss: 0.48, warning: false }),
  { state: 'good', text: '干扰较低 · 0.48 G' },
  'the latest stabilized reading is presented immediately without a sample counter',
)

assert.deepEqual(
  magPrecheckStatus({ fieldGauss: 2.34, warning: true }),
  { state: 'high', text: '干扰偏大 · 2.34 G' },
  'an established out-of-range field must be presented as abnormal',
)

assert.deepEqual(
  magPrecheckStatus(null, { unit: 'raw' }),
  { state: 'unavailable', text: '无法判断 · 仅原始数据' },
  'raw magnetometer counts must explain why interference cannot be assessed instead of sampling forever',
)

assert.deepEqual(
  magPrecheckStatus(null, null),
  { state: 'unavailable', text: '等待实时磁场数据' },
)

assert.equal(
  resolveAccelGuideSide({
    ...activeSnapshot,
    requestedPosition: null,
    phase: 'running',
    sides: {
      down: 'done', up: 'pending', left: 'active', right: 'pending', front: 'pending', back: 'pending',
    },
  }),
  'left',
  'the active orientation remains available while the transient confirmation phase is gone',
)

assert.equal(
  resolveAccelGuideSide({ ...activeSnapshot, requestedPosition: 6 }),
  'up',
  'an explicit FC position request wins over side-state inference',
)

assert.equal(
  calibrationSideInstruction('mag', 'front'),
  '保持机头朝下，按箭头方向绕竖直轴缓慢、连续旋转',
  'PX4 compass sides must instruct rotation instead of holding still',
)

assert.equal(
  calibrationSideInstruction('accel', 'front'),
  '机头垂直向下，保持静止',
  'accelerometer sides must retain the stationary sampling instruction',
)

assert.equal(
  shouldShowCalibrationWizard({ ...activeSnapshot, phase: 'done' }, activeSnapshot.sessionId),
  false,
  'a terminal calibration may be dismissed locally',
)

assert.equal(
  canRequestCalibrationExit(activeSnapshot, true),
  true,
  'the owner may request exit even when the flight controller requires a reboot',
)

assert.equal(
  canRequestCalibrationExit(activeSnapshot, false),
  false,
  'an observer must not exit another client\'s calibration',
)

assert.equal(
  calibrationAvailabilityReason({
    vehicleReady: false,
    supported: false,
    sessionActive: false,
    enabled: false,
  }),
  '等待连接飞控',
  'a disconnected vehicle must not be described as unsupported',
)

assert.equal(
  calibrationAvailabilityReason({
    vehicleReady: true,
    supported: false,
    sessionActive: false,
    enabled: false,
  }),
  '当前机型不支持',
  'unsupported is only shown after a vehicle is ready and identified',
)

assert.deepEqual(
  calibrationResultNotice({ ...activeSnapshot, kind: 'gyro', phase: 'done', progress: 100 }),
  { state: 'success', title: '陀螺仪校准成功', detail: '飞控已确认校准完成。' },
)

assert.deepEqual(
  calibrationResultNotice({
    ...activeSnapshot,
    kind: 'mag',
    phase: 'failed',
    failureReason: '磁场数据不稳定',
  }),
  { state: 'error', title: '罗盘校准失败', detail: '磁场数据不稳定' },
)

assert.deepEqual(
  calibrationResultNotice({
    ...activeSnapshot,
    kind: 'gyro',
    phase: 'accepted',
    verification: 'ack_only',
  }),
  {
    state: 'info',
    title: '陀螺仪校准命令已接受',
    detail: '飞控未提供独立的结果遥测；这不是失败，但当前结果无法进一步核验。',
  },
)

assert.equal(
  resolveCalibrationProgress({ ...activeSnapshot, kind: 'gyro', phase: 'running', progress: null }, 0, 0),
  null,
  'one-shot calibration without FC progress must render indeterminate rather than fake 0%',
)

assert.equal(
  resolveCalibrationProgress({ ...activeSnapshot, kind: 'baro', phase: 'accepted', progress: null }, 0, 0),
  100,
  'an accepted one-shot calibration must render complete',
)

console.log('SensorPage calibration visibility checks passed')
