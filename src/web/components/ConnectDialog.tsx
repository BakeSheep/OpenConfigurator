import { useState, useEffect } from 'react'
import { useConnectionStore } from '../stores/connectionStore'
import { BAUD_RATES, DEFAULT_BAUD_RATE } from '../../shared/constants'
import { getRestControlHeaders } from '../hooks/useWebSocket'

// Convert decimal vendor/product id from Web Serial to the lowercase hex
// string format used by serialport's PortInfo (e.g. 1A86, 7523).
const toHexId = (n: number | undefined) =>
  n === undefined ? undefined : n.toString(16).toUpperCase().padStart(4, '0')

const formatBluetoothServiceId = (value: number | string | undefined) => {
  if (value === undefined) return undefined
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `0x${value.toString(16).toUpperCase().padStart(4, '0')}`
  }
  const text = String(value)
  const shortId = text.match(/^(?:0x)?([0-9a-f]{4})$/i)?.[1]
    || text.match(/^0000([0-9a-f]{4})-/i)?.[1]
  return shortId ? `0x${shortId.toUpperCase()}` : text
}

interface PickedPort {
  label: string
  // Identifiers used to match the browser-side pick to a backend COM port
  vendorId?: string
  productId?: string
  bluetoothServiceClassId?: string
}

export default function ConnectDialog() {
  const { status, connectDialogOpen, serialPorts, bluetoothPorts, scanning, setPorts, setScanning, setStatus, setConnectDialogOpen } = useConnectionStore()
  const [selectedPort, setSelectedPort] = useState('')
  const [baudRate, setBaudRate] = useState(DEFAULT_BAUD_RATE)
  const [connType, setConnType] = useState<'serial' | 'bluetooth'>('serial')
  const [pickedBt, setPickedBt] = useState<PickedPort | null>(null)
  const [selectedBtPort, setSelectedBtPort] = useState('')
  const [serialSupported, setSerialSupported] = useState<boolean | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Auto-scan serial ports every time the dialog opens (the available port
  // set may change between opens, e.g. user plugged in a new device).
  useEffect(() => {
    if (connectDialogOpen) {
      scanPorts()
    }
    // scanPorts is stable enough for this purpose (only uses setState fns).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectDialogOpen])

  // Check Web Serial support
  useEffect(() => {
    if (typeof navigator !== 'undefined') {
      setSerialSupported(!!navigator.serial)
    }
  }, [])

  // Close on Escape
  useEffect(() => {
    if (!connectDialogOpen) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setConnectDialogOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [connectDialogOpen, setConnectDialogOpen])

  const scanPorts = async () => {
    setScanning(true)
    try {
      const res = await fetch('/api/connections/scan')
      const json = await res.json()
      if (json.success) {
        const btPorts = json.data.bluetooth || []
        setPorts(json.data.serial, btPorts)
        setSelectedBtPort((current) => current || btPorts[0]?.path || '')
      } else {
        setError(json.error || '扫描端口失败')
      }
    } catch (err: any) {
      console.error('Scan failed:', err)
      setError(`扫描端口失败：${err?.message || String(err)}`)
    } finally {
      setScanning(false)
    }
  }

  const pickSerialPort = async () => {
    setError(null)
    if (!navigator.serial) {
      setError('当前浏览器不支持 Web Serial API，请使用 Chrome/Edge 89+（HTTPS 或 localhost）')
      return
    }
    try {
      // This pops up the browser-native "Connect to a serial port" chooser.
      const port = await navigator.serial.requestPort({
        // No filters - let the user pick any paired BT SPP device.
        // filters: [{ bluetoothServiceClassId: 0x1101 }]
      })
      const info = await port.getInfo()
      // Log full info for debugging the BT SPP <-> COM port matching
      console.log('[Connect] Web Serial picked port info:', info)
      const vid = toHexId(info.usbVendorId)
      const pid = toHexId(info.usbProductId)
      const btSvc = info.bluetoothServiceClassId
      const bt = formatBluetoothServiceId(btSvc)
      // Build a human-readable label
      let label = '蓝牙串口设备'
      if (vid && pid) label = `USB ${vid}:${pid}`
      else if (bt) label = `Bluetooth SPP ${bt}`
      setPickedBt({
        label,
        vendorId: vid,
        productId: pid,
        bluetoothServiceClassId: bt,
      })
    } catch (err: any) {
      if (err && err.name === 'NotFoundError') return // user cancelled
      console.error('Serial port selection failed:', err)
      setError(`串口选择失败：${err?.message || String(err)}`)
    }
  }

  const postConnect = async (body: any): Promise<void> => {
    setStatus('connecting')
    try {
      const res = await fetch('/api/connections/connect', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...getRestControlHeaders(),
        },
        body: JSON.stringify(body),
      })
      // Robust JSON parse - backend may return empty body on crash/hang
      const text = await res.text()
      let json: any = null
      if (text) {
        try { json = JSON.parse(text) } catch { /* not JSON */ }
      }
      if (!res.ok || !json || !json.success) {
        setStatus('error')
        const reason = json?.error || (text ? `HTTP ${res.status}: ${text.slice(0, 200)}` : `HTTP ${res.status} 无响应（后端可能已崩溃）`)
        setError(`连接失败：${reason}`)
        return
      }
    } catch (e: any) {
      setStatus('error')
      setError(`连接失败：${e?.message || String(e)}`)
    }
  }

  const connect = async () => {
    setError(null)
    if (connType === 'bluetooth') {
      if (selectedBtPort) {
        const selected = bluetoothPorts.find((port) => port.path === selectedBtPort)
        await postConnect({
          type: 'bluetooth',
          port: selectedBtPort,
          baudRate,
          vendorId: selected?.vendorId,
          productId: selected?.productId,
          bluetoothAddress: selected?.bluetoothAddress,
        })
        return
      }
      if (!pickedBt) { setError('请选择已配对的蓝牙串口，或使用浏览器选择器'); return }
      await postConnect({
        type: 'bluetooth',
        port: pickedBt.label,
        baudRate,
        vendorId: pickedBt.vendorId,
        productId: pickedBt.productId,
        bluetoothServiceClassId: pickedBt.bluetoothServiceClassId,
      })
      return
    }
    if (!selectedPort) { setError('请选择端口'); return }
    await postConnect({ type: 'serial', port: selectedPort, baudRate })
  }

  const disconnect = async () => {
    // Clear any lingering error so a previous failure does not persist across
    // reconnect cycles (the dialog may stay open and show a stale error).
    setError(null)
    await fetch('/api/connections/disconnect', {
      method: 'POST',
      headers: getRestControlHeaders(),
    })
  }

  if (!connectDialogOpen) return null

  const connected = status === 'connected'

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 mc-animate-fade"
      style={{ background: 'rgba(0,0,0,.6)', backdropFilter: 'blur(4px)' }}
      onClick={() => setConnectDialogOpen(false)}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[400px] mc-animate-scale overflow-hidden flex flex-col"
        style={{
          background: 'var(--bg-secondary)',
          border: '1px solid var(--border-hover)',
          borderRadius: 'var(--radius-lg)',
          boxShadow: '0 24px 64px rgba(0,0,0,.5)',
        }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b" style={{ borderColor: 'var(--border)' }}>
          <div className="flex items-center gap-3">
            <div
              className="w-8 h-8 rounded-lg flex items-center justify-center"
              style={{ background: 'var(--accent-dim)' }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 2v6" /><path d="M15 2v6" /><path d="M6 8h12l-1.5 6.5a3 3 0 0 1-2.93 2.5h-3.14a3 3 0 0 1-2.93-2.5z" /><path d="M12 17v5" />
              </svg>
            </div>
            <div>
              <h2 className="text-[15px] font-bold" style={{ color: 'var(--text-primary)' }}>连接飞控</h2>
              <p className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>选择端口并建立连接</p>
            </div>
          </div>
          <button
            onClick={() => setConnectDialogOpen(false)}
            className="w-8 h-8 rounded-lg flex items-center justify-center transition-colors hover:bg-white/5"
            style={{ color: 'var(--text-secondary)' }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-5 space-y-5">
          {/* Type toggle */}
          <div className="flex p-1 rounded-xl gap-1" style={{ background: 'var(--bg-tertiary)' }}>
            {(['serial', 'bluetooth'] as const).map((t) => (
              <button
                key={t}
                onClick={() => { setConnType(t); setError(null) }}
                className="flex-1 py-2 rounded-lg text-[13px] font-medium transition-all flex items-center justify-center gap-1.5"
                style={
                  connType === t
                    ? { background: 'var(--bg-secondary)', color: 'var(--accent)', boxShadow: 'var(--card-shadow)' }
                    : { color: 'var(--text-secondary)' }
                }
              >
                {t === 'serial' ? (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 2v6" /><path d="M15 2v6" /><path d="M6 8h12l-1.5 6.5a3 3 0 0 1-2.93 2.5h-3.14a3 3 0 0 1-2.93-2.5z" /><path d="M12 17v5" /></svg>
                ) : (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m7 7 10 10-5 5V2l5 5L7 17" /></svg>
                )}
                {t === 'serial' ? 'USB 串口' : '蓝牙'}
              </button>
            ))}
          </div>

          {/* Serial: port select */}
          {connType === 'serial' && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="mc-section-title">端口</label>
                <button onClick={scanPorts} disabled={scanning} className="text-[12px] transition-colors disabled:opacity-50" style={{ color: 'var(--accent)' }}>
                  {scanning ? '扫描中…' : '刷新'}
                </button>
              </div>
              <select
                value={selectedPort}
                onChange={(e) => setSelectedPort(e.target.value)}
                className="mc-select"
              >
                <option value="">选择端口…</option>
                {serialPorts.map((p) => (
                  <option key={p.path} value={p.path}>
                    {p.path}{p.manufacturer ? ` - ${p.manufacturer}` : ''}
                  </option>
                ))}
              </select>
              <div className="mt-4">
                <label className="mc-section-title block mb-2">波特率</label>
                <select value={baudRate} onChange={(e) => setBaudRate(Number(e.target.value))} className="mc-select">
                  {BAUD_RATES.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
              </div>
            </div>
          )}

          {/* Bluetooth: Web Serial device chooser */}
          {connType === 'bluetooth' && (
            <div className="space-y-3">
              <label className="mc-section-title block">蓝牙设备</label>
              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>已配对的 SPP 串口</span>
                  <button onClick={scanPorts} disabled={scanning} className="text-[12px] disabled:opacity-50" style={{ color: 'var(--accent)' }}>
                    {scanning ? '扫描中…' : '刷新'}
                  </button>
                </div>
                <select
                  value={selectedBtPort}
                  onChange={(e) => { setSelectedBtPort(e.target.value); setPickedBt(null) }}
                  className="mc-select"
                >
                  <option value="">未发现蓝牙 SPP 串口</option>
                  {bluetoothPorts.map((p) => (
                    <option key={p.path} value={p.path}>
                      {p.path}{p.friendlyName ? ` · ${p.friendlyName}` : (p.manufacturer ? ` - ${p.manufacturer}` : '')}{p.recommended ? '（推荐）' : ''}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex items-center gap-3 text-[10px]" style={{ color: 'var(--text-disabled)' }}>
                <span className="h-px flex-1" style={{ background: 'var(--border)' }} />
                <span>未扫描到时使用兼容模式</span>
                <span className="h-px flex-1" style={{ background: 'var(--border)' }} />
              </div>
              {serialSupported === false && (
                <div className="p-3 rounded-xl text-[12px]" style={{ background: 'var(--warning-dim)', color: 'var(--warning)', border: '1px solid rgba(245,158,11,.25)' }}>
                  当前浏览器不支持 Web Serial。请使用 Chrome/Edge 89+，且页面需通过 HTTPS 或 localhost 访问。
                </div>
              )}
              <button
                onClick={() => { setSelectedBtPort(''); void pickSerialPort() }}
                className="mc-btn mc-btn-ghost w-full py-3 justify-center"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m7 7 10 10-5 5V2l5 5L7 17" />
                </svg>
                {pickedBt ? '重新选择设备' : '选择蓝牙设备'}
              </button>
              {pickedBt && (
                <div
                  className="p-3 rounded-xl flex items-center gap-2"
                  style={{ background: 'var(--accent-dim)', border: '1px solid rgba(59,130,246,.25)' }}
                >
                  <span
                    className="rounded-full shrink-0"
                    style={{ width: 8, height: 8, background: 'var(--accent)', boxShadow: '0 0 6px var(--accent-glow)' }}
                  />
                  <span className="text-[13px] mc-mono truncate" style={{ color: 'var(--text-primary)' }}>{pickedBt.label}</span>
                </div>
              )}
              <p className="text-[11px]" style={{ color: 'var(--text-disabled)' }}>
                建议先在 Windows 蓝牙设置中完成配对，并选择上方的出站 COM 口。浏览器选择器仅作为兼容回退。
              </p>
              <div>
                <label className="mc-section-title block mb-2">波特率</label>
                <select value={baudRate} onChange={(e) => setBaudRate(Number(e.target.value))} className="mc-select">
                  {BAUD_RATES.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
              </div>
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="p-3 rounded-xl text-[12px]" style={{ background: 'var(--danger-dim)', color: 'var(--danger)', border: '1px solid rgba(239,68,68,.25)' }}>
              {error}
            </div>
          )}

          {/* Status hint */}
          <p className="text-[11px] text-center" style={{ color: 'var(--text-disabled)' }}>
            支持 Pixhawk / CubePilot / MicoAir 等 ArduPilot/PX4 飞控
          </p>
        </div>

        {/* Footer */}
        <div className="flex gap-3 px-5 py-4 border-t" style={{ borderColor: 'var(--border)' }}>
          <button onClick={() => setConnectDialogOpen(false)} className="mc-btn mc-btn-ghost flex-1 py-2.5">
            取消
          </button>
          {connected ? (
            <button onClick={disconnect} className="mc-btn mc-btn-danger flex-1 py-2.5">
              断开连接
            </button>
          ) : (
            <button
              onClick={connect}
              disabled={status === 'connecting' || (connType === 'bluetooth' ? (!selectedBtPort && !pickedBt) : !selectedPort)}
              className="mc-btn mc-btn-primary flex-1 py-2.5"
            >
              {status === 'connecting' ? '连接中…' : '连接'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
