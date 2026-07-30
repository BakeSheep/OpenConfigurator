import { useEscStore } from '../../stores/escStore'

/** Scrolling console of server-side ESC log entries (max 500, newest last). */
export default function EscLogConsole() {
  const log = useEscStore((state) => state.log)

  if (log.length === 0) return null

  return (
    <details className="mc-card mc-esc-log">
      <summary>
        <span>通讯记录</span>
        <small>{log.length} 条 · 默认收起</small>
      </summary>
      <div className="mc-mono mc-esc-log__entries">
        {log.map((entry, index) => (
          <div key={`${entry.timestamp}-${index}`} data-level={entry.level}>
            <span>{new Date(entry.timestamp).toLocaleTimeString()}</span>
            <p>{entry.text}</p>
          </div>
        ))}
      </div>
    </details>
  )
}