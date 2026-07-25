import { EventEmitter } from 'events'
import { SerialPort } from 'serialport'
import type { PortInfo } from '../../shared/types'

export type SerialLifecycleState = 'idle' | 'opening' | 'open' | 'closing'
export type SerialWritePriority = 'normal' | 'high' | 'critical'

export interface SerialPortLike extends EventEmitter {
  readonly isOpen: boolean
  open(callback?: (error: Error | null | undefined) => void): void
  close(callback?: (error: Error | null | undefined) => void): void
  write(data: Buffer, callback?: (error: Error | null | undefined) => void): boolean
}

export interface SerialConnectionOptions {
  portFactory?: (options: { path: string; baudRate: number; autoOpen: false }) => SerialPortLike
  closeTimeoutMs?: number
  maxQueuedBytes?: number
  maxQueuedFrames?: number
}

export interface SerialWriteOverflow {
  droppedBytes: number
  queuedBytes: number
  queuedFrames: number
  maxQueuedBytes: number
  maxQueuedFrames: number
  droppedPriority?: SerialWritePriority
  incomingPriority?: SerialWritePriority
  evicted?: boolean
}

interface QueuedFrame {
  frame: Buffer
  priority: SerialWritePriority
}

interface PortBinding {
  generation: number
  port: SerialPortLike
  path: string
  baudRate: number
  nativeOpenSettled: boolean
  nativeOpenResult: 'open' | 'error' | null
  resolveNativeOpen: (result: 'open' | 'error') => void
  nativeOpenPromise: Promise<'open' | 'error'>
  closed: boolean
  resolveClosed: () => void
  closedPromise: Promise<void>
  connectSettled: boolean
  resolveConnect: () => void
  rejectConnect: (error: Error) => void
  connectPromise: Promise<void>
  openTimeout: ReturnType<typeof setTimeout> | null
  cancelled: boolean
  closePromise: Promise<void> | null
  onOpen: () => void
  onData: (data: Buffer) => void
  onClose: () => void
  onError: (error: Error) => void
  onDrain: () => void
}

const DEFAULT_CLOSE_TIMEOUT_MS = 5000
const DEFAULT_MAX_QUEUED_BYTES = 256 * 1024
const DEFAULT_MAX_QUEUED_FRAMES = 512

export class SerialConnection extends EventEmitter {
  private binding: PortBinding | null = null
  private state: SerialLifecycleState = 'idle'
  private operationGeneration = 0
  private _connected = false
  private disconnectPromise: Promise<void> | null = null
  private waitingForDrain = false
  private writeQueue: QueuedFrame[] = []
  private queuedBytes = 0

  private readonly portFactory: NonNullable<SerialConnectionOptions['portFactory']>
  private readonly closeTimeoutMs: number
  private readonly maxQueuedBytes: number
  private readonly maxQueuedFrames: number

  constructor(options: SerialConnectionOptions = {}) {
    super()
    this.portFactory = options.portFactory
      ?? ((serialOptions) => new SerialPort(serialOptions) as unknown as SerialPortLike)
    this.closeTimeoutMs = options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS
    this.maxQueuedBytes = options.maxQueuedBytes ?? DEFAULT_MAX_QUEUED_BYTES
    this.maxQueuedFrames = options.maxQueuedFrames ?? DEFAULT_MAX_QUEUED_FRAMES
  }

  get connected() {
    return this._connected
  }

  get lifecycleState() {
    return this.state
  }

  get pendingWriteBytes() {
    return this.queuedBytes
  }

  static async listPorts(): Promise<PortInfo[]> {
    const ports = await SerialPort.list()
    return ports.map((p) => ({
      path: p.path,
      manufacturer: p.manufacturer,
      productId: p.productId,
      vendorId: p.vendorId,
      pnpId: p.pnpId,
    }))
  }

