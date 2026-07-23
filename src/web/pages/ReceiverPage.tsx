import { useState } from 'react'
import Icon from '../components/ui/Icon'
import { PageHeader, PageTabs } from '../components/ui/PageFrame'
import { useConnectionStore } from '../stores/connectionStore'
import { useTelemetryStore } from '../stores/telemetryStore'
import ChannelBars from '../components/telemetry/ChannelBars'

const channelNames = ['Roll', 'Pitch', 'Throttle', 'Yaw', 'AUX1', 'AUX2', 'AUX3', 'AUX4', 'AUX5', 'AUX6', 'AUX7', 'AUX8', 'AUX9', 'AUX10', 'AUX11', 'AUX12']

const tabs = [
  { id: 'monitor', label: '通道监控' },
  { id: 'calibrate', label: '校准' },
  { id: 'reverse', label: '通道反向' },
]

export default function ReceiverPage({ embedded = false }: { embedded?: boolean }) {
  const [activeTab, setActiveTab] = useState('monitor')
  const [reversed, setReversed] = useState<Record<number, boolean>>({})
  const rcChannels = useTelemetryStore((state) => state.rcChannels)
  const connected = useConnectionStore((state) => state.status === 'connected')

  const getChannel = (index: number) => {
    const key = ('ch' + (index + 1)) as keyof NonNullable<typeof rcChannels>
    return rcChannels?.[key] ?? 0
  }

  return (
    <div className="mc-workspace mc-fade-in">
      <PageHeader
        title="遥控器"
        description="监控 RC 通道并完成接收机校准"
        actions={
          <span className="flex items-center gap-2 rounded-full px-3 py-2 text-[11px] font-semibold" style={{ background: rcChannels ? 'var(--success-dim)' : 'var(--bg-tertiary)', color: rcChannels ? 'var(--success)' : 'var(--text-disabled)' }}>
            <span className="mc-status-dot" style={{ background: rcChannels ? 'var(--success)' : 'var(--text-disabled)' }} />
            {rcChannels ? '信号正常' : connected ? '等待 RC 数据' : '未连接飞控'}
          </span>
        }
      />
      {!embedded && <PageTabs tabs={tabs} active={activeTab} onChange={setActiveTab} />}

      {(embedded || activeTab === 'monitor') && (
        <section className={'mc-card overflow-hidden ' + (embedded ? '' : 'mt-5')}>
          <div className="border-b px-5 py-4" style={{ borderColor: 'var(--border)' }}>
            <h2 className="text-[14px] font-bold" style={{ color: 'var(--text-primary)' }}>实时通道输入</h2>
            <p className="mt-1 text-[11px]" style={{ color: 'var(--text-secondary)' }}>标准 RC PWM 范围为 1000–2000，1500 为中位。</p>
          </div>
          <ChannelBars
            labels={channelNames}
            secondaryLabels={channelNames.map((_, index) => `CH${index + 1}`)}
            values={channelNames.map((_, index) => getChannel(index))}
            connected={connected && Boolean(rcChannels)}
          />
        </section>
      )}

      {(embedded || activeTab === 'calibrate') && (
        <section className="mc-card mt-5 overflow-hidden">
          <div className="border-b px-5 py-4" style={{ borderColor: 'var(--border)' }}>
            <h2 className="text-[14px] font-bold" style={{ color: 'var(--text-primary)' }}>遥控器校准</h2>
            <p className="mt-1 text-[11px]" style={{ color: 'var(--text-secondary)' }}>开始前请确保接收机已正确绑定，且飞行器螺旋桨已拆除。</p>
          </div>
          <div className="grid grid-cols-1 gap-5 p-5 xl:grid-cols-[1fr_0.75fr]">
            <ol className="space-y-4">
              {[
                '将油门置于最低位置，并让其余摇杆回中。',
                '点击“开始校准”，按提示将每个摇杆和开关移动到全部极限。',
                '确认通道范围与方向正确后，完成并保存校准。',
              ].map((step, index) => (
                <li key={step} className="flex gap-3">
                  <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full text-[11px] font-bold" style={{ background: 'var(--accent-dim)', color: 'var(--accent)' }}>{index + 1}</span>
                  <span className="pt-0.5 text-[13px] leading-6" style={{ color: 'var(--text-secondary)' }}>{step}</span>
                </li>
              ))}
            </ol>
            <div className="rounded-xl border p-5" style={{ borderColor: 'var(--border)', background: 'var(--bg-tertiary)' }}>
              <span className="grid h-10 w-10 place-items-center rounded-xl" style={{ background: 'var(--bg-secondary)', color: 'var(--accent)' }}><Icon name="receiver" size={20} /></span>
              <h3 className="mt-4 text-[14px] font-bold" style={{ color: 'var(--text-primary)' }}>校准向导</h3>
              <p className="mt-1 text-[11px] leading-5" style={{ color: 'var(--text-secondary)' }}>连接飞控后可通过设置向导完成完整校准流程。</p>
              <button type="button" className="mc-btn mc-btn-primary mt-5" disabled={!connected}>开始校准</button>
            </div>
          </div>
        </section>
      )}

      {(embedded || activeTab === 'reverse') && (
        <section className="mc-card mt-5 overflow-hidden">
          <div className="border-b px-5 py-4" style={{ borderColor: 'var(--border)' }}>
            <h2 className="text-[14px] font-bold" style={{ color: 'var(--text-primary)' }}>通道反向</h2>
            <p className="mt-1 text-[11px]" style={{ color: 'var(--text-secondary)' }}>仅调整显示中的反向选择；保存飞控参数请通过参数页完成。</p>
          </div>
          <div className="grid grid-cols-2 gap-3 p-5 sm:grid-cols-4 xl:grid-cols-8">
            {channelNames.slice(0, 8).map((name, index) => (
              <label key={name} className="flex cursor-pointer items-center justify-between rounded-xl border p-3" style={{ borderColor: reversed[index] ? 'var(--accent)' : 'var(--border)', background: reversed[index] ? 'var(--accent-dim)' : 'var(--bg-secondary)' }}>
                <span className="text-[12px] font-semibold" style={{ color: 'var(--text-primary)' }}>{name}</span>
                <input type="checkbox" checked={Boolean(reversed[index])} onChange={(event) => setReversed((current) => ({ ...current, [index]: event.target.checked }))} className="h-4 w-4 rounded" style={{ accentColor: 'var(--accent)' }} />
              </label>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
