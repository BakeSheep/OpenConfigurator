import { useConnectionStore } from '../../stores/connectionStore'
import { useThemeStore } from '../../stores/themeStore'

export default function Topbar() {
  const { status, port, type, setConnectDialogOpen } = useConnectionStore()
  const { theme, toggleTheme } = useThemeStore()
  const connected = status === 'connected'

  return (
    <header
      className="flex items-center px-4 gap-4 shrink-0 select-none border-b"
      style={{
        height: 'var(--topbar-height)',
        background: 'var(--bg-secondary)',
        borderColor: 'var(--border)',
      }}
    >
      {/* Brand */}
      <div className="flex items-center gap-3 min-w-0">
        <div
          className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0"
          style={{
            background: 'linear-gradient(135deg, #fff, #d4d4d8)',
            boxShadow: 'var(--card-shadow)',
          }}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
            <path d="M12 2L4 7v10l8 5 8-5V7l-8-5z" fill="#3B82F6" />
            <path d="M12 2v20M4 7l8 5 8-5" stroke="#1e3a8a" strokeWidth="1.2" />
          </svg>
        </div>
        <div className="min-w-0">
          <h1 className="text-[15px] font-bold leading-tight" style={{ color: 'var(--text-primary)' }}>
            MicoConfigurator
          </h1>
          <p className="text-[11px] leading-tight truncate" style={{ color: 'var(--text-secondary)' }}>
            PX4 飞控配置工具
          </p>
        </div>
      </div>

      <div className="mc-divider mx-2" style={{ height: 28 }} />

      {/* Autopilot info badges */}
      <div className="hidden md:flex items-center gap-2">
        <span
          className="mc-mono text-[11px] px-2.5 py-1 rounded-md font-medium"
          style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}
        >
          {connected && type ? (type === 'serial' ? 'USB' : 'BT') : '--'}
        </span>
        <span
          className="mc-mono text-[11px] px-2.5 py-1 rounded-md"
          style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}
        >
          {connected && port ? port : '未连接'}
        </span>
        <span
          className="text-[11px] px-2.5 py-1 rounded-md font-semibold"
          style={{ background: 'rgba(249, 115, 22, .15)', color: '#FB923C', border: '1px solid rgba(249, 115, 22, .25)' }}
        >
          PX4
        </span>
      </div>

      {/* Right: theme toggle + connection button */}
      <div className="ml-auto flex items-center gap-2">
        <button
          onClick={toggleTheme}
          title={theme === 'dark' ? '切换到亮色主题' : '切换到暗色主题'}
          className="w-9 h-9 rounded-lg flex items-center justify-center transition-colors hover:bg-white/5"
          style={{ color: 'var(--text-secondary)', border: '1px solid var(--border)' }}
        >
          {theme === 'dark' ? (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="4" />
              <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
            </svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
            </svg>
          )}
        </button>
        <button
          onClick={() => setConnectDialogOpen(true)}
          className="mc-btn px-4 py-2"
          style={
            connected
              ? { background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border)' }
              : { background: 'var(--accent)', color: '#fff', boxShadow: '0 2px 8px var(--accent-glow)', animation: 'mc-pulse 2s ease-in-out infinite' }
          }
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            {connected ? (
              <><path d="M18 6 6 18" /><path d="m6 6 12 12" /></>
            ) : (
              <><path d="M5 12h14" /><path d="M12 5v14" /></>
            )}
          </svg>
          {connected ? '已连接' : '连接'}
        </button>
      </div>
    </header>
  )
}