  async connect(path: string, baudRate: number, timeoutMs = 5000): Promise<void> {
    if (this.state !== 'idle' || this.binding) {
      throw new Error(`串口当前处于 ${this.state} 状态，无法开始新的连接。`)
    }

    const generation = ++this.operationGeneration
    let resolveNativeOpen!: (result: 'open' | 'error') => void
    const nativeOpenPromise = new Promise<'open' | 'error'>((resolve) => {
      resolveNativeOpen = resolve
    })
    let resolveConnect!: () => void
    let rejectConnect!: (error: Error) => void
    const connectPromise = new Promise<void>((resolve, reject) => {
      resolveConnect = resolve
      rejectConnect = reject
    })
    let resolveClosed!: () => void
    const closedPromise = new Promise<void>((resolve) => {
      resolveClosed = resolve
    })

    const port = this.portFactory({ path, baudRate, autoOpen: false })
    const binding: PortBinding = {
      generation,
      port,
      path,
      baudRate,
      nativeOpenSettled: false,
      nativeOpenResult: null,
      resolveNativeOpen,
      nativeOpenPromise,
      closed: false,
      resolveClosed,
      closedPromise,
      connectSettled: false,
      resolveConnect,
      rejectConnect,
      connectPromise,
      openTimeout: null,
      cancelled: false,
      closePromise: null,
      onOpen: () => this.handlePortOpen(binding),
      onData: (data: Buffer) => this.handlePortData(binding, data),
      onClose: () => this.handlePortClose(binding),
      onError: (error: Error) => this.handlePortError(binding, error),
      onDrain: () => this.handlePortDrain(binding),
    }

    this.binding = binding
    this.state = 'opening'
    this._connected = false
    port.on('open', binding.onOpen)
    port.on('data', binding.onData)
    port.on('close', binding.onClose)
    // This listener intentionally stays attached until the native open/close
    // lifecycle has fully settled. It absorbs late native errors after the
    // public connect promise has timed out or its owner has disconnected.
    port.on('error', binding.onError)
    port.on('drain', binding.onDrain)

    binding.openTimeout = setTimeout(() => {
      if (binding.connectSettled || binding !== this.binding) return
      binding.cancelled = true
      this.state = 'closing'
      this._connected = false
      this.settleConnect(
        binding,
        new Error(`打开串口 ${path} 超时（${Math.round(timeoutMs / 1000)}s）。端口可能被占用或设备无响应。`),
      )
      // serialport cannot cancel a native open. Keep the provisional object and
      // close it immediately if the late open eventually succeeds.
      void this.ensureBindingClosed(binding).catch((error) => {
        this.emitDiagnostic('lateCloseError', error)
      })
    }, timeoutMs)

    try {
      port.open()
    } catch (error) {
      this.handlePortError(binding, this.toError(error))
    }

    return connectPromise
  }

  async disconnect(timeoutMs = this.closeTimeoutMs): Promise<void> {
    if (this.disconnectPromise) return this.disconnectPromise
    const binding = this.binding
    if (!binding) {
      this.state = 'idle'
      this._connected = false
      this.clearWriteQueue()
      return
    }

    binding.cancelled = true
    ++this.operationGeneration
    this.state = 'closing'
    this._connected = false
    this.clearWriteQueue()
    if (!binding.connectSettled) {
      this.settleConnect(binding, new Error(`串口 ${binding.path} 连接已取消。`))
    }

    const closeWork = this.ensureBindingClosed(binding)
    this.disconnectPromise = this.withTimeout(
      closeWork,
      timeoutMs,
      `关闭串口 ${binding.path} 超时（${Math.round(timeoutMs / 1000)}s）。`,
    )
    try {
      await this.disconnectPromise
    } finally {
      this.disconnectPromise = null
    }
  }

  /**
   * Queue one complete MAVLink frame. `true` means the frame was accepted by
   * either the native stream or the bounded connection queue. `false` means the
   * link is unavailable or the queue rejected the newest frame.
   */
  write(data: Buffer, priority: SerialWritePriority = 'normal'): boolean {
    const binding = this.binding
    if (!binding || this.state !== 'open' || !this._connected) return false
    const frame = Buffer.from(data)
    if (this.waitingForDrain || this.writeQueue.length > 0) {
      return this.enqueueFrame(frame, priority)
    }
    return this.writeFrame(binding, frame)
  }

  private handlePortOpen(binding: PortBinding): void {
    this.settleNativeOpen(binding, 'open')
    if (binding.cancelled || binding !== this.binding || binding.generation !== this.operationGeneration) {
      void this.ensureBindingClosed(binding).catch((error) => {
        this.emitDiagnostic('lateCloseError', error)
      })
      return
    }

    this.clearOpenTimeout(binding)
    this.state = 'open'
    this._connected = true
    this.settleConnect(binding)
    this.emit('connected', { path: binding.path, baudRate: binding.baudRate })
  }

  private handlePortData(binding: PortBinding, data: Buffer): void {
    if (binding !== this.binding || this.state !== 'open') return
    this.emit('data', data)
  }

