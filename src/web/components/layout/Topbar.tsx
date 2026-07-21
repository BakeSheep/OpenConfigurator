import { useConnectionStore } from '../../stores/connectionStore'
import { useThemeStore } from '../../stores/themeStore'
import Icon from '../ui/Icon'

export default function Topbar() {
  const { status, port, type, setConnectDialogOpen } = useConnectionStore()
  const { theme, toggleTheme } = useThemeStore()
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

      <p className="mc-topbar__tagline">一个现代化、用户友好的 ArduPilot/PX4 飞控配置工具</p>

      <div className="mc-topbar__actions">
        <a className="mc-topbar__link" href="https://micoair.com" target="_blank" rel="noreferrer" title="官网首页">
          <Icon name="home" size={17} />
        </a>
        <a className="mc-topbar__link mc-topbar__link--desktop" href="https://discord.com/invite/sXWdgveJUz" target="_blank" rel="noreferrer" title="Discord">
          <Icon name="community" size={17} />
        </a>
        <a className="mc-topbar__link mc-topbar__link--desktop" href="https://store.micoair.com" target="_blank" rel="noreferrer" title="在线商城">
          <Icon name="shop" size={17} />
        </a>
        <button type="button" className="mc-topbar__language mc-topbar__link--desktop" aria-label="当前语言：中文">中文</button>
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
