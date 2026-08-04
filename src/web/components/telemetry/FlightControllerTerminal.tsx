import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { vehicleCapabilities } from '../../../shared/vehicleProfiles'
import { sendClientMessage } from '../../hooks/useWebSocket'
import { useConnectionStore } from '../../stores/connectionStore'
import { useShellStore } from '../../stores/shellStore'
import { useTelemetryStore } from '../../stores/telemetryStore'
import { ARDUPILOT_MAVPROXY_COMMANDS, PX4_NSH_COMMANDS } from '../../utils/terminalCommandCatalog'
import Icon from '../ui/Icon'

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
    ? '已连接，等待 PX4 NSH 输出…'
    : connecting
      ? '正在确认当前固件的 MAVLink Shell 能力…'
      : reason === 'shell_probe_timeout'
        ? '当前板卡或固件未响应 MAVLink Shell。可确认固件包含 NSH 后重新连接。'
        : reason === 'transfer_busy'
          ? '参数或日志传输进行中，完成后可重新连接终端。'
          : '终端已断开，点击“重新连接”再次探测。'

  const sendText = (text: string) => {
    if (!active || text.length === 0) return
    sendClientMessage({ type: 'shell_write', data: { text } })
  }

  const quickCategories = referenceFamily === 'px4' ? PX4_NSH_COMMANDS : ARDUPILOT_MAVPROXY_COMMANDS

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
    ? '连接并识别飞控后可使用实时终端。'
    : !supported
      ? identity?.family === 'ardupilot'
        ? 'ArduPilot 官方固件已移除旧 CLI，目前没有与 PX4 NSH 等价的 MAVLink 交互终端。'
        : '当前飞控未声明已验证的 MAVLink 交互 Shell。'
      : armed === true
        ? '飞行器已解锁，为避免绕过安全流程，终端已禁用。'
        : armed === undefined
          ? '尚未确认飞行器上锁状态，终端保持禁用。'
        : !canControl
          ? '当前浏览器未持有控制权，终端保持只读。'
          : rawSessionActive
            ? 'ESC 直通会话占用链路，退出该会话后才能打开终端。'
            : reason ?? '终端暂不可用。'

  return (
    <div className="mc-shell-layout">
    <section className="mc-card mc-shell">
      <header className="mc-shell__toolbar">
        <span className="mc-shell__status" data-active={active || undefined} data-connecting={connecting || undefined}><i />{active ? 'NSH 已连接' : connecting ? 'NSH 连接中' : 'NSH 未连接'}</span>
        <p>PX4 SERIAL_CONTROL · Ctrl+C 中断 · 支持粘贴</p>
        <button type="button" className="mc-icon-btn mc-icon-btn--bordered" aria-label="清空终端显示" onClick={clear}><Icon name="trash" size={14} /></button>
        {!active && available && !connecting && (
          <button type="button" className="mc-btn mc-btn-ghost" onClick={() => sendClientMessage({ type: 'shell_open', requestId: `shell-reopen-${Date.now().toString(36)}` })}>重新连接</button>
        )}
      </header>
      <div className="mc-shell__notice"><Icon name="warning" size={14} /><span>终端命令直接由飞控执行。请保持飞行器上锁，并在修改参数或重启前确认命令影响。</span></div>
      {available || active ? (
        <div
          ref={terminalRef}
          className="mc-shell__screen"
          role="textbox"
          aria-label="飞控终端输入"
          aria-multiline="true"
          tabIndex={0}
          onKeyDown={onKeyDown}
          onPaste={(event) => { event.preventDefault(); sendText(event.clipboardData.getData('text')) }}
          onClick={() => terminalRef.current?.focus()}
        >
          <pre ref={outputRef}>{visibleOutput || emptyScreenText}<span className="mc-shell__cursor" aria-hidden="true">▌</span></pre>
        </div>
      ) : (
        <div className="mc-shell__unavailable"><Icon name="message" size={28} /><strong>实时终端不可用</strong><p>{unavailableMessage}</p></div>
      )}
    </section>
    <aside className="mc-card mc-shell-reference" aria-label="终端常见指令速查">
      <header>
        <div>
          <span>COMMAND INDEX</span>
          <strong>常见指令速查</strong>
        </div>
        <div className="mc-shell-reference__tabs" role="tablist" aria-label="固件指令类型">
          <button type="button" role="tab" aria-selected={referenceFamily === 'px4'} onClick={() => setReferenceFamily('px4')}>PX4</button>
          <button type="button" role="tab" aria-selected={referenceFamily === 'ardupilot'} onClick={() => setReferenceFamily('ardupilot')}>AP</button>
        </div>
      </header>
      <p className="mc-shell-reference__note" data-external={referenceFamily === 'ardupilot' || undefined}>
        {referenceFamily === 'px4'
          ? '点击只写入当前 NSH 命令行，不会自动回车执行。'
          : '以下是外部 MAVProxy 控制台命令，不能在本页飞控终端执行。'}
      </p>
      <div className="mc-shell-reference__scroll">
        {quickCategories.map((category) => (
          <section key={category.title}>
            <h3>{category.title}</h3>
            <div>
              {category.commands.map((entry) => (
                <button
                  key={entry.command}
                  type="button"
                  disabled={referenceFamily !== 'px4' || !active}
                  title={referenceFamily === 'px4' ? `写入终端：${entry.command}` : '请在外部 MAVProxy 控制台使用'}
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
    </aside>
    </div>
  )
}
