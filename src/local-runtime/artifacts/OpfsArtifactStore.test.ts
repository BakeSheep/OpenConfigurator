import assert from 'node:assert/strict'
import test from 'node:test'
import { MAX_LOG_DOWNLOAD_BYTES } from '../mavlink/downloadLimits'
import { artifactFs } from '../platform/artifactFs'
import { OpfsArtifactStore } from './OpfsArtifactStore'

function installEstimate(quota: number, usage = 0): () => void {
  const navigatorObject = globalThis.navigator as Navigator
  const original = Object.getOwnPropertyDescriptor(navigatorObject, 'storage')
  Object.defineProperty(navigatorObject, 'storage', {
    configurable: true,
    value: { estimate: async () => ({ quota, usage }) },
  })
  return () => {
    if (original) Object.defineProperty(navigatorObject, 'storage', original)
    else Reflect.deleteProperty(navigatorObject, 'storage')
  }
}

test('artifact supports random-offset writes, local Blob reads and consume deletion', async () => {
  const restore = installEstimate(Number.MAX_SAFE_INTEGER)
  const store = new OpfsArtifactStore()
  try {
    const id = await store.create('flight.ulg', 6)
    await store.write(id, 3, Uint8Array.of(4, 5, 6))
    await store.write(id, 0, Uint8Array.of(1, 2, 3))
    await store.complete(id)
    assert.deepEqual(new Uint8Array(await (await store.readBlob(id)).arrayBuffer()), Uint8Array.of(1, 2, 3, 4, 5, 6))
    assert.deepEqual(new Uint8Array(await (await store.consume(id)).arrayBuffer()), Uint8Array.of(1, 2, 3, 4, 5, 6))
    await assert.rejects(() => store.readBlob(id), /not found/)
  } finally {
    await store.cleanup()
    restore()
  }
})

test('artifact enforces file cap, quota reserve, retention and startup cleanup', async () => {
  let restore = installEstimate(32 * 1024 * 1024)
  const constrained = new OpfsArtifactStore()
  await assert.rejects(() => constrained.create('no-space.ulg', 1), /空间不足/)
  await assert.rejects(() => constrained.create('too-large.ulg', MAX_LOG_DOWNLOAD_BYTES + 1), /超过/)
  restore()

  restore = installEstimate(Number.MAX_SAFE_INTEGER)
  const retained = new OpfsArtifactStore()
  try {
    for (let index = 0; index < 6; index++) {
      const id = await retained.create(`${index}.ulg`, 1)
      await retained.write(id, 0, Uint8Array.of(index))
      await retained.complete(id)
    }
    assert.equal((await artifactFs.readdir('/openconfigurator-artifacts')).length, 5)
    await retained.cleanup()
    assert.deepEqual(await artifactFs.readdir('/openconfigurator-artifacts'), [])
  } finally {
    await retained.cleanup()
    restore()
  }
})

test('virtual artifact directories are isolated during stale-file cleanup', async () => {
  await artifactFs.purge()
  const ulogPath = '/openconfigurator-artifacts/openconfigurator-logs/px4.ulg'
  const dataflashPath = '/openconfigurator-artifacts/openconfigurator-dataflash-logs/ap.bin'
  try {
    const ulog = await artifactFs.open(ulogPath, 'w')
    await ulog.write(Uint8Array.of(1), 0, 1, 0)
    await ulog.close()
    const dataflash = await artifactFs.open(dataflashPath, 'w')
    await dataflash.write(Uint8Array.of(2), 0, 1, 0)
    await dataflash.close()

    assert.deepEqual(await artifactFs.readdir('/openconfigurator-artifacts/openconfigurator-logs'), ['px4.ulg'])
    assert.deepEqual(await artifactFs.readdir('/openconfigurator-artifacts/openconfigurator-dataflash-logs'), ['ap.bin'])

    for (const name of await artifactFs.readdir('/openconfigurator-artifacts/openconfigurator-logs')) {
      await artifactFs.unlink(`/openconfigurator-artifacts/openconfigurator-logs/${name}`)
    }
    assert.deepEqual(await artifactFs.readFile(dataflashPath), Uint8Array.of(2))
  } finally {
    await artifactFs.purge()
  }
})
