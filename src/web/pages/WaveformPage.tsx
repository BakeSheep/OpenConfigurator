import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import Icon from '../components/ui/Icon'
import { useSensorStore } from '../stores/sensorStore'
import { useTelemetryStore } from '../stores/telemetryStore'

type ChannelKey = 'roll' | 'pitch' | 'yaw' | 'altitude' | 'climb' | 'speed' | 'voltage' | 'current' | 'battery' | 'accX' | 'accY' | 'accZ' | 'flowX' | 'flowY' | 'quality'
type WavePoint = Record<ChannelKey, number> & { time: number }

const SAMPLE_RATE_HZ = 20
const SAMPLE_INTERVAL_MS = 1000 / SAMPLE_RATE_HZ
const MAX_WINDOW_SECONDS = 60
const MAX_POINTS = SAMPLE_RATE_HZ * MAX_WINDOW_SECONDS
const STANDARD_GRAVITY = 9.80665

const channelGroups: Array<{ title: string; channels: Array<{ key: ChannelKey; label: string }> }> = [
  { title: 'waveform.groupAttitude', channels: [{ key: 'roll', label: 'Roll(°)' }, { key: 'pitch', label: 'Pitch(°)' }, { key: 'yaw', label: 'Yaw(°)' }] },
  { title: 'waveform.groupFlightData', channels: [{ key: 'altitude', label: 'Alt(m)' }, { key: 'climb', label: 'Climb(m/s)' }, { key: 'speed', label: 'GndSpd(m/s)' }] },
  { title: 'waveform.groupBattery', channels: [{ key: 'voltage', label: 'Volt(V)' }, { key: 'current', label: 'Curr(A)' }, { key: 'battery', label: 'Batt(%)' }] },
  { title: 'waveform.groupAccel', channels: [{ key: 'accX', label: 'IMU0 AccX(m/s²)' }, { key: 'accY', label: 'IMU0 AccY(m/s²)' }, { key: 'accZ', label: 'IMU0 AccZ(m/s²)' }] },
  { title: 'waveform.groupOpticalFlow', channels: [{ key: 'flowX', label: 'Flow X' }, { key: 'flowY', label: 'Flow Y' }, { key: 'quality', label: 'Quality' }] },
]

const colors: Record<ChannelKey, string> = {
  roll: '#22c7d8', pitch: '#44d184', yaw: '#e65aa5', altitude: '#4d8ff7', climb: '#f59e42', speed: '#8b6cf5',
  voltage: '#eab54a', current: '#ef7d55', battery: '#45b77b', accX: '#ef5d7a', accY: '#3ac47a', accZ: '#4c92ef',
  flowX: '#26b8c4', flowY: '#a96fe7', quality: '#e6a23c',
}

