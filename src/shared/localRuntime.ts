import type { ConnectionConfig, RuntimeCommand, RuntimeEvent } from './types'

export type { RuntimeCommand, RuntimeEvent } from './types'
export const LOCAL_RUNTIME_OWNER_ID = 'local-browser'

export interface BrowserPortDescriptor {
  /** Ephemeral id valid only for the current page lifecycle. */
  id: string
  /** Opaque identity valid only for this Web Serial transport instance. */
  deviceId: string
  label: string
  usbVendorId?: number
  usbProductId?: number
  bluetoothServiceClassId?: string
  granted: boolean
}

export interface MavlinkSigningInput {
  /** 64 hex characters or a passphrase. Never persisted by the application. */
  secret: string
  linkId: number
  requireSigned: boolean
  allowStaleFirstPacket: boolean
}

export interface BrowserConnectionOptions {
  portId: string
  type: ConnectionConfig['type']
  baudRate: number
  protocol: 'auto' | 'v1' | 'v2'
  signing?: MavlinkSigningInput
}

export interface LocalArtifactStore {
  create(fileName: string, expectedBytes: number): Promise<string>
  write(artifactId: string, offset: number, data: Uint8Array): Promise<void>
  complete(artifactId: string): Promise<void>
  readBlob(artifactId: string): Promise<Blob>
  consume(artifactId: string): Promise<Blob>
  cleanup(): Promise<void>
}

export type WorkerInboundMessage =
  | { type: 'transport_open'; config: ConnectionConfig; protocol: BrowserConnectionOptions['protocol']; signing?: MavlinkSigningInput }
  | { type: 'transport_bytes'; data: ArrayBuffer }
  | { type: 'transport_closed'; reason?: string }
  | { type: 'runtime_command'; command: RuntimeCommand }
  | { type: 'write_result'; writeId: number; accepted: boolean }
  | { type: 'artifact_read'; requestId: string; artifactId: string; consume: boolean }
  | { type: 'prepare_disconnect'; requestId: string }
  | { type: 'shutdown' }

export type WorkerOutboundMessage =
  | { type: 'runtime_event'; event: RuntimeEvent }
  | { type: 'transport_write'; writeId: number; data: ArrayBuffer; priority: 'normal' | 'high' | 'critical'; queueTag?: string }
  | { type: 'transport_cancel'; queueTag: string }
  | { type: 'transport_abort'; reason: string }
  | { type: 'runtime_ready' }
  | { type: 'runtime_error'; message: string }
  | { type: 'artifact_data'; requestId: string; artifactId: string; fileName: string; data: ArrayBuffer }
  | { type: 'artifact_error'; requestId: string; artifactId: string; message: string }
  | { type: 'transport_prepared'; requestId: string }
