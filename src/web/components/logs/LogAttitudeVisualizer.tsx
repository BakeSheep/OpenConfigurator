import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { OrbitControls } from '@react-three/drei'
import { Canvas, useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import type { SeriesData } from '../../utils/ulogAnalysis'
import { degreeAttitudeToModelRotation } from '../../utils/attitudeVisualization'
import Icon from '../ui/Icon'

interface EulerDegrees {
  roll: number
  pitch: number
  yaw: number
}

function sampleSeries(series: SeriesData, timeSec: number, wrapAngle = false): number {
  const { times, values } = series
  if (times.length === 0) return 0
  if (timeSec <= times[0]) return values[0]
  const lastIndex = times.length - 1
  if (timeSec >= times[lastIndex]) return values[lastIndex]

  let low = 0
  let high = lastIndex
  while (low + 1 < high) {
    const middle = (low + high) >>> 1
    if (times[middle] <= timeSec) low = middle
    else high = middle
  }
  const span = times[high] - times[low]
  if (span <= 0) return values[low]
  const ratio = (timeSec - times[low]) / span
  let delta = values[high] - values[low]
  if (wrapAngle && Math.abs(delta) > 180) delta -= Math.sign(delta) * 360
  return values[low] + delta * ratio
}

function LogDrone({ attitudeRef }: { attitudeRef: MutableRefObject<EulerDegrees> }) {
  const modelRef = useRef<THREE.Group>(null)

  useFrame(() => {
    if (!modelRef.current) return
    const rotation = degreeAttitudeToModelRotation(attitudeRef.current)
    modelRef.current.rotation.x = rotation.x
    modelRef.current.rotation.y = rotation.y
    modelRef.current.rotation.z = rotation.z
  })

  return (
    <group ref={modelRef}>
      <mesh>
        <boxGeometry args={[0.6, 0.15, 0.6]} />
        <meshStandardMaterial color="#3B82F6" metalness={0.3} roughness={0.7} />
      </mesh>
      {[[-0.5, 0, -0.5], [0.5, 0, -0.5], [0.5, 0, 0.5], [-0.5, 0, 0.5]].map((position, index) => (
        <group key={index} position={position as [number, number, number]}>
          <mesh position={[position[0] * 0.3, 0, position[2] * 0.3]}>
            <cylinderGeometry args={[0.03, 0.03, 0.5, 8]} />
            <meshStandardMaterial color="#1C1C26" />
          </mesh>
          <mesh position={[0, 0.08, 0]}>
            <cylinderGeometry args={[0.08, 0.08, 0.06, 16]} />
            <meshStandardMaterial color={index < 2 ? '#22C55E' : '#EF4444'} />
          </mesh>
          <mesh position={[0, 0.12, 0]} rotation={[0, index * 0.7, 0]}>
            <boxGeometry args={[0.4, 0.01, 0.04]} />
            <meshStandardMaterial color="#F0F0F5" transparent opacity={0.5} />
          </mesh>
        </group>
      ))}
      <mesh position={[0, 0.08, -0.35]}>
        <coneGeometry args={[0.05, 0.12, 8]} />
        <meshStandardMaterial color="#F59E0B" />
      </mesh>
    </group>
  )
}

function formatTime(value: number): string {
  const minutes = Math.floor(value / 60)
  const seconds = value - minutes * 60
  return `${minutes}:${seconds.toFixed(1).padStart(4, '0')}`
}

export default function LogAttitudeVisualizer({
  series,
  durationSec,
  startSec = 0,
  syncTimeSec,
}: {
  series: SeriesData[]
  durationSec: number
  startSec?: number
  syncTimeSec?: number | null
}) {
  const { t } = useTranslation()
  const rollSeries = useMemo(() => series.find((entry) => entry.id === 'attitude.roll'), [series])
  const pitchSeries = useMemo(() => series.find((entry) => entry.id === 'attitude.pitch'), [series])
  const yawSeries = useMemo(() => series.find((entry) => entry.id === 'attitude.yaw'), [series])
  const replayStartSec = Math.min(Math.max(startSec, 0), durationSec)
  const [timeSec, setTimeSec] = useState(replayStartSec)
  const [playing, setPlaying] = useState(false)
  const playbackTimeRef = useRef(replayStartSec)
  const attitudeRef = useRef<EulerDegrees>({ roll: 0, pitch: 0, yaw: 0 })

  const sampleAttitude = useCallback((sampleTimeSec: number): EulerDegrees => ({
    roll: rollSeries ? sampleSeries(rollSeries, sampleTimeSec) : 0,
    pitch: pitchSeries ? sampleSeries(pitchSeries, sampleTimeSec) : 0,
    yaw: yawSeries ? sampleSeries(yawSeries, sampleTimeSec, true) : 0,
  }), [pitchSeries, rollSeries, yawSeries])

  useEffect(() => {
    playbackTimeRef.current = replayStartSec
    attitudeRef.current = sampleAttitude(replayStartSec)
    setTimeSec(replayStartSec)
    setPlaying(false)
  }, [series, replayStartSec, sampleAttitude])

  useEffect(() => {
    if (syncTimeSec == null || !Number.isFinite(syncTimeSec)) return
    const next = Math.min(durationSec, Math.max(replayStartSec, syncTimeSec))
    playbackTimeRef.current = next
    attitudeRef.current = sampleAttitude(next)
    setPlaying(false)
    setTimeSec(next)
  }, [durationSec, replayStartSec, sampleAttitude, syncTimeSec])

  useEffect(() => {
    if (!playing) return
    let frameId = 0
    let previous = performance.now()
    let lastUiUpdate = previous
    const tick = (now: number) => {
      const elapsed = (now - previous) / 1000
      previous = now
      const next = Math.min(durationSec, playbackTimeRef.current + elapsed)
      playbackTimeRef.current = next
      attitudeRef.current = sampleAttitude(next)
      if (now - lastUiUpdate >= 100 || next >= durationSec) {
        lastUiUpdate = now
        setTimeSec(next)
      }
      if (next >= durationSec) {
        setPlaying(false)
        return
      }
      frameId = requestAnimationFrame(tick)
    }
    frameId = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frameId)
  }, [durationSec, playing, sampleAttitude])

  if (!rollSeries || !pitchSeries || !yawSeries) {
    return <p className="mc-explorer__notice">{t('logAnalysis.noAttitudeData')}</p>
  }

  const attitude = sampleAttitude(timeSec)

  const togglePlayback = () => {
    if (!playing && timeSec >= durationSec) {
      playbackTimeRef.current = replayStartSec
      attitudeRef.current = sampleAttitude(replayStartSec)
      setTimeSec(replayStartSec)
    }
    setPlaying((current) => !current)
  }

  return (
    <div className="mc-log-attitude">
      <div className="mc-log-attitude__canvas" style={{ background: 'var(--att3d-canvas-bg)' }}>
        <Canvas camera={{ position: [0, 2.5, 2.5], fov: 45 }} dpr={[1, 1.5]}>
          <ambientLight intensity={0.4} />
          <directionalLight position={[5, 5, 5]} intensity={0.8} />
          <pointLight position={[-3, 2, -3]} intensity={0.3} color="#3B82F6" />
          <LogDrone attitudeRef={attitudeRef} />
          <gridHelper args={[4, 20, '#24243A', '#13131A']} position={[0, -1, 0]} />
          <OrbitControls enablePan={false} enableZoom minDistance={2} maxDistance={8} />
        </Canvas>
      </div>
      <div className="mc-log-attitude__controls">
        <button
          type="button"
          className="mc-icon-btn mc-icon-btn--bordered"
          aria-label={playing ? t('logAnalysis.pauseReplay') : t('logAnalysis.playReplay')}
          title={playing ? t('common.pause' as const) : t('common.play' as const)}
          onClick={togglePlayback}
        >
          <Icon name={playing ? 'pause' : 'play'} size={14} />
        </button>
        <input
          type="range"
          min={replayStartSec}
          max={Math.max(durationSec, 0.01)}
          step={0.01}
          value={timeSec}
          aria-label={t('logAnalysis.attitudeTimeAria')}
          onChange={(event) => {
            const next = Number(event.target.value)
            playbackTimeRef.current = next
            attitudeRef.current = sampleAttitude(next)
            setPlaying(false)
            setTimeSec(next)
          }}
        />
        <span className="mc-mono">
          {formatTime(timeSec - replayStartSec)} / {formatTime(durationSec - replayStartSec)}
        </span>
      </div>
      <div className="mc-log-attitude__values">
        <span>{t('logAnalysis.label.roll')} <strong>{attitude.roll.toFixed(1)}°</strong></span>
        <span>{t('logAnalysis.label.pitch')} <strong>{attitude.pitch.toFixed(1)}°</strong></span>
        <span>{t('logAnalysis.label.yaw')} <strong>{attitude.yaw.toFixed(1)}°</strong></span>
      </div>
    </div>
  )
}
