import { spawn } from 'node:child_process'
import { chromium } from '@playwright/test'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const vite = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url))
const origin = 'http://127.0.0.1:4175'
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

const preview = spawn(process.execPath, [
  vite, 'preview', '--host', '127.0.0.1', '--port', '4175', '--strictPort',
], {
  cwd: root,
  detached: process.platform !== 'win32',
  stdio: 'ignore',
})

async function waitForPreview() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (preview.exitCode !== null) throw new Error(`preview exited with code ${preview.exitCode}`)
    try {
      const response = await fetch(origin, { signal: AbortSignal.timeout(500) })
      if (response.ok) return
    } catch {
      // Not ready yet.
    }
    await delay(100)
  }
  throw new Error('production preview did not become ready')
}

try {
  await waitForPreview()
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    const requests = []
    page.on('request', (request) => {
      requests.push({
        method: request.method(),
        resourceType: request.resourceType(),
        url: request.url(),
      })
    })
    await page.goto(`${origin}/#/dashboard`, { waitUntil: 'networkidle' })
    await page.waitForTimeout(500)

    const violations = requests.filter((request) => {
      const url = new URL(request.url)
      return url.origin !== origin
        || !['GET', 'HEAD'].includes(request.method)
        || ['fetch', 'xhr', 'websocket', 'eventsource'].includes(request.resourceType)
    })
    if (violations.length) {
      throw new Error(`business or third-party network requests detected: ${JSON.stringify(violations)}`)
    }

    const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content')
    if (!csp?.includes("connect-src 'none'")) {
      throw new Error(`production CSP does not disable connections: ${csp ?? 'missing'}`)
    }
    console.log(`production network audit passed (${requests.length} same-origin static GET requests)`)
  } finally {
    await browser.close()
  }
} finally {
  if (preview.exitCode === null) {
    try {
      if (process.platform === 'win32') preview.kill()
      else process.kill(-preview.pid, 'SIGTERM')
    } catch {
      preview.kill()
    }
  }
}
