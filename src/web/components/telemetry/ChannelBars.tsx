interface ChannelBarsProps {
  labels: string[]
  values: Array<number | null>
  connected: boolean
  secondaryLabels?: string[]
  accent?: 'accent' | 'success'
  compact?: boolean
}

export default function ChannelBars({ labels, values, connected, secondaryLabels, accent = 'accent', compact = false }: ChannelBarsProps) {
  const activeColor = accent === 'success' ? 'var(--success)' : 'var(--accent)'

  return (
    <div className={`mc-channel-bars${compact ? ' mc-channel-bars--compact' : ''}`}>
      <div className="mc-channel-bars__track" style={{ gridTemplateColumns: `repeat(${labels.length}, minmax(34px, 1fr))` }}>
        {labels.map((label, index) => {
          const raw = values[index] ?? 0
          const normalized = Math.max(0, Math.min(100, raw > 0 ? (raw - 1000) / 10 : 0))
          return (
            <div key={label} className="mc-channel-bar">
              <span className="mc-channel-bar__value">{raw > 0 ? Math.round(raw) : '—'}</span>
              <div className="mc-channel-bar__gauge">
                <i className="mc-channel-bar__midpoint" />
                <i
                  className="mc-channel-bar__fill"
                  style={{ height: normalized + '%', background: connected && raw > 0 ? activeColor : 'var(--text-disabled)' }}
                />
              </div>
              <strong>{label}</strong>
              {secondaryLabels && <small>{secondaryLabels[index]}</small>}
            </div>
          )
        })}
      </div>
    </div>
  )
}
