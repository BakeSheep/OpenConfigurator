import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import type { TrackData } from '../../utils/ulogAnalysis'

interface TrackMapProps {
  track: TrackData
}

function minMax(values: number[]): [number, number] {
  let min = Infinity
  let max = -Infinity
  for (const value of values) {
    if (value < min) min = value
    if (value > max) max = value
  }
  return [min, max]
}

/** GPS rendering is deliberately tile-free: coordinates never leave the tab. */
export default function TrackMap({ track }: TrackMapProps) {
  const { t } = useTranslation()
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const parent = canvas?.parentElement
    if (!canvas || !parent || track.lat.length === 0) return

    const render = () => {
      const width = Math.max(280, parent.clientWidth)
      const height = 360
      const ratio = window.devicePixelRatio || 1
      canvas.width = Math.round(width * ratio)
      canvas.height = Math.round(height * ratio)
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0)

      const lat0 = track.lat[0]
      const lon0 = track.lon[0]
      const cosLat = Math.cos((lat0 * Math.PI) / 180)
      const east = track.lon.map((lon) => (lon - lon0) * cosLat * 111_320)
      const north = track.lat.map((lat) => (lat - lat0) * 110_540)
      const [minX, maxX] = minMax(east)
      const [minY, maxY] = minMax(north)
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

      const dot = (index: number, color: string) => {
        const [x, y] = toPx(index)
        ctx.fillStyle = color
        ctx.beginPath()
        ctx.arc(x, y, 5, 0, Math.PI * 2)
        ctx.fill()
      }
      dot(0, styles.getPropertyValue('--success').trim() || '#16a34a')
      dot(east.length - 1, styles.getPropertyValue('--danger').trim() || '#dc2626')
      ctx.fillStyle = styles.getPropertyValue('--text-secondary').trim() || '#888'
      ctx.font = '11px ui-monospace, SFMono-Regular, Consolas, monospace'
      ctx.fillText(t('logAnalysis.offlineTrackHint', { width: Math.round(spanX), height: Math.round(spanY) }), 24, 18)
    }

    render()
    const observer = new ResizeObserver(render)
    observer.observe(parent)
    return () => observer.disconnect()
  }, [track, t])

  return (
    <div className="mc-analysis-map" role="img" aria-label={t('logAnalysis.trackMap')}>
      <canvas ref={canvasRef} />
    </div>
  )
}
