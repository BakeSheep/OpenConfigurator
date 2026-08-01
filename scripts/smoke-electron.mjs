import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import process from 'node:process'
import { WebSocket } from 'ws'

const executable = path.resolve(
  process.argv[2] ?? 'release/win-unpacked/OpenConfigurator.exe',
)
const screenshotPath = process.argv[3] ? path.resolve(process.argv[3]) : null

async function freePort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Unable to reserve a debug port')
  await new Promise((resolve) => server.close(resolve))
  return address.port
}

async function retry(operation, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      return await operation()
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  }
  throw lastError ?? new Error('Timed out')
}

function connectCdp(url) {
  const socket = new WebSocket(url)
  let nextId = 0
  const pending = new Map()
  const listeners = new Map()

  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString())
    if (message.id) {
      const waiter = pending.get(message.id)
      if (!waiter) return
      pending.delete(message.id)
      if (message.error) waiter.reject(new Error(message.error.message))
      else waiter.resolve(message.result)
      return
    }
    for (const listener of listeners.get(message.method) ?? []) listener(message.params)
  })

  return {
    async open() {
      await new Promise((resolve, reject) => {
        socket.once('open', resolve)
        socket.once('error', reject)
      })
    },
    send(method, params = {}) {
      const id = ++nextId
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        socket.send(JSON.stringify({ id, method, params }))
      })
    },
    notify(method, params = {}) {
      socket.send(JSON.stringify({ id: ++nextId, method, params }))
    },
    once(method) {
      return new Promise((resolve) => {
        const listener = (params) => {
          const current = listeners.get(method) ?? []
          listeners.set(method, current.filter((candidate) => candidate !== listener))
          resolve(params)
        }
        listeners.set(method, [...(listeners.get(method) ?? []), listener])
      })
    },
    on(method, listener) {
      listeners.set(method, [...(listeners.get(method) ?? []), listener])
    },
    close() {
      socket.close()
    },
  }
}

const debugPort = await freePort()
const child = spawn(executable, [`--remote-debugging-port=${debugPort}`], {
  stdio: 'ignore',
  windowsHide: true,
})
let client = null

try {
  const targets = await retry(async () => {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`)
    if (!response.ok) throw new Error(`DevTools endpoint returned ${response.status}`)
    const entries = await response.json()
    if (!entries.some((entry) => entry.type === 'page')) throw new Error('No page target yet')
    return entries
  })
  const target = targets.find((entry) => entry.type === 'page')
  client = connectCdp(target.webSocketDebuggerUrl)
  await client.open()

  const exceptions = []
  const consoleErrors = []
  const failedRequests = []
  const errorResponses = []
  client.on('Runtime.exceptionThrown', ({ exceptionDetails }) => {
    exceptions.push(exceptionDetails.exception?.description ?? exceptionDetails.text)
  })
  client.on('Runtime.consoleAPICalled', ({ type, args }) => {
    if (type === 'error') consoleErrors.push(args.map((arg) => arg.value ?? arg.description).join(' '))
  })
  client.on('Network.loadingFailed', ({ errorText, type, canceled }) => {
    if (!canceled) failedRequests.push({ errorText, type })
  })
  client.on('Network.responseReceived', ({ response, type }) => {
    if (response.status >= 400) errorResponses.push({ url: response.url, status: response.status, type })
  })
  await client.send('Runtime.enable')
  await client.send('Page.enable')
  await client.send('Network.enable')
  const loaded = client.once('Page.loadEventFired')
  await client.send('Page.reload', { ignoreCache: true })
  await loaded
  await new Promise((resolve) => setTimeout(resolve, 1_000))

  const evaluation = await client.send('Runtime.evaluate', {
    expression: `(() => ({
      title: document.title,
      readyState: document.readyState,
      rootChildren: document.querySelector('#root')?.childElementCount ?? -1,
      bodyText: document.body.innerText.slice(0, 300),
      scripts: [...document.scripts].map((script) => script.src || '<inline>'),
      resources: performance.getEntriesByType('resource').map((entry) => ({
        name: entry.name,
        transferSize: entry.transferSize,
        duration: entry.duration,
      })),
    }))()`,
    returnByValue: true,
  })
  const page = evaluation.result.value
  if (screenshotPath) {
    const screenshot = await client.send('Page.captureScreenshot', { format: 'png' })
    await mkdir(path.dirname(screenshotPath), { recursive: true })
    await writeFile(screenshotPath, Buffer.from(screenshot.data, 'base64'))
  }
  const report = {
    executable,
    url: target.url,
    page,
    screenshotPath,
    exceptions,
    consoleErrors,
    failedRequests,
    errorResponses,
  }
  console.log(JSON.stringify(report, null, 2))

  const unexpectedConsoleErrors = consoleErrors.filter((message) => (
    !message.includes('Electron sandboxed_renderer.bundle.js script failed to run')
    && !message.includes("binding.startupData' as it is null")
  ))
  if (page.rootChildren < 1) throw new Error('Electron renderer did not mount the React application')
  if (exceptions.length > 0) throw new Error('Electron renderer raised a runtime exception')
  if (failedRequests.length > 0 || errorResponses.length > 0) {
    throw new Error('Electron renderer failed to load one or more resources')
  }
  if (unexpectedConsoleErrors.length > 0) throw new Error('Electron renderer logged an application error')
} finally {
  if (client) {
    client.notify('Browser.close')
    await new Promise((resolve) => setTimeout(resolve, 300))
    client.close()
  }
  if (!child.killed) child.kill()
}
