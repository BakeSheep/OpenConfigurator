import type { LocalArtifactStore } from '../../shared/localRuntime'
import { assertDownloadCapacity } from '../mavlink/downloadLimits'
import { artifactFs, type ArtifactFileHandle } from '../platform/artifactFs'

const MAX_RETAINED_ARTIFACTS = 5

type Entry = {
  id: string
  fileName: string
  path: string
  handle: ArtifactFileHandle | null
  complete: boolean
}

/** OPFS-backed, tab-local artifacts with a memory fallback for tests. */
export class OpfsArtifactStore implements LocalArtifactStore {
  private readonly entries = new Map<string, Entry>()

  async create(fileName: string, expectedBytes: number): Promise<string> {
    await assertDownloadCapacity('/openconfigurator-artifacts', expectedBytes)
    const id = crypto.randomUUID()
    const path = `/openconfigurator-artifacts/${id}.artifact`
    const handle = await artifactFs.open(path, 'w')
    this.entries.set(id, { id, fileName, path, handle, complete: false })
    return id
  }

  async write(artifactId: string, offset: number, data: Uint8Array): Promise<void> {
    const entry = this.require(artifactId)
    if (!entry.handle || entry.complete) throw new Error('artifact is not writable')
    await entry.handle.write(data, 0, data.byteLength, offset)
  }

  async complete(artifactId: string): Promise<void> {
    const entry = this.require(artifactId)
    await entry.handle?.sync()
    await entry.handle?.close()
    entry.handle = null
    entry.complete = true
    while (this.entries.size > MAX_RETAINED_ARTIFACTS) {
      const oldest = this.entries.keys().next().value as string | undefined
      if (!oldest) break
      await this.remove(oldest)
    }
  }

  async readBlob(artifactId: string): Promise<Blob> {
    const entry = this.require(artifactId)
    if (!entry.complete) throw new Error('artifact is incomplete')
    return new Blob([Uint8Array.from(await artifactFs.readFile(entry.path))], { type: 'application/octet-stream' })
  }

  async consume(artifactId: string): Promise<Blob> {
    const blob = await this.readBlob(artifactId)
    await this.remove(artifactId)
    return blob
  }

  async cleanup(): Promise<void> {
    for (const id of [...this.entries.keys()]) await this.remove(id)
    await artifactFs.purge()
  }

  private require(id: string): Entry {
    const entry = this.entries.get(id)
    if (!entry) throw new Error('artifact not found')
    return entry
  }

  private async remove(id: string): Promise<void> {
    const entry = this.entries.get(id)
    if (!entry) return
    this.entries.delete(id)
    await entry.handle?.close().catch(() => undefined)
    await artifactFs.unlink(entry.path)
  }
}
