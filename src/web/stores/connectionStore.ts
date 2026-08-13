import { create } from 'zustand'
import type { ConnectionStatus, PortInfo } from '../../shared/types'

export interface ReconnectInfo {
  attempt: number
  maxAttempts: number
  delayMs: number
}

export interface LinkStats {
  rxBps: number
  txBps: number
  crcErrors: number
  crcErrorsPerSec: number
  // Optional counters mirrored from the server's link_stats payload.
  rxPackets?: number
  txPackets?: number
  rxSequenceLost?: number
  rxDuplicates?: number
  rxOutOfOrder?: number
  rejectedPackets?: number
  garbageBytes?: number
  protocolVersion?: 1 | 2
}

interface ConnectionState {
  status: ConnectionStatus
  transportOpen: boolean
  vehicleReady: boolean
  rawSessionActive: boolean
  connectionGeneration: number
  port: string | null
  type: string | null
  baudRate: number | null
  targetSystemId: number | null
  targetComponentId: number | null
  clientId: string | null
  controllerClientId: string | null
  controllerExpiresAt: number | null
  /** Server-authoritative safety-confirmation boundary. */
  safetyEpoch: number
  safetyAuthorityId: string | null
  canControl: boolean
  // Bluetooth auto-reconnect progress; non-null only while status === 'reconnecting'.
  reconnect: ReconnectInfo | null
  // Latest ~1 Hz link-quality sample (rx/tx throughput + CRC error rate).
  linkStats: LinkStats | null
  serialPorts: PortInfo[]
  bluetoothPorts: PortInfo[]
  scanning: boolean
  connectDialogOpen: boolean
  connectionError: string | null
  activePresetId: string | null
  setStatus: (status: ConnectionStatus) => void
  setConnectionError: (error: string | null) => void
  setConnectionSnapshot: (snapshot: {
    status: ConnectionStatus
    transportOpen: boolean
    vehicleReady: boolean
    rawSessionActive: boolean
    connectionGeneration?: number
    safetyEpoch: number
    safetyAuthorityId: string
    port?: string
    type?: string
    baudRate?: number
  }) => void
  setClientId: (clientId: string, safetyEpoch: number, safetyAuthorityId: string) => void
  setController: (clientId: string | null, expiresAt: number | null, safetyEpoch: number, safetyAuthorityId: string) => void
  setTarget: (systemId: number | null, componentId: number | null, safetyEpoch?: number, safetyAuthorityId?: string) => void
  setReconnecting: (info: ReconnectInfo) => void
  setDisconnected: () => void
  setLinkStats: (stats: LinkStats) => void
  setPorts: (serial: PortInfo[], bluetooth: PortInfo[]) => void
  setScanning: (scanning: boolean) => void
  setConnectDialogOpen: (open: boolean) => void
  setActivePresetId: (presetId: string | null) => void
}

export const useConnectionStore = create<ConnectionState>((set) => ({
  status: 'disconnected',
  transportOpen: false,
  vehicleReady: false,
  rawSessionActive: false,
  connectionGeneration: 0,
  port: null,
  type: null,
  baudRate: null,
  targetSystemId: null,
  targetComponentId: null,
  clientId: null,
  controllerClientId: null,
  controllerExpiresAt: null,
  safetyEpoch: 0,
  safetyAuthorityId: null,
  canControl: true,
  reconnect: null,
  linkStats: null,
  serialPorts: [],
  bluetoothPorts: [],
  scanning: false,
  connectDialogOpen: false,
  connectionError: null,
  activePresetId: null,
  setStatus: (status) => set({ status }),
  setConnectionError: (connectionError) => set({ connectionError }),
  setConnectionSnapshot: (snapshot) => set((state) => ({
    status: snapshot.status,
    transportOpen: snapshot.transportOpen,
    vehicleReady: snapshot.vehicleReady,
    rawSessionActive: snapshot.rawSessionActive,
    connectionGeneration: snapshot.connectionGeneration ?? state.connectionGeneration,
    port: snapshot.port ?? (snapshot.transportOpen ? state.port : null),
    type: snapshot.type ?? (snapshot.transportOpen ? state.type : null),
    baudRate: snapshot.baudRate ?? (snapshot.transportOpen ? state.baudRate : null),
    reconnect: snapshot.status === 'reconnecting' ? state.reconnect : null,
    connectDialogOpen: snapshot.transportOpen && !state.transportOpen
      ? false
      : state.connectDialogOpen,
    connectionError: snapshot.transportOpen ? null : state.connectionError,
    safetyEpoch: snapshot.safetyEpoch,
    safetyAuthorityId: snapshot.safetyAuthorityId,
  })),
  setClientId: (clientId, safetyEpoch, safetyAuthorityId) => set((state) => ({
    clientId,
    safetyEpoch,
    safetyAuthorityId,
    canControl: state.controllerClientId === null || state.controllerClientId === clientId,
  })),
  setController: (controllerClientId, controllerExpiresAt, safetyEpoch, safetyAuthorityId) => set((state) => ({
    controllerClientId,
    controllerExpiresAt,
    safetyEpoch,
    safetyAuthorityId,
    canControl: controllerClientId === null || controllerClientId === state.clientId,
  })),
  setTarget: (targetSystemId, targetComponentId, safetyEpoch, safetyAuthorityId) => set((state) => {
    const normalizedComponentId = targetSystemId === null ? null : targetComponentId
    return {
      targetSystemId,
      targetComponentId: normalizedComponentId,
      ...(safetyEpoch === undefined ? {} : { safetyEpoch }),
      ...(safetyAuthorityId === undefined ? {} : { safetyAuthorityId }),
    }
  }),
  // Keep port/type so the UI can show which device is being retried.
  setReconnecting: (info) => set((state) => ({
    status: 'reconnecting',
    transportOpen: false,
    vehicleReady: false,
    rawSessionActive: false,
    targetSystemId: null,
    targetComponentId: null,
    reconnect: info,
  })),
  setDisconnected: () => set((state) => ({
    status: 'disconnected',
    transportOpen: false,
    vehicleReady: false,
    rawSessionActive: false,
    port: null,
    type: null,
    baudRate: null,
    targetSystemId: null,
    targetComponentId: null,
    reconnect: null,
    linkStats: null,
    controllerClientId: null,
    controllerExpiresAt: null,
    canControl: true,
    activePresetId: null,
  })),
  setLinkStats: (stats) => set({ linkStats: stats }),
  setPorts: (serial, bluetooth) => set({ serialPorts: serial, bluetoothPorts: bluetooth }),
  setScanning: (scanning) => set({ scanning }),
  setConnectDialogOpen: (open) => set({ connectDialogOpen: open }),
  setActivePresetId: (activePresetId) => set({ activePresetId }),
}))
