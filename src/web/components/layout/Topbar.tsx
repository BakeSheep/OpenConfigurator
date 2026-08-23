import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import i18next from 'i18next'
import { availableModes, vehicleCapabilities } from '../../../shared/vehicleProfiles'
import { useConnectionStore } from '../../stores/connectionStore'
import { useTelemetryStore } from '../../stores/telemetryStore'
import { useThemeStore } from '../../stores/themeStore'
import { useLanguageStore } from '../../stores/languageStore'
import { getRestControlHeaders, sendClientMessage } from '../../hooks/useWebSocket'
import { appRuntimeMode } from '../../runtime'
import {
  connectionPresetEnablesGamepad,
  connectionConfigFromPreset,
  loadConnectionPresets,
  resolveBluetoothPreset,
  resolveSerialPreset,
  saveConnectionPresets,
  type ConnectionPreset,
} from '../../utils/connectionPresets'
import { useGamepadStore } from '../../stores/gamepadStore'
import Icon from '../ui/Icon'
import { Button, IconButton } from '../ui/Button'
import ArmSafetyControl from '../safety/ArmSafetyControl'
import { formatGpsCoordinate, gpsFixLabel, gpsHasPosition } from '../../utils/gpsTelemetry'

const radToDeg = (r: number) => r * 180 / Math.PI
type StatusMenu = 'mode' | 'arm' | 'gps' | 'tools'
const statusMenuTriggerIds: Record<StatusMenu, string> = {
  arm: 'mc-topbar-arm-trigger',
  mode: 'mc-topbar-mode-trigger',
  gps: 'mc-topbar-gps-trigger',
  tools: 'mc-topbar-tools-trigger',
}

