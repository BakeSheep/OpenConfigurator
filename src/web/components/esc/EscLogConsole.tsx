import { useEscStore } from '../../stores/escStore'

/** Scrolling console of server-side ESC log entries (max 500, newest last). */
export default function EscLogConsole() {
  const log = useEscStore((state) => state.log)

  if (log.length === 0) return null

  return (
    <section className="mc-card">
      <div className="mc-section-title">操作日志</div>
      <div
        className="mc-mono"
        style={{
          maxHeight: 200,
          overflowY: 'auto',
          fontSize: 12,
          lineHeight: 1.6,
          background: 'var(--bg-secondary)',
          borderRadius: 8,
          padding: '8px 12px',
        }}
      >
        {log.map((entry, index) => (
          <div
            key={`${entry.timestamp}-${index}`}
            style={{
              color:
                entry.level === 'error'
                  ? 'var(--danger)'
                  : entry.level === 'warn'
                    ? 'var(--warning)'
                    : 'var(--text-secondary)',
            }}
          >
            <span style={{ opacity: 0.6 }}>
              {new Date(entry.timestamp).toLocaleTimeString()}
            </span>{' '}
            {entry.text}
          </div>
        ))}
      </div>
    </section>
  )
}
