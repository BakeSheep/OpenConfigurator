import assert from 'node:assert/strict'
import { documentLanguage } from './languageStore'

assert.equal(documentLanguage('zh'), 'zh-CN')
assert.equal(documentLanguage('en'), 'en')

console.log('languageStore document language checks passed')
