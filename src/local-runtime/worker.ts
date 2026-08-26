import type { WorkerInboundMessage, WorkerOutboundMessage } from '../shared/localRuntime'
import { LocalRuntimeCoordinator } from './LocalRuntimeCoordinator'
import { artifactFs } from './platform/artifactFs'
import { InputValidationError, parseRuntimeCommand } from './validation'

const post = (message: WorkerOutboundMessage, transfer: Transferable[] = []) => {
  self.postMessage(message, { transfer })
}

let writeId = 0
const coordinator = new LocalRuntimeCoordinator({
  emit: (event) => post({ type: 'runtime_event', event }),
  write: (data, priority, queueTag) => {
    const copy = data.slice().buffer
    post({ type: 'transport_write', writeId: ++writeId, data: copy, priority, queueTag }, [copy])
    return true
  },
  cancelQueuedWrites: (queueTag) => {
    post({ type: 'transport_cancel', queueTag })
    return 0
  },
})

async function handle(message: WorkerInboundMessage): Promise<void> {
  switch (message.type) {
    case 'transport_open':
      coordinator.open(message.config, message)
      return
    case 'transport_bytes':
      coordinator.receive(new Uint8Array(message.data))
      return
    case 'transport_closed':
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
    case 'write_result':
      return
  }
}

self.addEventListener('message', (event: MessageEvent<WorkerInboundMessage>) => {
  void handle(event.data).catch((error) => {
    post({ type: 'runtime_error', message: error instanceof Error ? error.message : String(error) })
  })
})

void artifactFs.purge().finally(() => post({ type: 'runtime_ready' }))
