import { create } from 'zustand'
import { FTP_DEFAULT_LOG_DIRECTORY } from '../../shared/constants'
import type { FsEntry } from '../../shared/types'

export interface DownloadTask {
  path: string
  receivedBytes: number
  totalBytes: number
  rateBps: number
  status: 'active' | 'done' | 'error'
  /** Set once the backend registered the finished file. */
  downloadId?: string
  fileName?: string
  /** Consumer hint: 'save' triggers a browser download, 'analyze' loads the analysis page. */
  intent: 'save' | 'analyze'
  error?: string
}

export interface DeleteTask {
  done: number
  total: number
  current: string
  status: 'active' | 'done' | 'error'
  error?: string
}

interface FileExplorerState {
  currentPath: string
  entries: FsEntry[]
  /** Path the currently displayed entries belong to. */
  listedPath: string | null
  loading: boolean
  listError: string | null
  backStack: string[]
  forwardStack: string[]
  selection: Set<string>
  lastSelected: string | null
  download: DownloadTask | null
  deletion: DeleteTask | null

  navigateTo: (path: string, options?: { recordHistory?: boolean }) => void
  goBack: () => string | null
  goForward: () => string | null
  setLoading: (loading: boolean) => void
  setListing: (path: string, entries: FsEntry[]) => void
  setListError: (message: string) => void
  setSelection: (selection: Set<string>, lastSelected?: string | null) => void
  clearSelection: () => void
  beginDownload: (path: string, intent: 'save' | 'analyze') => void
  setDownloadProgress: (path: string, receivedBytes: number, totalBytes: number, rateBps: number) => void
  completeDownload: (path: string, downloadId: string, fileName: string, sizeBytes: number) => void
  failDownload: (message: string) => void
  clearDownload: () => void
  beginDeletion: () => void
  setDeleteProgress: (done: number, total: number, current: string) => void
  completeDeletion: () => void
  failDeletion: (message: string) => void
  clearDeletion: () => void
  reset: () => void
}

export const useFileExplorerStore = create<FileExplorerState>((set, get) => ({
  currentPath: FTP_DEFAULT_LOG_DIRECTORY,
  entries: [],
  listedPath: null,
  loading: false,
  listError: null,
  backStack: [],
  forwardStack: [],
  selection: new Set<string>(),
  lastSelected: null,
  download: null,
  deletion: null,

  navigateTo: (path, options) => set((state) => ({
    currentPath: path,
    backStack: options?.recordHistory === false || state.currentPath === path
      ? state.backStack
      : [...state.backStack, state.currentPath].slice(-50),
    forwardStack: options?.recordHistory === false ? state.forwardStack : [],
    selection: new Set<string>(),
    lastSelected: null,
    listError: null,
  })),
  goBack: () => {
    const state = get()
    const previous = state.backStack[state.backStack.length - 1]
    if (previous === undefined) return null
    set({
      currentPath: previous,
      backStack: state.backStack.slice(0, -1),
      forwardStack: [state.currentPath, ...state.forwardStack].slice(0, 50),
      selection: new Set<string>(),
      lastSelected: null,
      listError: null,
    })
    return previous
  },
  goForward: () => {
    const state = get()
    const next = state.forwardStack[0]
    if (next === undefined) return null
    set({
      currentPath: next,
      forwardStack: state.forwardStack.slice(1),
      backStack: [...state.backStack, state.currentPath].slice(-50),
      selection: new Set<string>(),
      lastSelected: null,
      listError: null,
    })
    return next
  },
  setLoading: (loading) => set({ loading }),
  // Listings for a directory the user already navigated away from are stale
  // and ignored; a request for the current directory is still in flight.
  setListing: (path, entries) => set((state) =>
    state.currentPath === path
      ? { entries, listedPath: path, loading: false, listError: null }
      : {},
  ),
  setListError: (message) => set({ loading: false, listError: message }),
  setSelection: (selection, lastSelected) => set({
    selection,
    ...(lastSelected !== undefined ? { lastSelected } : {}),
  }),
  clearSelection: () => set({ selection: new Set<string>(), lastSelected: null }),
  beginDownload: (path, intent) => set({
    download: {
      path,
      receivedBytes: 0,
      totalBytes: 0,
      rateBps: 0,
      status: 'active',
      intent,
    },
  }),
  setDownloadProgress: (path, receivedBytes, totalBytes, rateBps) => set((state) => ({
    download: state.download && state.download.path === path
      ? { ...state.download, receivedBytes, totalBytes, rateBps }
      : state.download,
  })),
  completeDownload: (path, downloadId, fileName, sizeBytes) => set((state) => ({
    download: state.download && state.download.path === path
      ? {
        ...state.download,
        status: 'done',
        downloadId,
        fileName,
        receivedBytes: sizeBytes,
        totalBytes: sizeBytes,
      }
      : state.download,
  })),
  failDownload: (message) => set((state) => ({
    // Failures can happen both during FTP transfer and after completion while
    // the browser fetches the registered temp file for analysis.
    download: state.download
      ? { ...state.download, status: 'error', error: message }
      : state.download,
  })),
  clearDownload: () => set({ download: null }),
  beginDeletion: () => set({ deletion: { done: 0, total: 0, current: '', status: 'active' } }),
  setDeleteProgress: (done, total, current) => set({
    deletion: { done, total, current, status: 'active' },
  }),
  completeDeletion: () => set((state) => ({
    deletion: state.deletion ? { ...state.deletion, status: 'done' } : null,
    selection: new Set<string>(),
    lastSelected: null,
  })),
  failDeletion: (message) => set((state) => ({
    deletion: state.deletion && state.deletion.status === 'active'
      ? { ...state.deletion, status: 'error', error: message }
      : state.deletion,
  })),
  clearDeletion: () => set({ deletion: null }),
  reset: () => set({
    entries: [],
    listedPath: null,
    loading: false,
    listError: null,
    selection: new Set<string>(),
    lastSelected: null,
    download: null,
    deletion: null,
  }),
}))
