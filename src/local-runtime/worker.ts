import type { WorkerInboundMessage, WorkerOutboundMessage } from '../shared/localRuntime'
import { LocalRuntimeCoordinator } from './LocalRuntimeCoordinator'
import { artifactFs } from './platform/artifactFs'
import { InputValidationError, parseRuntimeCommand } from './validation'

const post = (message: WorkerOutboundMessage, transfer: Transferable[] = []) => {
  self.postMessage(message, { transfer })
}

const MAX_PENDING_WRITE_BYTES = 512 * 1024
let writeId = 0
let pendingWriteBytes = 0
let writeFailureActive = false
const pendingWrites = new Map<number, { byteLength: number; queueTag?: string }>()

function clearPendingWrites(): void {
  pendingWrites.clear()
  pendingWriteBytes = 0
}

artifactFs.setNamespace(crypto.randomUUID())
const coordinator = new LocalRuntimeCoordinator({
  emit: (event) => post({ type: 'runtime_event', event }),
  write: (data, priority, queueTag) => {
    if (writeFailureActive || pendingWriteBytes + data.byteLength > MAX_PENDING_WRITE_BYTES) return false
    const currentWriteId = ++writeId
    pendingWrites.set(currentWriteId, { byteLength: data.byteLength, ...(queueTag ? { queueTag } : {}) })
    pendingWriteBytes += data.byteLength
    const copy = data.slice().buffer
    post({ type: 'transport_write', writeId: currentWriteId, data: copy, priority, queueTag }, [copy])
    return true
  },
  cancelQueuedWrites: (queueTag) => {
    let cancelled = 0
    for (const [id, pending] of pendingWrites) {
      if (pending.queueTag !== queueTag) continue
      pendingWrites.delete(id)
      pendingWriteBytes -= pending.byteLength
      cancelled += 1
    }
    post({ type: 'transport_cancel', queueTag })
    return cancelled
  },
})

async function handle(message: WorkerInboundMessage): Promise<void> {
  switch (message.type) {
    case 'transport_open':
      clearPendingWrites()
      writeFailureActive = false
      coordinator.open(message.config, message)
      return
    case 'transport_bytes':
      coordinator.receive(new Uint8Array(message.data))
      return
    case 'transport_closed':
      clearPendingWrites()
      writeFailureActive = true
      coordinator.close(message.reason)
      return
    case 'runtime_command':
      try {
        coordinator.handleCommand(parseRuntimeCommand(message.command))
      } catch (error) {
        const details = error instanceof InputValidationError
          ? `${error.code}: ${error.message}`
          : error instanceof Error ? error.message : String(error)
        post({ type: 'runtime_error', message: `Invalid runtime command: ${details}` })
      }
      return
    case 'artifact_read': {
      try {
        const artifact = await coordinator.readArtifact(message.artifactId, message.consume)
        const data = artifact.data.slice().buffer
        post({
          type: 'artifact_data',
          requestId: message.requestId,
          artifactId: message.artifactId,
          fileName: artifact.fileName,
          data,
        }, [data])
      } catch (error) {
        post({
          type: 'artifact_error',
          requestId: message.requestId,
          artifactId: message.artifactId,
          message: error instanceof Error ? error.message : String(error),
        })
      }
      return
    }
    case 'prepare_disconnect':
      await coordinator.prepareDisconnect()
      post({ type: 'transport_prepared', requestId: message.requestId })
      return
    case 'shutdown':
      coordinator.destroy()
      await artifactFs.purge()
      self.close()
      return
    case 'write_result': {
      const pending = pendingWrites.get(message.writeId)
      if (!pending) return
      pendingWrites.delete(message.writeId)
      pendingWriteBytes -= pending.byteLength
      if (message.accepted || writeFailureActive) return

      // The Worker already told the protocol layer that this frame was
      // accepted. A later main-thread rejection makes that link generation
      // indeterminate, so fail it closed instead of continuing with state that
      // assumes the command reached the serial stream.
      writeFailureActive = true
      clearPendingWrites()
      coordinator.close('serial_write_rejected')
      post({ type: 'transport_abort', reason: 'serial_write_rejected' })
      post({ type: 'runtime_error', message: 'Serial transport rejected a queued write' })
      return
    }
  }
}

self.addEventListener('message', (event: MessageEvent<WorkerInboundMessage>) => {
  void handle(event.data).catch((error) => {
    post({ type: 'runtime_error', message: error instanceof Error ? error.message : String(error) })
  })
})

void artifactFs.purge().finally(() => post({ type: 'runtime_ready' }))
