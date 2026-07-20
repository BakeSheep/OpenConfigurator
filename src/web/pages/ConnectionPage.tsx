import { useConnectionStore } from '../stores/connectionStore'

export default function ConnectionPage() {
  const { status, port, type, setConnectDialogOpen } = useConnectionStore()
  const connected = status === 'connected'

  return (
    <div className="h-full flex items-center justify-center p-8">
      <div className="w-full max-w-md text-center">
        {/* Logo */}
        <div className="flex justify-center mb-6">
          <div
            className="w-20 h-20 rounded-2xl flex items-center justify-center"
            style={{
              background: 'linear-gradient(135deg, #fff, #d4d4d8)',
              boxShadow: '0 8px 32px rgba(0,0,0,.4)',
            }}
          >
            <svg width="44" height="44" viewBox="0 0 24 24" fill="none">
              <path d="M12 2L4 7v10l8 5 8-5V7l-8-5z" fill="#3B82F6" />
              <path d="M12 2v20M4 7l8 5 8-5" stroke="#1e3a8a" strokeWidth="1.2" />
            </svg>
          </div>
        </div>

        <h1 className="text-2xl font-bold mb-1" style={{ color: 'var(--text-primary)' }}>MicoConfigurator</h1>
        <p className="text-[13px] mb-8" style={{ color: 'var(--text-secondary)' }}>
          现代化的 PX4 飞控配置工具
        </p>

        {/* Status card */}
        <div className="mc-card p-6 text-left">
          <div className="flex items-center gap-3 mb-4">
            <span
              className="rounded-full"
              style={{
                width: 12,
                height: 12,
                background: connected ? 'var(--success)' : 'var(--text-disabled)',
                boxShadow: connected ? '0 0 10px rgba(34,197,94,.6)' : 'none',
                animation: status === 'connecting' ? 'mc-pulse 1.2s ease-in-out infinite' : 'none',
              }}
            />
            <div className="flex-1">
              <p className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                {connected ? '已连接到飞控' : status === 'connecting' ? '正在连接…' : '未连接'}
              </p>
              <p className="text-[12px] mc-mono" style={{ color: 'var(--text-secondary)' }}>
                {connected && port ? `${type === 'serial' ? 'USB' : 'BT'} · ${port}` : '点击下方按钮开始连接'}
              </p>
            </div>
          </div>

          <button
            onClick={() => setConnectDialogOpen(true)}
            className="mc-btn w-full py-3"
            style={
              connected
                ? { background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border)' }
                : { background: 'var(--accent)', color: '#fff', boxShadow: '0 4px 16px var(--accent-glow)' }
            }
          >
            {connected ? '管理连接' : '连接飞控'}
          </button>

          <p className="text-[11px] text-center mt-4" style={{ color: 'var(--text-disabled)' }}>
            连接成功后即可在左侧导航使用各项功能
          </p>
        </div>
      </div>
    </div>
  )
}
