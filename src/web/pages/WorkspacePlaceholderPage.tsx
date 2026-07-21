import { useConnectionStore } from '../stores/connectionStore'
import Icon, { type IconName } from '../components/ui/Icon'
import { EmptyState, PageHeader } from '../components/ui/PageFrame'

interface WorkspacePlaceholderPageProps {
  title: string
  description: string
  icon: IconName
  connectedTitle?: string
  connectedDescription?: string
}

export default function WorkspacePlaceholderPage({
  title,
  description,
  icon,
  connectedTitle,
  connectedDescription,
}: WorkspacePlaceholderPageProps) {
  const connected = useConnectionStore((state) => state.status === 'connected')
  const setConnectDialogOpen = useConnectionStore((state) => state.setConnectDialogOpen)

  return (
    <div className="mc-workspace mc-fade-in">
      <PageHeader title={title} description={description} />
      {connected ? (
        <section className="mc-card mx-auto flex min-h-[360px] max-w-2xl items-center justify-center p-8 text-center">
          <div>
            <span className="mc-empty-state__icon"><Icon name={icon} size={22} /></span>
            <p className="mc-empty-state__title">{connectedTitle ?? (title + '工作区已就绪')}</p>
            <p className="mc-empty-state__description">
              {connectedDescription ?? '飞控连接已建立。此功能的完整后端工作流将复用当前实时消息通道。'}
            </p>
          </div>
        </section>
      ) : (
        <EmptyState
          icon={icon}
          description="建立飞控连接后，即可读取并管理该工作区的实时数据。"
          action={
            <button type="button" className="mc-btn mc-btn-primary" onClick={() => setConnectDialogOpen(true)}>
              连接飞控
            </button>
          }
        />
      )}
    </div>
  )
}
