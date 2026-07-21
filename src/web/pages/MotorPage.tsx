import { useState } from 'react'
import Icon from '../components/ui/Icon'
import { PageHeader } from '../components/ui/PageFrame'
import { useWebSocket } from '../hooks/useWebSocket'

const motors = [
  { x: 25, y: 25, ccw: true },
  { x: 75, y: 25, ccw: false },
  { x: 75, y: 75, ccw: true },
  { x: 25, y: 75, ccw: false },
]

export default function MotorPage() {
  const { send } = useWebSocket()
  const [safetyConfirmed, setSafetyConfirmed] = useState(false)
  const [activeMotor, setActiveMotor] = useState<number | null>(null)
  const [throttle, setThrottle] = useState(0)

  const testMotor = (index: number, level: number) => {
    if (!safetyConfirmed) return
    send({ type: 'motor_test', data: { instance: index + 1, throttle: level, duration: 2 } })
  }

  const stopAll = () => {
    for (let index = 0; index < motors.length; index += 1) {
      send({ type: 'motor_test', data: { instance: index + 1, throttle: 0, duration: 0 } })
    }
  }

  return (
    <div className="mc-workspace mc-fade-in">
      <PageHeader title="电机设置" description="验证电机编号、旋转方向与输出响应" />

      <label className="mb-5 flex cursor-pointer items-center gap-3 rounded-xl border px-4 py-3" style={{ borderColor: 'color-mix(in srgb, var(--danger) 32%, var(--border))', background: 'var(--danger-dim)' }}>
        <input type="checkbox" checked={safetyConfirmed} onChange={(event) => setSafetyConfirmed(event.target.checked)} className="h-4 w-4 rounded" style={{ accentColor: 'var(--danger)' }} />
        <span className="grid h-8 w-8 place-items-center rounded-lg" style={{ background: 'var(--bg-secondary)', color: 'var(--danger)' }}><Icon name="warning" size={17} /></span>
        <span>
          <span className="block text-[13px] font-bold" style={{ color: 'var(--danger)' }}>我已移除所有螺旋桨，确认测试安全</span>
          <span className="mt-0.5 block text-[11px]" style={{ color: 'var(--text-secondary)' }}>未确认前不能选择或测试任意电机。</span>
        </span>
      </label>

      <section className="grid grid-cols-1 gap-4 xl:grid-cols-[1fr_0.95fr]">
        <div className="mc-card overflow-hidden">
          <div className="border-b px-5 py-4" style={{ borderColor: 'var(--border)' }}>
            <h2 className="text-[14px] font-bold" style={{ color: 'var(--text-primary)' }}>电机布局</h2>
            <p className="mt-1 text-[11px]" style={{ color: 'var(--text-secondary)' }}>Quad X · 点击电机选择测试目标</p>
          </div>
          <div className="flex min-h-[350px] items-center justify-center p-8">
            <div className="relative h-64 w-64">
              <div className="absolute inset-10 rotate-45 rounded-2xl border" style={{ borderColor: 'var(--border-strong)' }} />
              <div className="absolute left-1/2 top-1/2 grid h-12 w-12 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-xl border text-[12px] font-bold" style={{ borderColor: 'var(--border)', background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}>FC</div>
              {motors.map((motor, index) => (
                <div key={index} className="absolute" style={{ left: motor.x + '%', top: motor.y + '%', transform: 'translate(-50%, -50%)' }}>
                  <button
                    type="button"
                    disabled={!safetyConfirmed}
                    onClick={() => setActiveMotor(index)}
                    className="grid h-14 w-14 place-items-center rounded-full border text-[16px] font-bold transition-all disabled:cursor-not-allowed disabled:opacity-40"
                    style={{
                      borderColor: activeMotor === index ? 'var(--accent)' : 'var(--border-strong)',
                      background: activeMotor === index ? 'var(--accent)' : 'var(--bg-secondary)',
                      color: activeMotor === index ? '#fff' : 'var(--text-primary)',
                      boxShadow: activeMotor === index ? '0 0 0 5px var(--accent-dim)' : 'var(--card-shadow)',
                    }}
                  >
                    {index + 1}
                  </button>
                  <span className="absolute left-1/2 top-[calc(100%+7px)] -translate-x-1/2 whitespace-nowrap mc-mono text-[10px]" style={{ color: motor.ccw ? 'var(--success)' : 'var(--danger)' }}>
                    {motor.ccw ? 'CCW' : 'CW'}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="mc-card overflow-hidden">
          <div className="border-b px-5 py-4" style={{ borderColor: 'var(--border)' }}>
            <h2 className="text-[14px] font-bold" style={{ color: 'var(--text-primary)' }}>测试控制</h2>
            <p className="mt-1 text-[11px]" style={{ color: 'var(--text-secondary)' }}>每次单电机测试持续 2 秒。</p>
          </div>
          <div className="space-y-6 p-5">
            <div>
              <div className="flex items-center justify-between">
                <span className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>测试油门</span>
                <span className="mc-mono text-[14px] font-bold" style={{ color: 'var(--accent)' }}>{throttle}%</span>
              </div>
              <input className="mt-4" type="range" min="0" max="100" value={throttle} disabled={!safetyConfirmed} onChange={(event) => setThrottle(Number(event.target.value))} />
              <div className="mt-2 flex justify-between text-[10px]" style={{ color: 'var(--text-disabled)' }}><span>0%</span><span>安全低速测试</span><span>100%</span></div>
            </div>
            <div className="grid grid-cols-[1fr_auto] gap-3">
              <button type="button" className="mc-btn mc-btn-primary min-h-11" disabled={!safetyConfirmed || activeMotor === null} onClick={() => activeMotor !== null && testMotor(activeMotor, throttle)}>
                <Icon name="motor" size={16} />测试 M{activeMotor === null ? '?' : activeMotor + 1}
              </button>
              <button type="button" className="mc-btn mc-btn-danger min-h-11" disabled={!safetyConfirmed} onClick={stopAll}>停止全部</button>
            </div>
            <div className="border-t pt-5" style={{ borderColor: 'var(--border)' }}>
              <p className="mc-section-title mb-3">顺序验证</p>
              <div className="grid grid-cols-4 gap-2">
                {motors.map((_, index) => (
                  <button key={index} type="button" className="mc-btn mc-btn-ghost" disabled={!safetyConfirmed} onClick={() => testMotor(index, 15)}>M{index + 1}</button>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  )
}
