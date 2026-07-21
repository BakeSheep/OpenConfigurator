import { useCallback, useEffect, useRef, useState } from 'react'
import GamepadVisualizer from '../components/gamepad/GamepadVisualizer'
import Icon from '../components/ui/Icon'
import { PageHeader, PageTabs } from '../components/ui/PageFrame'
import { useWebSocket } from '../hooks/useWebSocket'
import { useConnectionStore } from '../stores/connectionStore'
import { useGamepadStore } from '../stores/gamepadStore'

const tabs = [
  { id: 'overview', label: '手柄状态' },
  { id: 'mapping', label: '通道映射' },
  { id: 'monitor', label: '输入监视' },
]

const mappingLabels = [
  { key: 'throttle', label: '油门', channel: 'CH3' },
  { key: 'yaw', label: '偏航', channel: 'CH4' },
  { key: 'pitch', label: '俯仰', channel: 'CH2' },
  { key: 'roll', label: '横滚', channel: 'CH1' },
] as const

function StatusLine({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <div className="flex items-center justify-between border-b py-3 last:border-b-0" style={{ borderColor: 'var(--border)' }}>
      <span className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>{label}</span>
      <span className="flex items-center gap-2 text-[12px] font-semibold" style={{ color: tone }}>
        <span className="mc-status-dot" style={{ background: tone }} />
        {value}
      </span>
    </div>
  )
}

