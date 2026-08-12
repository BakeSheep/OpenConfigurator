import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import Icon from '../components/ui/Icon'
import { useSensorStore } from '../stores/sensorStore'
import { useTelemetryStore } from '../stores/telemetryStore'
import { useConnectionStore } from '../stores/connectionStore'

type ChannelKey = 'roll' | 'pitch' | 'yaw' | 'altitude' | 'climb' | 'speed' | 'voltage' | 'current' | 'battery' | 'accX' | 'accY' | 'accZ' | 'flowX' | 'flowY' | 'quality'
type WavePoint = Record<ChannelKey, number | null> & { time: number }

const SAMPLE_RATE_HZ = 20
const SAMPLE_INTERVAL_MS = 1000 / SAMPLE_RATE_HZ
const MAX_WINDOW_SECONDS = 60
const MAX_POINTS = SAMPLE_RATE_HZ * MAX_WINDOW_SECONDS
const STANDARD_GRAVITY = 9.80665

const channelGroups: Array<{ title: string; channels: Array<{ key: ChannelKey }> }> = [
  { title: 'waveform.groupAttitude', channels: [{ key: 'roll' }, { key: 'pitch' }, { key: 'yaw' }] },
  { title: 'waveform.groupFlightData', channels: [{ key: 'altitude' }, { key: 'climb' }, { key: 'speed' }] },
  { title: 'waveform.groupBattery', channels: [{ key: 'voltage' }, { key: 'current' }, { key: 'battery' }] },
  { title: 'waveform.groupAccel', channels: [{ key: 'accX' }, { key: 'accY' }, { key: 'accZ' }] },
  { title: 'waveform.groupOpticalFlow', channels: [{ key: 'flowX' }, { key: 'flowY' }, { key: 'quality' }] },
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
  const selectedRef = useRef(selected)
  selectedRef.current = selected
  const vehicleReady = useConnectionStore((state) => state.vehicleReady)

  useEffect(() => {
    const id = setInterval(() => {
      if (pausedRef.current) return
      if (!useConnectionStore.getState().vehicleReady) return
      const tele = useTelemetryStore.getState()
      const sensors = useSensorStore.getState()
      const attitude = tele.attitude
      const imu = sensors.imu
      const flow = sensors.opticalFlow
      const battery = tele.battery
      const attitudeFresh = !tele.isStale('attitude')
      const positionFresh = !tele.isStale('globalPosition')
      const vfrFresh = !tele.isStale('vfrHud')
      const batteryFresh = !tele.isStale('battery') && battery !== null
      const imuFresh = !sensors.isStale('imu') && imu !== null
      const flowFresh = !sensors.isStale('opticalFlow') && flow !== null
      const point: WavePoint = {
        time: (Date.now() - startRef.current) / 1000,
        roll: attitudeFresh && attitude ? attitude.roll * 180 / Math.PI : null,
        pitch: attitudeFresh && attitude ? attitude.pitch * 180 / Math.PI : null,
        yaw: attitudeFresh && attitude ? attitude.yaw * 180 / Math.PI : null,
        altitude: positionFresh ? tele.relativeAlt : null,
        climb: vfrFresh ? tele.climbRate : null,
        speed: vfrFresh ? tele.groundSpeed : null,
        voltage: batteryFresh ? battery.voltage : null,
        current: batteryFresh ? battery.current : null,
        battery: batteryFresh ? battery.remaining : null,
        accX: imuFresh ? imu.xacc * (imu.units === 'raw' ? 1 : STANDARD_GRAVITY) : null,
        accY: imuFresh ? imu.yacc * (imu.units === 'raw' ? 1 : STANDARD_GRAVITY) : null,
        accZ: imuFresh ? imu.zacc * (imu.units === 'raw' ? 1 : STANDARD_GRAVITY) : null,
        flowX: flowFresh ? flow.flow_x : null,
        flowY: flowFresh ? flow.flow_y : null,
        quality: flowFresh ? flow.quality : null,
      }
      if (!selectedRef.current.some((channel) => point[channel] !== null)) return
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
                    <span>{t(`waveform.channel.${channel.key}`)}</span>
                    <strong className="mc-mono">{latest?.[channel.key]?.toFixed(1) ?? '—'}</strong>
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
            <span>{t('waveform.channelSampleSummary', { count: selected.length, samples: visibleData.length })}</span>
            <span>{!vehicleReady ? t('waveform.offline') : paused ? t('waveform.paused') : t('waveform.live')}</span>
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
          <div className="mc-wave-legend">{selected.map((channel) => <span key={channel}><i style={{ background: colors[channel] }} />{t(`waveform.channel.${channel}`)} <strong className="mc-mono">{latest?.[channel]?.toFixed(1) ?? '—'}</strong></span>)}</div>
        </section>
      </div>
    </div>
  )
}
