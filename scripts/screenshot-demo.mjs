// One-off screenshot helper for README showcase images.
// Drives a headless Edge/Chrome over CDP: enables the ?demo=1 synthetic
// telemetry mode, switches the UI theme, waits for charts to fill, then
// captures docs/screenshots/*.png. Usage:
//   node scripts/screenshot-demo.mjs [light|dark] [baseUrl]
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import WebSocket from 'ws'

const THEME = process.argv[2] === 'dark' ? 'dark' : 'light'
const BASE = process.argv[3] ?? 'http://localhost:5174'
const OUT_DIR = resolve('docs/screenshots')
const PROFILE = resolve('.tmp-shot-profile')
const PORT = 9333

const BROWSERS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function findBrowser() {
  for (const path of BROWSERS) if (existsSync(path)) return path
  throw new Error('No Edge/Chrome executable found')
}

async function getPageTarget() {
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const targets = await res.json()
      const page = targets.find((t) => t.type === 'page')
      if (page) return page
    } catch { /* browser not ready yet */ }
    await sleep(500)
  }
  throw new Error('DevTools endpoint never came up')
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl, { maxPayload: 64 * 1024 * 1024 })
  let seq = 0
  const pending = new Map()
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString())
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)
    }
  })
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
  return new Promise((resolve, reject) => {
    ws.on('open', () => resolve({ send, close: () => ws.close() }))
    ws.on('error', reject)
  })
}

async function evaluate(cdp, expression) {
  const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true,
  })
  if (exceptionDetails) throw new Error(`page eval failed: ${exceptionDetails.text}`)
  return result?.value
}

async function shoot(cdp, name) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' })
  const file = resolve(OUT_DIR, `${name}.png`)
  writeFileSync(file, Buffer.from(data, 'base64'))
  console.log(`saved ${file}`)
}

async function gotoHash(cdp, hash, settleMs) {
  await evaluate(cdp, `location.hash = ${JSON.stringify(hash)}`)
  await sleep(settleMs)
}

const browser = await findBrowser()
mkdirSync(OUT_DIR, { recursive: true })
const proc = spawn(browser, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${PROFILE}`,
  '--window-size=1600,950',
  '--hide-scrollbars',
  '--no-first-run',
  '--disable-extensions',
  'about:blank',
], { stdio: 'ignore' })

try {
  const target = await getPageTarget()
  const cdp = await connect(target.webSocketDebuggerUrl)
  await cdp.send('Page.enable')
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1600, height: 950, deviceScaleFactor: 1, mobile: false,
  })

  // First load: seed theme before the app reads it, then reload with demo on.
  await cdp.send('Page.navigate', { url: `${BASE}/?demo=1#/dashboard` })
  await sleep(3000)
  await evaluate(cdp, `localStorage.setItem('mc-theme', ${JSON.stringify(THEME)})`)
  await cdp.send('Page.navigate', { url: `${BASE}/?demo=1#/dashboard` })
  await sleep(1000)
  await cdp.send('Page.reload')
  await sleep(6000)

  const theme = await evaluate(cdp, `document.documentElement.getAttribute('data-theme') ?? 'dark'`)
  const customVars = await evaluate(cdp, `document.querySelectorAll('.mc-dashboard-custom__list .mc-dashboard-health-card').length`)
  console.log(`theme=${theme} customBoardEntries=${customVars}`)
  if (theme !== THEME) throw new Error(`theme is ${theme}, expected ${THEME}`)
  await shoot(cdp, 'dashboard')

  await gotoHash(cdp, '#/flight', 4000)
  await shoot(cdp, 'flight')

  await gotoHash(cdp, '#/diagnostics', 4000)
  await shoot(cdp, 'diagnostics')

  // Waveform: drop the large-magnitude yaw channel and add climb so the
  // remaining curves share a comparable scale, then let samples accumulate.
  await gotoHash(cdp, '#/diagnostics?section=waveforms', 3000)
  const toggled = await evaluate(cdp, `(() => {
    const labels = [...document.querySelectorAll('label')]
    const click = (re) => {
      const label = labels.find((l) => re.test(l.textContent ?? ''))
      const box = label?.querySelector('input[type="checkbox"]')
      if (box) { box.click(); return true }
      return false
    }
    return { yaw: click(/Yaw\\s*\\(/), climb: click(/Climb\\s*\\(/) }
  })()`)
  console.log('waveform toggles:', JSON.stringify(toggled))
  await sleep(16000)
  await shoot(cdp, 'waveforms')

  await gotoHash(cdp, '#/settings', 4000)
  await shoot(cdp, 'settings')

  cdp.close()
} finally {
  proc.kill()
}
console.log('done')
