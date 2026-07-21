import express from 'express'
import cors from 'cors'
import { WebSocketServer, WebSocket } from 'ws'
import { createServer } from 'http'
import path from 'path'
import { fileURLToPath } from 'url'
import { ConnectionManager } from './connection/ConnectionManager'
import { MavlinkBridge } from './mavlink/MavlinkBridge'
import type { ClientMessage } from '../shared/types'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()
const server = createServer(app)
const wss = new WebSocketServer({ server, path: '/ws' })

app.use(cors())
app.use(express.json())

// Serve static files in production
const distPath = path.resolve(__dirname, '../../dist')
app.use(express.static(distPath))

// Core services
const connManager = new ConnectionManager()
const mavlinkBridge = new MavlinkBridge(connManager)

// Broadcast to all WebSocket clients. A slow/stalled client could otherwise
// grow backend RSS without bound: MAVLink telemetry at 10+ Hz keeps calling
// client.send() and buffering unsent frames per client. Drop clients whose
// buffered amount exceeds 1 MB so a single stuck browser cannot starve others.
const MAX_BUFFERED_AMOUNT = 1 * 1024 * 1024
function broadcast(data: any) {
  const msg = JSON.stringify(data)
  wss.clients.forEach((client) => {
    if (client.readyState !== WebSocket.OPEN) return
    if (client.bufferedAmount > MAX_BUFFERED_AMOUNT) {
      console.warn('[WS] Dropping slow client: bufferedAmount=' + client.bufferedAmount)
      client.close(1011, 'backend backpressure: client too slow')
      return
    }
    client.send(msg)
  })
}

// Forward MAVLink messages to WebSocket clients
mavlinkBridge.on('message', (msg) => {
  broadcast(msg)
})

// Forward connection status changes
connManager.on('statusChange', (status) => {
  broadcast({
    type: 'connection',
    data: {
      connected: status === 'connected',
      port: connManager.config?.port,
      type: connManager.config?.type,
    },
  })
})

// EventEmitter treats an unhandled event named "error" as fatal. Connection
// errors are reported to clients without terminating the backend process.
connManager.on('connectionError', (error: Error) => {
  console.error('[Connection] runtime error:', error.message)
})

// WebSocket connection handling
wss.on('connection', (ws) => {
  console.log('[WS] Client connected')

  // Send current connection status
  ws.send(JSON.stringify({
    type: 'connection',
    data: {
      connected: connManager.status === 'connected',
      port: connManager.config?.port,
      type: connManager.config?.type,
    },
  }))

  ws.on('message', (raw) => {
    try {
      const msg: ClientMessage = JSON.parse(raw.toString())
      mavlinkBridge.handleClientMessage(msg)
    } catch (err) {
      console.error('[WS] Invalid message:', err)
    }
  })

  ws.on('close', () => {
    console.log('[WS] Client disconnected')
  })
})

// REST API: Connection management
app.get('/api/connections/scan', async (_req, res) => {
  try {
    const ports = await connManager.scanPorts()
    res.json({ success: true, data: ports })
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message })
  }
})

// Diagnostic endpoint: list ALL serial ports with full metadata for debugging
// the browser-side Web Serial pick -> backend COM port matching.
app.get('/api/connections/debug-ports', async (_req, res) => {
  try {
    const { SerialPort } = await import('serialport')
    const ports = await SerialPort.list()
    res.json({
      success: true,
      data: ports.map((p) => ({
        path: p.path,
        manufacturer: p.manufacturer,
        vendorId: p.vendorId,
        productId: p.productId,
        pnpId: p.pnpId,
      })),
    })
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message })
  }
})

app.post('/api/connections/connect', async (req, res) => {
  try {
    const { type, port, baudRate, vendorId, productId, bluetoothServiceClassId } = req.body || {}
    console.log('[API] connect request:', { type, port, baudRate, vendorId, productId, bluetoothServiceClassId })
    if (!type || !port) {
      return res.status(400).json({ success: false, error: '缺少 type 或 port 参数' })
    }
    await connManager.connect({ type, port, baudRate, vendorId, productId, bluetoothServiceClassId })
    res.json({ success: true })
  } catch (err: any) {
    console.error('[API] connect failed:', err)
    res.status(500).json({ success: false, error: err?.message || String(err) })
  }
})

app.post('/api/connections/disconnect', async (_req, res) => {
  try {
    await connManager.disconnect()
    res.json({ success: true })
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message })
  }
})

app.get('/api/connections/status', (_req, res) => {
  res.json({
    success: true,
    data: {
      status: connManager.status,
      config: connManager.config,
    },
  })
})

// SPA fallback
app.get('/{*splat}', (_req, res) => {
  res.sendFile(path.join(distPath, 'index.html'))
})

const PORT = 3000
server.listen(PORT, () => {
  console.log(`[Server] PX4 Web GCS running at http://localhost:${PORT}`)
  console.log(`[Server] WebSocket at ws://localhost:${PORT}/ws`)
})
