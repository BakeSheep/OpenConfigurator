import { useTelemetryStore } from '../stores/telemetryStore'
import { useConnectionStore } from '../stores/connectionStore'

const names = ['Roll', 'Pitch', 'Throttle', 'Yaw', 'AUX1', 'AUX2', 'AUX3', 'AUX4', 'AUX5', 'AUX6', 'AUX7', 'AUX8', 'AUX9', 'AUX10', 'AUX11', 'AUX12']

export default function ReceiverPage() {
  const rcChannels = useTelemetryStore((s) => s.rcChannels)
  const connected = useConnectionStore((s) => s.status === 'connected')

  // Read channels in display order; RC PWM range is 1000-2000 with 1500 = neutral.
  const getChannel = (i: number): number => {
    const key = `ch${i + 1}` as keyof typeof rcChannels
    const v = rcChannels ? rcChannels[key] : undefined
    return v ?? 0
  }

  return (
    <div className="p-5 space-y-5">
      <div>
        <h2 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>遥控器</h2>
        <p className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>RC 通道监控与校准</p>
      </div>

      {/* Channel monitor */}
      <div className="mc-card p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="mc-section-title">通道监控</h3>
          <span
            className="text-[11px] px-2 py-0.5 rounded-md"
            style={{
              background: rcChannels ? 'var(--success-dim)' : 'var(--bg-tertiary)',
              color: rcChannels ? 'var(--success)' : 'var(--text-disabled)',
            }}
          >
            {rcChannels ? '信号正常' : connected ? '等待 RC 数据…' : '未连接飞控'}
          </span>
        </div>
        <div className="space-y-3">
          {names.map((name, i) => {
            const v = getChannel(i)
            // Clamp to 1000-2000 for the bar fill; 1500 is the center.
            const clamped = Math.max(1000, Math.min(2000, v))
            const fillPct = ((clamped - 1000) / 1000) * 100
            return (
              <div key={i} className="flex items-center gap-3">
                <span className="text-[12px] w-14" style={{ color: 'var(--text-secondary)' }}>{name}</span>
                <div className="flex-1 h-2.5 rounded-full relative overflow-hidden" style={{ background: 'var(--bg-tertiary)' }}>
                  <div className="absolute left-1/2 top-0 w-px h-full" style={{ background: 'var(--border-strong)' }} />
                  <div
                    className="h-full rounded-full transition-all duration-100"
                    style={{ width: `${fillPct}%`, background: v > 0 ? 'var(--accent)' : 'var(--text-disabled)' }}
                  />
                </div>
                <span className="text-[12px] mc-mono w-10 text-right" style={{ color: 'var(--text-primary)' }}>{v > 0 ? Math.round(v) : '--'}</span>
              </div>
            )
          })}
        </div>
      </div>

      {/* Calibration */}
      <div className="mc-card p-5 space-y-4">
        <h3 className="mc-section-title">遥控器校准</h3>
        <p className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>将所有摇杆和开关拨到极限位置数次，然后完成校准。</p>
        <div className="flex gap-3">
          <button className="mc-btn mc-btn-primary px-6 py-3">开始校准</button>
          <button className="mc-btn mc-btn-ghost px-6 py-3">完成</button>
        </div>
      </div>

      {/* Channel reverse */}
      <div className="mc-card p-5">
        <h3 className="mc-section-title mb-4">通道反向</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {names.slice(0, 8).map((name) => (
            <label key={name} className="flex items-center gap-2 text-[13px] cursor-pointer" style={{ color: 'var(--text-secondary)' }}>
              <input type="checkbox" className="w-4 h-4 rounded" style={{ accentColor: 'var(--accent)' }} />
              <span>{name}</span>
            </label>
          ))}
        </div>
      </div>
    </div>
  )
}
