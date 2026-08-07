import { useTranslation } from 'react-i18next'

interface GamepadVisualizerProps {
  connected: boolean
  controllerId: string | null
  flightControllerConnected: boolean
  enabled: boolean
  axes: number[]
  buttons: boolean[]
  mapping: {
    throttle: number
    yaw: number
    pitch: number
    roll: number
    armButton: number
    disarmButton: number
    modeButton: number
    rtlButton: number
  }
}

const clampAxis = (value: number | undefined) => Math.max(-1, Math.min(1, value || 0))

function ConnectionRow({ label, value, active, accent = false }: { label: string; value: string; active: boolean; accent?: boolean }) {
  const tone = active ? (accent ? 'var(--accent)' : 'var(--success)') : 'var(--text-disabled)'
  return (
    <div className="flex min-w-0 items-center justify-between gap-3 border-b py-2.5 last:border-0" style={{ borderColor: 'var(--border)' }}>
      <span className="shrink-0 text-[11px]" style={{ color: 'var(--text-secondary)' }}>{label}</span>
      <span className="flex min-w-0 items-center gap-2 text-[11px] font-semibold" style={{ color: tone }}>
        <i className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: tone }} />
        <span className="truncate">{value}</span>
      </span>
    </div>
  )
}

export default function GamepadVisualizer({
  connected,
  controllerId,
  flightControllerConnected,
  enabled,
  axes,
  buttons,
  mapping,
}: GamepadVisualizerProps) {
  const { t } = useTranslation()
  const leftX = clampAxis(axes[mapping.yaw])
  const leftY = clampAxis(axes[mapping.throttle])
  const rightX = clampAxis(axes[mapping.roll])
  const rightY = clampAxis(axes[mapping.pitch])
  const buttonFill = (index: number) => buttons[index] ? 'var(--accent)' : 'var(--bg-hover)'
  const buttonStroke = (index: number) => buttons[index] ? 'var(--accent-hover)' : 'var(--border-strong)'
  const dpadFill = (index: number) => buttons[index] ? 'var(--accent)' : 'var(--bg-hover)'

  return (
    <div className="grid items-stretch gap-4 lg:grid-cols-[minmax(360px,0.9fr)_minmax(360px,1.1fr)]">
      <div className="relative flex min-h-[260px] items-center overflow-hidden rounded-2xl border p-3" style={{ background: 'linear-gradient(145deg, var(--bg-tertiary), var(--bg-secondary))', borderColor: 'var(--border)' }}>
        <div className="absolute left-4 top-4 z-10 flex items-center gap-2 text-[9px] font-bold tracking-[0.16em]" style={{ color: connected ? 'var(--success)' : 'var(--text-disabled)' }}>
          <i className="h-1.5 w-1.5 rounded-full" style={{ background: connected ? 'var(--success)' : 'var(--text-disabled)', boxShadow: connected ? '0 0 10px var(--success)' : 'none' }} />
          {connected ? 'LIVE INPUT' : 'WAITING'}
        </div>
        <svg viewBox="0 0 560 300" className="h-auto w-full" role="img" aria-label={t('joystick.visualizer.aria.gamepadState')}>
          <defs>
            <linearGradient id="padBody" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="var(--bg-hover)" />
              <stop offset="1" stopColor="var(--bg-secondary)" />
            </linearGradient>
            <filter id="padShadow" x="-20%" y="-20%" width="140%" height="160%">
              <feDropShadow dx="0" dy="10" stdDeviation="10" floodColor="#000" floodOpacity=".25" />
            </filter>
          </defs>

          <path d="M149 69c-41 5-70 34-83 78L43 226c-9 31 29 51 50 25l49-61c22 19 50 28 82 28h112c32 0 60-9 82-28l49 61c21 26 59 6 50-25l-23-79c-13-44-42-73-83-78-32-4-58 8-78 31H227c-20-23-46-35-78-31Z" fill="url(#padBody)" stroke="var(--border-strong)" strokeWidth="4" filter="url(#padShadow)" />
          <path d="M222 101h116" stroke="var(--border)" strokeWidth="2" strokeLinecap="round" />

          {[4, 5].map((index, side) => (
            <rect key={index} x={side ? 367 : 133} y="54" width="60" height="18" rx="9" fill={buttonFill(index)} stroke={buttonStroke(index)} strokeWidth="2" />
          ))}

          <g aria-label={t('joystick.visualizer.aria.dpad')}>
            <circle cx="147" cy="139" r="47" fill="var(--bg-primary)" stroke="var(--border)" strokeWidth="2" />
            <path d="M136 130v-24c0-5 4-9 9-9h4c5 0 9 4 9 9v24Z" fill={dpadFill(12)} stroke={buttonStroke(12)} strokeWidth="1.5" />
            <path d="M158 148h24c5 0 9-4 9-9v-4c0-5-4-9-9-9h-24Z" fill={dpadFill(15)} stroke={buttonStroke(15)} strokeWidth="1.5" />
            <path d="M136 148v24c0 5 4 9 9 9h4c5 0 9-4 9-9v-24Z" fill={dpadFill(13)} stroke={buttonStroke(13)} strokeWidth="1.5" />
            <path d="M136 148h-24c-5 0-9-4-9-9v-4c0-5 4-9 9-9h24Z" fill={dpadFill(14)} stroke={buttonStroke(14)} strokeWidth="1.5" />
            <rect x="136" y="126" width="22" height="22" rx="4" fill="var(--bg-hover)" />
          </g>

          {[
            { cx: 218, cy: 178, x: leftX, y: leftY, label: 'L' },
            { cx: 342, cy: 178, x: rightX, y: rightY, label: 'R' },
          ].map((stick) => (
            <g key={stick.label}>
              <circle cx={stick.cx} cy={stick.cy} r="37" fill="var(--bg-primary)" stroke="var(--border-strong)" strokeWidth="2" />
              <circle cx={stick.cx} cy={stick.cy} r="27" fill="none" stroke="var(--border)" strokeDasharray="2 4" />
              <circle cx={stick.cx + stick.x * 19} cy={stick.cy + stick.y * 19} r="20" fill={connected ? 'var(--accent)' : 'var(--bg-hover)'} stroke={connected ? 'var(--accent-hover)' : 'var(--border-strong)'} strokeWidth="2" style={{ transition: 'cx 40ms linear, cy 40ms linear' }} />
              <text x={stick.cx + stick.x * 19} y={stick.cy + stick.y * 19 + 4} textAnchor="middle" fontSize="10" fontWeight="800" fill="#fff">{stick.label}</text>
            </g>
          ))}

          {[
            { index: 3, cx: 430, cy: 105, label: 'Y', color: 'var(--warning)' },
            { index: 1, cx: 430, cy: 169, label: 'A', color: 'var(--success)' },
            { index: 2, cx: 398, cy: 137, label: 'X', color: 'var(--accent)' },
            { index: 0, cx: 462, cy: 137, label: 'B', color: 'var(--danger)' },
          ].map((button) => (
            <g key={button.index}>
              <circle cx={button.cx} cy={button.cy} r="18" fill={buttonFill(button.index)} stroke={buttons[button.index] ? button.color : buttonStroke(button.index)} strokeWidth="2.5" />
              <text x={button.cx} y={button.cy + 4} textAnchor="middle" fontSize="10" fontWeight="800" fill={buttons[button.index] ? '#fff' : button.color}>{button.label}</text>
            </g>
          ))}

          {[8, 9].map((index, side) => (
            <g key={index}>
              <circle cx={262 + side * 36} cy="133" r="10" fill={buttonFill(index)} stroke={buttonStroke(index)} strokeWidth="2" />
              <path d={side ? 'M295 129h6v8h-6Z' : 'M258 133h8'} stroke="var(--text-secondary)" strokeWidth="2" />
            </g>
          ))}
        </svg>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <section className="rounded-xl border px-4 py-3" style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border)' }}>
          <p className="mc-section-title mb-1">{t('joystick.visualizer.connectionStatus')}</p>
          <ConnectionRow label={t('joystick.visualizer.gamepad')} value={connected ? controllerId ?? t('joystick.visualizer.connected') : t('joystick.visualizer.noDevice')} active={connected} />
          <ConnectionRow label={t('joystick.visualizer.fcLink')} value={flightControllerConnected ? t('joystick.visualizer.connected') : t('joystick.visualizer.disconnected')} active={flightControllerConnected} />
          <ConnectionRow label={t('joystick.visualizer.mavlinkManualInput')} value={enabled ? t('joystick.visualizer.manuallyEnabled') : t('joystick.visualizer.notEnabled')} active={enabled} accent />
        </section>

        <section className="rounded-xl border p-4" style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border)' }}>
          <p className="mc-section-title mb-3">{t('joystick.visualizer.stickCoords')}</p>
          <div className="grid grid-cols-2 gap-2">
            {[
              [t('joystick.visualizer.leftX'), leftX], [t('joystick.visualizer.leftY'), leftY], [t('joystick.visualizer.rightX'), rightX], [t('joystick.visualizer.rightY'), rightY],
            ].map(([label, value]) => (
              <div key={label as string} className="rounded-lg px-3 py-2" style={{ background: 'var(--bg-tertiary)' }}>
                <p className="text-[9px]" style={{ color: 'var(--text-disabled)' }}>{label}</p>
                <p className="mc-mono mt-0.5 text-[12px] font-semibold" style={{ color: 'var(--text-primary)' }}>{(value as number).toFixed(3)}</p>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  )
}
