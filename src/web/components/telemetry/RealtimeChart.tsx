import { useState, useEffect, useRef } from 'react'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import { useTelemetryStore } from '../../stores/telemetryStore'

interface DataPoint {
  time: number
  altitude: number
  voltage: number
  speed: number
}

export default function RealtimeChart() {
  const [data, setData] = useState<DataPoint[]>([])
  const [channel, setChannel] = useState<'altitude' | 'voltage' | 'speed'>('altitude')
  const startTimeRef = useRef(Date.now())

  useEffect(() => {
    const interval = setInterval(() => {
      const state = useTelemetryStore.getState()
      const point: DataPoint = {
        time: (Date.now() - startTimeRef.current) / 1000,
        altitude: state.relativeAlt,
        voltage: state.battery?.voltage || 0,
        speed: state.groundSpeed,
      }
      setData((prev) => [...prev.slice(-60), point])
    }, 500)
    return () => clearInterval(interval)
  }, [])

  const colors = { altitude: 'var(--chart-1)', voltage: 'var(--chart-2)', speed: 'var(--chart-3)' }
  const labels = { altitude: '高度 (m)', voltage: '电压 (V)', speed: '速度 (m/s)' }
  // Recharts needs actual hex values, not CSS vars - resolve them
  const colorHex = { altitude: '#3B82F6', voltage: '#22C55E', speed: '#F59E0B' }

  return (
    <div className="mc-card p-4">
      <div className="flex items-center justify-between mb-3">
        <h4 className="mc-section-title">实时曲线</h4>
        <div className="flex gap-1">
          {(Object.keys(labels) as Array<keyof typeof labels>).map((ch) => (
            <button
              key={ch}
              onClick={() => setChannel(ch)}
              className="px-2.5 py-1 rounded-lg text-[11px] font-medium transition-all"
              style={
                channel === ch
                  ? { background: 'var(--accent-dim)', color: 'var(--accent)' }
                  : { background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }
              }
            >
              {labels[ch]}
            </button>
          ))}
        </div>
      </div>
      <ResponsiveContainer width="100%" height={150}>
        <LineChart data={data} margin={{ top: 5, right: 5, bottom: 5, left: 5 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,.05)" />
          <XAxis dataKey="time" stroke="#555566" tick={{ fontSize: 10 }} tickFormatter={(v) => `${v.toFixed(0)}s`} />
          <YAxis stroke="#555566" tick={{ fontSize: 10 }} width={36} />
          <Tooltip
            contentStyle={{
              background: '#13131A',
              border: '1px solid rgba(255,255,255,.12)',
              borderRadius: 10,
              fontSize: 12,
              color: '#F0F0F5',
            }}
            labelFormatter={(v) => `${Number(v).toFixed(1)}s`}
          />
          <Line type="monotone" dataKey={channel} stroke={colorHex[channel]} strokeWidth={2} dot={false} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
