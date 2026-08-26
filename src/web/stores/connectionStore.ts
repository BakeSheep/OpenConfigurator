import { create } from 'zustand'
import type {
  ConnectionDiscoveryWarning,
  ConnectionStatus,
  PortInfo,
  RuntimeEvent,
} from '../../shared/types'

type TargetMessageData = Extract<RuntimeEvent, { type: 'target' }>['data']

export interface ReconnectInfo {
  attempt: number
  maxAttempts: number
  delayMs: number
}

/**
 * Per-kind scan state (connection compatibility plan §Phase 1). A failed
 * refresh keeps the previous candidates and flags them stale instead of
 * clearing the list; `scanGeneration` lets late responses be ignored.
 */
export interface ConnectionScanState {
  devices: PortInfo[]
  loading: boolean
  error: string | null
  stale: boolean
  scanGeneration: number
  warnings: ConnectionDiscoveryWarning[]
}

const initialScanState: ConnectionScanState = {
  devices: [],
  loading: false,
  error: null,
  stale: false,
  scanGeneration: 0,
  warnings: [],
}

// Module-level request bookkeeping so concurrent scans of the same kind
// resolve in issue order regardless of completion order.
const scanRequestSeq: Record<'serial' | 'bluetooth', number> = {
  serial: 0,
  bluetooth: 0,
}
const scanAbortControllers = new Map<'serial' | 'bluetooth', AbortController>()

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
  port: string | null
  type: string | null
  baudRate: number | null
  targetSystemId: number | null
  targetComponentId: number | null
  targetSelectionSource: TargetMessageData['selectionSource']
  targetConflict: TargetMessageData['conflict']
  discoveredTargets: NonNullable<TargetMessageData['discovered']>
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
  serialScan: ConnectionScanState
  bluetoothScan: ConnectionScanState
  showAllSerialPorts: boolean
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
    safetyEpoch: number
    safetyAuthorityId: string
    port?: string
    type?: string
    baudRate?: number
    canControl?: boolean
  }) => void
  setSafetyBoundary: (safetyEpoch: number, safetyAuthorityId: string) => void
  setClientId: (clientId: string, safetyEpoch: number, safetyAuthorityId: string) => void
  setController: (clientId: string | null, expiresAt: number | null, safetyEpoch: number, safetyAuthorityId: string) => void
  setTarget: (
    systemId: number | null,
    componentId: number | null,
    safetyEpoch?: number,
    safetyAuthorityId?: string,
    selectionSource?: TargetMessageData['selectionSource'],
    conflict?: TargetMessageData['conflict'],
    discovered?: TargetMessageData['discovered'],
  ) => void
  setReconnecting: (info: ReconnectInfo) => void
  setDisconnected: () => void
  setLinkStats: (stats: LinkStats) => void
  setPorts: (serial: PortInfo[], bluetooth: PortInfo[]) => void
  setScanning: (scanning: boolean) => void
  /**
   * Request one transport kind. Serial honors the show-all toggle; bluetooth
   * always uses the quick (cache-only) scope. Late/stale responses and
   * cancellations never clobber newer results.
   */
  scanConnections: (kind: 'serial' | 'bluetooth') => Promise<void>
  setShowAllSerialPorts: (showAll: boolean) => void
  /** Abort in-flight scans (dialog closed); ignores their results. */
  cancelConnectionScans: () => void
  setConnectDialogOpen: (open: boolean) => void
  setActivePresetId: (presetId: string | null) => void
}

