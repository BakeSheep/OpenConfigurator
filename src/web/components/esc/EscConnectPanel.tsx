import { useEffect, useState } from 'react'
import { sendClientMessage } from '../../hooks/useWebSocket'
import { useConnectionStore } from '../../stores/connectionStore'
import { useEscStore } from '../../stores/escStore'
import { useParameterStore } from '../../stores/parameterStore'
import { useTelemetryStore } from '../../stores/telemetryStore'
import Icon from '../ui/Icon'

type PanelMode = 'ardupilot_passthrough' | 'px4_serial_control' | 'direct'

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
  const session = useEscStore((state) => state.session)
  const family = useTelemetryStore((state) => state.vehicleIdentity?.family ?? 'unknown')
  const linkType = useConnectionStore((state) => state.type)
  const port = useConnectionStore((state) => state.port)
  const baudRate = useConnectionStore((state) => state.baudRate)
  const transportOpen = useConnectionStore((state) => state.transportOpen)
  const vehicleReady = useConnectionStore((state) => state.vehicleReady)
  const canControl = useConnectionStore((state) => state.canControl)
  const clientId = useConnectionStore((state) => state.clientId)
  const params = useParameterStore((state) => state.params)
  const lastWriteResult = useParameterStore((state) => state.lastWriteResult)

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
      setWriteMessage(`写入失败：${lastWriteResult.reason ?? '飞控未确认'}`)
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
      setWriteMessage('已恢复开启前参数，重启飞控后生效。')
    } else {
      setWriteMessage('直通参数已开启，重启飞控后生效。')
    }
    setPendingWrite(null)
  }, [lastWriteResult, pendingWrite, setupParamId])

  const togglePassthrough = () => {
    if (!setupParam || !vehicleReady || !canControl || active || pendingWrite) return
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
    && (mode === 'direct' ? directReady : vehicleReady)
    && (mode === 'ardupilot_passthrough' ? ardupilotReady && dshotReady : true)
    && (mode === 'px4_serial_control' ? px4Ready : true)

  return (
    <section className="mc-card mc-esc-connect">
      <div className="mc-esc-connect__header">
        <div>
          <div className="mc-section-title">连接与直通</div>
          <p>建立参数通道并检查飞控前置条件；直通参数支持恢复到开启前的值。</p>
        </div>
        {active && <span className="mc-esc-session-badge">{session?.state}</span>}
      </div>

      <div className="mc-esc-connect__body">
        <div className="mc-esc-mode-picker" role="group" aria-label="电调连接方式">
          <ModeButton current={effectiveMode} value="ardupilot_passthrough" label="ArduPilot 直通" onSelect={setMode} disabled={active} />
          <ModeButton current={effectiveMode} value="px4_serial_control" label="PX4 SERIAL_CONTROL" onSelect={setMode} disabled={active} />
          <ModeButton current={effectiveMode} value="direct" label="复用当前 USB" onSelect={setMode} disabled={active} />
        </div>

        <div className="mc-esc-connect__cards">
          <section className="mc-esc-connect-card" aria-labelledby="esc-preconditions-title">
            <header>
              <h3 id="esc-preconditions-title">连接前置条件</h3>
            </header>

            {effectiveMode === 'ardupilot_passthrough' && (
              <PreconditionList items={[
                { ok: !isBluetooth, text: isBluetooth ? '蓝牙链路不支持 ESC 直通，请改用 USB' : '当前连接为 USB 串口' },
                { ok: ardupilotReady, text: ardupilotReady ? 'SERVO_BLH_AUTO/MASK 已启用' : '需要开启直通参数' },
                { ok: dshotReady, text: dshotReady ? `电机输出为 DShot（MOT_PWM_TYPE=${motorPwmType}）` : 'MOT_PWM_TYPE 必须使用 DShot' },
                { ok: vehicleReady || active, text: vehicleReady ? '飞控心跳就绪' : active ? 'ESC 会话已独占串口' : '等待飞控心跳' },
              ]} />
            )}
            {effectiveMode === 'px4_serial_control' && (
              <PreconditionList items={[
                { ok: px4Ready, text: px4Ready ? 'PASSTHRU_EN 已启用' : '需要开启 PASSTHRU_EN（需 bitbang 固件）' },
                { ok: vehicleReady, text: vehicleReady ? '飞控心跳就绪' : '等待飞控心跳' },
              ]} />
            )}
            {effectiveMode === 'direct' && (
              <div className="mc-esc-current-link" data-ready={directReady || undefined}>
                <Icon name={directReady ? 'check' : 'warning'} size={16} />
                <div>
                  <strong>{transportOpen && linkType === 'serial' ? (port ?? '当前 USB 串口') : '尚未连接 USB 串口'}</strong>
                  <span>{directReady ? '将直接复用此连接的原始字节通道' : `请先通过连接面板以 19200 波特打开 USB 适配器${baudRate ? `（当前 ${baudRate}）` : ''}`}</span>
                </div>
              </div>
            )}
          </section>

          <section className="mc-esc-connect-card mc-esc-connect-card--actions" aria-labelledby="esc-actions-title">
            <header>
              <h3 id="esc-actions-title">直通与 ESC 配置</h3>
            </header>

            {effectiveMode !== 'direct' && (
              <div className="mc-esc-toggle-row" data-enabled={setupEnabled || undefined}>
                <div>
                  <strong>{setupEnabled ? '直通参数已开启' : '直通参数已关闭'}</strong>
                  <span>
                    {setupParam
                      ? setupEnabled
                        ? `关闭后恢复 ${setupParamId}=${backup?.value ?? 0}`
                        : `开启时保存 ${setupParamId} 当前值，关闭时自动写回`
                      : `参数 ${setupParamId} 尚未同步`}
                  </span>
                  {writeMessage && <small data-success={!writeMessage.startsWith('写入失败') || undefined}>{writeMessage}</small>}
                  {active && <small>请先退出下方 ESC 会话，再修改直通开关。</small>}
                </div>
                <button
                  type="button"
                  className="mc-switch"
                  role="switch"
                  aria-checked={setupEnabled}
                  aria-label={setupEnabled ? '关闭电调直通并恢复原参数' : '开启电调直通'}
                  disabled={!setupParam || !vehicleReady || !canControl || active || pendingWrite !== null}
                  onClick={togglePassthrough}
                >
                  <span />
                </button>
              </div>
            )}

            {!canControl && !active && <p className="mc-esc-warning">需要先获取飞控控制权。</p>}

            {active ? (
              <div className="mc-esc-session-row">
                <div>
                  <strong>参数会话已连接</strong>
                  <span className="mc-mono">{session?.mode} · {session?.sessionId?.slice(0, 8)}</span>
                </div>
                <div className="mc-esc-actions">
                  <button type="button" className="mc-btn mc-btn-ghost" onClick={rescan} disabled={busy || !ownsSession}>
                    <Icon name="refresh" size={16} /> 重新扫描
                  </button>
                  <button type="button" className="mc-btn mc-btn-danger" onClick={exitSession} disabled={busy || !ownsSession}>
                    退出 ESC 配置
                  </button>
                </div>
              </div>
            ) : (
              <div className="mc-esc-connect__footer">
                <button type="button" className="mc-btn mc-btn-primary" onClick={startSession} disabled={!canStart}>
                  <Icon name="plug" size={16} /> 进入 ESC 配置
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
