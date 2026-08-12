import { useTranslation } from 'react-i18next'
import { PageHeader } from '../components/ui/PageFrame'
import EscConnectPanel from '../components/esc/EscConnectPanel'
import EscSettingsWorkbench from '../components/esc/EscSettingsWorkbench'
import EscLogConsole from '../components/esc/EscLogConsole'
import { Notice } from '../components/ui/Feedback'
import StatePanel from '../components/ui/StatePanel'
import { useEscStore } from '../stores/escStore'

/** ESC configuration workspace, embedded directly in the vehicle settings page. */
export default function EscPage({ embedded = false }: { embedded?: boolean }) {
  const { t } = useTranslation()
  const session = useEscStore((state) => state.session)
  const devices = useEscStore((state) => state.devices)
  const lastError = useEscStore((state) => state.lastError)
  const active = session !== null && session.state !== 'idle'
  const scanFailed = lastError?.operation === 'esc_devices_scan'

  const content = (
    <div className="mc-esc-page">
      {lastError && (
        <Notice tone="danger" title={t('esc.commFailure')}>{lastError.message}</Notice>
      )}

      <EscConnectPanel />

      {active && (
        devices.length > 0 ? (
          <EscSettingsWorkbench />
        ) : (
          <StatePanel
            kind={scanFailed ? 'error' : 'loading'}
            title={scanFailed ? t('esc.scanFailed') : t('esc.buildingWorkspace')}
            description={scanFailed ? t('esc.scanFailedHint') : t('esc.identifyingMcu')}
          />
        )
      )}

      <EscLogConsole />
    </div>
  )

  if (embedded) return <div className="mc-fade-in">{content}</div>

  return (
    <div className="mc-workspace mc-workspace--wide mc-fade-in">
      <PageHeader title={t('esc.title')} description={t('esc.description')} />
      {content}
    </div>
  )
}
