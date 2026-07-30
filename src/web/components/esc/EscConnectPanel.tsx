import { useState } from 'react'
import { sendClientMessage } from '../../hooks/useWebSocket'
import { useConnectionStore } from '../../stores/connectionStore'
import { useEscStore } from '../../stores/escStore'
import { useParameterStore } from '../../stores/parameterStore'
import { useTelemetryStore } from '../../stores/telemetryStore'
import Icon from '../ui/Icon'

type PanelMode = 'ardupilot_passthrough' | 'px4_serial_control' | 'direct'

const PX4_DEFAULT_CHANNELS = [20, 21, 22, 23]

function paramValue(params: Map<string, { value: number }>, id: string): number | null {
  return params.has(id) ? params.get(id)!.value : null
}

/**
 * ESC session connection panel: picks the platform-appropriate passthrough
 * path, shows precondition checks and starts/stops the session. Read-only
 * milestone: no settings/flash controls yet.
 */
export default function EscConnectPanel() {
  const session = useEscStore((state) => state.session)
  const family = useTelemetryStore((state) => state.vehicleIdentity?.family ?? 'unknown')
  const linkType = useConnectionStore((state) => state.type)
  const vehicleReady = useConnectionStore((state) => state.vehicleReady)
  const canControl = useConnectionStore((state) => state.canControl)
  const params = useParameterStore((state) => state.params)
  const [directPort, setDirectPort] = useState('')

  const active = session !== null && session.state !== 'idle'
  const busy = session?.state === 'entering' || session?.state === 'exiting'
  const isBluetooth = linkType === 'bluetooth'

  const defaultMode: PanelMode = family === 'px4' ? 'px4_serial_control' : 'ardupilot_passthrough'
  const [mode, setMode] = useState<PanelMode>(defaultMode)

  const blhAuto = paramValue(params, 'SERVO_BLH_AUTO')
  const blhMask = paramValue(params, 'SERVO_BLH_MASK')
  const passthruEn = paramValue(params, 'PASSTHRU_EN')
  const ardupilotReady = blhAuto === 1 || (blhMask !== null && blhMask > 0)

  const startSession = () => {
    if (mode === 'direct') {
      const port = directPort.trim()
      if (!port) return
      sendClientMessage({ type: 'esc_session_start', data: { mode: 'direct', port, baudRate: 19200 } })
      return
    }
    if (mode === 'px4_serial_control') {
      sendClientMessage({ type: 'esc_session_start', data: { mode: 'px4_serial_control', channels: PX4_DEFAULT_CHANNELS } })
      return
    }
    sendClientMessage({ type: 'esc_session_start', data: { mode: 'ardupilot_passthrough' } })
  }

  const exitSession = () => {
    if (session?.sessionId) {
      sendClientMessage({ type: 'esc_session_exit', data: { sessionId: session.sessionId } })
    }
  }

  const rescan = () => {
    if (session?.sessionId) {
      sendClientMessage({ type: 'esc_devices_scan', data: { sessionId: session.sessionId } })
    }
  }

  const requiresReadyTarget = mode !== 'direct'
  const ardupilotBlocked = mode === 'ardupilot_passthrough' && isBluetooth
  const canStart =
    !active
    && !busy
    && canControl
    && !ardupilotBlocked
    && (mode === 'direct' ? directPort.trim().length > 0 : vehicleReady)
    && (mode === 'ardupilot_passthrough' ? ardupilotReady : true)

  return (
    <section className="mc-card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div className="mc-section-title">电调直通</div>

      {active ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <p style={{ margin: 0, fontSize: 13 }}>
            会话状态：<strong>{session?.state}</strong>
            {session?.mode ? `（${session.mode}）` : ''}
          </p>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="mc-btn mc-btn-ghost" onClick={rescan} disabled={busy}>
              <Icon name="refresh" size={16} /> 重新扫描
            </button>
            <button type="button" className="mc-btn mc-btn-danger" onClick={exitSession} disabled={busy}>
              退出直通
            </button>
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <ModeButton current={mode} value="ardupilot_passthrough" label="ArduPilot 直通" onSelect={setMode} />
            <ModeButton current={mode} value="px4_serial_control" label="PX4 SERIAL_CONTROL" onSelect={setMode} />
            <ModeButton current={mode} value="direct" label="USB 直连" onSelect={setMode} />
          </div>

          {mode === 'ardupilot_passthrough' && (
            <PreconditionList
              items={[
                { ok: !isBluetooth, text: isBluetooth ? '蓝牙链路不支持 ESC 直通，请改用 USB' : '使用 USB 串口连接' },
                { ok: ardupilotReady, text: ardupilotReady ? 'SERVO_BLH_AUTO/MASK 已启用' : '需设置 SERVO_BLH_AUTO=1 或 SERVO_BLH_MASK 并重启飞控' },
                { ok: vehicleReady, text: vehicleReady ? '飞控心跳就绪' : '等待飞控心跳' },
              ]}
            />
          )}
          {mode === 'px4_serial_control' && (
            <PreconditionList
              items={[
                { ok: passthruEn === 1, text: passthruEn === 1 ? 'PASSTHRU_EN 已启用' : '需设置 PASSTHRU_EN=1 并重启飞控（需 bitbang 固件）' },
                { ok: vehicleReady, text: vehicleReady ? '飞控心跳就绪' : '等待飞控心跳' },
              ]}
            />
          )}
          {mode === 'direct' && (
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
              <span style={{ color: 'var(--text-secondary)' }}>USB 串口端口（19200 波特）</span>
              <input
                className="mc-input"
                value={directPort}
                placeholder="例如 COM7 或 /dev/ttyUSB0"
                onChange={(event) => setDirectPort(event.target.value)}
              />
            </label>
          )}

          {!canControl && requiresReadyTarget && (
            <p style={{ margin: 0, fontSize: 12, color: 'var(--warning)' }}>需要先获取飞控控制权。</p>
          )}

          <button type="button" className="mc-btn mc-btn-primary" onClick={startSession} disabled={!canStart}>
            <Icon name="plug" size={16} /> 进入 ESC 配置
          </button>
        </div>
      )}
    </section>
  )
}

function ModeButton({
  current,
  value,
  label,
  onSelect,
}: {
  current: PanelMode
  value: PanelMode
  label: string
  onSelect: (mode: PanelMode) => void
}) {
  return (
    <button
      type="button"
      className={current === value ? 'mc-btn mc-btn-primary' : 'mc-btn mc-btn-ghost'}
      onClick={() => onSelect(value)}
    >
      {label}
    </button>
  )
}

function PreconditionList({ items }: { items: Array<{ ok: boolean; text: string }> }) {
  return (
    <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
      {items.map((item, index) => (
        <li key={index} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
          <span style={{ color: item.ok ? 'var(--success)' : 'var(--warning)' }}>
            <Icon name={item.ok ? 'check' : 'warning'} size={14} />
          </span>
          <span style={{ color: item.ok ? 'var(--text-secondary)' : 'var(--warning)' }}>{item.text}</span>
        </li>
      ))}
    </ul>
  )
}
