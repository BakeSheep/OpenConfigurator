import { useCallback, useEffect, useId, useState, type KeyboardEvent } from 'react'
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
import { Button } from './ui/Button'
import Dialog from './ui/Dialog'
import Field from './ui/Field'

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

const CONNECTION_TYPES = ['serial', 'bluetooth'] as const
type ConnectionType = typeof CONNECTION_TYPES[number]

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
  const [connType, setConnType] = useState<ConnectionType>('serial')
  const [pickedBt, setPickedBt] = useState<PickedPort | null>(null)
  const [selectedBtPort, setSelectedBtPort] = useState('')
  const [serialSupported, setSerialSupported] = useState<boolean | null>(null)
  const [error, setError] = useState<string | null>(null)
  const serialPortId = useId()
  const serialBaudRateId = useId()
  const bluetoothPortId = useId()
  const bluetoothBaudRateId = useId()
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

  const closeDialog = useCallback(() => {
    setConnectDialogOpen(false)
  }, [setConnectDialogOpen])

  const selectConnectionType = (type: ConnectionType) => {
    setConnType(type)
    setError(null)
  }

  const handleConnectionTypeKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    currentIndex: number,
  ) => {
    let nextIndex: number | null = null
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      nextIndex = (currentIndex + 1) % CONNECTION_TYPES.length
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      nextIndex = (currentIndex - 1 + CONNECTION_TYPES.length) % CONNECTION_TYPES.length
    } else if (event.key === 'Home') {
      nextIndex = 0
    } else if (event.key === 'End') {
      nextIndex = CONNECTION_TYPES.length - 1
    }
    if (nextIndex === null) return

    event.preventDefault()
    selectConnectionType(CONNECTION_TYPES[nextIndex])
    const radios = event.currentTarget
      .closest('[role="radiogroup"]')
      ?.querySelectorAll<HTMLButtonElement>('[role="radio"]')
    radios?.[nextIndex]?.focus()
  }

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
        const reason = json?.error?.message
          ?? json?.error
          ?? (text ? `HTTP ${res.status}: ${text.slice(0, 200)}` : t('connect.httpNoResponse', { status: res.status }))
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
          bluetoothChannel: selected?.bluetoothChannel,
          bluetoothServiceClassId: selected?.bluetoothServiceClassId,
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
    const selectedBluetooth = connType === 'bluetooth' && selectedBtPort
      ? bluetoothPorts.find((port) => port.path === selectedBtPort)
      : undefined
    const preset: ConnectionPreset = {
      id: Date.now().toString(36),
      name: presetName,
      type: presetType,
      port: presetPort,
      baudRate,
      ...(selectedSerial?.vendorId ? { vendorId: selectedSerial.vendorId } : {}),
      ...(selectedSerial?.productId ? { productId: selectedSerial.productId } : {}),
      ...(selectedBluetooth?.vendorId ? { vendorId: selectedBluetooth.vendorId } : {}),
      ...(selectedBluetooth?.productId ? { productId: selectedBluetooth.productId } : {}),
      ...(selectedBluetooth?.bluetoothAddress
        ? { bluetoothAddress: selectedBluetooth.bluetoothAddress }
        : {}),
      ...(selectedBluetooth?.bluetoothChannel
        ? { bluetoothChannel: selectedBluetooth.bluetoothChannel }
        : {}),
      ...(selectedBluetooth?.bluetoothServiceClassId
        ? { bluetoothServiceClassId: selectedBluetooth.bluetoothServiceClassId }
        : pickedBt?.bluetoothServiceClassId
          ? { bluetoothServiceClassId: pickedBt.bluetoothServiceClassId }
          : {}),
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

  if (isDemo) return null

  const connectionUnavailable = status === 'connecting'
    || (connType === 'bluetooth' ? (!selectedBtPort && !pickedBt) : !selectedPort)

  const serialIcon = (
    <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 2v6" /><path d="M15 2v6" /><path d="M6 8h12l-1.5 6.5a3 3 0 0 1-2.93 2.5h-3.14a3 3 0 0 1-2.93-2.5z" /><path d="M12 17v5" />
    </svg>
  )
  const bluetoothIcon = (
    <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m7 7 10 10-5 5V2l5 5L7 17" />
    </svg>
  )

  return (
    <Dialog
      open={connectDialogOpen}
      title={t('connect.title')}
      description={t('connect.subtitle')}
      closeLabel={t('common.close')}
      onClose={closeDialog}
      className="max-w-[440px]"
      footer={(
        <>
          <Button onClick={closeDialog} tone="secondary" size="default" className="flex-1">
            {t('connect.cancel')}
          </Button>
          {transportOpen ? (
            <Button onClick={disconnect} tone="danger" size="default" className="flex-1">
              {t('connect.disconnect')}
            </Button>
          ) : (
            <>
              <Button
                onClick={saveAsPreset}
                disabled={connectionUnavailable}
                tone="secondary"
                size="default"
                className="flex-1"
              >
                {t('connect.addToPreset')}
              </Button>
              <Button
                onClick={connect}
                disabled={connectionUnavailable}
                loading={status === 'connecting'}
                tone="primary"
                size="default"
                className="flex-1"
              >
                {status === 'connecting' ? t('connect.connecting') : t('connect.connect')}
              </Button>
            </>
          )}
        </>
      )}
    >
      <div className="space-y-5">
        <div
          className="mc-tabbar"
          role="radiogroup"
          aria-label={t('connect.connectionType')}
        >
          {CONNECTION_TYPES.map((type, index) => (
            <Button
              key={type}
              role="radio"
              aria-checked={connType === type}
              tabIndex={connType === type ? 0 : -1}
              onClick={() => selectConnectionType(type)}
              onKeyDown={(event) => handleConnectionTypeKeyDown(event, index)}
              tone={connType === type ? 'secondary' : 'quiet'}
              leadingIcon={type === 'serial' ? serialIcon : bluetoothIcon}
              className="flex-1"
            >
              {type === 'serial' ? t('connect.usbSerial') : t('connect.bluetooth')}
            </Button>
          ))}
        </div>

        {connType === 'serial' && (
          <div className="space-y-4">
            <Field label={t('connect.port')} controlId={serialPortId}>
              <div className="flex items-center gap-2">
                <select
                  id={serialPortId}
                  data-autofocus
                  value={selectedPort}
                  onChange={(event) => setSelectedPort(event.target.value)}
                  className="mc-select min-w-0 flex-1"
                >
                  <option value="">{t('connect.selectPortPlaceholder')}</option>
                  {serialPorts.map((port) => (
                    <option key={port.path} value={port.path}>
                      {port.path}{port.manufacturer ? ` - ${port.manufacturer}` : ''}
                    </option>
                  ))}
                </select>
                <Button onClick={scanPorts} disabled={scanning} tone="quiet" aria-live="polite">
                  {scanning ? t('connect.scanning') : t('connect.refresh')}
                </Button>
              </div>
            </Field>
            <Field label={t('connect.baudRate')} controlId={serialBaudRateId}>
              <select
                id={serialBaudRateId}
                value={baudRate}
                onChange={(event) => setBaudRate(Number(event.target.value))}
                className="mc-select"
              >
                {BAUD_RATES.map((rate) => <option key={rate} value={rate}>{rate}</option>)}
              </select>
            </Field>
          </div>
        )}

        {connType === 'bluetooth' && (
          <div className="space-y-4">
            <Field
              label={t('connect.bluetoothDevice')}
              controlId={bluetoothPortId}
              helper={t('connect.btPairHint')}
            >
              <div className="flex items-center gap-2">
                <select
                  id={bluetoothPortId}
                  data-autofocus
                  value={selectedBtPort}
                  onChange={(event) => { setSelectedBtPort(event.target.value); setPickedBt(null) }}
                  className="mc-select min-w-0 flex-1"
                  aria-describedby={`${bluetoothPortId}-helper`}
                >
                  <option value="">{t('connect.noBtSppFound')}</option>
                  {bluetoothPorts.map((port) => (
                    <option key={port.path} value={port.path}>
                      {port.friendlyName
                        ? `${port.friendlyName} · ${port.bluetoothAddress ?? port.path}`
                        : `${port.path}${port.manufacturer ? ` - ${port.manufacturer}` : ''}`}
                      {port.recommended ? t('connect.recommended') : ''}
                    </option>
                  ))}
                </select>
                <Button onClick={scanPorts} disabled={scanning} tone="quiet" aria-live="polite">
                  {scanning ? t('connect.scanning') : t('connect.refresh')}
                </Button>
              </div>
            </Field>

            <div className="flex items-center gap-3 text-[11px]" style={{ color: 'var(--text-secondary)' }} aria-hidden="true">
              <span className="h-px flex-1" style={{ background: 'var(--border)' }} />
              <span>{t('connect.compatModeHint')}</span>
              <span className="h-px flex-1" style={{ background: 'var(--border)' }} />
            </div>

            {serialSupported === false && (
              <div className="mc-notice" data-tone="warning" role="status">
                <div className="mc-notice__content">{t('connect.webSerialUnsupportedLong')}</div>
              </div>
            )}

            <Button
              onClick={() => { setSelectedBtPort(''); void pickSerialPort() }}
              tone="secondary"
              size="default"
              leadingIcon={bluetoothIcon}
              className="w-full"
            >
              {pickedBt ? t('connect.reselectDevice') : t('connect.selectBluetoothDevice')}
            </Button>

            {pickedBt && (
              <div className="mc-notice" data-tone="info" role="status">
                <span
                  className="mt-1 h-2 w-2 shrink-0 rounded-full"
                  style={{ background: 'var(--accent)' }}
                  aria-hidden="true"
                />
                <div className="mc-notice__content mc-mono truncate">{pickedBt.label}</div>
              </div>
            )}

            <Field label={t('connect.baudRate')} controlId={bluetoothBaudRateId}>
              <select
                id={bluetoothBaudRateId}
                value={baudRate}
                onChange={(event) => setBaudRate(Number(event.target.value))}
                className="mc-select"
              >
                {BAUD_RATES.map((rate) => <option key={rate} value={rate}>{rate}</option>)}
              </select>
            </Field>
          </div>
        )}

        {(error ?? connectionError) && (
          <div className="mc-notice" data-tone="danger" role="alert" aria-live="assertive">
            <div className="mc-notice__content">{error ?? connectionError}</div>
          </div>
        )}

        <p className="m-0 text-center text-[11px]" style={{ color: 'var(--text-secondary)' }}>
          {t('connect.supportedFcHint')}
        </p>
      </div>
    </Dialog>
  )
}