export const useConnectionStore = create<ConnectionState>((set) => ({
  status: 'disconnected',
  transportOpen: false,
  vehicleReady: false,
  rawSessionActive: false,
  port: null,
  type: null,
  baudRate: null,
  targetSystemId: null,
  targetComponentId: null,
  targetSelectionSource: null,
  targetConflict: null,
  discoveredTargets: [],
  clientId: null,
  controllerClientId: null,
  controllerExpiresAt: null,
  safetyEpoch: 0,
  safetyAuthorityId: null,
  canControl: false,
  reconnect: null,
  linkStats: null,
  serialPorts: [],
  bluetoothPorts: [],
  scanning: false,
  serialScan: initialScanState,
  bluetoothScan: initialScanState,
  showAllSerialPorts: false,
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
    canControl: snapshot.canControl ?? snapshot.transportOpen,
  })),
  setSafetyBoundary: (safetyEpoch, safetyAuthorityId) => set({
    safetyEpoch,
    safetyAuthorityId,
  }),
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
  setTarget: (
    targetSystemId,
    targetComponentId,
    safetyEpoch,
    safetyAuthorityId,
    targetSelectionSource,
    targetConflict,
    discoveredTargets,
  ) => set((state) => {
    const normalizedComponentId = targetSystemId === null ? null : targetComponentId
    return {
      targetSystemId,
      targetComponentId: normalizedComponentId,
      ...(targetSelectionSource === undefined ? {} : { targetSelectionSource }),
      ...(targetConflict === undefined ? {} : { targetConflict }),
      ...(discoveredTargets === undefined ? {} : { discoveredTargets }),
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
    targetSelectionSource: null,
    targetConflict: null,
    discoveredTargets: [],
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
    targetSelectionSource: null,
    targetConflict: null,
    discoveredTargets: [],
    reconnect: null,
    linkStats: null,
    canControl: false,
    activePresetId: null,
  })),
  setLinkStats: (stats) => set({ linkStats: stats }),
  setPorts: (serial, bluetooth) => set({ serialPorts: serial, bluetoothPorts: bluetooth }),
  setScanning: (scanning) => set({ scanning }),
  scanConnections: async (kind) => {
    const state = useConnectionStore.getState()
    const scope = kind === 'serial'
      ? (state.showAllSerialPorts ? 'all' : 'recommended')
      : 'quick'
    const requestGeneration = ++scanRequestSeq[kind]
    scanAbortControllers.get(kind)?.abort()
    const controller = new AbortController()
    scanAbortControllers.set(kind, controller)

    const patch = (partial: Partial<ConnectionScanState>) => set((current) => ({
      ...(kind === 'serial'
        ? {
          serialScan: { ...current.serialScan, ...partial },
          // Mirror for legacy consumers (presets dropdown) until they migrate.
          ...(partial.devices ? { serialPorts: partial.devices } : {}),
        }
        : {
          bluetoothScan: { ...current.bluetoothScan, ...partial },
          ...(partial.devices ? { bluetoothPorts: partial.devices } : {}),
        }),
    }))

    patch({ loading: true, scanGeneration: requestGeneration })
    try {
      const response = await fetch(
        `/api/connections/scan?kind=${kind}&scope=${scope}`,
        { signal: controller.signal },
      )
      const json = await response.json()
      if (scanRequestSeq[kind] !== requestGeneration) return
      if (!response.ok || !json?.success) {
        patch({
          loading: false,
          stale: true,
          error: json?.error?.message ?? `HTTP ${response.status}`,
        })
        return
      }
      patch({
        loading: false,
        stale: false,
        error: null,
        devices: (json.data?.devices ?? []) as PortInfo[],
        warnings: (json.data?.warnings ?? []) as ConnectionDiscoveryWarning[],
      })
    } catch (scanError) {
      if (scanRequestSeq[kind] !== requestGeneration) return
      if (scanError instanceof DOMException && scanError.name === 'AbortError') {
        patch({ loading: false })
        return
      }
      patch({
        loading: false,
        stale: true,
        error: scanError instanceof Error ? scanError.message : String(scanError),
      })
    } finally {
      if (scanAbortControllers.get(kind) === controller) {
        scanAbortControllers.delete(kind)
      }
    }
  },
  setShowAllSerialPorts: (showAll) => set({ showAllSerialPorts: showAll }),
  cancelConnectionScans: () => {
    for (const controller of scanAbortControllers.values()) controller.abort()
    scanAbortControllers.clear()
    set((current) => ({
      serialScan: { ...current.serialScan, loading: false },
      bluetoothScan: { ...current.bluetoothScan, loading: false },
    }))
  },
  setConnectDialogOpen: (open) => set({ connectDialogOpen: open }),
  setActivePresetId: (activePresetId) => set({ activePresetId }),
}))
