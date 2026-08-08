import { existsSync } from 'node:fs'
import path from 'node:path'
import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  shell,
  type Event as ElectronEvent,
} from 'electron'
import {
  startServer,
  type BackendRuntime,
} from '../src/server/index'
import { parseServerConfig } from '../src/server/validation'

let mainWindow: BrowserWindow | null = null
let backend: BackendRuntime | null = null
let backendStopped = false
let quitAfterShutdown = false

function openExternalUrl(targetUrl: string): void {
  let parsedUrl: URL
  try {
    parsedUrl = new URL(targetUrl)
  } catch {
    return
  }

  if (parsedUrl.protocol !== 'https:') return

  void shell.openExternal(parsedUrl.toString()).catch((error) => {
    console.error('[Desktop] Failed to open external URL:', error)
  })
}

function packagedWebDir(): string {
  return path.join(app.getAppPath(), 'dist')
}

async function startDesktopBackend(): Promise<string> {
  const staticDir = packagedWebDir()
  if (!existsSync(path.join(staticDir, 'index.html'))) {
    throw new Error(`找不到桌面前端资源：${staticDir}`)
  }

  // Desktop mode is deliberately local-only and ignores deployment environment
  // variables that could otherwise widen the listener or force remote auth.
  const config = parseServerConfig({}, {
    host: '127.0.0.1',
    port: 0,
    remoteEnabled: false,
    authToken: null,
    allowedOrigins: [],
    allowDevOrigin: false,
  })
  backend = await startServer({
    config,
    staticDir,
    installSignalHandlers: false,
  })

  const address = backend.server.address()
  if (!address || typeof address === 'string') {
    throw new Error('桌面服务未能取得本机监听端口')
  }
  return `http://127.0.0.1:${address.port}`
}

async function stopDesktopBackend(): Promise<void> {
  if (!backend || backendStopped) return
  const current = backend
  backend = null
  const result = await current.shutdown('electron_app_quit')
  backendStopped = true
  if (result.timedOut) {
    console.error('[Desktop] Backend shutdown reached its deadline')
  }
}

function createMainWindow(appUrl: string): BrowserWindow {
  const window = new BrowserWindow({
    title: `OpenConfigurator ${app.getVersion()}`,
    width: 1440,
    height: 900,
    minWidth: 1080,
    minHeight: 700,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !app.isPackaged,
    },
  })

  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternalUrl(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, targetUrl) => {
    if (targetUrl !== appUrl && !targetUrl.startsWith(`${appUrl}/`)) {
      event.preventDefault()
      openExternalUrl(targetUrl)
    }
  })
  window.once('ready-to-show', () => window.show())
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null
  })
  void window.loadURL(appUrl)
  return window
}

function handleBeforeQuit(event: ElectronEvent): void {
  if (!backend || backendStopped || quitAfterShutdown) return
  event.preventDefault()
  quitAfterShutdown = true
  void stopDesktopBackend()
    .catch((error) => console.error('[Desktop] Backend shutdown failed:', error))
    .finally(() => app.quit())
}

const ownsSingleInstance = app.requestSingleInstanceLock()
if (!ownsSingleInstance) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })
  app.on('before-quit', handleBeforeQuit)
  app.on('window-all-closed', () => app.quit())

  void app.whenReady().then(async () => {
    Menu.setApplicationMenu(null)
    try {
      const appUrl = await startDesktopBackend()
      mainWindow = createMainWindow(appUrl)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error('[Desktop] Startup failed:', error)
      dialog.showErrorBox('OpenConfigurator 启动失败', message)
      await stopDesktopBackend().catch(() => undefined)
      app.exit(1)
    }
  })
}
