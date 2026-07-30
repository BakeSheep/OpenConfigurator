import { PageHeader } from '../components/ui/PageFrame'
import EscConnectPanel from '../components/esc/EscConnectPanel'
import EscSettingsWorkbench from '../components/esc/EscSettingsWorkbench'
import EscLogConsole from '../components/esc/EscLogConsole'
import Icon from '../components/ui/Icon'
import { useEscStore } from '../stores/escStore'

/** ESC configuration workspace, embedded directly in the vehicle settings page. */
export default function EscPage({ embedded = false }: { embedded?: boolean }) {
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
            <strong>ESC 通讯失败</strong>
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
              <strong>{scanFailed ? '没有完成电调扫描' : '正在建立参数工作区'}</strong>
              <p>{scanFailed
                ? '检查 ESC 供电、DShot 输出和直通参数后重新扫描。'
                : '正在识别 MCU 与 AM32 EEPROM 布局，完成后将自动载入全部参数。'}</p>
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
      <PageHeader title="电调配置" description="读取、比较并安全写入 AM32 电调参数。" />
      {content}
    </div>
  )
}