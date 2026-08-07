import { useTranslation } from 'react-i18next'
import { PageHeader } from '../components/ui/PageFrame'
import EscConnectPanel from '../components/esc/EscConnectPanel'
import EscSettingsWorkbench from '../components/esc/EscSettingsWorkbench'
import EscLogConsole from '../components/esc/EscLogConsole'
import Icon from '../components/ui/Icon'
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
      <EscConnectPanel />

      {lastError && (
        <div className="mc-card mc-esc-alert" role="alert">
          <Icon name="warning" size={17} />
          <div>
            <strong>{t('esc.commFailure')}</strong>
            <span>{lastError.message}</span>
          </div>
        </div>
      )}

      {active && (
        devices.length > 0 ? (
          <EscSettingsWorkbench />
        ) : (
          <section className="mc-esc-scan-stage" aria-live="polite">
            {!scanFailed && <span className="mc-esc-scan-status__pulse" />}
            <div>
              <span className="mc-eyebrow">DISCOVERY</span>
              <strong>{scanFailed ? t('esc.scanFailed') : t('esc.buildingWorkspace')}</strong>
              <p>{scanFailed
                ? t('esc.scanFailedHint')
                : t('esc.identifyingMcu')}</p>
            </div>
          </section>
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