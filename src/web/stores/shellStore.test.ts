import assert from 'node:assert/strict'
import test from 'node:test'
import { appendTerminalText } from './shellStore'

test('terminal text applies backspace and filters unsupported C0 controls', () => {
  assert.equal(appendTerminalText('abc', '\b\bXY'), 'aXY')
  assert.equal(appendTerminalText('line\n', '\bnext'), 'line\nnext')
  assert.equal(appendTerminalText('', 'a\u0000b\u0007c\t\r\nd\u007f'), 'abc\t\r\nd')
})
