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
  port: string | null
  type: string | null
  clientId: string | null
  controllerClientId: string | null
  controllerExpiresAt: number | null
  canControl: boolean
  // Bluetooth auto-reconnect progress; non-null only while status === 'reconnecting'.
  reconnect: ReconnectInfo | null
  // Latest ~1 Hz link-quality sample (rx/tx throughput + CRC error rate).
  linkStats: LinkStats | null
  serialPorts: PortInfo[]
  bluetoothPorts: PortInfo[]
  scanning: boolean
  connectDialogOpen: boolean
  setStatus: (status: ConnectionStatus) => void
  setConnectionSnapshot: (snapshot: {
    status: ConnectionStatus
    transportOpen: boolean
    vehicleReady: boolean
    port?: string
    type?: string
  }) => void
  setClientId: (clientId: string) => void
  setController: (clientId: string | null, expiresAt: number | null) => void
  setReconnecting: (info: ReconnectInfo) => void
  setDisconnected: () => void
  setLinkStats: (stats: LinkStats) => void
  setPorts: (serial: PortInfo[], bluetooth: PortInfo[]) => void
  setScanning: (scanning: boolean) => void
  setConnectDialogOpen: (open: boolean) => void
}

export const useConnectionStore = create<ConnectionState>((set) => ({
  status: 'disconnected',
  transportOpen: false,
  vehicleReady: false,
  port: null,
  type: null,
  clientId: null,
  controllerClientId: null,
  controllerExpiresAt: null,
  canControl: true,
  reconnect: null,
  linkStats: null,
  serialPorts: [],
  bluetoothPorts: [],
  scanning: false,
  connectDialogOpen: false,
  setStatus: (status) => set({ status }),
  setConnectionSnapshot: (snapshot) => set((state) => ({
    status: snapshot.status,
    transportOpen: snapshot.transportOpen,
    vehicleReady: snapshot.vehicleReady,
    port: snapshot.port ?? (snapshot.transportOpen ? state.port : null),
    type: snapshot.type ?? (snapshot.transportOpen ? state.type : null),
    reconnect: snapshot.status === 'reconnecting' ? state.reconnect : null,
    connectDialogOpen: snapshot.transportOpen ? false : state.connectDialogOpen,
  })),
  setClientId: (clientId) => set((state) => ({
    clientId,
    canControl: state.controllerClientId === null || state.controllerClientId === clientId,
  })),
  setController: (controllerClientId, controllerExpiresAt) => set((state) => ({
    controllerClientId,
    controllerExpiresAt,
    canControl: controllerClientId === null || controllerClientId === state.clientId,
  })),
  // Keep port/type so the UI can show which device is being retried.
  setReconnecting: (info) => set({ status: 'reconnecting', transportOpen: false, vehicleReady: false, reconnect: info }),
  setDisconnected: () => set({
    status: 'disconnected',
    transportOpen: false,
    vehicleReady: false,
    port: null,
    type: null,
    reconnect: null,
    linkStats: null,
    controllerClientId: null,
    controllerExpiresAt: null,
    canControl: true,
  }),
  setLinkStats: (stats) => set({ linkStats: stats }),
  setPorts: (serial, bluetooth) => set({ serialPorts: serial, bluetoothPorts: bluetooth }),
  setScanning: (scanning) => set({ scanning }),
  setConnectDialogOpen: (open) => set({ connectDialogOpen: open }),
}))
