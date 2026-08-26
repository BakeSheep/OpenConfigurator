import type {
  BrowserConnectionOptions,
  BrowserPortDescriptor,
  RuntimeCommand,
  RuntimeEvent,
  WorkerInboundMessage,
  WorkerOutboundMessage,
} from '../../shared/localRuntime'
import { WebSerialTransport } from './WebSerialTransport'

type EventListener = (event: RuntimeEvent) => void
type ArtifactResult = { fileName: string; blob: Blob }

export class LocalRuntimeClient {
  private readonly serial = new WebSerialTransport()
  private worker: Worker | null = null
  private listeners = new Set<EventListener>()
  private artifactRequests = new Map<string, { resolve: (value: ArtifactResult) => void; reject: (reason: Error) => void }>()
  private prepareRequests = new Map<string, () => void>()

  get supported(): boolean {
    return this.serial.supported
  }

  start(): void {
    if (this.worker) return
    const worker = new Worker(new URL('../../local-runtime/worker.ts', import.meta.url), { type: 'module', name: 'openconfigurator-local-runtime' })
    worker.addEventListener('message', (event: MessageEvent<WorkerOutboundMessage>) => this.handleWorkerMessage(event.data))
    worker.addEventListener('error', (event) => console.error('[LocalRuntime] Worker error:', event.message))
    this.worker = worker
  }

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async listPorts(): Promise<BrowserPortDescriptor[]> {
    return this.serial.listAuthorizedPorts()
  }

  async requestPort(): Promise<BrowserPortDescriptor> {
    return this.serial.requestPort()
  }

  async connect(options: BrowserConnectionOptions): Promise<void> {
    this.start()
    const worker = this.requireWorker()
    const config = await this.serial.open(options, {
      onBytes: (data) => worker.postMessage({ type: 'transport_bytes', data } satisfies WorkerInboundMessage, [data]),
      onClosed: (reason) => worker.postMessage({ type: 'transport_closed', reason } satisfies WorkerInboundMessage),
      onReopened: (reopenedConfig) => worker.postMessage({
        type: 'transport_open',
        config: reopenedConfig,
        protocol: options.protocol,
        signing: options.signing,
      } satisfies WorkerInboundMessage),
    })
    worker.postMessage({ type: 'transport_open', config, protocol: options.protocol, signing: options.signing } satisfies WorkerInboundMessage)
  }

  async disconnect(): Promise<void> {
    if (this.worker) {
      const requestId = crypto.randomUUID()
      await Promise.race([
        new Promise<void>((resolve) => {
          this.prepareRequests.set(requestId, resolve)
          this.worker?.postMessage({ type: 'prepare_disconnect', requestId } satisfies WorkerInboundMessage)
        }),
        new Promise<void>((resolve) => setTimeout(resolve, 350)),
      ])
      this.prepareRequests.delete(requestId)
    }
    await this.serial.close(false)
    this.worker?.postMessage({ type: 'transport_closed', reason: 'user_disconnect' } satisfies WorkerInboundMessage)
  }

  send(command: RuntimeCommand): boolean {
    if (!this.worker) return false
    this.worker.postMessage({ type: 'runtime_command', command } satisfies WorkerInboundMessage)
    return true
  }

  readArtifact(artifactId: string, consume = true): Promise<ArtifactResult> {
    const worker = this.requireWorker()
    const requestId = crypto.randomUUID()
    return new Promise((resolve, reject) => {
      this.artifactRequests.set(requestId, { resolve, reject })
      worker.postMessage({ type: 'artifact_read', requestId, artifactId, consume } satisfies WorkerInboundMessage)
    })
  }

  async stop(): Promise<void> {
    // Detach the Worker synchronously before the first await. React StrictMode
    // intentionally runs effect setup -> cleanup -> setup once in development;
    // an async cleanup must never terminate the Worker created by the second
    // setup after its await resumes.
    const worker = this.worker
    this.worker = null
    worker?.postMessage({ type: 'shutdown' } satisfies WorkerInboundMessage)
    worker?.terminate()
    await this.serial.close(false)
    // Prevent late events from an old StrictMode/test lifecycle from
    // overwriting the next tab-local state. Startup cleanup handles any OPFS
    // artifact left if termination wins the race with Worker shutdown.
    for (const pending of this.artifactRequests.values()) pending.reject(new Error('本地运行时已关闭'))
    this.artifactRequests.clear()
  }

  private handleWorkerMessage(message: WorkerOutboundMessage): void {
    if (message.type === 'runtime_event') {
      for (const listener of [...this.listeners]) listener(message.event)
      return
    }
    if (message.type === 'transport_write') {
      void this.serial.write(message.data, message.priority, message.queueTag).then((accepted) => {
        this.worker?.postMessage({ type: 'write_result', writeId: message.writeId, accepted } satisfies WorkerInboundMessage)
      })
      return
    }
    if (message.type === 'transport_cancel') {
      this.serial.cancelQueued(message.queueTag)
      return
    }
    if (message.type === 'transport_abort') {
      void this.serial.close(false)
      return
    }
    if (message.type === 'artifact_data' || message.type === 'artifact_error') {
      const pending = this.artifactRequests.get(message.requestId)
      if (!pending) return
      this.artifactRequests.delete(message.requestId)
      if (message.type === 'artifact_error') pending.reject(new Error(message.message))
      else pending.resolve({ fileName: message.fileName, blob: new Blob([message.data], { type: 'application/octet-stream' }) })
      return
    }
    if (message.type === 'transport_prepared') {
      this.prepareRequests.get(message.requestId)?.()
      this.prepareRequests.delete(message.requestId)
      return
    }
    if (message.type === 'runtime_error') console.error('[LocalRuntime]', message.message)
  }

  private requireWorker(): Worker {
    this.start()
    if (!this.worker) throw new Error('本地运行时启动失败')
    return this.worker
  }
}

export const localRuntime = new LocalRuntimeClient()
