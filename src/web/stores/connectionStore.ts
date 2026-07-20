import { create } from 'zustand'
import type { ConnectionStatus, PortInfo } from '../../shared/types'

interface ConnectionState {
  status: ConnectionStatus
  port: string | null
  type: string | null
  serialPorts: PortInfo[]
  bluetoothPorts: PortInfo[]
  scanning: boolean
  connectDialogOpen: boolean
  setStatus: (status: ConnectionStatus) => void
  setConnected: (port: string, type: string) => void
  setDisconnected: () => void
  setPorts: (serial: PortInfo[], bluetooth: PortInfo[]) => void
  setScanning: (scanning: boolean) => void
  setConnectDialogOpen: (open: boolean) => void
}

export const useConnectionStore = create<ConnectionState>((set) => ({
  status: 'disconnected',
  port: null,
  type: null,
  serialPorts: [],
  bluetoothPorts: [],
  scanning: false,
  connectDialogOpen: false,
  setStatus: (status) => set({ status }),
  setConnected: (port, type) => set({ status: 'connected', port, type, connectDialogOpen: false }),
  setDisconnected: () => set({ status: 'disconnected', port: null, type: null }),
  setPorts: (serial, bluetooth) => set({ serialPorts: serial, bluetoothPorts: bluetooth }),
  setScanning: (scanning) => set({ scanning }),
  setConnectDialogOpen: (open) => set({ connectDialogOpen: open }),
}))
