// GPS ground track: OSM tiles via leaflet when the network allows, with an
// automatic offline fallback to a dependency-free 2D canvas track (the app is
// local-first; tile availability must never break the analysis page).
import { useEffect, useMemo, useRef, useState } from 'react'
import { CircleMarker, MapContainer, Polyline, TileLayer, useMap } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import type { TrackData } from '../../utils/ulogAnalysis'

const ALTITUDE_COLORS = ['#2dd4bf', '#38bdf8', '#a855f7', '#fbbf24', '#f97316', '#f87171']

interface TrackMapProps {
  track: TrackData
}

interface ColoredSegment {
  positions: Array<[number, number]>
  color: string
}

/** Split the track into consecutive runs colored by altitude bucket. */
function buildSegments(track: TrackData): ColoredSegment[] {
  const altitudes = track.altM.filter((value): value is number => value !== null)
  const min = altitudes.length > 0 ? Math.min(...altitudes) : 0
  const max = altitudes.length > 0 ? Math.max(...altitudes) : 1
  const range = Math.max(1e-6, max - min)
  const bucketOf = (index: number): number => {
    const alt = track.altM[index]
    if (alt === null) return 0
    return Math.min(
      ALTITUDE_COLORS.length - 1,
      Math.floor(((alt - min) / range) * ALTITUDE_COLORS.length),
    )
  }
  const segments: ColoredSegment[] = []
  let current: ColoredSegment | null = null
  let currentBucket = -1
  for (let index = 0; index < track.lat.length; index++) {
    const bucket = bucketOf(index)
    const point: [number, number] = [track.lat[index], track.lon[index]]
    if (!current || bucket !== currentBucket) {
      // Repeat the previous point so runs connect seamlessly.
      current = {
        positions: current ? [current.positions[current.positions.length - 1], point] : [point],
        color: ALTITUDE_COLORS[bucket],
      }
      currentBucket = bucket
      segments.push(current)
    } else {
      current.positions.push(point)
    }
  }
  return segments.filter((segment) => segment.positions.length > 1)
}

function FitBounds({ track }: { track: TrackData }) {
  const map = useMap()
  useEffect(() => {
    const lats = track.lat
    const lons = track.lon
    if (lats.length === 0) return
    map.fitBounds(
      [
        [Math.min(...lats), Math.min(...lons)],
        [Math.max(...lats), Math.max(...lons)],
      ],
      { padding: [24, 24] },
    )
  }, [map, track])
  return null
}

/** Offline fallback: plain-canvas north/east projection of the track. */
function TrackCanvas({ track }: { track: TrackData }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const parent = canvas.parentElement
    const width = parent?.clientWidth ?? 600
    const height = 360
    const ratio = window.devicePixelRatio || 1
    canvas.width = width * ratio
    canvas.height = height * ratio
    canvas.style.width = `${width}px`
    canvas.style.height = `${height}px`
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.scale(ratio, ratio)

    const lat0 = track.lat[0]
    const lon0 = track.lon[0]
    const cosLat = Math.cos((lat0 * Math.PI) / 180)
    const east = track.lon.map((lon) => (lon - lon0) * cosLat * 111_320)
    const north = track.lat.map((lat) => (lat - lat0) * 110_540)
    const minX = Math.min(...east)
    const maxX = Math.max(...east)
    const minY = Math.min(...north)
    const maxY = Math.max(...north)
    const spanX = Math.max(1, maxX - minX)
    const spanY = Math.max(1, maxY - minY)
    const scale = Math.min((width - 48) / spanX, (height - 48) / spanY)
    const toPx = (index: number): [number, number] => [
      24 + (east[index] - minX) * scale,
      height - 24 - (north[index] - minY) * scale,
    ]

    const styles = getComputedStyle(document.documentElement)
    ctx.clearRect(0, 0, width, height)
    ctx.strokeStyle = styles.getPropertyValue('--accent').trim() || '#0d9488'
    ctx.lineWidth = 1.6
    ctx.beginPath()
    for (let index = 0; index < east.length; index++) {
      const [x, y] = toPx(index)
      if (index === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.stroke()
    // Start (green) / end (red) markers.
    const drawDot = (index: number, color: string) => {
      const [x, y] = toPx(index)
      ctx.fillStyle = color
      ctx.beginPath()
      ctx.arc(x, y, 5, 0, Math.PI * 2)
      ctx.fill()
    }
    drawDot(0, styles.getPropertyValue('--success').trim() || '#16a34a')
    drawDot(east.length - 1, styles.getPropertyValue('--danger').trim() || '#dc2626')
    // Scale hint.
    ctx.fillStyle = styles.getPropertyValue('--text-secondary').trim() || '#888'
    ctx.font = '11px "JetBrains Mono", monospace'
    ctx.fillText(`范围约 ${Math.round(spanX)} m × ${Math.round(spanY)} m（离线轨迹，北向朝上）`, 24, 18)
  }, [track])

  return <canvas ref={canvasRef} />
}

export default function TrackMap({ track }: TrackMapProps) {
  const [tilesFailed, setTilesFailed] = useState(() =>
    typeof navigator !== 'undefined' && navigator.onLine === false,
  )
  const errorCountRef = useRef(0)
  const loadedRef = useRef(false)
  const segments = useMemo(() => buildSegments(track), [track])
  const center: [number, number] = [track.lat[0], track.lon[0]]
  const last = track.lat.length - 1

  if (tilesFailed) {
    return (
      <div className="mc-analysis-map">
        <TrackCanvas track={track} />
      </div>
    )
  }

  return (
    <div className="mc-analysis-map">
      <MapContainer center={center} zoom={16} scrollWheelZoom attributionControl>
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
          eventHandlers={{
            tileload: () => {
              loadedRef.current = true
            },
            tileerror: () => {
              errorCountRef.current++
              // Only degrade when nothing loaded at all - single-tile errors
              // are normal on flaky networks.
              if (!loadedRef.current && errorCountRef.current >= 4) {
                setTilesFailed(true)
              }
            },
          }}
        />
        {segments.map((segment, index) => (
          <Polyline
            key={index}
            positions={segment.positions}
            pathOptions={{ color: segment.color, weight: 3 }}
          />
        ))}
        <CircleMarker
          center={[track.lat[0], track.lon[0]]}
          radius={6}
          pathOptions={{ color: '#16a34a', fillColor: '#16a34a', fillOpacity: 0.9 }}
        />
        <CircleMarker
          center={[track.lat[last], track.lon[last]]}
          radius={6}
          pathOptions={{ color: '#dc2626', fillColor: '#dc2626', fillOpacity: 0.9 }}
        />
        <FitBounds track={track} />
      </MapContainer>
    </div>
  )
}
