import Icon from '../components/ui/Icon'
import { PageHeader } from '../components/ui/PageFrame'
import { useConnectionStore } from '../stores/connectionStore'

export default function ConnectionPage() {
  const { status, port, type, setConnectDialogOpen } = useConnectionStore()
  const connected = status === 'connected'

  return (
    <div className="mc-workspace mc-fade-in">
      <PageHeader title="连接飞控" description="通过 USB 串口或蓝牙 SPP 与 PX4 飞控建立连接" />
      <section className="mc-card mx-auto max-w-xl overflow-hidden">
        <div className="flex flex-col items-center border-b px-6 py-9 text-center" style={{ borderColor: 'var(--border)' }}>
          <span className="grid h-16 w-16 place-items-center rounded-2xl" style={{ background: connected ? 'var(--success-dim)' : 'var(--accent-dim)', color: connected ? 'var(--success)' : 'var(--accent)' }}>
            <Icon name="plug" size={29} />
          </span>
          <h2 className="mt-5 text-[19px] font-bold" style={{ color: 'var(--text-primary)' }}>{connected ? '飞控已连接' : status === 'connecting' ? '正在连接飞控' : '尚未连接飞控'}</h2>
          <p className="mt-2 text-[12px]" style={{ color: 'var(--text-secondary)' }}>
            {connected ? (type === 'bluetooth' ? '蓝牙 SPP · ' : 'USB 串口 · ') + (port ?? '—') : '点击下方按钮选择可用串口设备。'}
          </p>
        </div>
        <div className="p-6">
          <button type="button" className={'mc-btn w-full min-h-11 ' + (connected ? 'mc-btn-ghost' : 'mc-btn-primary')} onClick={() => setConnectDialogOpen(true)}>
            <Icon name="plug" size={17} />{connected ? '管理连接' : '连接飞控'}
          </button>
          <div className="mt-5 rounded-xl p-4 text-[11px] leading-5" style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}>
            支持 USB 串口与 Windows 蓝牙 SPP。连接完成后，顶栏和仪表盘会自动显示飞控遥测状态。
          </div>
        </div>
      </section>
    </div>
  )
}
