import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { availableModes } from '../../../shared/vehicleProfiles'
import { useConnectionStore } from '../../stores/connectionStore'
import { useTelemetryStore } from '../../stores/telemetryStore'
import { useThemeStore } from '../../stores/themeStore'
import { getRestControlHeaders, sendClientMessage } from '../../hooks/useWebSocket'
import {
  loadConnectionPresets,
  resolveSerialPreset,
  saveConnectionPresets,
  type ConnectionPreset,
} from '../../utils/connectionPresets'
import Icon from '../ui/Icon'

const radToDeg = (r: number) => r * 180 / Math.PI

export default function Topbar() {
  const { status, transportOpen, vehicleReady, canControl, port, type, reconnect, setConnectDialogOpen, setStatus, setConnectionError } = useConnectionStore()
  const { theme, toggleTheme } = useThemeStore()
  const reconnecting = status === 'reconnecting'
  const connectionLabel = vehicleReady
    ? (type === 'bluetooth' ? 'BT' : 'USB') + ' · ' + (port ?? '飞控已就绪')
    : transportOpen
      ? '等待飞控'
    : reconnecting
      ? `重连中${reconnect ? ` (${reconnect.attempt}/${reconnect.maxAttempts})` : ''}`
      : status === 'connecting' ? '连接中' : '未连接'

  // Presets for QGC-style connection dropdown
  const [presets, setPresets] = useState(loadConnectionPresets)
  const [connectDropdown, setConnectDropdown] = useState(false)
  const [activeStatusMenu, setActiveStatusMenu] = useState<'mode' | 'arm' | null>(null)
  const [armDragProgress, setArmDragProgress] = useState(0)
  const [armDragging, setArmDragging] = useState(false)
  const topbarRef = useRef<HTMLElement | null>(null)
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
          setConnectionError('未找到与该预设匹配的串口，请重新选择设备。')
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
      let json: { success?: boolean; error?: { message?: string } } | null = null
      if (text) {
        try { json = JSON.parse(text) } catch { /* not JSON */ }
      }
      // A 200 with success=false is still a failure; never report it silently.
      if (!res.ok || !json?.success) {
        const reason = json?.error?.message ?? (text || `HTTP ${res.status}`)
        console.error('[Connect] preset connect failed:', reason)
        setConnectionError(`预设连接失败：${reason}`)
        setStatus('error')
        setConnectDialogOpen(true)
      }
    } catch (error) {
      console.error('[Connect] preset connect failed:', error)
      setConnectionError(`预设连接失败：${error instanceof Error ? error.message : String(error)}`)
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
  const hasGps = !gpsStale && gps && (gps.satellites_visible ?? 0) > 0
  const canArm = vehicleReady && canControl && preflightCheck !== false && sensorsHealthy !== false
  const armTone = confirmedArmed ? 'var(--success)' : canArm ? 'var(--info)' : 'var(--danger)'
  const armLabel = confirmedArmed ? '已解锁' : canArm ? '已上锁 · 可解锁' : vehicleReady ? '已上锁 · 不可解锁' : '飞控未就绪'
  const recentArmErrors = statusLogs
    .filter((entry) => /arm|arming|pre-arm|preflight|解锁|预检/i.test(entry.text))
    .slice(0, 4)

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
      if (!canControl) return
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
    if (!vehicleReady || !canControl || (!confirmedArmed && !canArm)) return
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
            <section className="mc-topbar-menu mc-topbar-menu--arm" aria-label="解锁状态">
              <header>
                <div><strong>{armLabel}</strong><small>{confirmedArmed || canArm ? '将滑块完整拖到右端以确认操作' : '当前不允许操作'}</small></div>
                <span style={{ color: armTone }}>{confirmedArmed ? 'ARMED' : canArm ? 'READY' : 'BLOCKED'}</span>
              </header>
              {(confirmedArmed || canArm) ? (
                <div className="mc-arm-control">
                  <button
                    ref={armSliderRef}
                    type="button"
                    role="slider"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(armDragProgress * 100)}
                    aria-label={confirmedArmed ? '滑动以上锁飞行器' : '滑动以解锁飞行器'}
                    className="mc-arm-slider"
                    data-armed={confirmedArmed}
                    data-dragging={armDragging}
                    disabled={!vehicleReady || !canControl}
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
                  {!vehicleReady && <p>尚未收到飞控有效心跳，飞控未就绪。</p>}
                  {vehicleReady && !canControl && <p>控制权正由另一客户端持有，当前页面为只读。</p>}
                  {vehicleReady && canControl && preflightCheck === false && recentArmErrors.length === 0 && <p>飞控预检未通过，请查看底部状态消息。</p>}
                  {unhealthySensors.length > 0 && <p>传感器异常：{unhealthySensors.join('、')}</p>}
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
            <span className="mc-topbar__status-label">模式</span>
            <span className="mc-topbar__status-value">{vehicle?.mode ?? '—'}</span>
            <Icon name="chevronDown" size={11} />
          </button>
          {activeStatusMenu === 'mode' && (
            <section className="mc-topbar-menu mc-topbar-menu--mode" aria-label="选择飞行模式">
              <header><div><strong>飞行模式</strong><small>{vehicleReady && canControl ? '选择后立即向飞控发送模式切换指令' : '飞控未就绪或当前没有控制权'}</small></div></header>
              <div role="menu">
                {availableModes(vehicleIdentity).length === 0 && (
                  <p className="px-3 py-2 text-[11px]" style={{ color: 'var(--text-secondary)' }}>
                    当前飞控类型尚未适配模式切换（仅支持 PX4 与 ArduCopter）。
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
                <span className="mc-topbar__status-label">姿态</span>
                <span className="mc-topbar__status-value">{radToDeg(attitude.roll).toFixed(1)}° / {radToDeg(attitude.pitch).toFixed(1)}° / {isStale('vfrHud') ? '—' : relativeAlt.toFixed(1)}m</span>
              </span>
            )}
            {!isStale('vfrHud') && (
              <span className="mc-topbar__status-item mc-topbar__status-item--secondary">
                <span className="mc-topbar__status-label">航向</span>
                <span className="mc-topbar__status-value">{heading.toFixed(0)}°</span>
              </span>
            )}
            {hasGps && (
              <span className="mc-topbar__status-item mc-topbar__status-item--secondary">
                <Icon name="satellite" size={13} />
                <span className="mc-topbar__status-value">{gps!.satellites_visible} SAT</span>
              </span>
            )}
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
          title="GitHub 仓库"
          aria-label="打开 GitHub 仓库"
        >
          <Icon name="github" size={16} />
        </a>
        <button
          type="button"
          className="mc-topbar__link"
          title={theme === 'dark' ? '切换到浅色主题' : '切换到深色主题'}
          onClick={toggleTheme}
        >
          <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={16} />
        </button>
        <div className="relative">
          <button
            type="button"
            className={'mc-topbar__connect' + (vehicleReady ? ' is-connected' : transportOpen ? ' is-waiting' : '')}
            onClick={() => { setActiveStatusMenu(null); if (!transportOpen) setPresets(loadConnectionPresets()); setConnectDropdown((v) => !v) }}
          >
            <span className="mc-status-dot" style={{ background: vehicleReady ? 'var(--success)' : (transportOpen || reconnecting || status === 'connecting') ? 'var(--warning)' : 'var(--text-disabled)' }} />
            <span>{connectionLabel}</span>
            <Icon name="chevronDown" size={11} />
          </button>
          {connectDropdown && transportOpen && (
            <div className="mc-topbar__arm-dropdown" style={{ right: 0, minWidth: 200 }} onMouseLeave={() => setConnectDropdown(false)}>
              <p className="mb-1.5 text-[11px] font-bold" style={{ color: 'var(--text-primary)' }}>当前连接</p>
              <div className="mb-2 rounded-md px-2 py-1.5 text-[11px]" style={{ background: 'var(--bg-tertiary)' }}>
                <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>{type === 'bluetooth' ? '蓝牙 SPP' : 'USB 串口'}</span>
                <span className="ml-1.5 mc-mono text-[10px]" style={{ color: 'var(--text-secondary)' }}>{port ?? '—'}</span>
              </div>
              <button type="button" className="mc-btn mc-btn-danger w-full py-1.5 text-[11px]" onClick={disconnectTransport}>断开连接</button>
              <button type="button" className="mc-btn mc-btn-ghost mt-1.5 w-full py-1.5 text-[11px]" onClick={() => { setConnectDropdown(false); setConnectDialogOpen(true) }}>连接管理…</button>
            </div>
          )}
          {connectDropdown && !transportOpen && (
            <div className="mc-topbar__arm-dropdown" style={{ right: 0, minWidth: 200 }} onMouseLeave={() => setConnectDropdown(false)}>
              <div className="flex items-center justify-between mb-1.5">
                <p className="text-[11px] font-bold" style={{ color: 'var(--text-primary)' }}>选择设备</p>
                <button type="button" className="text-[15px] font-bold leading-none" style={{ color: 'var(--accent)' }} onClick={() => { setConnectDropdown(false); setConnectDialogOpen(true) }} title="添加设备">+</button>
              </div>
              {presets.length === 0 && (
                <p className="text-[10px] py-1.5" style={{ color: 'var(--text-disabled)' }}>暂无预设设备</p>
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
        </div>
      </div>
    </header>
  )
}
