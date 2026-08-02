import { useId, useMemo, useState } from 'react'
import Icon from '../ui/Icon'
import { useTelemetryStore } from '../../stores/telemetryStore'
import { projectGpsTrack } from '../../utils/gpsTrack'

const DISPLAY_RADII = [2, 5, 10, 20, 50, 100] as const
const VIEW_SIZE = 320
const CENTER = VIEW_SIZE / 2
const PLOT_RADIUS = 132

export default function GpsTrackPlot() {
  const [displayRadius, setDisplayRadius] = useState<number>(20)
  const clipId = `gps-track-${useId().replace(/:/g, '')}`
  const track = useTelemetryStore((state) => state.gpsTrack)
  const origin = useTelemetryStore((state) => state.gpsTrackOrigin)
  const clearTrack = useTelemetryStore((state) => state.clearGpsTrack)
  const recenterTrack = useTelemetryStore((state) => state.recenterGpsTrack)
  const projected = useMemo(() => projectGpsTrack(track, origin), [track, origin])
  const visiblePoints = projected.slice(-400).map((point) => ({
    ...point,
    x: CENTER + (point.east / displayRadius) * PLOT_RADIUS,
    y: CENTER - (point.north / displayRadius) * PLOT_RADIUS,
  }))
  const path = visiblePoints.map((point) => `${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(' ')
  const latest = visiblePoints[visiblePoints.length - 1]
  const latestDistance = projected.length > 0
    ? Math.hypot(projected[projected.length - 1]!.east, projected[projected.length - 1]!.north)
    : 0
  const latestOutside = latestDistance > displayRadius

  return (
    <section className="mc-card mc-gps-track">
      <header>
        <div>
          <span className="mc-eyebrow">LOCAL POSITION</span>
          <h2>GPS 打点轨迹</h2>
        </div>
        <div className="mc-gps-track__actions">
          <label>
            <span>显示半径</span>
            <select
              className="mc-select"
              aria-label="GPS 轨迹显示半径"
              value={displayRadius}
              onChange={(event) => setDisplayRadius(Number(event.target.value))}
            >
              {DISPLAY_RADII.map((radius) => <option key={radius} value={radius}>{radius} m</option>)}
            </select>
          </label>
          <button type="button" className="mc-icon-btn mc-icon-btn--bordered" onClick={recenterTrack} disabled={track.length === 0} aria-label="以当前位置为轨迹中心" title="以当前位置为中心">
            <Icon name="rtk" size={15} />
          </button>
          <button type="button" className="mc-icon-btn mc-icon-btn--bordered" onClick={clearTrack} disabled={track.length === 0} aria-label="清空 GPS 轨迹" title="清空轨迹">
            <Icon name="trash" size={15} />
          </button>
        </div>
      </header>

      <div className="mc-gps-track__meta">
        <span>打点数 <strong className="mc-mono">{track.length}</strong></span>
        <span>中心偏移 <strong className="mc-mono">{latestDistance.toFixed(1)} m</strong></span>
        {latestOutside && <span data-state="warning">当前位置超出显示半径</span>}
      </div>

      <div className="mc-gps-track__plot" data-empty={track.length === 0 || undefined}>
        {track.length === 0 && <div><span>等待有效 GPS 定位点</span></div>}
        <svg viewBox={`0 0 ${VIEW_SIZE} ${VIEW_SIZE}`} role="img" aria-label={`GPS 本地轨迹，共 ${track.length} 个点，显示半径 ${displayRadius} 米`}>
          <defs><clipPath id={clipId}><circle cx={CENTER} cy={CENTER} r={PLOT_RADIUS} /></clipPath></defs>
          <g className="mc-gps-track__grid">
            <circle cx={CENTER} cy={CENTER} r={PLOT_RADIUS} />
            <circle cx={CENTER} cy={CENTER} r={PLOT_RADIUS / 2} />
            <line x1={CENTER - PLOT_RADIUS} y1={CENTER} x2={CENTER + PLOT_RADIUS} y2={CENTER} />
            <line x1={CENTER} y1={CENTER - PLOT_RADIUS} x2={CENTER} y2={CENTER + PLOT_RADIUS} />
          </g>
          <g className="mc-gps-track__labels">
            <text x={CENTER} y={CENTER - PLOT_RADIUS + 15}>N</text>
            <text x={CENTER} y={CENTER + PLOT_RADIUS - 7}>S</text>
            <text x={CENTER - PLOT_RADIUS + 12} y={CENTER + 4}>W</text>
            <text x={CENTER + PLOT_RADIUS - 12} y={CENTER + 4}>E</text>
            <text x={CENTER + PLOT_RADIUS / 2 + 5} y={CENTER - 7}>{displayRadius / 2}m</text>
          </g>
          <g clipPath={`url(#${clipId})`}>
            {path && <polyline className="mc-gps-track__line" points={path} />}
            {visiblePoints.map((point, index) => (
              <circle
                key={`${point.capturedAt}-${index}`}
                className="mc-gps-track__point"
                cx={point.x}
                cy={point.y}
                r={index === visiblePoints.length - 1 ? 3.2 : 1.7}
                opacity={0.26 + (index / Math.max(visiblePoints.length - 1, 1)) * 0.64}
              />
            ))}
            {latest && <circle className="mc-gps-track__current-ring" cx={latest.x} cy={latest.y} r={7} />}
          </g>
          <circle className="mc-gps-track__origin" cx={CENTER} cy={CENTER} r={2.6} />
        </svg>
      </div>
    </section>
  )
}
