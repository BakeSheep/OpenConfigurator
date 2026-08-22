// ArduPilot DataFlash log-transfer state: the LOG_REQUEST_* protocol exposes
// a flat id-addressed log list (no filesystem), a single download task and an
// erase-all task. Mirrors the fileExplorerStore task-state conventions.
import { create } from 'zustand'
import type { DataflashLogEntry } from '../../shared/types'

export interface LogDownloadTask {
  logId: number
  receivedBytes: number
  totalBytes: number
  rateBps: number
  status: 'active' | 'done' | 'error'
  /** Set once the backend registered the finished file. */
  downloadId?: string
  fileName?: string
  advertisedSizeBytes?: number
  sizeAdjusted?: boolean
  integrity?: 'unverified'
  /** Consumer hint: 'save' triggers a browser download, 'analyze' loads the analysis page. */
  intent: 'save' | 'analyze'
  error?: string
}

export interface LogEraseTask {
  status: 'active' | 'done' | 'error'
  error?: string
}

interface LogTransferState {
  entries: DataflashLogEntry[]
  /** True once a list result has been received for this connection. */
  listed: boolean
  loading: boolean
  listError: string | null
  selection: Set<number>
  lastSelected: number | null
  download: LogDownloadTask | null
  erase: LogEraseTask | null

  setLoading: (loading: boolean) => void
  setListing: (entries: DataflashLogEntry[]) => void
  setListError: (message: string) => void
  setSelection: (selection: Set<number>, lastSelected?: number | null) => void
  clearSelection: () => void
  beginDownload: (logId: number, intent: 'save' | 'analyze') => void
  setDownloadProgress: (logId: number, receivedBytes: number, totalBytes: number, rateBps: number) => void
  completeDownload: (
    logId: number,
    downloadId: string,
    fileName: string,
    sizeBytes: number,
    advertisedSizeBytes: number,
    sizeAdjusted: boolean,
    integrity: 'unverified',
  ) => void
  failDownload: (message: string) => void
  clearDownload: () => void
  beginErase: () => void
  completeErase: () => void
  failErase: (message: string) => void
  clearErase: () => void
  reset: () => void
}

export const useLogTransferStore = create<LogTransferState>((set) => ({
  entries: [],
  listed: false,
  loading: false,
  listError: null,
  selection: new Set<number>(),
  lastSelected: null,
  download: null,
  erase: null,

  setLoading: (loading) => set({ loading }),
  setListing: (entries) => set({
    entries,
    listed: true,
    loading: false,
    listError: null,
  }),
  setListError: (message) => set({ loading: false, listError: message }),
  setSelection: (selection, lastSelected) => set({
    selection,
    ...(lastSelected !== undefined ? { lastSelected } : {}),
  }),
  clearSelection: () => set({ selection: new Set<number>(), lastSelected: null }),
  beginDownload: (logId, intent) => set({
    download: {
      logId,
      receivedBytes: 0,
      totalBytes: 0,
      rateBps: 0,
      status: 'active',
      intent,
    },
  }),
  setDownloadProgress: (logId, receivedBytes, totalBytes, rateBps) => set((state) => ({
    download: state.download && state.download.logId === logId
      ? { ...state.download, receivedBytes, totalBytes, rateBps }
      : state.download,
  })),
  completeDownload: (
    logId,
    downloadId,
    fileName,
    sizeBytes,
    advertisedSizeBytes,
    sizeAdjusted,
    integrity,
  ) => set((state) => ({
    download: state.download && state.download.logId === logId
      ? {
        ...state.download,
        status: 'done',
        downloadId,
        fileName,
        advertisedSizeBytes,
        sizeAdjusted,
        integrity,
        receivedBytes: sizeBytes,
        totalBytes: sizeBytes,
      }
      : state.download,
  })),
  failDownload: (message) => set((state) => ({
    // Failures can happen both during the transfer and after completion while
    // the browser fetches the registered temp file for analysis.
    download: state.download
      ? { ...state.download, status: 'error', error: message }
      : state.download,
  })),
  clearDownload: () => set({ download: null }),
  beginErase: () => set({ erase: { status: 'active' } }),
  completeErase: () => set((state) => ({
    erase: state.erase ? { ...state.erase, status: 'done' } : null,
    selection: new Set<number>(),
    lastSelected: null,
  })),
  failErase: (message) => set((state) => ({
    erase: state.erase && state.erase.status === 'active'
      ? { ...state.erase, status: 'error', error: message }
      : state.erase,
  })),
  clearErase: () => set({ erase: null }),
  reset: () => set({
    entries: [],
    listed: false,
    loading: false,
    listError: null,
    selection: new Set<number>(),
    lastSelected: null,
    download: null,
    erase: null,
  }),
}))