export default function WaveformPage({ embedded = false }: { embedded?: boolean }) {
  const { t } = useTranslation()
  const [data, setData] = useState<WavePoint[]>([])
  const [selected, setSelected] = useState<ChannelKey[]>(['roll', 'pitch', 'yaw'])
  const [paused, setPaused] = useState(false)
  const [windowSeconds, setWindowSeconds] = useState(10)
  const startRef = useRef(Date.now())
  const pausedRef = useRef(paused)
  pausedRef.current = paused

  useEffect(() => {
    const id = setInterval(() => {
      if (pausedRef.current) return
      const tele = useTelemetryStore.getState()
      const sensors = useSensorStore.getState()
      const attitude = tele.attitude
      const imu = sensors.imu
      const flow = sensors.opticalFlow
      const battery = tele.battery
      const point: WavePoint = {
        time: (Date.now() - startRef.current) / 1000,
        roll: (attitude?.roll ?? 0) * 180 / Math.PI,
        pitch: (attitude?.pitch ?? 0) * 180 / Math.PI,
        yaw: (attitude?.yaw ?? 0) * 180 / Math.PI,
        altitude: tele.relativeAlt, climb: tele.climbRate, speed: tele.groundSpeed,
        voltage: battery?.voltage ?? 0, current: battery?.current ?? 0, battery: battery?.remaining ?? 0,
        accX: (imu?.xacc ?? 0) * STANDARD_GRAVITY,
        accY: (imu?.yacc ?? 0) * STANDARD_GRAVITY,
        accZ: (imu?.zacc ?? 0) * STANDARD_GRAVITY,
        flowX: flow?.flow_x ?? 0, flowY: flow?.flow_y ?? 0, quality: flow?.quality ?? 0,
      }
      setData((current) => [...current.slice(-(MAX_POINTS - 1)), point])
    }, SAMPLE_INTERVAL_MS)
    return () => clearInterval(id)
  }, [])

  const visibleData = useMemo(() => {
    const latest = data[data.length - 1]?.time ?? 0
    return data.filter((point) => point.time >= latest - windowSeconds)
  }, [data, windowSeconds])

  const latest = data[data.length - 1]
  const toggleChannel = (channel: ChannelKey) => setSelected((current) => current.includes(channel) ? current.filter((item) => item !== channel) : current.length < 6 ? [...current, channel] : current)

  return (
    <div className={embedded ? 'mc-fade-in mc-wave-page' : 'mc-workspace mc-fade-in mc-wave-page'}>
      <div className="mc-wave-layout">
        <aside className="mc-card mc-wave-sources">
          <header><strong>{t('waveform.dataSources')}</strong><button type="button" className="mc-icon-btn" onClick={() => setSelected(['roll', 'pitch', 'yaw'])} aria-label={t('waveform.resetDefault')}><Icon name="refresh" size={14} /></button></header>
          <div className="mc-wave-source-scroll">
            {channelGroups.map((group) => (
              <section key={group.title}>
                <h3>⌄ {t(group.title)}</h3>
                {group.channels.map((channel) => (
                  <label key={channel.key}>
                    <input type="checkbox" checked={selected.includes(channel.key)} onChange={() => toggleChannel(channel.key)} />
                    <i style={{ background: colors[channel.key] }} />
                    <span>{channel.label}</span>
                    <strong className="mc-mono" style={{ color: colors[channel.key] }}>{latest?.[channel.key]?.toFixed(1) ?? '—'}</strong>
                  </label>
                ))}
              </section>
            ))}
          </div>
        </aside>

        <section className="mc-wave-main">
          <div className="mc-wave-toolbar">
            <div>{[5, 10, 30, 60].map((seconds) => <button type="button" key={seconds} data-active={windowSeconds === seconds} onClick={() => setWindowSeconds(seconds)}>{seconds}s</button>)}</div>
            <button type="button" className="mc-icon-btn" onClick={() => setPaused((value) => !value)} aria-label={paused ? t('waveform.resume') : t('waveform.pause')}><Icon name={paused ? 'refresh' : 'pause'} size={15} /></button>
            <button type="button" className="mc-icon-btn" onClick={() => setData([])} aria-label={t('waveform.clearData')}><Icon name="trash" size={15} /></button>
            <div><button type="button" data-active>{t('waveform.chartSampleRate', { rate: SAMPLE_RATE_HZ })}</button></div>
            <span>{t('waveform.channelSampleSummary', { channels: selected.length, samples: visibleData.length })}</span>
          </div>
          <div className="mc-card mc-wave-chart">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={visibleData} margin={{ top: 18, right: 14, bottom: 6, left: 0 }}>
                <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
                <XAxis dataKey="time" stroke="var(--chart-axis)" tick={{ fontSize: 10 }} tickFormatter={(value) => `${(Number(value) - (visibleData[visibleData.length - 1]?.time ?? 0)).toFixed(0)}s`} />
                <YAxis stroke="var(--chart-axis)" tick={{ fontSize: 10 }} width={44} />
                <Tooltip contentStyle={{ background: 'var(--chart-tooltip-bg)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 11 }} />
                {selected.map((channel) => <Line key={channel} type="monotone" dataKey={channel} stroke={colors[channel]} strokeWidth={1.8} dot={false} isAnimationActive={false} />)}
              </LineChart>
            </ResponsiveContainer>
          </div>
          <div className="mc-wave-legend">{selected.map((channel) => <span key={channel}><i style={{ background: colors[channel] }} />{channel} <strong className="mc-mono" style={{ color: colors[channel] }}>{latest?.[channel]?.toFixed(1) ?? '—'}</strong></span>)}</div>
        </section>
      </div>
    </div>
  )
}