  private handlePortClose(binding: PortBinding): void {
    const wasOpen = this._connected || this.state === 'open'
    binding.closed = true
    binding.resolveClosed()
    this._connected = false
    this.clearWriteQueue()
    this.settleNativeOpen(binding, 'error')
    if (!binding.connectSettled) {
      this.settleConnect(binding, new Error(`串口 ${binding.path} 在打开完成前已关闭。`))
    }
    this.finalizeBinding(binding)
    if (wasOpen) this.emit('disconnected')
  }

  private handlePortError(binding: PortBinding, error: Error): void {
    if (!binding.nativeOpenSettled) this.settleNativeOpen(binding, 'error')

    if (binding !== this.binding || binding.cancelled || this.state === 'closing') {
      this.clearOpenTimeout(binding)
      if (!binding.port.isOpen) this.finalizeBinding(binding)
      this.emitDiagnostic('latePortError', error)
      return
    }

    if (this.state === 'opening') {
      this.clearOpenTimeout(binding)
      this._connected = false
      this.settleConnect(binding, error)
      if (binding.port.isOpen) {
        binding.cancelled = true
        this.state = 'closing'
        void this.ensureBindingClosed(binding).catch((closeError) => {
          this.emitDiagnostic('openErrorCloseFailure', closeError)
        })
      } else {
        this.finalizeBinding(binding)
      }
      return
    }

    if (this.state === 'open') {
      this.state = 'closing'
      this._connected = false
      this.clearWriteQueue()
      this.emitPublicError(error)
      void this.ensureBindingClosed(binding).catch((closeError) => {
        this.emitDiagnostic('runtimeCloseError', closeError)
      })
    }
  }

  private handlePortDrain(binding: PortBinding): void {
    if (binding !== this.binding || this.state !== 'open') return
    this.waitingForDrain = false
    this.flushWriteQueue(binding)
  }

  private writeFrame(binding: PortBinding, frame: Buffer): boolean {
    try {
      const accepted = binding.port.write(frame, (error) => {
        if (error) {
          if (binding === this.binding && this.state === 'open') {
            this.state = 'closing'
            this._connected = false
            this.clearWriteQueue()
            this.emitPublicError(error)
            void this.ensureBindingClosed(binding).catch((closeError) => {
              this.emitDiagnostic('runtimeCloseError', closeError)
            })
          } else {
            this.emitDiagnostic('lateWriteError', error)
          }
          return
        }
        this.emit('dataSent', frame.length)
      })
      if (!accepted) this.waitingForDrain = true
      return true
    } catch (error) {
      this.state = 'closing'
      this._connected = false
      this.clearWriteQueue()
      this.emitPublicError(this.toError(error))
      void this.ensureBindingClosed(binding).catch((closeError) => {
        this.emitDiagnostic('runtimeCloseError', closeError)
      })
      return false
    }
  }

  private enqueueFrame(frame: Buffer, priority: SerialWritePriority): boolean {
    if (frame.length > this.maxQueuedBytes || this.maxQueuedFrames < 1) {
      this.emitWriteOverflow(frame.length, priority, priority, false)
      return false
    }

    while (
      this.writeQueue.length >= this.maxQueuedFrames
      || this.queuedBytes + frame.length > this.maxQueuedBytes
    ) {
      const incomingRank = this.priorityRank(priority)
      let victimIndex = -1
      for (let index = this.writeQueue.length - 1; index >= 0; index -= 1) {
        if (this.priorityRank(this.writeQueue[index].priority) < incomingRank) {
          victimIndex = index
          break
        }
      }
      if (victimIndex < 0) {
        this.emitWriteOverflow(frame.length, priority, priority, false)
        return false
      }
      const [victim] = this.writeQueue.splice(victimIndex, 1)
      this.queuedBytes -= victim.frame.length
      this.emitWriteOverflow(victim.frame.length, victim.priority, priority, true)
    }

    const incomingRank = this.priorityRank(priority)
    const insertAt = this.writeQueue.findIndex(
      (queued) => this.priorityRank(queued.priority) < incomingRank,
    )
    const queued = { frame, priority }
    if (insertAt < 0) this.writeQueue.push(queued)
    else this.writeQueue.splice(insertAt, 0, queued)
    this.queuedBytes += frame.length
    return true
  }

  private flushWriteQueue(binding: PortBinding): void {
    while (
      binding === this.binding
      && this.state === 'open'
      && !this.waitingForDrain
      && this.writeQueue.length > 0
    ) {
      const queued = this.writeQueue.shift()!
      this.queuedBytes -= queued.frame.length
      this.writeFrame(binding, queued.frame)
    }
  }

  private clearWriteQueue(): void {
    this.writeQueue = []
    this.queuedBytes = 0
    this.waitingForDrain = false
  }

