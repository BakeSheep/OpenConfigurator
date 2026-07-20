import { useState } from 'react'
import { useWebSocket } from '../hooks/useWebSocket'

const motors = [
  { x: 25, y: 25, ccw: true },
  { x: 75, y: 25, ccw: false },
  { x: 75, y: 75, ccw: true },
  { x: 25, y: 75, ccw: false },
]

export default function MotorPage() {
  const { send } = useWebSocket()
  const [safety, setSafety] = useState(false)
  const [active, setActive] = useState<number | null>(null)
  const [throttle, setThrottle] = useState(0)

  const testMotor = (i: number, thr: number) => {
    if (!safety) return
    // MAV_CMD_DO_MOTOR_TEST expects a 1-based motor instance number.
    send({ type: 'motor_test', data: { instance: i + 1, throttle: thr, duration: 2 } })
  }
  const stopAll = () => { for (let i = 0; i < 4; i++) send({ type: 'motor_test', data: { instance: i + 1, throttle: 0, duration: 0 } }) }

  return (
    <div className="p-5 space-y-5">
      <div>
        <h2 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>电机测试</h2>
        <p className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>单独测试电机旋转方向与油门响应</p>
      </div>

      {/* Safety */}
      <div className="p-4 rounded-2xl" style={{ background: 'var(--danger-dim)', border: '1px solid rgba(239,68,68,.2)' }}>
        <label className="flex items-center gap-3 cursor-pointer">
          <input type="checkbox" checked={safety} onChange={(e) => setSafety(e.target.checked)} className="w-4 h-4 rounded" style={{ accentColor: 'var(--danger)' }} />
          <span className="text-[13px] font-medium" style={{ color: 'var(--danger)' }}>我已移除所有螺旋桨，确认安全</span>
        </label>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* Motor layout */}
        <div className="mc-card p-6">
          <h3 className="mc-section-title mb-4">电机布局 (Quad X)</h3>
          <div className="relative w-56 h-56 mx-auto">
            <div className="absolute inset-10 rounded-xl rotate-45" style={{ border: '1px solid var(--border)' }} />
            <div
              className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-8 h-8 rounded-lg flex items-center justify-center text-[10px]"
              style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
            >
              FC
            </div>
            {motors.map((m, i) => (
              <button
                key={i}
                onClick={() => setActive(i)}
                disabled={!safety}
                className="absolute w-11 h-11 rounded-full flex flex-col items-center justify-center text-[12px] font-bold transition-all disabled:opacity-30"
                style={{
                  left: `${m.x}%`,
                  top: `${m.y}%`,
                  transform: `translate(-50%,-50%)${active === i ? ' scale(1.1)' : ''}`,
                  background: active === i ? 'var(--accent)' : 'var(--bg-tertiary)',
                  color: active === i ? '#fff' : 'var(--text-primary)',
                  border: '1px solid ' + (active === i ? 'var(--accent)' : 'var(--border)'),
                  boxShadow: active === i ? '0 0 16px var(--accent-glow)' : 'none',
                }}
              >
                {i + 1}
              </button>
            ))}
            {/* Rotation labels */}
            {motors.map((m, i) => (
              <span
                key={`lbl-${i}`}
                className="absolute text-[9px] mc-mono"
                style={{
                  left: `${m.x}%`,
                  top: `${m.y + 9}%`,
                  transform: 'translate(-50%, 0)',
                  color: m.ccw ? 'var(--success)' : 'var(--danger)',
                }}
              >
                {m.ccw ? 'CCW' : 'CW'}
              </span>
            ))}
          </div>
        </div>

        {/* Controls */}
        <div className="mc-card p-6 space-y-5">
          <h3 className="mc-section-title">电机控制</h3>
          <div>
            <div className="flex justify-between text-[12px] mb-2">
              <span style={{ color: 'var(--text-secondary)' }}>油门</span>
              <span className="mc-mono" style={{ color: 'var(--accent)' }}>{throttle}%</span>
            </div>
            <input type="range" min="0" max="100" value={throttle} onChange={(e) => setThrottle(Number(e.target.value))} disabled={!safety} />
          </div>
          <div className="flex gap-3">
            <button onClick={() => active !== null && testMotor(active, throttle)} disabled={!safety || active === null} className="mc-btn mc-btn-primary flex-1 py-3">
              测试 M{active !== null ? active + 1 : '?'}
            </button>
            <button onClick={stopAll} disabled={!safety} className="mc-btn mc-btn-danger px-6 py-3">停止</button>
          </div>
          <div className="pt-4" style={{ borderTop: '1px solid var(--border)' }}>
            <p className="mc-section-title mb-3">顺序验证</p>
            <div className="flex gap-2">
              {motors.map((_, i) => (
                <button key={i} onClick={() => testMotor(i, 15)} disabled={!safety} className="mc-btn mc-btn-ghost flex-1 py-2.5 text-[12px] disabled:opacity-30">
                  M{i + 1}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
