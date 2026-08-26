import { useCallback, useEffect, useId, useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useConnectionStore } from '../stores/connectionStore'
import { BAUD_RATES, DEFAULT_BAUD_RATE } from '../../shared/constants'
import { appRuntimeMode } from '../runtime'
import { localRuntime } from '../runtime/LocalRuntimeClient'
import type { BrowserPortDescriptor } from '../../shared/localRuntime'
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
// string format used by Web Serial device info (e.g. 1A86, 7523).
const toHexId = (n: number | undefined) =>
  n === undefined ? undefined : n.toString(16).toUpperCase().padStart(4, '0')

const CONNECTION_TYPES = ['serial', 'bluetooth'] as const
type ConnectionType = typeof CONNECTION_TYPES[number]

export default function ConnectDialog() {
  const { status, connectDialogOpen, serialPorts, bluetoothPorts, scanning, transportOpen, connectionError, setPorts, setScanning, setStatus, setConnectionError, setConnectDialogOpen, setActivePresetId } = useConnectionStore()
  const { t } = useTranslation()
  const [selectedPort, setSelectedPort] = useState('')
  const [baudRate, setBaudRate] = useState(DEFAULT_BAUD_RATE)
  const [connType, setConnType] = useState<ConnectionType>('serial')
  const [pickedBt, setPickedBt] = useState<BrowserPortDescriptor | null>(null)
  const [selectedBtPort, setSelectedBtPort] = useState('')
  const [protocol, setProtocol] = useState<'auto' | 'v1' | 'v2'>('auto')
  const [signingSecret, setSigningSecret] = useState('')
  const [signingLinkId, setSigningLinkId] = useState(0)
  const [serialSupported, setSerialSupported] = useState<boolean | null>(null)
  const [error, setError] = useState<string | null>(null)
  const serialPortId = useId()
  const serialBaudRateId = useId()
  const bluetoothPortId = useId()
  const bluetoothBaudRateId = useId()
  // Static demo preview: the dialog never renders and never opens a local port or
  // navigator.serial; demo mode has no real device to connect.
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
      const descriptors = await localRuntime.listPorts()
      const ports = descriptors.map((descriptor) => ({
        path: descriptor.id,
        friendlyName: descriptor.label,
        manufacturer: descriptor.label,
        vendorId: descriptor.usbVendorId === undefined ? undefined : toHexId(descriptor.usbVendorId),
        productId: descriptor.usbProductId === undefined ? undefined : toHexId(descriptor.usbProductId),
        bluetoothServiceClassId: descriptor.bluetoothServiceClassId,
      }))
      const bluetooth = ports.filter((port) => Boolean(port.bluetoothServiceClassId))
      const serial = ports.filter((port) => !port.bluetoothServiceClassId)
      setPorts(serial, bluetooth)
      setSelectedPort((current) => current || serial[0]?.path || '')
      setSelectedBtPort((current) => current || bluetooth[0]?.path || '')
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
      const descriptor = await localRuntime.requestPort()
      setPickedBt(descriptor)
      await scanPorts()
      if (descriptor.bluetoothServiceClassId) {
        setConnType('bluetooth')
        setSelectedBtPort(descriptor.id)
      } else {
        setConnType('serial')
        setSelectedPort(descriptor.id)
      }
    } catch (err: any) {
      if (err && err.name === 'NotFoundError') return // user cancelled
      console.error('Serial port selection failed:', err)
      setError(t('connect.serialSelectFailed', { reason: err?.message || String(err) }))
    }
  }

  const postConnect = async (portId: string, type: ConnectionType): Promise<void> => {
    setActivePresetId(null)
    setConnectionError(null)
    setStatus('connecting')
    try {
      await localRuntime.connect({
        portId,
        type,
        baudRate,
        protocol,
        ...(signingSecret ? {
          signing: {
            secret: signingSecret,
            linkId: signingLinkId,
            requireSigned: true,
            allowStaleFirstPacket: false,
          },
        } : {}),
      })
      setSigningSecret('')
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
        await postConnect(selectedBtPort, 'bluetooth')
        return
      }
      if (!pickedBt) { setError(t('connect.selectPairedBtOrBrowser')); return }
      await postConnect(pickedBt.id, 'bluetooth')
      return
    }
    if (!selectedPort) { setError(t('connect.selectPort')); return }
    await postConnect(selectedPort, 'serial')
  }

  const disconnect = async () => {
    setError(null)
    await localRuntime.disconnect()
    setSigningSecret('')
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
        presetPort = pickedBt.id
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
      protocol,
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
        {serialSupported === false && (
          <div className="mc-notice" data-tone="warning" role="status">
            <div className="mc-notice__content">{t('connect.webSerialUnsupportedLong')}</div>
          </div>
        )}
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
                <Button onClick={() => void pickSerialPort()} tone="secondary">
                  {t('connect.selectSerialDevice')}
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

        <details>
          <summary className="mc-details-summary">{t('connect.advancedSettings')}</summary>
          <div className="mt-3 space-y-4">
            <Field label="MAVLink" controlId="connect-mavlink-protocol">
              <select
                id="connect-mavlink-protocol"
                value={protocol}
                onChange={(event) => setProtocol(event.target.value as typeof protocol)}
                className="mc-select"
              >
                <option value="auto">Auto</option>
                <option value="v2">MAVLink 2</option>
                <option value="v1">MAVLink 1</option>
              </select>
            </Field>
            <Field label={t('connect.signingKey')} controlId="connect-signing-key" helper={t('connect.signingKeyHelp')}>
              <input
                id="connect-signing-key"
                type="password"
                autoComplete="off"
                value={signingSecret}
                onChange={(event) => setSigningSecret(event.target.value)}
                className="mc-input"
              />
            </Field>
            {signingSecret && (
              <Field label="Link ID" controlId="connect-signing-link-id">
                <input
                  id="connect-signing-link-id"
                  type="number"
                  min={0}
                  max={255}
                  value={signingLinkId}
                  onChange={(event) => setSigningLinkId(Math.max(0, Math.min(255, Number(event.target.value))))}
                  className="mc-input"
                />
              </Field>
            )}
          </div>
        </details>

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
