import { PageHeader } from '../components/ui/PageFrame'
import EscConnectPanel from '../components/esc/EscConnectPanel'
import EscDeviceCard from '../components/esc/EscDeviceCard'
import EscLogConsole from '../components/esc/EscLogConsole'
import Icon from '../components/ui/Icon'
import { useEscStore } from '../stores/escStore'

/**
 * ESC configuration workspace. First milestone is read-only: connect through a
 * passthrough/direct session, discover ESCs and show their identity. Settings
 * editing and flashing arrive in later milestones behind capability gates.
 */
export default function EscPage({ embedded = false }: { embedded?: boolean }) {
  const session = useEscStore((state) => state.session)
  const devices = useEscStore((state) => state.devices)
  const lastError = useEscStore((state) => state.lastError)
  const active = session !== null && session.state !== 'idle'

  const content = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <EscConnectPanel />

      {lastError && (
        <div className="mc-card" style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--danger)' }}>
          <Icon name="warning" size={16} />
          <span style={{ fontSize: 13 }}>{lastError.message}</span>
        </div>
      )}

      {active && (
        devices.length > 0 ? (
          <div
            style={{
              display: 'grid',
              gap: 12,
              gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
            }}
          >
            {devices.map((esc) => (
              <EscDeviceCard key={esc.index} esc={esc} />
            ))}
          </div>
        ) : (
          <div className="mc-card" style={{ color: 'var(--text-secondary)', fontSize: 13 }}>
            正在扫描电调……若长时间无结果，请检查连接方式与前置条件。
          </div>
        )
      )}

      <EscLogConsole />
    </div>
  )

  if (embedded) return <div className="mc-fade-in">{content}</div>

  return (
    <div className="mc-workspace mc-workspace--wide mc-fade-in">
      <PageHeader title="电调配置" description="通过飞控直通或 USB 直连读取电调信息、配置与刷写固件。" />
      {content}
    </div>
  )
}
