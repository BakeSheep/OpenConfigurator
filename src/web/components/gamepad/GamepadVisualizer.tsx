interface GamepadVisualizerProps {
  connected: boolean
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

export default function GamepadVisualizer({ connected, axes, buttons, mapping }: GamepadVisualizerProps) {
  const leftX = clampAxis(axes[mapping.yaw])
  const leftY = clampAxis(axes[mapping.throttle])
  const rightX = clampAxis(axes[mapping.roll])
  const rightY = clampAxis(axes[mapping.pitch])
  const pressed = buttons.flatMap((value, index) => value ? [index] : [])

  const buttonFill = (index: number) => buttons[index] ? 'var(--accent)' : 'var(--bg-hover)'
  const buttonStroke = (index: number) => buttons[index] ? 'var(--accent-hover)' : 'var(--border-strong)'

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[minmax(280px,1fr)_220px] gap-5 items-center">
      <div className="relative min-h-[250px] rounded-xl overflow-hidden" style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border)' }}>
        <div className="absolute left-3 top-3 z-10 text-[10px] font-semibold tracking-wider" style={{ color: connected ? 'var(--success)' : 'var(--text-disabled)' }}>
          {connected ? 'LIVE INPUT' : 'WAITING FOR GAMEPAD'}
        </div>
        <svg viewBox="0 0 520 280" className="w-full h-full min-h-[250px]" role="img" aria-label="当前手柄按钮和摇杆状态">
          <path
            d="M153 66C98 70 70 107 56 159L40 222c-7 28 28 42 47 19l48-56c18 13 39 20 64 20h122c25 0 46-7 64-20l48 56c19 23 54 9 47-19l-16-63c-14-52-42-89-97-93-31-2-56 11-75 30h-84c-19-19-44-32-75-30Z"
            fill="var(--bg-secondary)"
            stroke="var(--border-strong)"
            strokeWidth="4"
          />

          {/* shoulder buttons */}
          {[4, 5].map((index, i) => (
            <rect key={index} x={i === 0 ? 116 : 344} y="48" width="60" height="18" rx="9" fill={buttonFill(index)} stroke={buttonStroke(index)} />
          ))}

          {/* d-pad */}
          <path d="M122 105h24v20h20v24h-20v20h-24v-20h-20v-24h20Z" fill="var(--bg-hover)" stroke="var(--border-strong)" strokeWidth="2" />

          {/* sticks */}
          {[
            { cx: 190, cy: 158, x: leftX, y: leftY, label: 'L' },
            { cx: 330, cy: 158, x: rightX, y: rightY, label: 'R' },
          ].map((stick) => (
            <g key={stick.label}>
              <circle cx={stick.cx} cy={stick.cy} r="35" fill="var(--bg-primary)" stroke="var(--border-strong)" strokeWidth="2" />
              <line x1={stick.cx - 28} y1={stick.cy} x2={stick.cx + 28} y2={stick.cy} stroke="var(--border)" />
              <line x1={stick.cx} y1={stick.cy - 28} x2={stick.cx} y2={stick.cy + 28} stroke="var(--border)" />
              <circle
                cx={stick.cx + stick.x * 21}
                cy={stick.cy + stick.y * 21}
                r="19"
                fill={connected ? 'var(--accent)' : 'var(--bg-hover)'}
                stroke="var(--accent-hover)"
                strokeWidth="2"
                style={{ transition: 'cx 40ms linear, cy 40ms linear' }}
              />
              <text x={stick.cx} y={stick.cy + 4} textAnchor="middle" fontSize="10" fontWeight="700" fill="#fff">{stick.label}</text>
            </g>
          ))}

          {/* ABXY / buttons 0-3 */}
          {[
            { index: 3, cx: 414, cy: 112, label: 'Y' },
            { index: 1, cx: 414, cy: 168, label: 'A' },
            { index: 2, cx: 386, cy: 140, label: 'X' },
            { index: 0, cx: 442, cy: 140, label: 'B' },
          ].map((button) => (
            <g key={button.index}>
              <circle cx={button.cx} cy={button.cy} r="17" fill={buttonFill(button.index)} stroke={buttonStroke(button.index)} strokeWidth="2" />
              <text x={button.cx} y={button.cy + 4} textAnchor="middle" fontSize="10" fontWeight="700" fill="var(--text-primary)">{button.label}</text>
            </g>
          ))}

          {/* center buttons */}
          {[8, 9].map((index, i) => (
            <circle key={index} cx={242 + i * 36} cy="126" r="9" fill={buttonFill(index)} stroke={buttonStroke(index)} />
          ))}
        </svg>
      </div>

      <div className="space-y-4">
        <div>
          <p className="mc-section-title mb-2">摇杆坐标</p>
          <div className="grid grid-cols-2 gap-2">
            {[
              ['左 X', leftX], ['左 Y', leftY], ['右 X', rightX], ['右 Y', rightY],
            ].map(([label, value]) => (
              <div key={label as string} className="rounded-lg p-2" style={{ background: 'var(--bg-tertiary)' }}>
                <p className="text-[10px]" style={{ color: 'var(--text-disabled)' }}>{label}</p>
                <p className="mc-mono text-[12px]" style={{ color: 'var(--text-primary)' }}>{(value as number).toFixed(3)}</p>
              </div>
            ))}
          </div>
        </div>
        <div>
          <p className="mc-section-title mb-2">按键状态</p>
          <div className="min-h-9 rounded-lg px-3 py-2 text-[11px] mc-mono" style={{ background: 'var(--bg-tertiary)', color: pressed.length ? 'var(--accent)' : 'var(--text-disabled)' }}>
            {pressed.length ? `按下：${pressed.join(', ')}` : '没有按键按下'}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2 text-[10px]" style={{ color: 'var(--text-secondary)' }}>
          <span>解锁 B{mapping.armButton}</span><span>上锁 B{mapping.disarmButton}</span>
          <span>模式 B{mapping.modeButton}</span><span>返航 B{mapping.rtlButton}</span>
        </div>
      </div>
    </div>
  )
}
