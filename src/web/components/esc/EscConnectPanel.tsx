import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { sendClientMessage } from '../../hooks/useWebSocket'
import { useConnectionStore } from '../../stores/connectionStore'
import { useEscStore } from '../../stores/escStore'
import { useParameterStore } from '../../stores/parameterStore'
import { useTelemetryStore } from '../../stores/telemetryStore'
import {
  escModeAllowedForProfile,
  passthroughParamWriteError,
  type EscConnectionMode,
} from '../../utils/escConnectionPolicy'
import Icon from '../ui/Icon'

type PanelMode = EscConnectionMode

interface PassthroughBackup {
  paramId: string
  value: number
  paramType: number
}

const PX4_DEFAULT_CHANNELS = [20, 21, 22, 23]
const PASSTHROUGH_BACKUP_PREFIX = 'openconfigurator:esc-passthrough-backup:'

function backupKey(paramId: string): string {
  return `${PASSTHROUGH_BACKUP_PREFIX}${paramId}`
}

function loadBackup(paramId: string): PassthroughBackup | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(backupKey(paramId)) ?? 'null') as Partial<PassthroughBackup> | null
    return parsed?.paramId === paramId
      && typeof parsed.value === 'number'
      && Number.isFinite(parsed.value)
      && typeof parsed.paramType === 'number'
      ? { paramId, value: parsed.value, paramType: parsed.paramType }
      : null
  } catch {
    return null
  }
}

