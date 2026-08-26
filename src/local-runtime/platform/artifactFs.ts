const MEMORY_FILES = new Map<string, Uint8Array>()
const ARTIFACT_DIR = 'openconfigurator-artifacts'

type OpfsDirectory = FileSystemDirectoryHandle & {
  values?: () => AsyncIterableIterator<FileSystemHandle>
}

async function directory(): Promise<OpfsDirectory | null> {
  const storage = globalThis.navigator?.storage as (StorageManager & {
    getDirectory?: () => Promise<FileSystemDirectoryHandle>
  }) | undefined
  if (!storage?.getDirectory) return null
  const root = await storage.getDirectory()
  return await root.getDirectoryHandle(ARTIFACT_DIR, { create: true }) as OpfsDirectory
}

function normalizePath(filePath: string): string {
  const normalized = `/${filePath}`.replace(/\/{2,}/g, '/').replace(/\/$/, '')
  return normalized || '/'
}

function parentOf(filePath: string): string {
  const normalized = normalizePath(filePath)
  const separator = normalized.lastIndexOf('/')
  return separator <= 0 ? '/' : normalized.slice(0, separator)
}

function baseName(filePath: string): string {
  return normalizePath(filePath).split('/').filter(Boolean).pop() ?? ''
}

/** OPFS directory entries are flat, so encode the complete virtual path. */
function storageName(filePath: string): string {
  return encodeURIComponent(normalizePath(filePath))
}

function virtualPath(storageEntryName: string): string {
  try {
    return normalizePath(decodeURIComponent(storageEntryName))
  } catch {
    // Legacy entries from the first browser-local preview had bare names.
    return normalizePath(storageEntryName)
  }
}

export class ArtifactFileHandle {
  private readonly filePath: string
  private readonly mode: 'r' | 'w'
  private writable: FileSystemWritableFileStream | null = null
  private closed = false

  constructor(filePath: string, mode: 'r' | 'w') {
    this.filePath = filePath
    this.mode = mode
  }

  async initialize(): Promise<this> {
    if (this.mode === 'w') {
      const dir = await directory()
      if (dir) {
        const handle = await dir.getFileHandle(storageName(this.filePath), { create: true })
        this.writable = await handle.createWritable({ keepExistingData: false })
      } else MEMORY_FILES.set(normalizePath(this.filePath), new Uint8Array())
    }
    return this
  }

  async write(
    source: Uint8Array,
    sourceOffset: number,
    length: number,
    position: number,
  ): Promise<{ bytesWritten: number; buffer: Uint8Array }> {
    if (this.closed || this.mode !== 'w') throw new Error('artifact file is not writable')
    const chunk = source.slice(sourceOffset, sourceOffset + length)
    if (this.writable) {
      await this.writable.write({ type: 'write', position, data: chunk })
    } else {
      const key = normalizePath(this.filePath)
      const current = MEMORY_FILES.get(key) ?? new Uint8Array()
      const next = current.length >= position + chunk.length
        ? current.slice()
        : new Uint8Array(position + chunk.length)
      next.set(current)
      next.set(chunk, position)
      MEMORY_FILES.set(key, next)
    }
    return { bytesWritten: chunk.length, buffer: source }
  }

  async read(
    target: Uint8Array,
    targetOffset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number; buffer: Uint8Array }> {
    if (this.closed) throw new Error('artifact file is closed')
    const bytes = await artifactFs.readFile(this.filePath)
    const chunk = bytes.subarray(position, Math.min(bytes.length, position + length))
    target.set(chunk, targetOffset)
    return { bytesRead: chunk.length, buffer: target }
  }

  async truncate(size: number): Promise<void> {
    if (this.writable) await this.writable.truncate(size)
    else {
      const key = normalizePath(this.filePath)
      MEMORY_FILES.set(key, (MEMORY_FILES.get(key) ?? new Uint8Array()).slice(0, size))
    }
  }

  async sync(): Promise<void> {}

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.writable?.close()
    this.writable = null
  }
}

export const artifactPath = {
  join: (...parts: string[]) => parts.join('/').replace(/\/{2,}/g, '/'),
}

export const artifactOs = {
  tmpdir: () => '/openconfigurator-artifacts',
}

export const artifactFs = {
  async mkdtemp(prefix: string): Promise<string> {
    await this.purge()
    return `${prefix}${crypto.randomUUID()}`
  },

  async mkdir(_path: string, _options?: { recursive?: boolean }): Promise<void> {
    await directory()
  },

  async readdir(filePath: string): Promise<string[]> {
    const parent = normalizePath(filePath)
    const dir = await directory()
    if (!dir) return [...MEMORY_FILES.keys()]
      .filter((entry) => parentOf(entry) === parent)
      .map(baseName)
    if (!dir.values) return []
    const names: string[] = []
    for await (const handle of dir.values()) {
      const entryPath = virtualPath(handle.name)
      if (parentOf(entryPath) === parent) names.push(baseName(entryPath))
    }
    return names
  },

  async open(filePath: string, mode: 'r' | 'w'): Promise<ArtifactFileHandle> {
    return new ArtifactFileHandle(filePath, mode).initialize()
  },

  async unlink(filePath: string): Promise<void> {
    const dir = await directory()
    if (dir) await dir.removeEntry(storageName(filePath)).catch(() => undefined)
    MEMORY_FILES.delete(normalizePath(filePath))
  },

  async rename(from: string, to: string): Promise<void> {
    const bytes = await this.readFile(from)
    const target = await this.open(to, 'w')
    await target.write(bytes, 0, bytes.length, 0)
    await target.close()
    await this.unlink(from)
  },

  async readFile(filePath: string): Promise<Uint8Array> {
    const dir = await directory()
    if (dir) {
      const handle = await dir.getFileHandle(storageName(filePath))
      return new Uint8Array(await (await handle.getFile()).arrayBuffer())
    }
    const value = MEMORY_FILES.get(normalizePath(filePath))
    if (!value) throw new Error(`artifact not found: ${filePath}`)
    return value.slice()
  },

  async estimate(): Promise<{ quota: number; usage: number }> {
    const estimate = await globalThis.navigator?.storage?.estimate?.()
    return { quota: estimate?.quota ?? Number.MAX_SAFE_INTEGER, usage: estimate?.usage ?? 0 }
  },

  async purge(): Promise<void> {
    const dir = await directory()
    if (dir?.values) {
      const names: string[] = []
      for await (const handle of dir.values()) names.push(handle.name)
      await Promise.all(names.map((name) => dir.removeEntry(name).catch(() => undefined)))
    }
    MEMORY_FILES.clear()
  },

  async rm(_path: string, _options?: { recursive?: boolean; force?: boolean }): Promise<void> {
    await this.purge()
  },
}
