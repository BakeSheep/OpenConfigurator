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
}

interface ConnectionState {
  status: ConnectionStatus
  port: string | null
  type: string | null
  // Bluetooth auto-reconnect progress; non-null only while status === 'reconnecting'.
  reconnect: ReconnectInfo | null
  // Latest ~1 Hz link-quality sample (rx/tx throughput + CRC error rate).
  linkStats: LinkStats | null
  serialPorts: PortInfo[]
  bluetoothPorts: PortInfo[]
  scanning: boolean
  connectDialogOpen: boolean
  setStatus: (status: ConnectionStatus) => void
  setConnected: (port: string, type: string) => void
  setReconnecting: (info: ReconnectInfo) => void
  setDisconnected: () => void
  setLinkStats: (stats: LinkStats) => void
  setPorts: (serial: PortInfo[], bluetooth: PortInfo[]) => void
  setScanning: (scanning: boolean) => void
  setConnectDialogOpen: (open: boolean) => void
}

export const useConnectionStore = create<ConnectionState>((set) => ({
  status: 'disconnected',
  port: null,
  type: null,
  reconnect: null,
  linkStats: null,
  serialPorts: [],
  bluetoothPorts: [],
  scanning: false,
  connectDialogOpen: false,
  setStatus: (status) => set({ status }),
  setConnected: (port, type) => set({ status: 'connected', port, type, reconnect: null, connectDialogOpen: false }),
  // Keep port/type so the UI can show which device is being retried.
  setReconnecting: (info) => set({ status: 'reconnecting', reconnect: info }),
  setDisconnected: () => set({ status: 'disconnected', port: null, type: null, reconnect: null, linkStats: null }),
  setLinkStats: (stats) => set({ linkStats: stats }),
  setPorts: (serial, bluetooth) => set({ serialPorts: serial, bluetoothPorts: bluetooth }),
  setScanning: (scanning) => set({ scanning }),
  setConnectDialogOpen: (open) => set({ connectDialogOpen: open }),
}))