function bluetoothEndpointLabel(port: string | null, ports: Array<{ path: string; friendlyName?: string; bluetoothAddress?: string }>): string {
  const matched = ports.find((candidate) => candidate.path === port)
  const friendlyName = matched?.friendlyName?.trim()
  if (friendlyName) return `BT · ${friendlyName}`

  const compactAddress = matched?.bluetoothAddress?.replace(/[^0-9a-f]/gi, '')
    ?? port?.match(/^bt-rfcomm:\/\/([0-9a-f]{12})\//i)?.[1]
  if (compactAddress?.length === 12) {
    const suffix = compactAddress.slice(-6).toUpperCase().match(/.{2}/g)?.join(':')
    return `BT · ${suffix}`
  }
  return 'BT · SPP'
}

export default function Topbar() {
  const { t } = useTranslation()
  const {
    status,
    transportOpen,
    vehicleReady,
    canControl,
    port,
    type,
    reconnect,
    bluetoothPorts,
    targetSystemId,
    targetComponentId,
    targetConflict,
    setConnectDialogOpen,
    setStatus,
    setConnectionError,
    setActivePresetId,
  } = useConnectionStore()
  const safetyEpoch = useConnectionStore((state) => state.safetyEpoch)
  const safetyAuthorityId = useConnectionStore((state) => state.safetyAuthorityId)
  const { theme, toggleTheme } = useThemeStore()
  const { language, toggleLanguage } = useLanguageStore()
  const isDemo = appRuntimeMode === 'demo'
  const setGamepadEnabled = useGamepadStore((state) => state.setEnabled)
  const reconnecting = status === 'reconnecting'
  const connectionLabel = vehicleReady
    ? type === 'bluetooth'
      ? bluetoothEndpointLabel(port, bluetoothPorts)
      : `USB · ${port ?? t('topbar.connection.ready')}`
    : transportOpen
      ? t('topbar.connection.notConnected')
    : reconnecting
      ? `${t('topbar.connection.reconnecting')}${reconnect ? ` (${reconnect.attempt}/${reconnect.maxAttempts})` : ''}`
      : status === 'connecting' ? t('topbar.connection.connecting') : t('topbar.connection.disconnected')
  const targetChoices = targetConflict?.reason === 'multiple_stable_targets'
    ? targetConflict.candidates
    : []

  // Presets for QGC-style connection dropdown
  const [presets, setPresets] = useState(loadConnectionPresets)
  const [connectDropdown, setConnectDropdown] = useState(false)
  const [rebootConfirm, setRebootConfirm] = useState(false)
  const [activeStatusMenu, setActiveStatusMenu] = useState<StatusMenu | null>(null)
  const topbarRef = useRef<HTMLElement | null>(null)
  const toolsMenuRef = useRef<HTMLDivElement | null>(null)
  const modeMenuRef = useRef<HTMLDivElement | null>(null)
  const rebootTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const rebootSafetyKeyRef = useRef<string | null>(null)

  const connectPreset = async (preset: ConnectionPreset) => {
    setConnectDropdown(false)
    setActivePresetId(null)
    setConnectionError(null)
    setStatus('connecting')
    try {
      let resolved = preset
      if (preset.type === 'serial' || preset.type === 'bluetooth') {
        const scope = preset.type === 'serial' ? 'recommended' : 'quick'
        const scanResponse = await fetch(
          `/api/connections/scan?kind=${preset.type}&scope=${scope}`,
        )
        const scan = await scanResponse.json()
        if (!scanResponse.ok || !scan.success) throw new Error('connection scan failed')
        const ports = scan.data.devices ?? []
        const connectionState = useConnectionStore.getState()
        connectionState.setPorts(
          preset.type === 'serial' ? ports : connectionState.serialPorts,
          preset.type === 'bluetooth' ? ports : connectionState.bluetoothPorts,
        )
        const matched = preset.type === 'serial'
          ? resolveSerialPreset(preset, ports)
          : resolveBluetoothPreset(preset, ports)
        if (!matched) {
          setConnectionError(t('topbar.connection.presetNotFound'))
          setStatus('error')
          setConnectDialogOpen(true)
          return
        }
        resolved = matched
        if (
          resolved.port !== preset.port
          || resolved.vendorId !== preset.vendorId
          || resolved.productId !== preset.productId
          || resolved.deviceId !== preset.deviceId
          || resolved.transport !== preset.transport
          || resolved.stablePath !== preset.stablePath
          || resolved.serialNumber !== preset.serialNumber
          || resolved.bluetoothAddress !== preset.bluetoothAddress
          || resolved.bluetoothChannel !== preset.bluetoothChannel
          || resolved.bluetoothServiceClassId !== preset.bluetoothServiceClassId
        ) {
          const updated = presets.map((candidate) =>
            candidate.id === preset.id ? resolved : candidate,
          )
          setPresets(updated)
          saveConnectionPresets(updated)
        }
      }
      const res = await fetch('/api/connections/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getRestControlHeaders() },
        body: JSON.stringify(connectionConfigFromPreset(resolved)),
      })
      const text = await res.text()
      let json: { success?: boolean; error?: { code?: string; message?: string } } | null = null
      if (text) {
        try { json = JSON.parse(text) } catch { /* not JSON */ }
      }
      // A 200 with success=false is still a failure; never report it silently.
      if (!res.ok || !json?.success) {
        const raw = json?.error?.message ?? (text || `HTTP ${res.status}`)
        const code = json?.error?.code
        const reason = code && i18next.exists(`errors.${code}`) ? i18next.t(`errors.${code}`) : raw
        console.error('[Connect] preset connect failed:', reason)
        setConnectionError(t('topbar.connection.presetFailed', { reason }))
        setStatus('error')
        setConnectDialogOpen(true)
        setGamepadEnabled(false)
      } else {
        setActivePresetId(resolved.id)
        setGamepadEnabled(connectionPresetEnablesGamepad(resolved))
      }
    } catch (error) {
      console.error('[Connect] preset connect failed:', error)
      setConnectionError(t('topbar.connection.presetFailed', { reason: error instanceof Error ? error.message : String(error) }))
      setStatus('error')
      setConnectDialogOpen(true)
      setActivePresetId(null)
      setGamepadEnabled(false)
    }
  }

  const removePreset = (id: string) => {
    const updated = presets.filter((p) => p.id !== id)
    setPresets(updated)
    saveConnectionPresets(updated)
  }

  // Close the transport from the topbar dropdown; connection state updates
  // arrive over the WebSocket, so no local status juggling is needed here.
  const disconnectTransport = async () => {
    setConnectDropdown(false)
    try {
      await fetch('/api/connections/disconnect', { method: 'POST', headers: getRestControlHeaders() })
    } catch { /* ignore - WS will report the real state */ }
  }

  // Telemetry data
  const attitude = useTelemetryStore((s) => s.attitude)
  const gps = useTelemetryStore((s) => s.gps)
  const battery = useTelemetryStore((s) => s.battery)
  const vehicle = useTelemetryStore((s) => s.status)
  const vehicleIdentity = useTelemetryStore((s) => s.vehicleIdentity)
  const caps = vehicleCapabilities(vehicleIdentity)
  const relativeAlt = useTelemetryStore((s) => s.relativeAlt)
  const heading = useTelemetryStore((s) => s.heading)
  const isStale = useTelemetryStore((s) => s.isStale)
  const preflightCheck = useTelemetryStore((s) => s.preflightCheck)
  const sensorsHealthy = useTelemetryStore((s) => s.sensorsHealthy)
  const unhealthySensors = useTelemetryStore((s) => s.unhealthySensors)
  const statusLogs = useTelemetryStore((s) => s.statusLogs)
  const armed = vehicle?.armed ?? false
  const confirmedArmed = vehicleReady && armed
  const stale = !vehicleReady || isStale('attitude')
  const gpsStale = !vehicleReady || isStale('gps')
  const batteryStale = !vehicleReady || (isStale('battery') && isStale('sysStatus'))
  const gpsLive = !gpsStale && gps !== null
  const hasGpsPosition = gpsLive && gpsHasPosition(gps)
  const canChangeArmState = vehicleReady && canControl && caps.writeOperations && caps.arm
  const canArm = canChangeArmState && preflightCheck !== false && sensorsHealthy !== false
  const armTone = confirmedArmed ? 'var(--success)' : canArm ? 'var(--info)' : 'var(--danger)'
  const armLabel = confirmedArmed ? t('topbar.arm.armed') : canArm ? t('topbar.arm.disarmedCanArm') : vehicleReady ? t('topbar.arm.disarmedCannotArm') : t('topbar.arm.vehicleNotReady')
  const recentArmErrors = statusLogs
    .filter((entry) => /arm|arming|pre-arm|preflight|解锁|预检/i.test(entry.text))
    .slice(0, 4)

  const closeStatusMenuAndRestoreFocus = (menu: StatusMenu) => {
    setActiveStatusMenu(null)
    requestAnimationFrame(() => document.getElementById(statusMenuTriggerIds[menu])?.focus())
  }

  const requestVehicleReboot = () => {
    if (!vehicleReady || !canControl || !caps.writeOperations || armed) return
    if (!rebootConfirm) {
      if (safetyAuthorityId === null) return
      setRebootConfirm(true)
      rebootSafetyKeyRef.current = `${safetyAuthorityId}:${safetyEpoch}`
      if (rebootTimerRef.current) clearTimeout(rebootTimerRef.current)
      rebootTimerRef.current = setTimeout(() => setRebootConfirm(false), 3000)
      return
    }
    if (rebootTimerRef.current) clearTimeout(rebootTimerRef.current)
    rebootTimerRef.current = null
    setRebootConfirm(false)
    const connection = useConnectionStore.getState()
    const telemetry = useTelemetryStore.getState()
    const liveCaps = vehicleCapabilities(telemetry.vehicleIdentity)
    if (
      !connection.vehicleReady
      || !connection.canControl
      || connection.safetyAuthorityId === null
      || connection.safetyEpoch !== safetyEpoch
      || connection.safetyAuthorityId !== safetyAuthorityId
      || rebootSafetyKeyRef.current !== `${connection.safetyAuthorityId}:${connection.safetyEpoch}`
      || !liveCaps.writeOperations
      || telemetry.status?.armed === true
    ) return
    rebootSafetyKeyRef.current = null
    sendClientMessage({
      type: 'reboot_vehicle',
      requestId: `reboot-${Date.now().toString(36)}`,
      safetyConfirmation: 'reboot_flight_controller',
      expectedSafetyEpoch: connection.safetyEpoch,
      expectedSafetyAuthorityId: connection.safetyAuthorityId,
    })
    setActiveStatusMenu(null)
  }

  const selectTarget = (systemId: number, componentId: number) => {
    if (!transportOpen || !canControl) return
    sendClientMessage({
      type: 'select_target',
      requestId: `target-${Date.now().toString(36)}`,
      data: { systemId, componentId },
    })
  }

  useEffect(() => () => {
    if (rebootTimerRef.current) clearTimeout(rebootTimerRef.current)
  }, [])

  useEffect(() => {
    const closeOnOutside = (event: PointerEvent) => {
      if (topbarRef.current && !topbarRef.current.contains(event.target as Node)) {
        setActiveStatusMenu(null)
        setConnectDropdown(false)
      }
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setConnectDropdown(false)
      setActiveStatusMenu((current) => {
        if (current) {
          requestAnimationFrame(() => document.getElementById(statusMenuTriggerIds[current])?.focus())
        }
        return null
      })
    }
    document.addEventListener('pointerdown', closeOnOutside)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutside)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [])

  useEffect(() => {
    setRebootConfirm(false)
    rebootSafetyKeyRef.current = null
    if (rebootTimerRef.current) clearTimeout(rebootTimerRef.current)
    rebootTimerRef.current = null
  }, [safetyAuthorityId, safetyEpoch])

  useEffect(() => {
    if (activeStatusMenu !== 'tools') return
    const firstItem = toolsMenuRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')
    firstItem?.focus()
  }, [activeStatusMenu])

  useEffect(() => {
    if (activeStatusMenu !== 'mode') return
    const selected = modeMenuRef.current?.querySelector<HTMLElement>('[role="menuitem"][data-active="true"]')
    const first = modeMenuRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')
    ;(selected ?? first)?.focus()
  }, [activeStatusMenu])

  const handleToolsMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])'),
    )
    if (items.length === 0) return
    event.preventDefault()
    const currentIndex = items.indexOf(document.activeElement as HTMLElement)
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? items.length - 1
        : event.key === 'ArrowDown'
          ? (currentIndex + 1 + items.length) % items.length
          : (currentIndex - 1 + items.length) % items.length
    items[nextIndex]?.focus()
  }

  const handleModeMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])'),
    )
    if (items.length === 0) return
    event.preventDefault()
    const currentIndex = Math.max(0, items.indexOf(document.activeElement as HTMLElement))
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? items.length - 1
        : event.key === 'ArrowDown' || event.key === 'ArrowRight'
          ? (currentIndex + 1) % items.length
          : (currentIndex - 1 + items.length) % items.length
    items[nextIndex]?.focus()
  }

  const selectMode = (modeId: number) => {
    if (!vehicleReady || !canControl) return
    // The server encodes stack-specific DO_SET_MODE parameters from the
    // selected vehicle profile; the browser only names the mode.
    sendClientMessage({
      type: 'set_flight_mode',
      requestId: `mode-${Date.now().toString(36)}`,
      data: { modeId },
    })
    closeStatusMenuAndRestoreFocus('mode')
  }

  const requestArm = () => {
    const connection = useConnectionStore.getState()
    const telemetry = useTelemetryStore.getState()
    const liveCaps = vehicleCapabilities(telemetry.vehicleIdentity)
    if (
      !canArm
      || !connection.vehicleReady
      || !connection.canControl
      || connection.safetyAuthorityId === null
      || connection.safetyEpoch !== safetyEpoch
      || connection.safetyAuthorityId !== safetyAuthorityId
      || !liveCaps.writeOperations
      || !liveCaps.arm
      || telemetry.status?.armed === true
      || telemetry.preflightCheck === false
      || telemetry.sensorsHealthy === false
    ) return
    sendClientMessage({
      type: 'command',
      requestId: `arm-${Date.now().toString(36)}`,
      cmd: 'MAV_CMD_COMPONENT_ARM_DISARM',
      params: [1, 0, 0, 0, 0, 0, 0],
      safetyConfirmation: 'arm',
      expectedSafetyEpoch: connection.safetyEpoch,
      expectedSafetyAuthorityId: connection.safetyAuthorityId,
    })
    closeStatusMenuAndRestoreFocus('arm')
  }

  const requestDisarm = () => {
    if (!canChangeArmState) return
    sendClientMessage({
      type: 'command',
      requestId: `disarm-${Date.now().toString(36)}`,
      cmd: 'MAV_CMD_COMPONENT_ARM_DISARM',
      params: [0, 0, 0, 0, 0, 0, 0],
      safetyConfirmation: 'disarm',
    })
    closeStatusMenuAndRestoreFocus('arm')
  }

  return (
    <header className="mc-topbar" ref={topbarRef}>
      <div className="mc-topbar__brand">
        <span className="mc-topbar__mark" aria-hidden="true">O</span>
        <span className="mc-topbar__name">OpenConfigurator</span>
      </div>

      <div className="mc-topbar__status" aria-live="polite">
        <div className="mc-topbar__status-item mc-topbar__status-menu">
          <button
            id="mc-topbar-arm-trigger"
            type="button"
            className="mc-topbar__status-trigger"
            aria-haspopup="dialog"
            aria-expanded={activeStatusMenu === 'arm'}
            aria-controls="mc-topbar-arm-popover"
            onClick={() => { setConnectDropdown(false); setActiveStatusMenu((current) => current === 'arm' ? null : 'arm') }}
            style={{ color: armTone }}
          >
            <span className="mc-status-dot" style={{ background: armTone }} />
            <span>{armLabel}</span>
            <Icon name="chevronDown" size={11} />
          </button>
          {activeStatusMenu === 'arm' && (
            <section id="mc-topbar-arm-popover" className="mc-topbar-menu mc-topbar-menu--arm" role="dialog" aria-label={t('topbar.arm.armed')}>
              <header>
                <div><strong>{armLabel}</strong><small>{confirmedArmed ? t('topbar.arm.disarmImmediate') : canArm ? t('topbar.arm.dragToConfirm') : t('topbar.arm.operationNotAllowed')}</small></div>
                <span style={{ color: armTone }}>{confirmedArmed ? t('topbar.arm.stateArmed') : canArm ? t('topbar.arm.stateReady') : t('topbar.arm.stateBlocked')}</span>
              </header>
              {confirmedArmed || (canChangeArmState && canArm) ? (
                <>
                  <div className="mc-arm-control">
                    <ArmSafetyControl
                      armed={confirmedArmed}
                      canArm={canArm}
                      canChangeArmState={canChangeArmState}
                      onArm={requestArm}
                      onDisarm={requestDisarm}
                      safetyKey={`${safetyAuthorityId ?? '-'}:${safetyEpoch}`}
                    />
                  </div>
                  {confirmedArmed && !canChangeArmState && (
                    <div className="mc-arm-errors" role="status">
                      <p>{!canControl ? t('topbar.arm.readOnly') : t('topbar.arm.noWriteOps')}</p>
                    </div>
                  )}
                </>
              ) : (
                <div className="mc-arm-errors" role="alert">
                  {!vehicleReady && <p>{t('topbar.arm.noHeartbeat')}</p>}
                  {vehicleReady && !canControl && <p>{t('topbar.arm.readOnly')}</p>}
                  {vehicleReady && canControl && !caps.writeOperations && <p>{t('topbar.arm.noWriteOps')}</p>}
                  {vehicleReady && canControl && preflightCheck === false && recentArmErrors.length === 0 && <p>{t('topbar.arm.preflightFailed')}</p>}
                  {unhealthySensors.length > 0 && <p>{t('topbar.arm.sensorAbnormal', { sensors: unhealthySensors.join(t('common.listSeparator')) })}</p>}
                  {recentArmErrors.map((entry) => <p key={entry.id}>{entry.text}</p>)}
                </div>
              )}
            </section>
          )}
        </div>

        <div className="mc-topbar__status-item mc-topbar__status-menu">
          <button
            id="mc-topbar-mode-trigger"
            type="button"
            className="mc-topbar__status-trigger"
            aria-haspopup="menu"
            aria-expanded={activeStatusMenu === 'mode'}
            aria-controls="mc-topbar-mode-menu"
            onClick={() => { setConnectDropdown(false); setActiveStatusMenu((current) => current === 'mode' ? null : 'mode') }}
          >
            <span className="mc-topbar__status-label">{t('topbar.mode.label')}</span>
            <span className="mc-topbar__status-value">{vehicle?.mode ?? '—'}</span>
            <Icon name="chevronDown" size={11} />
          </button>
          {activeStatusMenu === 'mode' && (
            <section className="mc-topbar-menu mc-topbar-menu--mode" aria-label={t('topbar.mode.flightMode')}>
              <header><div><strong>{t('topbar.mode.flightMode')}</strong><small>{vehicleReady && canControl ? t('topbar.mode.selectHint') : t('topbar.mode.notReadyOrNoControl')}</small></div></header>
              <div ref={modeMenuRef} id="mc-topbar-mode-menu" role="menu" onKeyDown={handleModeMenuKeyDown}>
                {availableModes(vehicleIdentity).length === 0 && (
                  <p className="px-3 py-2 text-[11px]" style={{ gridColumn: '1 / -1', color: 'var(--text-secondary)' }}>
                    {vehicleReady ? t('topbar.mode.notSupported') : t('topbar.mode.connectToShow')}
                  </p>
                )}
                {availableModes(vehicleIdentity).map((mode) => (
                  <button
                    key={mode.id}
                    type="button"
                    role="menuitem"
                    tabIndex={vehicle?.modeId === mode.id ? 0 : -1}
                    disabled={!vehicleReady || !canControl}
                    data-active={vehicle?.modeId === mode.id}
                    onClick={() => selectMode(mode.id)}
                  >
                    <span>{mode.name}</span>
                    {vehicle?.modeId === mode.id && <Icon name="check" size={14} />}
                  </button>
                ))}
              </div>
            </section>
          )}
        </div>

        {vehicleReady && (
          <>
            {!stale && attitude && (
              <span className="mc-topbar__status-item mc-topbar__status-item--secondary">
                <span className="mc-topbar__status-label">{t('topbar.attitude')}</span>
                <span className="mc-topbar__status-value">{radToDeg(attitude.roll).toFixed(1)}° / {radToDeg(attitude.pitch).toFixed(1)}° / {isStale('vfrHud') ? '—' : relativeAlt.toFixed(1)}m</span>
              </span>
            )}
            {!isStale('vfrHud') && (
              <span className="mc-topbar__status-item mc-topbar__status-item--secondary">
                <span className="mc-topbar__status-label">{t('topbar.heading')}</span>
                <span className="mc-topbar__status-value">{heading.toFixed(0)}°</span>
              </span>
            )}
            <div className="mc-topbar__status-item mc-topbar__status-menu mc-topbar__status-item--secondary">
              <button
                id="mc-topbar-gps-trigger"
                type="button"
                className="mc-topbar__status-trigger"
                aria-haspopup="dialog"
                aria-expanded={activeStatusMenu === 'gps'}
                aria-controls="mc-topbar-gps-popover"
                onClick={() => { setConnectDropdown(false); setActiveStatusMenu((current) => current === 'gps' ? null : 'gps') }}
              >
                <Icon name="satellite" size={13} />
                <span className="mc-topbar__status-value">{gpsLive ? `${gps.satellites_visible ?? '—'} SAT` : 'GPS —'}</span>
                <Icon name="chevronDown" size={11} />
              </button>
              {activeStatusMenu === 'gps' && (
                <section id="mc-topbar-gps-popover" className="mc-topbar-menu mc-topbar-menu--gps" role="dialog" aria-label={t('topbar.gps.details')}>
                  <header>
                    <div><strong>{t('topbar.gps.details')}</strong><small>{gpsLive ? t('topbar.gps.dataFromRaw') : t('topbar.gps.waiting')}</small></div>
                    <span data-fix={hasGpsPosition || undefined}>{gpsLive ? gpsFixLabel(gps.fix_type) : t('topbar.gps.noData')}</span>
                  </header>
                  <dl>
                    <div><dt>{t('topbar.gps.fixType')}</dt><dd>{gpsLive ? gpsFixLabel(gps.fix_type) : '—'}</dd></div>
                    <div><dt>{t('topbar.gps.satellites')}</dt><dd className="mc-mono">{gpsLive ? gps.satellites_visible ?? '—' : '—'}</dd></div>
                    <div><dt>{t('topbar.gps.latitude')}</dt><dd className="mc-mono">{hasGpsPosition ? formatGpsCoordinate(gps.lat) : '—'}</dd></div>
                    <div><dt>{t('topbar.gps.longitude')}</dt><dd className="mc-mono">{hasGpsPosition ? formatGpsCoordinate(gps.lon) : '—'}</dd></div>
                    <div><dt>{t('topbar.gps.altitudeMSL')}</dt><dd className="mc-mono">{hasGpsPosition ? `${gps.alt.toFixed(1)} m` : '—'}</dd></div>
                    <div><dt>{t('topbar.gps.speed')}</dt><dd className="mc-mono">{gpsLive && gps.vel != null ? `${gps.vel.toFixed(2)} m/s` : '—'}</dd></div>
                    <div><dt>HDOP</dt><dd className="mc-mono">{gpsLive && gps.eph != null ? gps.eph.toFixed(2) : '—'}</dd></div>
                    <div><dt>VDOP</dt><dd className="mc-mono">{gpsLive && gps.epv != null ? gps.epv.toFixed(2) : '—'}</dd></div>
                    <div><dt>{t('topbar.gps.horizontalAccuracy')}</dt><dd>{t('topbar.gps.notProvided')}</dd></div>
                    <div><dt>{t('topbar.gps.verticalAccuracy')}</dt><dd>{t('topbar.gps.notProvided')}</dd></div>
                    <div className="mc-topbar-gps__wide"><dt>{t('topbar.gps.heading')}</dt><dd className="mc-mono">{gpsLive && gps.cog != null ? `${gps.cog.toFixed(1)}°` : '—'}</dd></div>
                  </dl>
                </section>
              )}
            </div>
            {!batteryStale && battery && (
              <span className="mc-topbar__status-item mc-topbar__status-item--secondary">
                <Icon name="battery" size={13} />
                <span className="mc-topbar__status-value">{battery.voltage?.toFixed(1) ?? '—'}V · {battery.remaining ?? '—'}%</span>
              </span>
            )}
          </>
        )}
      </div>

      <div className="mc-topbar__actions">
        <div className="mc-topbar__tools">
          <IconButton
            id="mc-topbar-tools-trigger"
            className="mc-topbar__tools-trigger"
            tone="quiet"
            label={t('topbar.tools.open')}
            icon={<Icon name="settings" size={16} />}
            aria-haspopup="menu"
            aria-expanded={activeStatusMenu === 'tools'}
            aria-controls="mc-topbar-tools-menu"
            onClick={() => {
              setConnectDropdown(false)
              setActiveStatusMenu((current) => current === 'tools' ? null : 'tools')
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                setConnectDropdown(false)
                setActiveStatusMenu('tools')
              }
            }}
          />
          {activeStatusMenu === 'tools' && (
            <div
              ref={toolsMenuRef}
              id="mc-topbar-tools-menu"
              className="mc-topbar-menu mc-topbar-menu--tools"
              role="menu"
              aria-label={t('topbar.tools.menuLabel')}
              onKeyDown={handleToolsMenuKeyDown}
            >
              <a
                href="https://github.com/BakeSheep/OpenConfigurator"
                target="_blank"
                rel="noreferrer"
                role="menuitem"
                onClick={() => closeStatusMenuAndRestoreFocus('tools')}
              >
                <Icon name="github" size={16} />
                <span>{t('topbar.tools.github')}</span>
                <Icon name="external" size={13} />
              </a>
              <button
                type="button"
                role="menuitem"
                onClick={() => { toggleLanguage(); closeStatusMenuAndRestoreFocus('tools') }}
              >
                <span className="mc-topbar-menu__language" aria-hidden="true">{language === 'zh' ? 'EN' : '中'}</span>
                <span>{language === 'zh' ? t('topbar.language.toEnglish') : t('topbar.language.toChinese')}</span>
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => { toggleTheme(); closeStatusMenuAndRestoreFocus('tools') }}
              >
                <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={16} />
                <span>{theme === 'dark' ? t('topbar.theme.toLight') : t('topbar.theme.toDark')}</span>
              </button>
            </div>
          )}
        </div>
        <Button
          id="mc-topbar-reboot"
          className="mc-topbar__reboot"
          tone="secondary"
          size="compact"
          data-confirm={rebootConfirm || undefined}
          disabled={!vehicleReady || !canControl || !caps.writeOperations || armed}
          title={!caps.writeOperations ? t('topbar.reboot.notSupported') : armed ? t('topbar.reboot.armed') : rebootConfirm ? t('topbar.reboot.confirmAgain') : t('topbar.reboot.title')}
          aria-label={rebootConfirm ? t('topbar.reboot.confirmAgain') : t('topbar.reboot.title')}
          leadingIcon={(
            <span className="mc-topbar__reboot-icon" aria-hidden="true">
              <Icon name="refresh" size={15} />
              {rebootConfirm && <Icon className="mc-topbar__reboot-confirm-badge" name="check" size={9} strokeWidth={2.8} />}
            </span>
          )}
          onClick={() => {
            setConnectDropdown(false)
            setActiveStatusMenu(null)
            requestVehicleReboot()
          }}
        >
          {rebootConfirm ? t('topbar.reboot.confirm') : t('topbar.reboot.title')}
        </Button>
        <div className="relative">
          {isDemo ? (
            // Static preview: read-only badge, no REST scan/connect/disconnect.
            <span
              className="mc-topbar__connect is-connected"
              style={{ cursor: 'default' }}
              title={t('topbar.demo.title')}
            >
              <span className="mc-topbar__connect-icon" aria-hidden="true">
                <Icon name="plug" size={16} />
                <span className="mc-status-dot" style={{ background: 'var(--success)' }} />
              </span>
              <span className="mc-topbar__connect-label">{t('topbar.demo.simulated')} · {port ?? 'DEMO'}</span>
            </span>
          ) : (
            <>
          <button
            type="button"
            className={'mc-topbar__connect' + (vehicleReady ? ' is-connected' : transportOpen ? ' is-waiting' : '')}
            title={connectionLabel}
            aria-label={connectionLabel}
            onClick={() => { setActiveStatusMenu(null); if (!transportOpen) setPresets(loadConnectionPresets()); setConnectDropdown((v) => !v) }}
          >
            <span className="mc-topbar__connect-icon" aria-hidden="true">
              <Icon name="plug" size={16} />
              <span className="mc-status-dot" style={{ background: vehicleReady ? 'var(--success)' : (transportOpen || reconnecting || status === 'connecting') ? 'var(--warning)' : 'var(--text-disabled)' }} />
            </span>
            <span className="mc-topbar__connect-label">{connectionLabel}</span>
            <Icon className="mc-topbar__connect-chevron" name="chevronDown" size={11} aria-hidden="true" />
          </button>
          {connectDropdown && transportOpen && (
            <div className="mc-topbar__arm-dropdown" style={{ right: 0, minWidth: 200 }} onMouseLeave={() => setConnectDropdown(false)}>
              <p className="mb-1.5 text-[11px] font-bold" style={{ color: 'var(--text-primary)' }}>{t('topbar.connect.currentConnection')}</p>
              <div className="mb-2 rounded-md px-2 py-1.5 text-[11px]" style={{ background: 'var(--bg-tertiary)' }}>
                <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>{type === 'bluetooth' ? t('topbar.connect.bluetoothSPP') : t('topbar.connect.usbSerial')}</span>
                <span className="ml-1.5 mc-mono text-[11px]" style={{ color: 'var(--text-secondary)' }}>{port ?? '—'}</span>
              </div>
              {targetConflict && (
                <p className="mb-2 rounded-md px-2 py-1.5 text-[11px]" style={{ background: 'var(--warning-tint)', color: 'var(--warning-foreground)' }}>
                  {t(targetConflict.reason === 'same_system_identity_conflict'
                    ? 'topbar.connect.targetIdentityConflict'
                    : 'topbar.connect.targetConflict')}
                </p>
              )}
              {targetChoices.length > 0 && (
                <div className="mb-2">
                  <p className="mb-1 text-[11px] font-bold" style={{ color: 'var(--text-primary)' }}>
                    {t('topbar.connect.flightControllers')}
                  </p>
                  <div className="flex flex-col gap-1">
                    {targetChoices.map((target) => {
                      const selected = target.systemId === targetSystemId && target.componentId === targetComponentId
                      return (
                        <button
                          key={`${target.systemId}:${target.componentId}`}
                          type="button"
                          className={`mc-btn mc-btn--compact w-full ${selected ? 'mc-btn-primary' : 'mc-btn-ghost'}`}
                          disabled={!canControl || selected}
                          onClick={() => selectTarget(target.systemId, target.componentId)}
                        >
                          <span className="mc-mono">SYS {target.systemId} / COMP {target.componentId}</span>
                          {selected && (
                            <span className="ml-1">
                              · {t('topbar.connect.selected')}
                            </span>
                          )}
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}
              <button type="button" className="mc-btn mc-btn-danger mc-btn--compact w-full" onClick={disconnectTransport}>{t('topbar.connect.disconnect')}</button>
              <button type="button" className="mc-btn mc-btn-ghost mc-btn--compact mt-1.5 w-full" onClick={() => { setConnectDropdown(false); setConnectDialogOpen(true) }}>{t('topbar.connect.manage')}</button>
            </div>
          )}
          {connectDropdown && !transportOpen && (
            <div className="mc-topbar__arm-dropdown" style={{ right: 0, minWidth: 200 }} onMouseLeave={() => setConnectDropdown(false)}>
              <div className="flex items-center justify-between mb-1.5">
                <p className="text-[11px] font-bold" style={{ color: 'var(--text-primary)' }}>{t('topbar.connect.selectDevice')}</p>
                <button type="button" className="text-[14px] font-bold leading-none" style={{ color: 'var(--accent)' }} onClick={() => { setConnectDropdown(false); setConnectDialogOpen(true) }} title={t('topbar.connect.addDevice')}>+</button>
              </div>
              {presets.length === 0 && (
                <p className="text-[11px] py-1.5" style={{ color: 'var(--text-secondary)' }}>{t('topbar.connect.noPresets')}</p>
              )}
              {presets.map((p) => (
                <div key={p.id} className="flex items-center gap-2 rounded-md px-2 py-1 hover:bg-[var(--bg-hover)] cursor-pointer group">
                  <button type="button" className="flex-1 text-left text-[11px]" style={{ color: 'var(--text-primary)' }} onClick={() => connectPreset(p)}>
                    <span className="font-semibold">{p.name}</span>
                    <span className="ml-1.5 mc-mono text-[11px]" style={{ color: 'var(--text-secondary)' }}>{p.port}</span>
                  </button>
                  <button
                    type="button"
                    className="mc-topbar__preset-delete text-[11px]"
                    style={{ color: 'var(--danger)' }}
                    aria-label={`${t('common.delete')} ${p.name}`}
                    title={`${t('common.delete')} ${p.name}`}
                    onClick={() => removePreset(p.id)}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
            </>
          )}
        </div>
      </div>
    </header>
  )
}
