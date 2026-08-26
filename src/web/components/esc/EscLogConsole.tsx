import { useTranslation } from 'react-i18next'
import { useEscStore } from '../../stores/escStore'

/** Scrolling console of local-runtime ESC log entries (max 500, newest last). */
export default function EscLogConsole() {
  const { t } = useTranslation()
  const log = useEscStore((state) => state.log)

  if (log.length === 0) return null

  return (
    <details className="mc-card mc-esc-log">
      <summary>
        <span>{t('escLog.title')}</span>
        <small>{t('escLog.countCollapsed', { count: log.length })}</small>
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
