import type { ReactNode } from 'react'
import { NavLink } from 'react-router-dom'
import { useConnectionStore } from '../../stores/connectionStore'
import { useTelemetryStore } from '../../stores/telemetryStore'
import Icon from '../ui/Icon'

const radToDegrees = (radians: number) => radians * 180 / Math.PI

function TelemetryItem({ icon, label, value, muted = false, width }: { icon?: ReactNode; label: string; value: string; muted?: boolean; width?: string }) {
  return (
    <div className="mc-telemetry__item" style={width ? { '--telemetry-item-width': width } as React.CSSProperties : undefined}>
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
  const preflightCheck = useTelemetryStore((state) => state.preflightCheck)
  const sensorsHealthy = useTelemetryStore((state) => state.sensorsHealthy)
  const isStale = useTelemetryStore((state) => state.isStale)
  const status = useConnectionStore((state) => state.status)
  const connected = status === 'connected'
  const stale = !connected || isStale('attitude')
  const gpsStale = !connected || isStale('gps')
  const batteryStale = !connected || (isStale('battery') && isStale('sysStatus'))
  const preflightStale = !connected || isStale('sysStatus')
  const preflightLabel = preflightStale
    ? (connected ? '预检中' : '预检 —')
    : preflightCheck === true
      ? '预检通过'
      : preflightCheck === false
        ? '预检未通过'
        : sensorsHealthy === true
          ? '传感器正常'
          : sensorsHealthy === false
            ? '传感器异常'
            : '状态未知'

  return (
    <div className="mc-telemetry" aria-label="飞行遥测">
      <div className="mc-telemetry__arm">
        <span className="mc-status-dot" style={{ background: vehicle?.armed && connected ? 'var(--danger)' : connected ? 'var(--success)' : 'var(--text-disabled)' }} />
        <span>{vehicle?.armed && connected ? '已解锁' : connected ? '已上锁' : '未连接'}</span>
      </div>
      <TelemetryItem label="模式" width="138px" value={connected ? vehicle?.mode ?? '—' : '—'} muted={!connected} />
      <TelemetryItem label="姿态" width="158px" value={stale ? '—° / —°' : radToDegrees(attitude?.roll ?? 0).toFixed(1) + '° / ' + radToDegrees(attitude?.pitch ?? 0).toFixed(1) + '°'} muted={stale} />
      <TelemetryItem icon={<Icon name="altitude" size={15} />} label="高度" width="110px" value={connected && !isStale('vfrHud') ? relativeAlt.toFixed(1) + 'm' : '—m'} muted={!connected || isStale('vfrHud')} />
      <TelemetryItem label="航向" width="94px" value={connected && !isStale('vfrHud') ? heading.toFixed(0) + '°' : '—°'} muted={!connected || isStale('vfrHud')} />
      <TelemetryItem icon={<Icon name="satellite" size={15} />} label="GPS" width="106px" value={gpsStale ? 'N/A' : String(gps?.satellites_visible ?? 0) + ' SAT'} muted={gpsStale} />
      <TelemetryItem icon={<Icon name="battery" size={15} />} label="电池" width="154px" value={batteryStale ? '—' : (battery?.voltage.toFixed(1) ?? '—') + 'V · ' + (battery?.remaining ?? 0) + '%'} muted={batteryStale} />
      <div className="mc-telemetry__spacer" />
      <div className="mc-telemetry__tools" aria-label="飞控快捷操作">
        <NavLink to="/settings" className="mc-telemetry__pill">
          <Icon name="settings" size={13} />
          <span>设置引导</span>
        </NavLink>
        <span className="mc-telemetry__pill is-muted" title={connected ? '飞控 SYS_STATUS 预检结果' : '连接飞控后显示预检状态'}>
          <Icon name="check" size={13} />
          <span>{preflightLabel}</span>
        </span>
      </div>
    </div>
  )
}
