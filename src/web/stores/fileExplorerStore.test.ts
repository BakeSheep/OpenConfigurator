import assert from 'node:assert/strict'
import { useFileExplorerStore } from './fileExplorerStore'

const store = useFileExplorerStore.getState()

store.beginDownload('/fs/microsd/log/test.ulg', 'analyze')
store.completeDownload(
  '/fs/microsd/log/test.ulg',
  '0123456789abcdef',
  'test.ulg',
  1024,
)
assert.equal(useFileExplorerStore.getState().download?.status, 'done')

store.failDownload('读取已下载文件失败')
assert.deepEqual(
  {
    status: useFileExplorerStore.getState().download?.status,
    error: useFileExplorerStore.getState().download?.error,
  },
  { status: 'error', error: '读取已下载文件失败' },
)

store.clearDownload()
console.log('fileExplorerStore unit tests passed')
