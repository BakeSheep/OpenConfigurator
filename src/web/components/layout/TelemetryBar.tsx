import type { ReactNode } from 'react'
import { useConnectionStore } from '../../stores/connectionStore'
import { useTelemetryStore } from '../../stores/telemetryStore'
import Icon from '../ui/Icon'

const radToDegrees = (radians: number) => radians * 180 / Math.PI

function TelemetryItem({ icon, label, value, muted = false }: { icon?: ReactNode; label: string; value: string; muted?: boolean }) {
  return (
    <div className="mc-telemetry__item">
      {icon && <span className="mc-telemetry__icon">{icon}</span>}
      <span className="mc-telemetry__label">{label}</span>
      <span className="mc-telemetry__value" data-muted={muted}>{value}</span>
    </div>
  )
}

export default function TelemetryBar() {
  const attitude = useTelemetryStore((state) => state.attitude)
  const gps = useTelemetryStore((state) => state.gps)
  const battery = useTelemetryStore((state) => state.battery)
  const vehicle = useTelemetryStore((state) => state.status)
  const relativeAlt = useTelemetryStore((state) => state.relativeAlt)
  const heading = useTelemetryStore((state) => state.heading)
  const isStale = useTelemetryStore((state) => state.isStale)
  const status = useConnectionStore((state) => state.status)
  const connected = status === 'connected'
  const stale = !connected || isStale('attitude')
  const gpsStale = !connected || isStale('gps')
  const batteryStale = !connected || (isStale('battery') && isStale('sysStatus'))

  return (
    <div className="mc-telemetry" aria-label="飞行遥测">
      <div className="mc-telemetry__arm">
        <span className="mc-status-dot" style={{ background: vehicle?.armed && connected ? 'var(--danger)' : connected ? 'var(--success)' : 'var(--text-disabled)' }} />
        <span>{vehicle?.armed && connected ? '已解锁' : connected ? '已上锁' : '未连接'}</span>
      </div>
      <TelemetryItem label="模式" value={connected ? vehicle?.mode ?? '—' : '—'} muted={!connected} />
      <TelemetryItem label="姿态" value={stale ? '—° / —°' : radToDegrees(attitude?.roll ?? 0).toFixed(1) + '° / ' + radToDegrees(attitude?.pitch ?? 0).toFixed(1) + '°'} muted={stale} />
      <TelemetryItem icon={<Icon name="altitude" size={15} />} label="高度" value={connected && !isStale('vfrHud') ? relativeAlt.toFixed(1) + 'm' : '—m'} muted={!connected || isStale('vfrHud')} />
      <TelemetryItem label="航向" value={connected && !isStale('vfrHud') ? heading.toFixed(0) + '°' : '—°'} muted={!connected || isStale('vfrHud')} />
      <TelemetryItem icon={<Icon name="satellite" size={15} />} label="GPS" value={gpsStale ? 'N/A' : String(gps?.satellites_visible ?? 0) + ' SAT'} muted={gpsStale} />
      <TelemetryItem icon={<Icon name="battery" size={15} />} label="电池" value={batteryStale ? '—' : (battery?.voltage.toFixed(1) ?? '—') + 'V · ' + (battery?.remaining ?? 0) + '%'} muted={batteryStale} />
    </div>
  )
}
