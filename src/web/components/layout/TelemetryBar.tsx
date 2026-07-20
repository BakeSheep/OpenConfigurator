import { useTelemetryStore } from '../../stores/telemetryStore'
import { useConnectionStore } from '../../stores/connectionStore'

const rad2deg = (r: number) => (r * 180 / Math.PI)

function Group({ children }: { children: React.ReactNode }) {
  return <div className="flex items-center gap-2 px-3">{children}</div>
}

function Label({ children }: { children: React.ReactNode }) {
  return <span className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--text-disabled)' }}>{children}</span>
}

function Value({ children, accent }: { children: React.ReactNode; accent?: boolean }) {
  return (
    <span className="mc-mono text-[13px] font-medium tabular-nums" style={{ color: accent ? 'var(--accent)' : 'var(--text-primary)' }}>
      {children}
    </span>
  )
}

function fixLabel(fix: number): { text: string; color: string; bg: string } {
  if (fix >= 6) return { text: 'RTK', color: '#3B82F6', bg: 'rgba(59,130,246,.15)' }
  if (fix >= 3) return { text: '3D', color: '#22C55E', bg: 'rgba(34,197,94,.15)' }
  if (fix === 2) return { text: '2D', color: '#F59E0B', bg: 'rgba(245,158,11,.15)' }
  return { text: 'NoFix', color: '#EF4444', bg: 'rgba(239,68,68,.15)' }
}

export default function TelemetryBar() {
  const { attitude, gps, battery, status, relativeAlt, groundSpeed, heading } = useTelemetryStore()
  const connected = useConnectionStore((s) => s.status === 'connected')

  const armed = status?.armed || false
  const fix = fixLabel(gps?.fix_type || 0)
  const battPct = battery?.remaining ?? 0
  const battColor = battPct > 40 ? '#22C55E' : battPct > 20 ? '#F59E0B' : '#EF4444'

  return (
    <div
      className="flex items-stretch shrink-0 border-b overflow-x-auto select-none"
      style={{
        height: 'var(--telemetrybar-height)',
        background: 'var(--bg-secondary)',
        borderColor: 'var(--border)',
        opacity: connected ? 1 : 0.45,
      }}
    >
      {/* ARMED / DISARMED */}
      <Group>
        <span
          className="text-[11px] font-bold px-2.5 py-1 rounded-md tracking-wider"
          style={
            armed
              ? { background: 'rgba(239,68,68,.18)', color: '#EF4444', animation: 'mc-pulse 1.5s ease-in-out infinite' }
              : { background: 'rgba(34,197,94,.12)', color: '#22C55E' }
          }
        >
          {armed ? 'ARMED' : 'DISARMED'}
        </span>
        {status?.mode && (
          <span
            className="text-[11px] font-medium px-2 py-0.5 rounded"
            style={{ background: 'var(--accent-dim)', color: 'var(--accent)' }}
          >
            {status.mode}
          </span>
        )}
      </Group>

      <div className="mc-divider" />

      {/* Attitude */}
      <Group>
        <div className="flex flex-col items-center leading-none gap-0.5">
          <Label>Roll</Label>
          <Value>{rad2deg(attitude?.roll || 0).toFixed(1)}°</Value>
        </div>
        <div className="flex flex-col items-center leading-none gap-0.5">
          <Label>Pitch</Label>
          <Value>{rad2deg(attitude?.pitch || 0).toFixed(1)}°</Value>
        </div>
        <div className="flex flex-col items-center leading-none gap-0.5">
          <Label>Yaw</Label>
          <Value>{rad2deg(attitude?.yaw || 0).toFixed(0)}°</Value>
        </div>
      </Group>

      <div className="mc-divider" />

      {/* Flight data */}
      <Group>
        <div className="flex flex-col items-center leading-none gap-0.5">
          <Label>ALT</Label>
          <Value accent>{relativeAlt.toFixed(1)}m</Value>
        </div>
        <div className="flex flex-col items-center leading-none gap-0.5">
          <Label>SPD</Label>
          <Value>{groundSpeed.toFixed(1)}</Value>
        </div>
        <div className="flex flex-col items-center leading-none gap-0.5">
          <Label>HDG</Label>
          <Value>{heading.toFixed(0)}°</Value>
        </div>
      </Group>

      <div className="mc-divider" />

      {/* GPS */}
      <Group>
        <span
          className="text-[11px] font-bold px-2 py-0.5 rounded"
          style={{ background: fix.bg, color: fix.color }}
        >
          {fix.text}
        </span>
        <div className="flex flex-col items-center leading-none gap-0.5">
          <Label>SATS</Label>
          <Value>{gps?.satellites_visible ?? '--'}</Value>
        </div>
      </Group>

      <div className="mc-divider" />

      {/* Battery */}
      <Group>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={battColor} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="2" y="7" width="17" height="10" rx="2" />
          <path d="M22 11v2" />
          <rect x="4" y="9" width={Math.max(2, (battPct / 100) * 13)} height="6" rx="1" fill={battColor} stroke="none" />
        </svg>
        <Value>{battery ? `${battery.voltage.toFixed(1)}V` : '--V'}</Value>
        <span className="mc-mono text-[13px] font-semibold" style={{ color: battColor }}>
          {battery ? `${battPct}%` : '--%'}
        </span>
      </Group>

      <div className="mc-divider" />

      {/* EKF status dot */}
      <Group>
        <div className="flex flex-col items-center leading-none gap-0.5">
          <Label>EKF</Label>
          <span
            className="w-2.5 h-2.5 rounded-full"
            style={{
              background: '#22C55E',
              boxShadow: '0 0 6px rgba(34,197,94,.5)',
            }}
            title="EKF 正常"
          />
        </div>
      </Group>
    </div>
  )
}
