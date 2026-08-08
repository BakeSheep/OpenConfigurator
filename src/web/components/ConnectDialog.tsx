import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useConnectionStore } from '../stores/connectionStore'
import { BAUD_RATES, DEFAULT_BAUD_RATE } from '../../shared/constants'
import { getRestControlHeaders } from '../hooks/useWebSocket'
import { appRuntimeMode } from '../runtime'
import {
  loadConnectionPresets,
  samePresetDevice,
  saveConnectionPresets,
  type ConnectionPreset,
} from '../utils/connectionPresets'

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
  const { status, connectDialogOpen, serialPorts, bluetoothPorts, scanning, transportOpen, connectionError, setPorts, setScanning, setStatus, setConnectionError, setConnectDialogOpen, setActivePresetId } = useConnectionStore()
  const { t } = useTranslation()
  const [selectedPort, setSelectedPort] = useState('')
  const [baudRate, setBaudRate] = useState(DEFAULT_BAUD_RATE)
  const [connType, setConnType] = useState<'serial' | 'bluetooth'>('serial')
  const [pickedBt, setPickedBt] = useState<PickedPort | null>(null)
  const [selectedBtPort, setSelectedBtPort] = useState('')
  const [serialSupported, setSerialSupported] = useState<boolean | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Static demo preview: the dialog never renders and never touches /api or
  // navigator.serial - there is no backend and no real device to connect.
  const isDemo = appRuntimeMode === 'demo'

  // Auto-scan serial ports every time the dialog opens (the available port
  // set may change between opens, e.g. user plugged in a new device).
  useEffect(() => {
    if (connectDialogOpen && !isDemo) {
      scanPorts()
    }
    // scanPorts is stable enough for this purpose (only uses setState fns).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectDialogOpen, isDemo])

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
        setError(json.error || t('connect.scanFailed'))
      }
    } catch (err: any) {
      console.error('Scan failed:', err)
      setError(t('connect.scanFailedReason', { reason: err?.message || String(err) }))
    } finally {
      setScanning(false)
    }
  }

  const pickSerialPort = async () => {
    setError(null)
    if (!navigator.serial) {
      setError(t('connect.webSerialUnsupported'))
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
      let label = t('connect.bluetoothSerialDevice')
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
      setError(t('connect.serialSelectFailed', { reason: err?.message || String(err) }))
    }
  }

  const postConnect = async (body: any): Promise<void> => {
    setActivePresetId(null)
    setConnectionError(null)
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
        const reason = json?.error || (text ? `HTTP ${res.status}: ${text.slice(0, 200)}` : t('connect.httpNoResponse', { status: res.status }))
        const reasonText = typeof reason === 'string' ? reason : JSON.stringify(reason)
        setError(t('connect.connectFailed', { reason: reasonText }))
        setConnectionError(t('connect.connectFailed', { reason: reasonText }))
        return
      }
    } catch (e: any) {
      setStatus('error')
      setError(t('connect.connectFailed', { reason: e?.message || String(e) }))
      setConnectionError(t('connect.connectFailed', { reason: e?.message || String(e) }))
    }
  }

  const connect = async () => {
    setError(null)
    setConnectionError(null)
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
      if (!pickedBt) { setError(t('connect.selectPairedBtOrBrowser')); return }
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
    if (!selectedPort) { setError(t('connect.selectPort')); return }
    const selected = serialPorts.find((port) => port.path === selectedPort)
    await postConnect({
      type: 'serial',
      port: selectedPort,
      baudRate,
      vendorId: selected?.vendorId,
      productId: selected?.productId,
    })
  }

  const disconnect = async () => {
    setError(null)
    await fetch('/api/connections/disconnect', {
      method: 'POST',
      headers: getRestControlHeaders(),
    })
  }

  const saveAsPreset = () => {
    setError(null)
    let presetName = ''
    let presetPort = ''
    let presetType: 'serial' | 'bluetooth' = connType

    if (connType === 'bluetooth') {
      if (selectedBtPort) {
        const selected = bluetoothPorts.find((p) => p.path === selectedBtPort)
        presetPort = selectedBtPort
        presetName = selected?.friendlyName || selected?.manufacturer || selectedBtPort
      } else if (pickedBt) {
        presetPort = pickedBt.label
        presetName = pickedBt.label
      } else {
        setError(t('connect.selectBtDeviceFirst'))
        return
      }
    } else {
      if (!selectedPort) { setError(t('connect.selectPortFirst')); return }
      presetPort = selectedPort
      const portInfo = serialPorts.find((p) => p.path === selectedPort)
      presetName = portInfo?.manufacturer ? `${selectedPort} (${portInfo.manufacturer})` : selectedPort
    }

    const selectedSerial = connType === 'serial'
      ? serialPorts.find((port) => port.path === selectedPort)
      : undefined
    const preset: ConnectionPreset = {
      id: Date.now().toString(36),
      name: presetName,
      type: presetType,
      port: presetPort,
      baudRate,
      ...(selectedSerial?.vendorId ? { vendorId: selectedSerial.vendorId } : {}),
      ...(selectedSerial?.productId ? { productId: selectedSerial.productId } : {}),
    }
    const existing = loadConnectionPresets()
    const duplicate = existing.find((candidate) => samePresetDevice(candidate, preset))
    const updated = duplicate
      ? existing.map((candidate) => candidate.id === duplicate.id
        ? { ...preset, id: duplicate.id, enableGamepad: duplicate.enableGamepad }
        : candidate)
      : [...existing, preset]
    saveConnectionPresets(updated)
    setConnectDialogOpen(false)
  }

  if (!connectDialogOpen || isDemo) return null

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
              <h2 className="text-[15px] font-bold" style={{ color: 'var(--text-primary)' }}>{t('connect.title')}</h2>
              <p className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>{t('connect.subtitle')}</p>
            </div>
          </div>
          <button
            onClick={() => setConnectDialogOpen(false)}
            aria-label={t('common.close')}
            title={t('common.close')}
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
            {(['serial', 'bluetooth'] as const).map((type) => (
              <button
                key={type}
                onClick={() => { setConnType(type); setError(null) }}
                className="flex-1 py-2 rounded-lg text-[13px] font-medium transition-all flex items-center justify-center gap-1.5"
                style={
                  connType === type
                    ? { background: 'var(--bg-secondary)', color: 'var(--accent)', boxShadow: 'var(--card-shadow)' }
                    : { color: 'var(--text-secondary)' }
                }
              >
                {type === 'serial' ? (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 2v6" /><path d="M15 2v6" /><path d="M6 8h12l-1.5 6.5a3 3 0 0 1-2.93 2.5h-3.14a3 3 0 0 1-2.93-2.5z" /><path d="M12 17v5" /></svg>
                ) : (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m7 7 10 10-5 5V2l5 5L7 17" /></svg>
                )}
                {type === 'serial' ? t('connect.usbSerial') : t('connect.bluetooth')}
              </button>
            ))}
          </div>

          {/* Serial: port select */}
          {connType === 'serial' && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="mc-section-title">{t('connect.port')}</label>
                <button onClick={scanPorts} disabled={scanning} className="text-[12px] transition-colors disabled:opacity-50" style={{ color: 'var(--accent)' }}>
                  {scanning ? t('connect.scanning') : t('connect.refresh')}
                </button>
              </div>
              <select
                value={selectedPort}
                onChange={(e) => setSelectedPort(e.target.value)}
                className="mc-select"
              >
                <option value="">{t('connect.selectPortPlaceholder')}</option>
                {serialPorts.map((p) => (
                  <option key={p.path} value={p.path}>
                    {p.path}{p.manufacturer ? ` - ${p.manufacturer}` : ''}
                  </option>
                ))}
              </select>
              <div className="mt-4">
                <label className="mc-section-title block mb-2">{t('connect.baudRate')}</label>
                <select value={baudRate} onChange={(e) => setBaudRate(Number(e.target.value))} className="mc-select">
                  {BAUD_RATES.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
              </div>
            </div>
          )}

          {/* Bluetooth: Web Serial device chooser */}
          {connType === 'bluetooth' && (
            <div className="space-y-3">
              <label className="mc-section-title block">{t('connect.bluetoothDevice')}</label>
              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>{t('connect.pairedSppSerial')}</span>
                  <button onClick={scanPorts} disabled={scanning} className="text-[12px] disabled:opacity-50" style={{ color: 'var(--accent)' }}>
                    {scanning ? t('connect.scanning') : t('connect.refresh')}
                  </button>
                </div>
                <select
                  value={selectedBtPort}
                  onChange={(e) => { setSelectedBtPort(e.target.value); setPickedBt(null) }}
                  className="mc-select"
                >
                  <option value="">{t('connect.noBtSppFound')}</option>
                  {bluetoothPorts.map((p) => (
                    <option key={p.path} value={p.path}>
                      {p.path}{p.friendlyName ? ` · ${p.friendlyName}` : (p.manufacturer ? ` - ${p.manufacturer}` : '')}{p.recommended ? t('connect.recommended') : ''}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex items-center gap-3 text-[10px]" style={{ color: 'var(--text-disabled)' }}>
                <span className="h-px flex-1" style={{ background: 'var(--border)' }} />
                <span>{t('connect.compatModeHint')}</span>
                <span className="h-px flex-1" style={{ background: 'var(--border)' }} />
              </div>
              {serialSupported === false && (
                <div className="p-3 rounded-xl text-[12px]" style={{ background: 'var(--warning-dim)', color: 'var(--warning)', border: '1px solid rgba(245,158,11,.25)' }}>
                  {t('connect.webSerialUnsupportedLong')}
                </div>
              )}
              <button
                onClick={() => { setSelectedBtPort(''); void pickSerialPort() }}
                className="mc-btn mc-btn-ghost w-full py-3 justify-center"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m7 7 10 10-5 5V2l5 5L7 17" />
                </svg>
                {pickedBt ? t('connect.reselectDevice') : t('connect.selectBluetoothDevice')}
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
                {t('connect.btPairHint')}
              </p>
              <div>
                <label className="mc-section-title block mb-2">{t('connect.baudRate')}</label>
                <select value={baudRate} onChange={(e) => setBaudRate(Number(e.target.value))} className="mc-select">
                  {BAUD_RATES.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
              </div>
            </div>
          )}

          {/* Error */}
          {(error ?? connectionError) && (
            <div className="p-3 rounded-xl text-[12px]" style={{ background: 'var(--danger-dim)', color: 'var(--danger)', border: '1px solid rgba(239,68,68,.25)' }}>
              {error ?? connectionError}
            </div>
          )}

          {/* Status hint */}
          <p className="text-[11px] text-center" style={{ color: 'var(--text-disabled)' }}>
            {t('connect.supportedFcHint')}
          </p>
        </div>

        {/* Footer */}
        <div className="flex gap-3 px-5 py-4 border-t" style={{ borderColor: 'var(--border)' }}>
          <button onClick={() => setConnectDialogOpen(false)} className="mc-btn mc-btn-ghost flex-1 py-2.5">
            {t('connect.cancel')}
          </button>
          {transportOpen ? (
            <button onClick={disconnect} className="mc-btn mc-btn-danger flex-1 py-2.5">
              {t('connect.disconnect')}
            </button>
          ) : (
            <>
              <button
                onClick={saveAsPreset}
                disabled={status === 'connecting' || (connType === 'bluetooth' ? (!selectedBtPort && !pickedBt) : !selectedPort)}
                className="mc-btn mc-btn-ghost flex-1 py-2.5"
              >
                {t('connect.addToPreset')}
              </button>
              <button
                onClick={connect}
                disabled={status === 'connecting' || (connType === 'bluetooth' ? (!selectedBtPort && !pickedBt) : !selectedPort)}
                className="mc-btn mc-btn-primary flex-1 py-2.5"
              >
                {status === 'connecting' ? t('connect.connecting') : t('connect.connect')}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
