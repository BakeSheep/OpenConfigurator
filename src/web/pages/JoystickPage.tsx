import { useEffect, useRef } from 'react'
import { useGamepadStore } from '../stores/gamepadStore'
import { useWebSocket } from '../hooks/useWebSocket'

export default function JoystickPage() {
  const { connected, id, axes, mapping, deadzone, expo, enabled, setConnected, setAxes, setButtons, setEnabled, setDeadzone, setExpo } = useGamepadStore()
  const { send } = useWebSocket()
  const rafRef = useRef<number>(0)
  const lastSendRef = useRef(0)

  // Keep the latest values in refs so the RAF loop doesn't need to be
  // torn down and restarted on every state change (which previously caused
  // setAxes/setButtons to re-render -> new pollGamepad -> new RAF every frame).
  const stateRef = useRef({ connected, enabled, deadzone, expo, mapping })
  stateRef.current = { connected, enabled, deadzone, expo, mapping }
  const actionsRef = useRef({ setConnected, setAxes, setButtons, send })
  actionsRef.current = { setConnected, setAxes, setButtons, send }

  useEffect(() => {
    const pollGamepad = () => {
      const { connected: wasConnected, enabled, deadzone, expo, mapping } = stateRef.current
      const { setConnected, setAxes, setButtons, send } = actionsRef.current
      const gamepads = navigator.getGamepads()
      const gp = gamepads[0] || gamepads[1] || gamepads[2] || gamepads[3]
      if (gp) {
        if (!wasConnected) setConnected(true, gp.id)
        setAxes([...gp.axes])
        setButtons(gp.buttons.map((b) => b.pressed))
        if (enabled && Date.now() - lastSendRef.current > 50) {
          lastSendRef.current = Date.now()
          const applyDz = (v: number) => {
            if (Math.abs(v) < deadzone) return 0
            const s = v > 0 ? 1 : -1
            const n = (Math.abs(v) - deadzone) / (1 - deadzone)
            return s * Math.pow(n, 1 + expo)
          }
          const toPwm = (v: number) => Math.round(1500 + applyDz(v) * 500)
          send({
            type: 'rc_channels_override',
            data: {
              ch1: toPwm(gp.axes[mapping.roll] || 0),
              ch2: toPwm(-(gp.axes[mapping.pitch] || 0)),
              ch3: toPwm(-(gp.axes[mapping.throttle] || 0)),
              ch4: toPwm(gp.axes[mapping.yaw] || 0),
              ch5: 1500, ch6: 1500, ch7: 1500, ch8: 1500,
            },
          })
        }
      } else if (wasConnected) {
        setConnected(false)
      }
      rafRef.current = requestAnimationFrame(pollGamepad)
    }
    rafRef.current = requestAnimationFrame(pollGamepad)
    return () => cancelAnimationFrame(rafRef.current)
  }, [])

  return (
    <div className="p-5 space-y-5">
      <div>
        <h2 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>游戏手柄</h2>
        <p className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>USB/蓝牙手柄映射为 RC 通道</p>
      </div>

      {/* Status */}
      <div className="mc-card p-5 flex items-center gap-3">
        <span
          className="rounded-full"
          style={{ width: 10, height: 10, background: connected ? 'var(--success)' : 'var(--text-disabled)', boxShadow: connected ? '0 0 8px rgba(34,197,94,.5)' : 'none' }}
        />
        <span className="text-[13px]" style={{ color: connected ? 'var(--text-primary)' : 'var(--text-secondary)' }}>
          {connected ? id : '未检测到手柄 — 连接 USB/蓝牙手柄后自动识别'}
        </span>
      </div>

      {/* Enable + Axes */}
      <div className="mc-card p-5 space-y-5">
        <label className="flex items-center gap-3 cursor-pointer">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} disabled={!connected} className="w-4 h-4 rounded" style={{ accentColor: 'var(--accent)' }} />
          <span className="text-[13px]" style={{ color: 'var(--text-primary)' }}>启用手柄控制 (RC_CHANNELS_OVERRIDE @ 20Hz)</span>
        </label>
        {connected && axes.length > 0 && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {axes.map((v, i) => (
              <div key={i} className="p-3 rounded-xl" style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border)' }}>
                <p className="text-[10px] mb-1.5" style={{ color: 'var(--text-disabled)' }}>Axis {i}</p>
                <div className="h-1.5 rounded-full relative" style={{ background: 'var(--bg-hover)' }}>
                  <div className="absolute top-0 left-1/2 w-px h-1.5" style={{ background: 'var(--text-secondary)' }} />
                  <div className="absolute top-0 h-1.5 rounded-full" style={{ left: v >= 0 ? '50%' : `${50+v*50}%`, width: `${Math.abs(v)*50}%`, background: 'var(--accent)' }} />
                </div>
                <p className="text-[10px] mt-1 mc-mono" style={{ color: 'var(--text-primary)' }}>{v.toFixed(3)}</p>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Settings */}
      <div className="mc-card p-5 space-y-5">
        <h3 className="mc-section-title">手柄设置</h3>
        <div>
          <div className="flex justify-between text-[12px] mb-2">
            <span style={{ color: 'var(--text-secondary)' }}>死区</span>
            <span className="mc-mono" style={{ color: 'var(--accent)' }}>{deadzone.toFixed(2)}</span>
          </div>
          <input type="range" min="0" max="0.3" step="0.01" value={deadzone} onChange={(e) => setDeadzone(Number(e.target.value))} />
        </div>
        <div>
          <div className="flex justify-between text-[12px] mb-2">
            <span style={{ color: 'var(--text-secondary)' }}>Expo</span>
            <span className="mc-mono" style={{ color: 'var(--accent)' }}>{expo.toFixed(2)}</span>
          </div>
          <input type="range" min="0" max="1" step="0.05" value={expo} onChange={(e) => setExpo(Number(e.target.value))} />
        </div>
        <div className="pt-3" style={{ borderTop: '1px solid var(--border)' }}>
          <p className="mc-section-title mb-2">轴映射</p>
          <div className="grid grid-cols-2 gap-2">
            {[
              { label: '油门', value: mapping.throttle },
              { label: '偏航', value: mapping.yaw },
              { label: '俯仰', value: mapping.pitch },
              { label: '横滚', value: mapping.roll },
            ].map((m) => (
              <div key={m.label} className="flex justify-between text-[12px] p-2 rounded-lg" style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}>
                <span>{m.label}</span>
                <span className="mc-mono" style={{ color: 'var(--text-primary)' }}>Axis {m.value}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
