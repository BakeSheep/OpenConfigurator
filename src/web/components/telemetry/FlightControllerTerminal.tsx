import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { vehicleCapabilities } from '../../../shared/vehicleProfiles'
import { sendClientMessage } from '../../hooks/useWebSocket'
import { useConnectionStore } from '../../stores/connectionStore'
import { useShellStore } from '../../stores/shellStore'
import { useTelemetryStore } from '../../stores/telemetryStore'
import { getArduPilotMavproxyCommands, getPx4NshCommands } from '../../utils/terminalCommandCatalog'
import Icon from '../ui/Icon'
import { TabPanel, Tabs } from '../ui/Tabs'

const KEY_SEQUENCES: Record<string, string> = {
  Enter: '\r', Backspace: '\x7f', Tab: '\t', Escape: '\x1b',
  ArrowUp: '\x1b[A', ArrowDown: '\x1b[B', ArrowRight: '\x1b[C', ArrowLeft: '\x1b[D',
  Home: '\x1b[H', End: '\x1b[F', Delete: '\x1b[3~',
}

function visibleTerminalText(raw: string): string {
  return raw
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '')
}

export default function FlightControllerTerminal() {
  const { t } = useTranslation()
  const vehicleReady = useConnectionStore((state) => state.vehicleReady)
  const canControl = useConnectionStore((state) => state.canControl)
  const rawSessionActive = useConnectionStore((state) => state.rawSessionActive)
  const identity = useTelemetryStore((state) => state.vehicleIdentity)
  const armed = useTelemetryStore((state) => state.status?.armed)
  const active = useShellStore((state) => state.active)
  const output = useShellStore((state) => state.output)
  const reason = useShellStore((state) => state.reason)
  const clear = useShellStore((state) => state.clear)
  const terminalRef = useRef<HTMLDivElement>(null)
  const outputRef = useRef<HTMLPreElement>(null)
  const [referenceFamily, setReferenceFamily] = useState<'px4' | 'ardupilot'>(
    identity?.family === 'ardupilot' ? 'ardupilot' : 'px4',
  )
  const supported = vehicleCapabilities(identity).mavlinkShell === 'px4-nsh'
  const available = vehicleReady && canControl && supported && !rawSessionActive && armed === false
  const connecting = available && !active && reason === 'probing'

  useEffect(() => {
    if (!available) return
    sendClientMessage({ type: 'shell_open', requestId: `shell-open-${Date.now().toString(36)}` })
    return () => {
      sendClientMessage({ type: 'shell_close', requestId: `shell-close-${Date.now().toString(36)}` })
    }
  }, [available])

  useEffect(() => {
    if (identity?.family === 'px4' || identity?.family === 'ardupilot') {
      setReferenceFamily(identity.family)
    }
  }, [identity?.family])

  useEffect(() => {
    if (!active) return
    terminalRef.current?.focus()
  }, [active])

  useEffect(() => {
    const element = outputRef.current
    if (element) element.scrollTop = element.scrollHeight
  }, [output])

  const visibleOutput = useMemo(() => visibleTerminalText(output), [output])
  const emptyScreenText = active
    ? t('terminal.empty.connected')
    : connecting
      ? t('terminal.empty.probing')
      : reason === 'shell_probe_timeout'
        ? t('terminal.empty.probeTimeout')
        : reason === 'transfer_busy'
          ? t('terminal.empty.transferBusy')
          : t('terminal.empty.disconnected')

  const sendText = (text: string) => {
    if (!active || text.length === 0) return
    sendClientMessage({ type: 'shell_write', data: { text } })
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!active) return
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.length === 1) {
      const upper = event.key.toUpperCase().charCodeAt(0)
      if (upper >= 64 && upper <= 95) {
        event.preventDefault()
        sendText(String.fromCharCode(upper - 64))
      }
      return
    }
    const sequence = KEY_SEQUENCES[event.key]
    if (sequence) {
      event.preventDefault()
      sendText(sequence)
      return
    }
    if (!event.altKey && !event.metaKey && event.key.length === 1) {
      event.preventDefault()
      sendText(event.key)
    }
  }

  const unavailableMessage = !vehicleReady
    ? t('terminal.unavailable.notReady')
    : !supported
      ? identity?.family === 'ardupilot'
        ? t('terminal.unavailable.arduNoCli')
        : t('terminal.unavailable.notSupported')
      : armed === true
        ? t('terminal.unavailable.armed')
        : armed === undefined
          ? t('terminal.unavailable.armUnknown')
        : !canControl
          ? t('terminal.unavailable.noControl')
          : rawSessionActive
            ? t('terminal.unavailable.escSession')
            : reason ?? t('terminal.unavailable.fallback')

  return (
    <div className="mc-shell-layout">
    <section className="mc-card mc-shell">
      <header className="mc-shell__toolbar">
        <span className="mc-shell__status" data-active={active || undefined} data-connecting={connecting || undefined}><i />{active ? t('terminal.status.connected') : connecting ? t('terminal.status.connecting') : t('terminal.status.disconnected')}</span>
        <p>{t('terminal.toolbar.hint')}</p>
        <button type="button" className="mc-icon-btn mc-icon-btn--bordered" aria-label={t('terminal.aria.clear')} onClick={clear}><Icon name="trash" size={14} /></button>
        {!active && available && !connecting && (
          <button type="button" className="mc-btn mc-btn-ghost" onClick={() => sendClientMessage({ type: 'shell_open', requestId: `shell-reopen-${Date.now().toString(36)}` })}>{t('terminal.reconnect')}</button>
        )}
      </header>
      <div className="mc-shell__notice"><Icon name="warning" size={14} /><span>{t('terminal.notice.safety')}</span></div>
      {available || active ? (
        <div
          ref={terminalRef}
          className="mc-shell__screen"
          role="textbox"
          aria-label={t('terminal.aria.input')}
          aria-multiline="true"
          tabIndex={0}
          onKeyDown={onKeyDown}
          onPaste={(event) => { event.preventDefault(); sendText(event.clipboardData.getData('text')) }}
          onClick={() => terminalRef.current?.focus()}
        >
          <pre ref={outputRef}>{visibleOutput || emptyScreenText}<span className="mc-shell__cursor" aria-hidden="true">▌</span></pre>
        </div>
      ) : (
        <div className="mc-shell__unavailable"><Icon name="message" size={28} /><strong>{t('terminal.unavailable.title')}</strong><p>{unavailableMessage}</p></div>
      )}
    </section>
    <aside className="mc-card mc-shell-reference" aria-label={t('terminal.aria.reference')}>
      <header>
        <div>
          <span>COMMAND INDEX</span>
          <strong>{t('terminal.reference.title')}</strong>
        </div>
        <Tabs
          tabs={[{ id: 'px4', label: 'PX4' }, { id: 'ardupilot', label: 'AP' }]}
          active={referenceFamily}
          onChange={(id) => setReferenceFamily(id === 'ardupilot' ? 'ardupilot' : 'px4')}
          ariaLabel={t('terminal.aria.firmwareTabs')}
          idBase="terminal-reference"
          className="mc-shell-reference__tabs"
        />
      </header>
      {(['px4', 'ardupilot'] as const).map((family) => {
        const categories = family === 'px4' ? getPx4NshCommands(t) : getArduPilotMavproxyCommands(t)
        return (
          <TabPanel
            key={family}
            idBase="terminal-reference"
            tabId={family}
            hidden={referenceFamily !== family}
            tabIndex={referenceFamily === family ? 0 : -1}
            className="mc-shell-reference__panel"
          >
            <p className="mc-shell-reference__note" data-external={family === 'ardupilot' || undefined}>
              {family === 'px4'
                ? t('terminal.reference.px4Note')
                : t('terminal.reference.apNote')}
            </p>
            <div className="mc-shell-reference__scroll">
              {categories.map((category) => (
                <section key={category.title}>
                  <h3>{category.title}</h3>
                  <div>
                    {category.commands.map((entry) => (
                      <button
                        key={entry.command}
                        type="button"
                        disabled={family !== 'px4' || !active}
                        title={family === 'px4' ? t('terminal.reference.writeToTerminal', { command: entry.command }) : t('terminal.reference.useExternalMavproxy')}
                        onClick={() => sendText(entry.command)}
                      >
                        <code>{entry.command}</code>
                        <span>{entry.description}</span>
                      </button>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          </TabPanel>
        )
      })}
    </aside>
    </div>
  )
}
