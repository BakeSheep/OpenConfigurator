import { useTranslation } from 'react-i18next'
import ChannelBars from '../components/telemetry/ChannelBars'
import Icon from '../components/ui/Icon'
import { PageHeader } from '../components/ui/PageFrame'
import { useConnectionStore } from '../stores/connectionStore'
import { useTelemetryStore } from '../stores/telemetryStore'

export default function ReceiverPage({ embedded = false }: { embedded?: boolean }) {
  const { t } = useTranslation()
  const rcChannels = useTelemetryStore((state) => state.rcChannels)
  const vehicleReady = useConnectionStore((state) => state.vehicleReady)

  const getChannel = (index: number) => {
    const key = ('ch' + (index + 1)) as keyof NonNullable<typeof rcChannels>
    return rcChannels?.[key] ?? 0
  }
  const rssi = rcChannels?.rssi ?? null
  const channelNames = Array.from({ length: 16 }, (_, index) => {
    const primary = ['roll', 'pitch', 'throttle', 'yaw'] as const
    return index < primary.length
      ? t(`receiver.channel.${primary[index]}`)
      : t('receiver.channel.aux', { index: index - 3 })
  })

  return (
    <div className={embedded ? 'mc-fade-in' : 'mc-workspace mc-fade-in'}>
      {!embedded && <PageHeader title={t('common.receiver')} description={t('receiver.description')} />}
      <div className="mc-capability-note" data-state={vehicleReady ? 'detected' : 'waiting'}>
        <Icon name={vehicleReady ? 'check' : 'warning'} size={15} />
        <span>{vehicleReady ? t('receiver.readyHint') : t('receiver.waitingHint')}</span>
      </div>
      <section className="mc-card overflow-hidden mt-4">
        <div className="border-b px-5 py-4" style={{ borderColor: 'var(--border)' }}>
          <h2 className="text-[14px] font-bold" style={{ color: 'var(--text-primary)' }}>{t('receiver.realtimeChannels')}</h2>
          <p className="mt-1 text-[12px]" style={{ color: 'var(--text-secondary)' }}>{t('receiver.pwmRangeHint')}{rssi !== null ? t('receiver.rssi', { rssi }) : ''}</p>
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
