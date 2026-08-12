import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const viteCli = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url))
const playwrightCli = fileURLToPath(new URL('../node_modules/@playwright/test/cli.js', import.meta.url))
const healthUrl = 'http://127.0.0.1:4174/?demo=1#/dashboard'

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

async function serverAvailable() {
  try {
    const response = await fetch(healthUrl, { signal: AbortSignal.timeout(1_000) })
    return response.ok
  } catch {
    return false
  }
}

async function waitForServer(processHandle) {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (processHandle.exitCode !== null) {
      throw new Error(`Vite exited before becoming ready (code ${processHandle.exitCode})`)
    }
    if (await serverAvailable()) return
    await delay(100)
  }
  throw new Error('Timed out waiting for the UI test server')
}

async function stopServer(processHandle) {
  if (!processHandle || processHandle.exitCode !== null) return

  if (process.platform === 'win32') {
    // Playwright's taskkill-based webServer teardown can be denied by a
    // managed Windows shell and then wait forever for cmd.exe. Owning the
    // direct Vite process lets us close that exact PID deterministically.
    spawnSync('powershell.exe', [
      '-NoProfile',
      '-Command',
      `Stop-Process -Id ${processHandle.pid} -Force -ErrorAction SilentlyContinue`,
    ], {
      stdio: 'ignore',
      windowsHide: true,
    })
    await Promise.race([
      new Promise((resolve) => processHandle.once('exit', resolve)),
      delay(1_000),
    ])
    processHandle.unref()
    return
  }

  try {
    process.kill(-processHandle.pid, 'SIGTERM')
  } catch {
    processHandle.kill('SIGTERM')
  }
  await Promise.race([
    new Promise((resolve) => processHandle.once('exit', resolve)),
    delay(3_000),
  ])
  if (processHandle.exitCode === null) {
    try {
      process.kill(-processHandle.pid, 'SIGKILL')
    } catch {
      processHandle.kill('SIGKILL')
    }
  }
}

let viteProcess = null
let ownsServer = false

try {
  if (!(await serverAvailable())) {
    viteProcess = spawn(process.execPath, [
      viteCli,
      '--host', '127.0.0.1',
      '--port', '4174',
      '--strictPort',
    ], {
      cwd: projectRoot,
      stdio: 'ignore',
      windowsHide: true,
      detached: process.platform !== 'win32',
    })
    ownsServer = true
    await waitForServer(viteProcess)
  }

  const playwrightProcess = spawn(process.execPath, [
    playwrightCli,
    'test',
    ...process.argv.slice(2),
  ], {
    cwd: projectRoot,
    env: { ...process.env, PLAYWRIGHT_EXTERNAL_SERVER: '1' },
    stdio: 'inherit',
    windowsHide: true,
  })

  const exitCode = await new Promise((resolve, reject) => {
    playwrightProcess.once('error', reject)
    playwrightProcess.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)))
  })
  process.exitCode = exitCode
} finally {
  if (ownsServer) await stopServer(viteProcess)
}
