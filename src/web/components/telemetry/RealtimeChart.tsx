import { useState, useEffect, useRef } from 'react'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts'
import { useTelemetryStore } from '../../stores/telemetryStore'
import { useConnectionStore } from '../../stores/connectionStore'

interface DataPoint {
  time: number
  altitude: number
  voltage: number
  speed: number
  // When true, this point marks the moment the link dropped. A dashed
  // reference line is drawn here to visually separate pre-drop (live) and
  // post-reconnect (live) data on the chart.
  gap?: boolean
}

export default function RealtimeChart() {
  const [data, setData] = useState<DataPoint[]>([])
  const [channel, setChannel] = useState<'altitude' | 'voltage' | 'speed'>('altitude')
  const startTimeRef = useRef(Date.now())
  // Track the previous connection state so we can insert a single gap marker
  // exactly when the link drops, and clear it once data resumes.
  const prevConnectedRef = useRef(false)
  const gapInsertedRef = useRef(false)

  useEffect(() => {
    const interval = setInterval(() => {
      const connState = useConnectionStore.getState()
      const teleState = useTelemetryStore.getState()
      const connected = connState.vehicleReady
      // Stop sampling when the link is down OR when the data itself is stale
      // (FC stalled but COM port still open). Otherwise the chart would keep
      // appending the frozen value as a flat line, looking like live data.
      const stale = teleState.isStale('vfrHud') || teleState.isStale('battery') || teleState.isStale('globalPosition')

      // Insert a single gap marker the moment the link drops, so the chart
      // visually separates pre-drop and post-reconnect data.
      if (prevConnectedRef.current && !connected && !gapInsertedRef.current) {
        gapInsertedRef.current = true
        setData((prev) => [...prev.slice(-60), {
          time: (Date.now() - startTimeRef.current) / 1000,
          altitude: teleState.relativeAlt,
          voltage: teleState.battery?.voltage || 0,
          speed: teleState.groundSpeed,
          gap: true,
        }])
      }
      prevConnectedRef.current = connected

      if (!connected || stale) return
      // Link is back and producing fresh data - clear the gap flag so a future
      // drop can insert another marker.
      gapInsertedRef.current = false

      const point: DataPoint = {
        time: (Date.now() - startTimeRef.current) / 1000,
        altitude: teleState.relativeAlt,
        voltage: teleState.battery?.voltage || 0,
        speed: teleState.groundSpeed,
      }
      setData((prev) => [...prev.slice(-60), point])
    }, 500)
    return () => clearInterval(interval)
  }, [])

  const colors = { altitude: 'var(--chart-1)', voltage: 'var(--chart-2)', speed: 'var(--chart-3)' }
  const labels = { altitude: '高度 (m)', voltage: '电压 (V)', speed: '速度 (m/s)' }
  // Recharts needs actual hex values, not CSS vars - resolve them
  const colorHex = { altitude: '#3B82F6', voltage: '#22C55E', speed: '#F59E0B' }

  // Find the gap point's time to draw a dashed reference line separating
  // pre-drop and post-reconnect data.
  const gapPoint = data.find((d) => d.gap)

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
          <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" />
          <XAxis dataKey="time" stroke="var(--chart-axis)" tick={{ fontSize: 10 }} tickFormatter={(v) => `${v.toFixed(0)}s`} />
          <YAxis stroke="var(--chart-axis)" tick={{ fontSize: 10 }} width={36} />
          <Tooltip
            contentStyle={{
              background: 'var(--chart-tooltip-bg)',
              border: '1px solid var(--border-hover)',
              borderRadius: 10,
              fontSize: 12,
              color: 'var(--text-primary)',
            }}
            labelFormatter={(v) => `${Number(v).toFixed(1)}s`}
          />
          {gapPoint && (
            <ReferenceLine x={gapPoint.time} stroke="#F59E0B" strokeDasharray="4 4" label={{ value: '断链', fontSize: 9, fill: '#F59E0B', position: 'top' }} />
          )}
          <Line type="monotone" dataKey={channel} stroke={colorHex[channel]} strokeWidth={2} dot={false} isAnimationActive={false} connectNulls />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
