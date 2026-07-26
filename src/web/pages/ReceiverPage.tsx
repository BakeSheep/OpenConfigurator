import ChannelBars from '../components/telemetry/ChannelBars'
import Icon from '../components/ui/Icon'
import { PageHeader } from '../components/ui/PageFrame'
import { useConnectionStore } from '../stores/connectionStore'
import { useTelemetryStore } from '../stores/telemetryStore'

const channelNames = ['Roll', 'Pitch', 'Throttle', 'Yaw', 'AUX1', 'AUX2', 'AUX3', 'AUX4', 'AUX5', 'AUX6', 'AUX7', 'AUX8', 'AUX9', 'AUX10', 'AUX11', 'AUX12']

export default function ReceiverPage({ embedded = false }: { embedded?: boolean }) {
  const rcChannels = useTelemetryStore((state) => state.rcChannels)
  const vehicleReady = useConnectionStore((state) => state.vehicleReady)

  const getChannel = (index: number) => {
    const key = ('ch' + (index + 1)) as keyof NonNullable<typeof rcChannels>
    return rcChannels?.[key] ?? 0
  }
  const rssi = rcChannels?.rssi ?? null

  return (
    <div className={embedded ? 'mc-fade-in' : 'mc-workspace mc-fade-in'}>
      {!embedded && <PageHeader title="遥控器" description="查看飞控接收到的 RC 通道与信号状态。" />}
      <div className="mc-capability-note" data-state={vehicleReady ? 'detected' : 'waiting'}>
        <Icon name={vehicleReady ? 'check' : 'warning'} size={15} />
        <span>{vehicleReady ? '飞控已就绪，正在显示实时 RC 输入。' : '连接飞控后显示实时通道；校准和通道反向尚未接入，当前不会显示虚假配置。'}</span>
      </div>
      <section className="mc-card overflow-hidden mt-4">
        <div className="border-b px-5 py-4" style={{ borderColor: 'var(--border)' }}>
          <h2 className="text-[14px] font-bold" style={{ color: 'var(--text-primary)' }}>实时通道输入</h2>
          <p className="mt-1 text-[12px]" style={{ color: 'var(--text-secondary)' }}>标准 RC PWM 范围为 1000–2000，1500 为中位。{rssi !== null ? ` · 信号强度 RSSI ${rssi}/254` : ''}</p>
        </div>
        <ChannelBars
          labels={channelNames}
          secondaryLabels={channelNames.map((_, index) => `CH${index + 1}`)}
          values={channelNames.map((_, index) => getChannel(index))}
          connected={vehicleReady && Boolean(rcChannels)}
        />
      </section>
    </div>
  )
}
