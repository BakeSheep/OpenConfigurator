import assert from 'node:assert/strict'
import { statusVariableDescription } from './statusVariableMetadata'

assert.equal(statusVariableDescription('Vehicle', 'groundSpeed'), '对地移动速度')
assert.equal(statusVariableDescription('VEHICLE', 'armed'), '飞行器解锁状态')
assert.equal(statusVariableDescription('GPS', 'satellitesVisible'), '可见卫星数量')
assert.equal(statusVariableDescription('Gps2', 'hdop'), '水平精度因子')
assert.equal(statusVariableDescription('IMU0', 'xgyro'), 'X 轴角速度')
assert.equal(statusVariableDescription('RCCHANNELS', 'ch8'), '遥控通道脉宽')
assert.equal(statusVariableDescription('SERVOOUTPUT', 'servo12'), '舵机输出脉宽')
assert.equal(statusVariableDescription('EscStatus0', 'connectionType'), '电调遥测连接类型')
assert.equal(statusVariableDescription('Generator', 'powerGenerated'), '当前发电功率')
assert.equal(statusVariableDescription('Vibration', 'clipCount1'), '第一惯导削波次数')
assert.equal(statusVariableDescription('UNKNOWN', 'notKnown'), null)

console.log('statusVariableMetadata checks passed')