  private priorityRank(priority: SerialWritePriority): number {
    if (priority === 'critical') return 2
    if (priority === 'high') return 1
    return 0
  }

  private emitWriteOverflow(
    droppedBytes: number,
    droppedPriority: SerialWritePriority,
    incomingPriority: SerialWritePriority,
    evicted: boolean,
  ): void {
    this.emit('overflow', {
      droppedBytes,
      queuedBytes: this.queuedBytes,
      queuedFrames: this.writeQueue.length,
      maxQueuedBytes: this.maxQueuedBytes,
      maxQueuedFrames: this.maxQueuedFrames,
      droppedPriority,
      incomingPriority,
      evicted,
    } satisfies SerialWriteOverflow)
  }

  private ensureBindingClosed(binding: PortBinding): Promise<void> {
    if (binding.closePromise) return binding.closePromise
    const closePromise = (async () => {
      if (!binding.nativeOpenSettled) {
        await binding.nativeOpenPromise
      }
      if (!binding.closed && binding.port.isOpen) {
        await this.closeNativePort(binding)
      } else if (binding.nativeOpenResult === 'open' && !binding.closed) {
        // serialport reports isOpen=false while an internal close is already
        // running. Wait for its close event instead of detaching the internal
        // error listener early.
        await this.withTimeout(
          binding.closedPromise,
          this.closeTimeoutMs,
          `等待串口 ${binding.path} 完成关闭超时。`,
        )
      }
      this.finalizeBinding(binding)
    })()
    binding.closePromise = closePromise
    void closePromise.catch(() => {
      if (binding.closePromise === closePromise) binding.closePromise = null
    })
    return closePromise
  }

  private closeNativePort(binding: PortBinding): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        const error = new Error(
          `关闭串口 ${binding.path} 超时（${Math.round(this.closeTimeoutMs / 1000)}s）。`,
        )
        this.emit('closeError', error)
        reject(error)
      }, this.closeTimeoutMs)

      const done = (error: Error | null | undefined) => {
        if (settled) {
          if (error) this.emitDiagnostic('lateCloseError', error)
          else if (!binding.port.isOpen) {
            binding.closed = true
            binding.resolveClosed()
            this.finalizeBinding(binding)
          }
          return
        }
        settled = true
        clearTimeout(timer)
        if (error) {
          this.emit('closeError', error)
          reject(error)
          return
        }
        binding.closed = true
        binding.resolveClosed()
        resolve()
      }

      try {
        binding.port.close(done)
      } catch (error) {
        done(this.toError(error))
      }
    })
  }

  private finalizeBinding(binding: PortBinding): void {
    this.clearOpenTimeout(binding)
    if (this.binding !== binding) {
      this.detachPortListeners(binding)
      return
    }
    if (binding.port.isOpen) return
    this.detachPortListeners(binding)
    this.binding = null
    this.state = 'idle'
    this._connected = false
    this.clearWriteQueue()
  }

  private detachPortListeners(binding: PortBinding): void {
    binding.port.off('open', binding.onOpen)
    binding.port.off('data', binding.onData)
    binding.port.off('close', binding.onClose)
    binding.port.off('error', binding.onError)
    binding.port.off('drain', binding.onDrain)
  }

  private settleConnect(binding: PortBinding, error?: Error): void {
    if (binding.connectSettled) return
    binding.connectSettled = true
    this.clearOpenTimeout(binding)
    if (error) binding.rejectConnect(error)
    else binding.resolveConnect()
  }

  private settleNativeOpen(binding: PortBinding, result: 'open' | 'error'): void {
    if (binding.nativeOpenSettled) return
    binding.nativeOpenSettled = true
    binding.nativeOpenResult = result
    binding.resolveNativeOpen(result)
  }

  private clearOpenTimeout(binding: PortBinding): void {
    if (!binding.openTimeout) return
    clearTimeout(binding.openTimeout)
    binding.openTimeout = null
  }

  private emitPublicError(error: Error): void {
    if (this.listenerCount('error') > 0) {
      this.emit('error', error)
      return
    }
    this.emitDiagnostic('unhandledLinkError', error)
  }

  private emitDiagnostic(kind: string, error: unknown): void {
    this.emit('diagnostic', { kind, error: this.toError(error) })
  }

  private withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        reject(new Error(message))
      }, timeoutMs)
      promise.then(
        (value) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve(value)
        },
        (error) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          reject(error)
        },
      )
    })
  }

  private toError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error))
  }
}