/** ESC session connection and passthrough-preflight panel. */
export default function EscConnectPanel() {
  const { t } = useTranslation()
  const session = useEscStore((state) => state.session)
  const vehicleIdentity = useTelemetryStore((state) => state.vehicleIdentity)
  const family = vehicleIdentity?.family ?? 'unknown'
  const linkType = useConnectionStore((state) => state.type)
  const port = useConnectionStore((state) => state.port)
  const baudRate = useConnectionStore((state) => state.baudRate)
  const transportOpen = useConnectionStore((state) => state.transportOpen)
  const vehicleReady = useConnectionStore((state) => state.vehicleReady)
  const canControl = useConnectionStore((state) => state.canControl)
  const clientId = useConnectionStore((state) => state.clientId)
  const params = useParameterStore((state) => state.params)
  const lastWriteResult = useParameterStore((state) => state.lastWriteResult)
  const lastOperationError = useTelemetryStore((state) => state.lastOperationError)

  const defaultMode: PanelMode = family === 'px4' ? 'px4_serial_control' : 'ardupilot_passthrough'
  const [mode, setMode] = useState<PanelMode>(defaultMode)
  const [backup, setBackup] = useState<PassthroughBackup | null>(null)
  const [pendingWrite, setPendingWrite] = useState<{ requestId: string; restoring: boolean } | null>(null)
  const [writeMessage, setWriteMessage] = useState<string | null>(null)

  const active = session !== null && session.state !== 'idle'
  const busy = session?.state === 'entering' || session?.state === 'exiting' || session?.activeJobId != null
  const ownsSession = session?.ownerClientId === clientId
  const isBluetooth = linkType === 'bluetooth'
  const effectiveMode = active && session?.mode ? session.mode : mode

  useEffect(() => {
    if (!active) setMode(defaultMode)
  }, [active, defaultMode])

  const blhAuto = params.get('SERVO_BLH_AUTO')
  const blhMask = params.get('SERVO_BLH_MASK')
  const passthruEn = params.get('PASSTHRU_EN')
  const motorPwmType = params.get('MOT_PWM_TYPE')?.value
  const dshotReady = motorPwmType != null && motorPwmType >= 4 && motorPwmType <= 7
  const ardupilotReady = blhAuto?.value === 1 || (blhMask?.value != null && blhMask.value > 0)
  const px4Ready = passthruEn?.value === 1
  const directReady = transportOpen && linkType === 'serial' && baudRate === 19200
  const profileAllowsMode = escModeAllowedForProfile(vehicleIdentity, effectiveMode)
  const setupParam = effectiveMode === 'ardupilot_passthrough'
    ? blhAuto
    : effectiveMode === 'px4_serial_control'
      ? passthruEn
      : null
  const setupParamId = effectiveMode === 'ardupilot_passthrough' ? 'SERVO_BLH_AUTO' : 'PASSTHRU_EN'
  const setupEnabled = setupParam?.value === 1

  useEffect(() => {
    setBackup(loadBackup(setupParamId))
    setWriteMessage(null)
    setPendingWrite(null)
  }, [setupParamId])

  useEffect(() => {
    if (!pendingWrite || lastWriteResult?.requestId !== pendingWrite.requestId) return
    if (!lastWriteResult.accepted) {
      setWriteMessage(t('escConnect.writeFailed', { reason: lastWriteResult.reason ?? t('escConnect.fcNotConfirmed') }))
      setPendingWrite(null)
      return
    }
    if (pendingWrite.restoring) {
      try {
        localStorage.removeItem(backupKey(setupParamId))
      } catch {
        // See saveBackup: storage is best-effort only.
      }
      setBackup(null)
      setWriteMessage(t('escConnect.restoredMessage'))
    } else {
      setWriteMessage(t('escConnect.passthroughEnabledMessage'))
    }
    setPendingWrite(null)
  }, [lastWriteResult, pendingWrite, setupParamId])

  useEffect(() => {
    const message = passthroughParamWriteError(
      pendingWrite?.requestId ?? null,
      lastOperationError,
    )
    if (message === null) return
    setWriteMessage(t('escConnect.writeFailed', { reason: message }))
    setPendingWrite(null)
  }, [lastOperationError, pendingWrite])

  const togglePassthrough = () => {
    if (
      !setupParam
      || !vehicleReady
      || !canControl
      || !profileAllowsMode
      || active
      || pendingWrite
    ) return
    const restoring = setupEnabled
    let restorePoint = backup
    if (!restoring && !restorePoint) {
      restorePoint = { paramId: setupParamId, value: setupParam.value, paramType: setupParam.type }
      try {
        localStorage.setItem(backupKey(setupParamId), JSON.stringify(restorePoint))
      } catch {
        // Keep the in-memory copy when persistent storage is unavailable.
      }
      setBackup(restorePoint)
    }
    const requestId = `esc-setup-${Date.now().toString(36)}`
    const value = restoring ? (restorePoint?.value ?? 0) : 1
    setWriteMessage(null)
    setPendingWrite({ requestId, restoring })
    sendClientMessage({
      type: 'param_set',
      requestId,
      data: { id: setupParamId, value, paramType: restorePoint?.paramType ?? setupParam.type },
    })
  }

  const startSession = () => {
    if (mode === 'direct') {
      sendClientMessage({ type: 'esc_session_start', data: { mode: 'direct' } })
    } else if (mode === 'px4_serial_control') {
      sendClientMessage({ type: 'esc_session_start', data: { mode: 'px4_serial_control', channels: PX4_DEFAULT_CHANNELS } })
    } else {
      sendClientMessage({ type: 'esc_session_start', data: { mode: 'ardupilot_passthrough' } })
    }
  }

  const exitSession = () => {
    if (session?.sessionId) sendClientMessage({ type: 'esc_session_exit', data: { sessionId: session.sessionId } })
  }

  const rescan = () => {
    if (session?.sessionId) sendClientMessage({ type: 'esc_devices_scan', data: { sessionId: session.sessionId } })
  }

  const ardupilotBlocked = mode === 'ardupilot_passthrough' && isBluetooth
  const canStart = !active
    && !busy
    && canControl
    && !ardupilotBlocked
    && escModeAllowedForProfile(vehicleIdentity, mode)
    && (mode === 'direct' ? directReady : vehicleReady)
    && (mode === 'ardupilot_passthrough' ? ardupilotReady && dshotReady : true)
    && (mode === 'px4_serial_control' ? px4Ready : true)

  return (
    <section className="mc-card mc-esc-connect">
      <div className="mc-esc-connect__header">
        <div>
          <div className="mc-section-title">{t('escConnect.title')}</div>
          <p>{t('escConnect.subtitle')}</p>
        </div>
        {active && <span className="mc-esc-session-badge">{session?.state}</span>}
      </div>

      <div className="mc-esc-connect__body">
        <div className="mc-esc-mode-picker" role="group" aria-label={t('escConnect.modeAriaLabel')}>
          <ModeButton current={effectiveMode} value="ardupilot_passthrough" label={t('escConnect.modeArduPilot')} onSelect={setMode} disabled={active} />
          <ModeButton current={effectiveMode} value="px4_serial_control" label="PX4 SERIAL_CONTROL" onSelect={setMode} disabled={active} />
          <ModeButton current={effectiveMode} value="direct" label={t('escConnect.modeDirectUsb')} onSelect={setMode} disabled={active} />
        </div>

        <div className="mc-esc-connect__cards">
          <section className="mc-esc-connect-card" aria-labelledby="esc-preconditions-title">
            <header>
              <h3 id="esc-preconditions-title">{t('escConnect.preconditionsTitle')}</h3>
            </header>

            {effectiveMode === 'ardupilot_passthrough' && (
              <PreconditionList items={[
                { ok: !isBluetooth, text: isBluetooth ? t('escConnect.precondBluetoothBlocked') : t('escConnect.precondUsbConnected') },
                { ok: ardupilotReady, text: ardupilotReady ? t('escConnect.precondBlhEnabled') : t('escConnect.precondNeedPassthrough') },
                { ok: dshotReady, text: dshotReady ? t('escConnect.precondDshotReady', { value: motorPwmType }) : t('escConnect.precondDshotRequired') },
                { ok: vehicleReady || active, text: vehicleReady ? t('escConnect.precondHeartbeatReady') : active ? t('escConnect.precondSessionExclusive') : t('escConnect.precondWaitingHeartbeat') },
              ]} />
            )}
            {effectiveMode === 'px4_serial_control' && (
              <PreconditionList items={[
                { ok: px4Ready, text: px4Ready ? t('escConnect.precondPassthruEnEnabled') : t('escConnect.precondNeedPassthruEn') },
                { ok: vehicleReady, text: vehicleReady ? t('escConnect.precondHeartbeatReady') : t('escConnect.precondWaitingHeartbeat') },
              ]} />
            )}
            {effectiveMode === 'direct' && (
              <div className="mc-esc-current-link" data-ready={directReady || undefined}>
                <Icon name={directReady ? 'check' : 'warning'} size={16} />
                <div>
                  <strong>{transportOpen && linkType === 'serial' ? (port ?? t('escConnect.currentUsbPort')) : t('escConnect.usbNotConnected')}</strong>
                  <span>{directReady ? t('escConnect.directReuseReady') : (baudRate ? t('escConnect.directOpenHintWithBaud', { baudRate }) : t('escConnect.directOpenHint'))}</span>
                </div>
              </div>
            )}
          </section>

          <section className="mc-esc-connect-card mc-esc-connect-card--actions" aria-labelledby="esc-actions-title">
            <header>
              <h3 id="esc-actions-title">{t('escConnect.actionsTitle')}</h3>
            </header>

            {effectiveMode !== 'direct' && (
              <div className="mc-esc-toggle-row" data-enabled={setupEnabled || undefined}>
                <div>
                  <strong>{setupEnabled ? t('escConnect.passthroughOn') : t('escConnect.passthroughOff')}</strong>
                  <span>
                    {setupParam
                      ? setupEnabled
                        ? t('escConnect.toggleRestoreHint', { paramId: setupParamId, value: backup?.value ?? 0 })
                        : t('escConnect.toggleSaveHint', { paramId: setupParamId })
                      : t('escConnect.paramNotSynced', { paramId: setupParamId })}
                  </span>
                  {writeMessage && <small data-success={!writeMessage.startsWith(t('escConnect.writeFailedPrefix')) || undefined}>{writeMessage}</small>}
                  {active && <small>{t('escConnect.exitSessionFirstHint')}</small>}
                </div>
                <button
                  type="button"
                  className="mc-switch"
                  role="switch"
                  aria-checked={setupEnabled}
                  aria-label={setupEnabled ? t('escConnect.ariaDisablePassthrough') : t('escConnect.ariaEnablePassthrough')}
                  disabled={!setupParam
                    || !vehicleReady
                    || !canControl
                    || !profileAllowsMode
                    || active
                    || pendingWrite !== null}
                  onClick={togglePassthrough}
                >
                  <span />
                </button>
              </div>
            )}

            {!canControl && !active && <p className="mc-esc-warning">{t('escConnect.needControlWarning')}</p>}
            {effectiveMode !== 'direct' && !profileAllowsMode && !active && (
              <p className="mc-esc-warning">{t('escConnect.profileNotSupportedWarning')}</p>
            )}

            {active ? (
              <div className="mc-esc-session-row">
                <div>
                  <strong>{t('escConnect.sessionConnected')}</strong>
                  <span className="mc-mono">{session?.mode} · {session?.sessionId?.slice(0, 8)}</span>
                </div>
                <div className="mc-esc-actions">
                  <button type="button" className="mc-btn mc-btn-ghost" onClick={rescan} disabled={busy || !ownsSession}>
                    <Icon name="refresh" size={16} /> {t('escConnect.rescan')}
                  </button>
                  <button type="button" className="mc-btn mc-btn-danger" onClick={exitSession} disabled={busy || !ownsSession}>
                    {t('escConnect.exitEscConfig')}
                  </button>
                </div>
              </div>
            ) : (
              <div className="mc-esc-connect__footer">
                <button type="button" className="mc-btn mc-btn-primary" onClick={startSession} disabled={!canStart}>
                  <Icon name="plug" size={16} /> {t('escConnect.enterEscConfig')}
                </button>
              </div>
            )}
          </section>
        </div>
      </div>
    </section>
  )
}

function ModeButton({ current, value, label, onSelect, disabled }: {
  current: PanelMode
  value: PanelMode
  label: string
  onSelect: (mode: PanelMode) => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      className={current === value ? 'mc-btn mc-btn-primary' : 'mc-btn mc-btn-ghost'}
      aria-pressed={current === value}
      disabled={disabled}
      onClick={() => onSelect(value)}
    >
      {label}
    </button>
  )
}

function PreconditionList({ items }: { items: Array<{ ok: boolean; text: string }> }) {
  return (
    <ul className="mc-esc-preconditions">
      {items.map((item) => (
        <li key={item.text} data-ok={item.ok || undefined}>
          <Icon name={item.ok ? 'check' : 'warning'} size={14} />
          <span>{item.text}</span>
        </li>
      ))}
    </ul>
  )
}