export default function JoystickPage() {
  const {
    connected,
    id,
    axes,
    buttons,
    mapping,
    deadzone,
    expo,
    enabled,
    setConnected,
    setAxes,
    setButtons,
    setEnabled,
    setDeadzone,
    setExpo,
    setMapping,
  } = useGamepadStore()
  const { send } = useWebSocket()
  const [activeTab, setActiveTab] = useState('overview')
  const rafRef = useRef<number>(0)
  const lastSendRef = useRef(0)
  const flightControllerConnected = useConnectionStore((state) => state.status === 'connected')

  const stateRef = useRef({ connected, enabled, deadzone, expo, mapping })
  stateRef.current = { connected, enabled, deadzone, expo, mapping }
  const actionsRef = useRef({ setConnected, setAxes, setButtons, send })
  actionsRef.current = { setConnected, setAxes, setButtons, send }

  // Release RC override (all channels 0 = return to normal RC input) when
  // control is disabled or the gamepad disconnects, so PX4 does not keep
  // applying the last override values (a safety hazard if the last frame
  // carried throttle input).
  const releaseOverride = useCallback(() => {
    actionsRef.current.send({
      type: 'rc_channels_override',
      data: { ch1: 0, ch2: 0, ch3: 0, ch4: 0, ch5: 0, ch6: 0, ch7: 0, ch8: 0 },
    })
  }, [])

  useEffect(() => {
    if (!enabled) releaseOverride()
  }, [enabled, releaseOverride])

  useEffect(() => {
    if (!connected) releaseOverride()
  }, [connected, releaseOverride])

  useEffect(() => {
    const unsubscribe = useConnectionStore.subscribe((state) => {
      if (state.status !== 'connected' && useGamepadStore.getState().enabled) {
        useGamepadStore.getState().setEnabled(false)
      }
    })
    return unsubscribe
  }, [])

  useEffect(() => {
    const pollGamepad = () => {
      const current = stateRef.current
      const actions = actionsRef.current
      const controllerConnected = useConnectionStore.getState().status === 'connected'
      const gamepads = navigator.getGamepads()
      const gamepad = gamepads[0] || gamepads[1] || gamepads[2] || gamepads[3]

      if (gamepad) {
        if (!current.connected) actions.setConnected(true, gamepad.id)
        actions.setAxes(Array.from(gamepad.axes))
        actions.setButtons(gamepad.buttons.map((button) => button.pressed))

        if (current.enabled && controllerConnected && Date.now() - lastSendRef.current > 50) {
          lastSendRef.current = Date.now()
          const applyDeadzone = (value: number) => {
            if (Math.abs(value) < current.deadzone) return 0
            const sign = value >= 0 ? 1 : -1
            const normalized = (Math.abs(value) - current.deadzone) / (1 - current.deadzone)
            return sign * Math.pow(normalized, 1 + current.expo)
          }
          const toPwm = (value: number) => Math.round(1500 + applyDeadzone(value) * 500)
          actions.send({
            type: 'rc_channels_override',
            data: {
              ch1: toPwm(gamepad.axes[current.mapping.roll] ?? 0),
              ch2: toPwm(-(gamepad.axes[current.mapping.pitch] ?? 0)),
              ch3: toPwm(-(gamepad.axes[current.mapping.throttle] ?? 0)),
              ch4: toPwm(gamepad.axes[current.mapping.yaw] ?? 0),
              ch5: 1500,
              ch6: 1500,
              ch7: 1500,
              ch8: 1500,
            },
          })
        }
      } else if (current.connected) {
        actions.setConnected(false)
      }

      rafRef.current = requestAnimationFrame(pollGamepad)
    }

    rafRef.current = requestAnimationFrame(pollGamepad)
    return () => cancelAnimationFrame(rafRef.current)
  }, [])

  const axisCount = Math.max(axes.length, 4)

  return (
    <div className="mc-workspace mc-fade-in">
      <PageHeader
        title="游戏手柄"
        description="将 USB 或蓝牙游戏手柄映射为 RC 通道输入"
        actions={
          <span className="flex items-center gap-2 rounded-full px-3 py-2 text-[11px] font-semibold" style={{ background: connected ? 'var(--success-dim)' : 'var(--bg-tertiary)', color: connected ? 'var(--success)' : 'var(--text-disabled)' }}>
            <span className="mc-status-dot" style={{ background: connected ? 'var(--success)' : 'var(--text-disabled)' }} />
            {connected ? '已检测到手柄' : '等待手柄'}
          </span>
        }
      />

      <PageTabs tabs={tabs} active={activeTab} onChange={setActiveTab} />

      {activeTab === 'overview' && (
        <section className="mt-5 grid grid-cols-1 gap-4 2xl:grid-cols-[1.45fr_0.85fr]">
          <div className="mc-card overflow-hidden">
            <div className="border-b px-5 py-4" style={{ borderColor: 'var(--border)' }}>
              <h2 className="text-[14px] font-bold" style={{ color: 'var(--text-primary)' }}>当前手柄可视化</h2>
              <p className="mt-1 text-[11px]" style={{ color: 'var(--text-secondary)' }}>摇杆位置与按键状态会随物理手柄实时更新。</p>
            </div>
            <div className="p-5">
              <GamepadVisualizer connected={connected} axes={axes} buttons={buttons} mapping={mapping} />
            </div>
          </div>

          <div className="space-y-4">
            <section className="mc-card p-5">
              <h2 className="text-[14px] font-bold" style={{ color: 'var(--text-primary)' }}>连接状态</h2>
              <div className="mt-3">
                <StatusLine label="游戏手柄" value={connected ? id ?? '已连接' : '未检测到设备'} tone={connected ? 'var(--success)' : 'var(--text-disabled)'} />
                <StatusLine label="飞控链路" value={flightControllerConnected ? '已连接' : '未连接'} tone={flightControllerConnected ? 'var(--success)' : 'var(--text-disabled)'} />
                <StatusLine label="RC 覆盖" value={enabled ? '已手动启用' : '未启用'} tone={enabled ? 'var(--accent)' : 'var(--text-disabled)'} />
              </div>
            </section>

            <section className="mc-card p-5">
              <div className="flex items-start gap-3">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl" style={{ background: 'var(--warning-dim)', color: 'var(--warning)' }}><Icon name="warning" size={18} /></span>
                <div>
                  <h2 className="text-[14px] font-bold" style={{ color: 'var(--text-primary)' }}>安全控制</h2>
                  <p className="mt-1 text-[11px] leading-5" style={{ color: 'var(--text-secondary)' }}>手柄不会自动接管飞控；飞控断链后会立刻停止并关闭 RC 覆盖。</p>
                </div>
              </div>
              <label className="mt-5 flex cursor-pointer items-center justify-between rounded-xl border p-3" style={{ borderColor: enabled ? 'var(--accent)' : 'var(--border)', background: enabled ? 'var(--accent-dim)' : 'var(--bg-secondary)' }}>
                <span>
                  <span className="block text-[13px] font-bold" style={{ color: 'var(--text-primary)' }}>启用手柄控制</span>
                  <span className="mt-0.5 block text-[10px]" style={{ color: 'var(--text-secondary)' }}>RC_CHANNELS_OVERRIDE · 20 Hz</span>
                </span>
                <input
                  type="checkbox"
                  checked={enabled}
                  disabled={!connected || !flightControllerConnected}
                  onChange={(event) => setEnabled(event.target.checked)}
                  className="h-4 w-4 rounded"
                  style={{ accentColor: 'var(--accent)' }}
                />
              </label>
              {!flightControllerConnected && <p className="mt-3 text-[11px]" style={{ color: 'var(--warning)' }}>请先连接飞控，才能手动启用 RC 覆盖。</p>}
            </section>
          </div>
        </section>
      )}

      {activeTab === 'mapping' && (
        <section className="mc-card mt-5 overflow-hidden">
          <div className="border-b px-5 py-4" style={{ borderColor: 'var(--border)' }}>
            <h2 className="text-[14px] font-bold" style={{ color: 'var(--text-primary)' }}>轴映射与响应曲线</h2>
            <p className="mt-1 text-[11px]" style={{ color: 'var(--text-secondary)' }}>映射修改会在下一帧输入时生效；不会自动启用控制。</p>
          </div>
          <div className="grid grid-cols-1 gap-6 p-5 xl:grid-cols-[1fr_0.8fr]">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {mappingLabels.map((item) => (
                <label key={item.key} className="rounded-xl border p-4" style={{ borderColor: 'var(--border)', background: 'var(--bg-secondary)' }}>
                  <span className="flex items-center justify-between">
                    <span className="text-[13px] font-bold" style={{ color: 'var(--text-primary)' }}>{item.label}</span>
                    <span className="mc-mono text-[10px]" style={{ color: 'var(--accent)' }}>{item.channel}</span>
                  </span>
                  <select
                    className="mc-select mt-3"
                    value={mapping[item.key]}
                    onChange={(event) => setMapping({ [item.key]: Number(event.target.value) })}
                  >
                    {Array.from({ length: axisCount }, (_, index) => <option key={index} value={index}>Axis {index}</option>)}
                  </select>
                </label>
              ))}
            </div>
            <div className="space-y-5 rounded-xl border p-5" style={{ borderColor: 'var(--border)', background: 'var(--bg-tertiary)' }}>
              <div>
                <div className="flex items-center justify-between text-[12px]">
                  <span style={{ color: 'var(--text-secondary)' }}>死区</span>
                  <span className="mc-mono font-bold" style={{ color: 'var(--accent)' }}>{deadzone.toFixed(2)}</span>
                </div>
                <input className="mt-3" type="range" min="0" max="0.3" step="0.01" value={deadzone} onChange={(event) => setDeadzone(Number(event.target.value))} />
                <p className="mt-2 text-[10px]" style={{ color: 'var(--text-secondary)' }}>过滤摇杆回中附近的微小抖动。</p>
              </div>
              <div>
                <div className="flex items-center justify-between text-[12px]">
                  <span style={{ color: 'var(--text-secondary)' }}>Expo</span>
                  <span className="mc-mono font-bold" style={{ color: 'var(--accent)' }}>{expo.toFixed(2)}</span>
                </div>
                <input className="mt-3" type="range" min="0" max="1" step="0.05" value={expo} onChange={(event) => setExpo(Number(event.target.value))} />
                <p className="mt-2 text-[10px]" style={{ color: 'var(--text-secondary)' }}>减小摇杆中心区域的操纵灵敏度。</p>
              </div>
            </div>
          </div>
        </section>
      )}

      {activeTab === 'monitor' && (
        <section className="mc-card mt-5 overflow-hidden">
          <div className="border-b px-5 py-4" style={{ borderColor: 'var(--border)' }}>
            <h2 className="text-[14px] font-bold" style={{ color: 'var(--text-primary)' }}>原始输入监视</h2>
            <p className="mt-1 text-[11px]" style={{ color: 'var(--text-secondary)' }}>用于检查浏览器 Gamepad API 读取到的轴和按键值。</p>
          </div>
          <div className="grid grid-cols-2 gap-3 p-5 sm:grid-cols-4 xl:grid-cols-8">
            {Array.from({ length: axisCount }, (_, index) => {
              const value = axes[index] ?? 0
              return (
                <div key={index} className="rounded-xl border p-3" style={{ borderColor: 'var(--border)', background: 'var(--bg-secondary)' }}>
                  <div className="flex items-center justify-between">
                    <span className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>Axis {index}</span>
                    <span className="mc-mono text-[10px]" style={{ color: 'var(--accent)' }}>{value.toFixed(2)}</span>
                  </div>
                  <div className="relative mt-4 h-1.5 rounded-full" style={{ background: 'var(--bg-tertiary)' }}>
                    <i className="absolute left-1/2 top-0 h-full w-px" style={{ background: 'var(--border-strong)' }} />
                    <i className="absolute top-0 h-full rounded-full" style={{ left: value >= 0 ? '50%' : 50 + value * 50 + '%', width: Math.abs(value) * 50 + '%', background: 'var(--accent)' }} />
                  </div>
                </div>
              )
            })}
          </div>
          <div className="border-t px-5 py-4" style={{ borderColor: 'var(--border)' }}>
            <p className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
              按下按键：<span className="mc-mono font-semibold" style={{ color: buttons.some(Boolean) ? 'var(--accent)' : 'var(--text-disabled)' }}>{buttons.flatMap((pressed, index) => pressed ? [index] : []).join(', ') || '无'}</span>
            </p>
          </div>
        </section>
      )}
    </div>
  )
}
