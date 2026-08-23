import assert from 'node:assert/strict'
import test from 'node:test'
import { classifySerialOpenError } from './serialOpenErrors'

const errnoError = (code: string, message = code) => {
  const error = new Error(message) as NodeJS.ErrnoException
  error.code = code
  return error
}

test('permission errors carry ownership and the group-membership hint', () => {
  const error = classifySerialOpenError('/dev/ttyACM0', errnoError('EACCES'), {
    platform: 'linux',
    ownership: { uid: 0, gid: 20 },
  })
  assert.equal(error.code, 'SERIAL_PERMISSION_DENIED')
  assert.match(error.message, /uid=0/)
  assert.match(error.message, /gid=20/)
  assert.match(error.message, /dialout|uucp/)

  const withoutOwnership = classifySerialOpenError('/dev/ttyUSB0', errnoError('EPERM'), {
    platform: 'linux',
  })
  assert.equal(withoutOwnership.code, 'SERIAL_PERMISSION_DENIED')
  assert.ok(!withoutOwnership.message.includes('uid='))
})

test('busy, missing and timeout failures map to stable codes', () => {
  assert.equal(
    classifySerialOpenError('COM7', errnoError('EBUSY'), { platform: 'win32' }).code,
    'SERIAL_BUSY',
  )
  assert.equal(
    classifySerialOpenError('/dev/ttyACM0', errnoError('ENOENT'), { platform: 'linux' }).code,
    'SERIAL_NOT_FOUND',
  )
  assert.equal(
    classifySerialOpenError('COM7', new Error('打开串口 COM7 超时（5s）。端口可能被占用或设备无响应。')).code,
    'SERIAL_OPEN_TIMEOUT',
  )
  // The timeout hint text contains “被占用”, which must not re-classify as
  // SERIAL_BUSY under the win32 message heuristic.
  assert.equal(
    classifySerialOpenError('COM7', new Error('打开串口 COM7 超时（5s）。端口可能被占用或设备无响应。'), {
      platform: 'win32',
    }).code,
    'SERIAL_OPEN_TIMEOUT',
  )
  assert.equal(
    classifySerialOpenError('COM7', new Error('The port is in use by another process'), {
      platform: 'win32',
    }).code,
    'SERIAL_BUSY',
  )
})

test('unknown errors pass through unchanged', () => {
  const original = new Error('driver exploded')
  assert.equal(classifySerialOpenError('COM7', original), original)
})
