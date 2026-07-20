import type { ReactElement } from 'react'
import { NavLink } from 'react-router-dom'
import { useConnectionStore } from '../../stores/connectionStore'

// Refined line icons (Lucide-style)
const icons: Record<string, ReactElement> = {
  connect: (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 2v6" /><path d="M15 2v6" /><path d="M6 8h12l-1.5 6.5a3 3 0 0 1-2.93 2.5h-3.14a3 3 0 0 1-2.93-2.5z" /><path d="M12 17v5" /><circle cx="12" cy="22" r="0.5" fill="currentColor" />
    </svg>
  ),
  dashboard: (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="9" rx="1.5" /><rect x="14" y="3" width="7" height="5" rx="1.5" /><rect x="14" y="12" width="7" height="9" rx="1.5" /><rect x="3" y="16" width="7" height="5" rx="1.5" />
    </svg>
  ),
  sensors: (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2v2" /><path d="M12 20v2" /><path d="M4.93 4.93l1.41 1.41" /><path d="M17.66 17.66l1.41 1.41" /><path d="M2 12h2" /><path d="M20 12h2" /><circle cx="12" cy="12" r="4" /><circle cx="12" cy="12" r="1" fill="currentColor" />
    </svg>
  ),
  parameters: (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <line x1="4" y1="6" x2="20" y2="6" /><line x1="4" y1="12" x2="20" y2="12" /><line x1="4" y1="18" x2="20" y2="18" /><circle cx="9" cy="6" r="2.2" fill="var(--bg-secondary)" /><circle cx="15" cy="12" r="2.2" fill="var(--bg-secondary)" /><circle cx="8" cy="18" r="2.2" fill="var(--bg-secondary)" />
    </svg>
  ),
  motors: (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" /><path d="M12 2v3" /><path d="M12 19v3" /><path d="M2 12h3" /><path d="M19 12h3" /><path d="m4.93 4.93 2.12 2.12" /><path d="m16.95 16.95 2.12 2.12" /><path d="m4.93 19.07 2.12-2.12" /><path d="m16.95 7.05 2.12-2.12" />
    </svg>
  ),
  receiver: (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="6" width="20" height="12" rx="2" /><path d="M10 10v4" /><path d="M14 10v4" /><circle cx="7" cy="12" r="1" fill="currentColor" /><circle cx="17" cy="12" r="1" fill="currentColor" />
    </svg>
  ),
  joystick: (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="6" width="20" height="12" rx="4" /><circle cx="7" cy="12" r="2.5" /><path d="M15 11h.01" /><path d="M18 13h.01" /><path d="M15 14h.01" /><path d="M18 11h.01" /><path d="M15.5 12.5h.01" />
    </svg>
  ),
  flight: (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z" />
    </svg>
  ),
}

const navItems = [
  { path: '/dashboard', label: '仪表盘', icon: 'dashboard' },
  { path: '/sensors', label: '传感器', icon: 'sensors' },
  { path: '/parameters', label: '参数', icon: 'parameters' },
  { path: '/motors', label: '电机', icon: 'motors' },
  { path: '/receiver', label: '遥控器', icon: 'receiver' },
  { path: '/joystick', label: '手柄', icon: 'joystick' },
  { path: '/flight', label: '飞行', icon: 'flight' },
]

export default function Sidebar() {
  const { status, setConnectDialogOpen } = useConnectionStore()

  return (
    <aside
      className="flex flex-col items-center py-3 shrink-0 select-none border-r"
      style={{
        width: 'var(--sidebar-width)',
        background: 'var(--bg-secondary)',
        borderColor: 'var(--border)',
      }}
    >
      <nav className="flex-1 flex flex-col items-center gap-1 w-full px-2">
        {navItems.map((item) => (
          <NavLink
            key={item.path}
            to={item.path}
            title={item.label}
            className="group relative w-full h-[58px] flex flex-col items-center justify-center rounded-xl transition-all duration-150 gap-1"
            style={({ isActive }) => ({
              color: isActive ? 'var(--accent)' : 'var(--text-disabled)',
              background: isActive ? 'var(--accent-dim)' : 'transparent',
            })}
          >
            {({ isActive }) => (
              <>
                {isActive && (
                  <span
                    className="absolute left-0 top-1/2 -translate-y-1/2 rounded-r-full"
                    style={{ width: 3, height: 22, background: 'var(--accent)' }}
                  />
                )}
                <span className="group-hover:[&_svg]:opacity-100 transition-opacity">{icons[item.icon]}</span>
                <span className="text-[10px] leading-none font-medium">{item.label}</span>
              </>
            )}
          </NavLink>
        ))}
      </nav>

      {/* Connection status indicator */}
      <button
        onClick={() => setConnectDialogOpen(true)}
        title={status === 'connected' ? '已连接 — 点击管理' : status === 'connecting' ? '连接中' : '未连接 — 点击连接'}
        className="mt-auto pt-3 flex items-center justify-center w-full"
      >
        <span
          className="rounded-full transition-all"
          style={{
            width: 10,
            height: 10,
            background:
              status === 'connected' ? 'var(--success)' : status === 'connecting' ? 'var(--warning)' : 'var(--text-disabled)',
            boxShadow: status === 'connected' ? '0 0 8px rgba(34,197,94,.6)' : status === 'connecting' ? '0 0 8px rgba(245,158,11,.6)' : 'none',
            animation: status === 'connecting' ? 'mc-pulse 1.2s ease-in-out infinite' : 'none',
          }}
        />
      </button>
    </aside>
  )
}
