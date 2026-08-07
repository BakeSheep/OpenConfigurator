import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react'
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
  loadConnectionPresets,
  resolveSerialPreset,
  saveConnectionPresets,
  type ConnectionPreset,
} from '../../utils/connectionPresets'
import Icon from '../ui/Icon'
import { formatGpsCoordinate, gpsFixLabel, gpsHasPosition } from '../../utils/gpsTelemetry'

const radToDeg = (r: number) => r * 180 / Math.PI

export default function Topbar() {
  const { t } = useTranslation()
  const { status, transportOpen, vehicleReady, canControl, port, type, reconnect, setConnectDialogOpen, setStatus, setConnectionError } = useConnectionStore()
  const { theme, toggleTheme } = useThemeStore()
  const { language, toggleLanguage } = useLanguageStore()
  const isDemo = appRuntimeMode === 'demo'
  const reconnecting = status === 'reconnecting'
  const connectionLabel = vehicleReady
    ? (type === 'bluetooth' ? 'BT' : 'USB') + ' · ' + (port ?? t('topbar.connection.ready'))
    : transportOpen
      ? t('topbar.connection.notConnected')
    : reconnecting
      ? `${t('topbar.connection.reconnecting')}${reconnect ? ` (${reconnect.attempt}/${reconnect.maxAttempts})` : ''}`
      : status === 'connecting' ? t('topbar.connection.connecting') : t('topbar.connection.disconnected')

  // Presets for QGC-style connection dropdown
  const [presets, setPresets] = useState(loadConnectionPresets)
  const [connectDropdown, setConnectDropdown] = useState(false)
  const [rebootConfirm, setRebootConfirm] = useState(false)
  const [activeStatusMenu, setActiveStatusMenu] = useState<'mode' | 'arm' | 'gps' | null>(null)
  const [armDragProgress, setArmDragProgress] = useState(0)
  const [armDragging, setArmDragging] = useState(false)
  const topbarRef = useRef<HTMLElement | null>(null)
  const rebootTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const armSliderRef = useRef<HTMLButtonElement | null>(null)
  const armDraggingRef = useRef(false)

  const connectPreset = async (preset: ConnectionPreset) => {
    setConnectDropdown(false)
    setConnectionError(null)
    setStatus('connecting')
    try {
      let resolved = preset
      if (preset.type === 'serial') {
        const scanResponse = await fetch('/api/connections/scan')
        const scan = await scanResponse.json()
        if (!scanResponse.ok || !scan.success) throw new Error('serial scan failed')
        const matched = resolveSerialPreset(preset, scan.data.serial ?? [])
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
        body: JSON.stringify({
          type: resolved.type,
          port: resolved.port,
          baudRate: resolved.baudRate,
          vendorId: resolved.vendorId,
          productId: resolved.productId,
        }),
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
      }
    } catch (error) {
      console.error('[Connect] preset connect failed:', error)
      setConnectionError(t('topbar.connection.presetFailed', { reason: error instanceof Error ? error.message : String(error) }))
      setStatus('error')
      setConnectDialogOpen(true)
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

  const requestVehicleReboot = () => {
    if (!vehicleReady || !canControl || !caps.writeOperations || armed) return
    if (!rebootConfirm) {
      setRebootConfirm(true)
      if (rebootTimerRef.current) clearTimeout(rebootTimerRef.current)
      rebootTimerRef.current = setTimeout(() => setRebootConfirm(false), 3000)
      return
    }
    if (rebootTimerRef.current) clearTimeout(rebootTimerRef.current)
    rebootTimerRef.current = null
    setRebootConfirm(false)
    sendClientMessage({
      type: 'reboot_vehicle',
      requestId: `reboot-${Date.now().toString(36)}`,
      safetyConfirmation: 'reboot_flight_controller',
    })
  }

  useEffect(() => () => {
    if (rebootTimerRef.current) clearTimeout(rebootTimerRef.current)
  }, [])

  useEffect(() => {
    const closeOnOutside = (event: PointerEvent) => {
      if (topbarRef.current && !topbarRef.current.contains(event.target as Node)) setActiveStatusMenu(null)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setActiveStatusMenu(null)
    }
    document.addEventListener('pointerdown', closeOnOutside)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutside)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [])

  useEffect(() => {
    setArmDragProgress(0)
    setArmDragging(false)
    armDraggingRef.current = false
  }, [armed, canArm, vehicleReady])

  const selectMode = (modeId: number) => {
    if (!vehicleReady || !canControl) return
    // The server encodes stack-specific DO_SET_MODE parameters from the
    // selected vehicle profile; the browser only names the mode.
    sendClientMessage({
      type: 'set_flight_mode',
      requestId: `mode-${Date.now().toString(36)}`,
      data: { modeId },
    })
    setActiveStatusMenu(null)
  }

  const commitArmChange = () => {
    if (confirmedArmed) {
      if (!canChangeArmState) return
      sendClientMessage({
        type: 'command',
        requestId: `disarm-${Date.now().toString(36)}`,
        cmd: 'MAV_CMD_COMPONENT_ARM_DISARM',
        params: [0, 0, 0, 0, 0, 0, 0],
        safetyConfirmation: 'disarm',
      })
    } else {
      if (!canArm) return
      sendClientMessage({
        type: 'command',
        requestId: `arm-${Date.now().toString(36)}`,
        cmd: 'MAV_CMD_COMPONENT_ARM_DISARM',
        params: [1, 0, 0, 0, 0, 0, 0],
        safetyConfirmation: 'arm',
      })
    }
    setArmDragProgress(0)
    setArmDragging(false)
    armDraggingRef.current = false
    setActiveStatusMenu(null)
  }

  const armProgressFromPointer = (clientX: number) => {
    const rect = armSliderRef.current?.getBoundingClientRect()
    if (!rect) return 0
    const thumbCenter = 25
    const travel = Math.max(1, rect.width - thumbCenter * 2)
    return Math.max(0, Math.min(1, (clientX - rect.left - thumbCenter) / travel))
  }

  const startArmDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!canChangeArmState || (!confirmedArmed && !canArm)) return
    const startProgress = armProgressFromPointer(event.clientX)
    if (startProgress > 0.18) return
    event.currentTarget.setPointerCapture(event.pointerId)
    armDraggingRef.current = true
    setArmDragging(true)
    setArmDragProgress(startProgress)
  }

  const moveArmDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!armDraggingRef.current) return
    setArmDragProgress(armProgressFromPointer(event.clientX))
  }

  const finishArmDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!armDraggingRef.current) return
    const progress = armProgressFromPointer(event.clientX)
    armDraggingRef.current = false
    setArmDragging(false)
    if (progress >= 0.88) commitArmChange()
    else setArmDragProgress(0)
  }

  const cancelArmDrag = () => {
    armDraggingRef.current = false
    setArmDragging(false)
    setArmDragProgress(0)
  }

  const handleArmSliderKey = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft' && event.key !== 'Home') return
    event.preventDefault()
    const next = event.key === 'Home' ? 0 : Math.max(0, Math.min(1, armDragProgress + (event.key === 'ArrowRight' ? 0.2 : -0.2)))
    if (next >= 0.99) commitArmChange()
    else setArmDragProgress(next)
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
            type="button"
            className="mc-topbar__status-trigger"
            aria-haspopup="menu"
            aria-expanded={activeStatusMenu === 'arm'}
            onClick={() => { setConnectDropdown(false); setActiveStatusMenu((current) => current === 'arm' ? null : 'arm') }}
            style={{ color: armTone }}
          >
            <span className="mc-status-dot" style={{ background: armTone }} />
            <span>{armLabel}</span>
            <Icon name="chevronDown" size={11} />
          </button>
          {activeStatusMenu === 'arm' && (
            <section className="mc-topbar-menu mc-topbar-menu--arm" aria-label={t('topbar.arm.armed')}>
              <header>
                <div><strong>{armLabel}</strong><small>{canChangeArmState && (confirmedArmed || canArm) ? t('topbar.arm.dragToConfirm') : t('topbar.arm.operationNotAllowed')}</small></div>
                <span style={{ color: armTone }}>{confirmedArmed ? 'ARMED' : canArm ? 'READY' : 'BLOCKED'}</span>
              </header>
              {canChangeArmState && (confirmedArmed || canArm) ? (
                <div className="mc-arm-control">
                  <button
                    ref={armSliderRef}
                    type="button"
                    role="slider"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(armDragProgress * 100)}
                    aria-label={confirmedArmed ? t('topbar.arm.slideToDisarm') : t('topbar.arm.slideToArm')}
                    className="mc-arm-slider"
                    data-armed={confirmedArmed}
                    data-dragging={armDragging}
                    disabled={!canChangeArmState}
                    onPointerDown={startArmDrag}
                    onPointerMove={moveArmDrag}
                    onPointerUp={finishArmDrag}
                    onPointerCancel={cancelArmDrag}
                    onLostPointerCapture={() => { if (armDraggingRef.current) cancelArmDrag() }}
                    onKeyDown={handleArmSliderKey}
                    style={{
                      '--arm-slide-progress': armDragProgress,
                      '--arm-slide-tone': confirmedArmed ? 'var(--success)' : 'var(--info)',
                    } as CSSProperties}
                  >
                    <span className="mc-arm-slider__fill" />
                    <i aria-hidden="true">››</i>
                  </button>
                </div>
              ) : (
                <div className="mc-arm-errors" role="alert">
                  {!vehicleReady && <p>{t('topbar.arm.noHeartbeat')}</p>}
                  {vehicleReady && !canControl && <p>{t('topbar.arm.readOnly')}</p>}
                  {vehicleReady && canControl && !caps.writeOperations && <p>{t('topbar.arm.noWriteOps')}</p>}
                  {vehicleReady && canControl && preflightCheck === false && recentArmErrors.length === 0 && <p>{t('topbar.arm.preflightFailed')}</p>}
                  {unhealthySensors.length > 0 && <p>{t('topbar.arm.sensorAbnormal', { sensors: unhealthySensors.join('、') })}</p>}
                  {recentArmErrors.map((entry) => <p key={entry.id}>{entry.text}</p>)}
                </div>
              )}
            </section>
          )}
        </div>

        <div className="mc-topbar__status-item mc-topbar__status-menu">
          <button
            type="button"
            className="mc-topbar__status-trigger"
            aria-haspopup="menu"
            aria-expanded={activeStatusMenu === 'mode'}
            onClick={() => { setConnectDropdown(false); setActiveStatusMenu((current) => current === 'mode' ? null : 'mode') }}
          >
            <span className="mc-topbar__status-label">{t('topbar.mode.label')}</span>
            <span className="mc-topbar__status-value">{vehicle?.mode ?? '—'}</span>
            <Icon name="chevronDown" size={11} />
          </button>
          {activeStatusMenu === 'mode' && (
            <section className="mc-topbar-menu mc-topbar-menu--mode" aria-label={t('topbar.mode.flightMode')}>
              <header><div><strong>{t('topbar.mode.flightMode')}</strong><small>{vehicleReady && canControl ? t('topbar.mode.selectHint') : t('topbar.mode.notReadyOrNoControl')}</small></div></header>
              <div role="menu">
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
                type="button"
                className="mc-topbar__status-trigger"
                aria-haspopup="menu"
                aria-expanded={activeStatusMenu === 'gps'}
                onClick={() => { setConnectDropdown(false); setActiveStatusMenu((current) => current === 'gps' ? null : 'gps') }}
              >
                <Icon name="satellite" size={13} />
                <span className="mc-topbar__status-value">{gpsLive ? `${gps.satellites_visible ?? '—'} SAT` : 'GPS —'}</span>
                <Icon name="chevronDown" size={11} />
              </button>
              {activeStatusMenu === 'gps' && (
                <section className="mc-topbar-menu mc-topbar-menu--gps" aria-label={t('topbar.gps.details')}>
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
        <a
          className="mc-topbar__link"
          href="https://github.com/BakeSheep/OpenConfigurator"
          target="_blank"
          rel="noreferrer"
          title={t('topbar.github.title')}
          aria-label={t('topbar.github.ariaLabel')}
        >
          <Icon name="github" size={16} />
        </a>
        <button
          type="button"
          className="mc-topbar__link"
          title={language === 'zh' ? t('topbar.language.toEnglish') : t('topbar.language.toChinese')}
          onClick={toggleLanguage}
        >
          <span style={{ fontSize: 11, fontWeight: 600 }}>{language === 'zh' ? 'EN' : '中'}</span>
        </button>
        <button
          type="button"
          className="mc-topbar__link"
          title={theme === 'dark' ? t('topbar.theme.toLight') : t('topbar.theme.toDark')}
          onClick={toggleTheme}
        >
          <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={16} />
        </button>
        <button
          type="button"
          className="mc-topbar__reboot"
          data-confirm={rebootConfirm || undefined}
          aria-pressed={rebootConfirm}
          disabled={!vehicleReady || !canControl || !caps.writeOperations || armed}
          title={!caps.writeOperations ? t('topbar.reboot.notSupported') : armed ? t('topbar.reboot.armed') : rebootConfirm ? t('topbar.reboot.confirmAgain') : t('topbar.reboot.title')}
          aria-label={rebootConfirm ? t('topbar.reboot.confirmTitle') : t('topbar.reboot.title')}
          onClick={requestVehicleReboot}
        >
          <span className="mc-topbar__reboot-icon" aria-hidden="true">
            <Icon name="refresh" size={15} />
            {rebootConfirm && <Icon className="mc-topbar__reboot-confirm-badge" name="check" size={9} strokeWidth={2.8} />}
          </span>
          <span className="mc-topbar__reboot-label">{rebootConfirm ? t('topbar.reboot.confirm') : t('topbar.reboot.label')}</span>
        </button>
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
                <span className="ml-1.5 mc-mono text-[10px]" style={{ color: 'var(--text-secondary)' }}>{port ?? '—'}</span>
              </div>
              <button type="button" className="mc-btn mc-btn-danger w-full py-1.5 text-[11px]" onClick={disconnectTransport}>{t('topbar.connect.disconnect')}</button>
              <button type="button" className="mc-btn mc-btn-ghost mt-1.5 w-full py-1.5 text-[11px]" onClick={() => { setConnectDropdown(false); setConnectDialogOpen(true) }}>{t('topbar.connect.manage')}</button>
            </div>
          )}
          {connectDropdown && !transportOpen && (
            <div className="mc-topbar__arm-dropdown" style={{ right: 0, minWidth: 200 }} onMouseLeave={() => setConnectDropdown(false)}>
              <div className="flex items-center justify-between mb-1.5">
                <p className="text-[11px] font-bold" style={{ color: 'var(--text-primary)' }}>{t('topbar.connect.selectDevice')}</p>
                <button type="button" className="text-[15px] font-bold leading-none" style={{ color: 'var(--accent)' }} onClick={() => { setConnectDropdown(false); setConnectDialogOpen(true) }} title={t('topbar.connect.addDevice')}>+</button>
              </div>
              {presets.length === 0 && (
                <p className="text-[10px] py-1.5" style={{ color: 'var(--text-disabled)' }}>{t('topbar.connect.noPresets')}</p>
              )}
              {presets.map((p) => (
                <div key={p.id} className="flex items-center gap-2 rounded-md px-2 py-1 hover:bg-[var(--bg-hover)] cursor-pointer group">
                  <button type="button" className="flex-1 text-left text-[11px]" style={{ color: 'var(--text-primary)' }} onClick={() => connectPreset(p)}>
                    <span className="font-semibold">{p.name}</span>
                    <span className="ml-1.5 mc-mono text-[9px]" style={{ color: 'var(--text-disabled)' }}>{p.port}</span>
                  </button>
                  <button type="button" className="opacity-0 group-hover:opacity-100 text-[10px]" style={{ color: 'var(--danger)' }} onClick={() => removePreset(p.id)}>×</button>
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
