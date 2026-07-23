import { useConnectionStore } from '../../stores/connectionStore'
import { useTelemetryStore } from '../../stores/telemetryStore'
import { useThemeStore } from '../../stores/themeStore'
import Icon from '../ui/Icon'

export default function Topbar() {
  const { status, port, type, setConnectDialogOpen } = useConnectionStore()
  const { theme, toggleTheme } = useThemeStore()
  const autopilotVersion = useTelemetryStore((state) => state.autopilotVersion)
  const connected = status === 'connected'
  const connectionLabel = connected
    ? (type === 'bluetooth' ? 'BT' : 'USB') + ' · ' + (port ?? '已连接')
    : status === 'connecting' ? '连接中' : '未连接'

  return (
    <header className="mc-topbar">
      <div className="mc-topbar__brand">
        <span className="mc-topbar__mark" aria-hidden="true">S</span>
        <span className="mc-topbar__name">SkyLab</span>
      </div>

      <div className="mc-topbar__vehicle" aria-live="polite">
        {connected && autopilotVersion && (
          <>
            <strong>{autopilotVersion.boardName}</strong>
            <i />
            <span>{autopilotVersion.firmwareLabel}</span>
          </>
        )}
      </div>

      <div className="mc-topbar__actions">
        <button
          type="button"
          className="mc-topbar__link"
          title={theme === 'dark' ? '切换到浅色主题' : '切换到深色主题'}
          aria-label={theme === 'dark' ? '切换到浅色主题' : '切换到深色主题'}
          onClick={toggleTheme}
        >
          <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={17} />
        </button>
        <button
          type="button"
          className={'mc-topbar__connect' + (connected ? ' is-connected' : '')}
          onClick={() => setConnectDialogOpen(true)}
        >
          <span className="mc-status-dot" style={{ background: connected ? 'var(--success)' : status === 'connecting' ? 'var(--warning)' : 'var(--text-disabled)' }} />
          <span>{connectionLabel}</span>
        </button>
      </div>
    </header>
  )
}
