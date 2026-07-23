import { useCallback, useEffect, useRef, useState } from 'react'
import { PX4_MODES } from '../../shared/constants'
import GamepadVisualizer from '../components/gamepad/GamepadVisualizer'
import Icon from '../components/ui/Icon'
import { PageHeader, PageTabs } from '../components/ui/PageFrame'
import { useWebSocket } from '../hooks/useWebSocket'
import { useConnectionStore } from '../stores/connectionStore'
import {
  useGamepadStore,
  type GamepadActionId,
  type GamepadMapping,
} from '../stores/gamepadStore'
import { useTelemetryStore } from '../stores/telemetryStore'

const tabs = [
  { id: 'overview', label: '手柄状态' },
  { id: 'mapping', label: '通道映射' },
  { id: 'buttons', label: '按钮分配' },
  { id: 'advanced', label: '高级设置' },
]

const mappingLabels = [
  { key: 'throttle', label: '油门', channel: 'CH3' },
  { key: 'yaw', label: '偏航', channel: 'CH4' },
  { key: 'pitch', label: '俯仰', channel: 'CH2' },
  { key: 'roll', label: '横滚', channel: 'CH1' },
] as const

const actionOptions: Array<{ id: GamepadActionId; label: string }> = [
  { id: 'none', label: '无动作' },
  { id: 'arm', label: '解锁（需二次确认）' },
  { id: 'disarm', label: '上锁' },
  { id: 'toggle_arm', label: '切换解锁状态' },
  { id: 'manual', label: 'Manual 模式' },
  { id: 'altitude', label: 'Altitude 模式' },
  { id: 'position', label: 'Position 模式' },
  { id: 'mission', label: 'Mission 模式' },
  { id: 'hold', label: 'Hold 模式' },
  { id: 'rtl', label: '返航 RTL' },
  { id: 'land', label: '降落 Land' },
  { id: 'stabilized', label: 'Stabilized 模式' },
  { id: 'acro', label: 'Acro 模式' },
]

const actionModes: Partial<Record<GamepadActionId, (typeof PX4_MODES)[keyof typeof PX4_MODES]>> = {
  manual: PX4_MODES.MANUAL,
  altitude: PX4_MODES.ALTCTL,
  position: PX4_MODES.POSCTL,
  mission: PX4_MODES.AUTO_MISSION,
  hold: PX4_MODES.AUTO_LOITER,
  rtl: PX4_MODES.AUTO_RTL,
  land: PX4_MODES.AUTO_LAND,
  stabilized: PX4_MODES.STABILIZED,
  acro: PX4_MODES.ACRO,
}

function ToggleSetting({ label, hint, checked, onChange }: {
  label: string
  hint: string
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-5 rounded-xl border p-4" style={{ borderColor: 'var(--border)', background: 'var(--bg-secondary)' }}>
      <span>
        <span className="block text-[13px] font-bold" style={{ color: 'var(--text-primary)' }}>{label}</span>
        <span className="mt-1 block text-[10px] leading-4" style={{ color: 'var(--text-secondary)' }}>{hint}</span>
      </span>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} className="h-4 w-4 shrink-0" style={{ accentColor: 'var(--accent)' }} />
    </label>
  )
}

export default function JoystickPage({ embedded = false }: { embedded?: boolean }) {
  const gamepadState = useGamepadStore()
  const {
    connected, id, axes, buttons, mapping, buttonAssignments,
    deadzone, expo, advanced, enabled,
    setConnected, setAxes, setButtons, setEnabled, setDeadzone, setExpo,
    setMapping, setButtonAssignment, setAdvanced,
  } = gamepadState
  const { send } = useWebSocket()
  const [activeTab, setActiveTab] = useState('overview')
  const [actionNotice, setActionNotice] = useState('')
  const rafRef = useRef<number>(0)
  const lastAxisSendRef = useRef(0)
  const lastButtonFireRef = useRef<Record<number, number>>({})
  const previousButtonsRef = useRef<boolean[]>([])
  const pendingArmRef = useRef<{ button: number; expires: number } | null>(null)
  const smoothedThrottleRef = useRef(0)
  const flightControllerConnected = useConnectionStore((state) => state.status === 'connected')

  const stateRef = useRef(gamepadState)
  stateRef.current = gamepadState
  const actionsRef = useRef({ setConnected, setAxes, setButtons, send })
  actionsRef.current = { setConnected, setAxes, setButtons, send }

  const releaseOverride = useCallback(() => {
    actionsRef.current.send({
      type: 'rc_channels_override',
      data: { ch1: 0, ch2: 0, ch3: 0, ch4: 0, ch5: 0, ch6: 0, ch7: 0, ch8: 0 },
    })
  }, [])

  useEffect(() => {
    if (!enabled) releaseOverride()
  }, [enabled, releaseOverride])

  useEffect(() => {
    if (!connected) releaseOverride()
  }, [connected, releaseOverride])

  useEffect(() => useConnectionStore.subscribe((state) => {
    if (state.status !== 'connected' && useGamepadStore.getState().enabled) {
      useGamepadStore.getState().setEnabled(false)
    }
  }), [])

  useEffect(() => {
    const fireAction = (action: GamepadActionId, button: number) => {
      if (action === 'none') return
      const actions = actionsRef.current
      const armed = useTelemetryStore.getState().status?.armed ?? false
      const armCommand = (arm: boolean) => actions.send({
        type: 'command',
        cmd: 'MAV_CMD_COMPONENT_ARM_DISARM',
        params: [arm ? 1 : 0, 0, 0, 0, 0, 0, 0],
      })

      if (action === 'arm' || (action === 'toggle_arm' && !armed)) {
        const now = Date.now()
        if (pendingArmRef.current?.button === button && pendingArmRef.current.expires > now) {
          armCommand(true)
          pendingArmRef.current = null
          setActionNotice(`B${button}：已发送解锁指令`)
        } else {
          pendingArmRef.current = { button, expires: now + 3000 }
          setActionNotice(`B${button}：3 秒内再次按下以确认解锁`)
        }
        return
      }
      if (action === 'disarm' || action === 'toggle_arm') {
        armCommand(false)
        setActionNotice(`B${button}：已发送上锁指令`)
        return
      }
      const mode = actionModes[action]
      if (mode) {
        actions.send({
          type: 'command',
          cmd: 'MAV_CMD_DO_SET_MODE',
          params: [1, mode.mainMode, mode.subMode, 0, 0, 0, 0],
        })
        setActionNotice(`B${button}：切换至 ${mode.name}`)
      }
    }

    const pollGamepad = () => {
      const current = stateRef.current
      const actions = actionsRef.current
      const controllerConnected = useConnectionStore.getState().status === 'connected'
      const gamepads = navigator.getGamepads()
      const gamepad = gamepads[0] || gamepads[1] || gamepads[2] || gamepads[3]

      if (gamepad) {
        if (!current.connected) actions.setConnected(true, gamepad.id)
        const rawButtons = gamepad.buttons.map((button) => button.pressed)
        actions.setAxes(Array.from(gamepad.axes))
        actions.setButtons(rawButtons)

        if (current.enabled && controllerConnected) {
          const now = Date.now()
          const buttonDelay = 1000 / Math.max(1, current.advanced.buttonFrequencyHz)
          rawButtons.forEach((pressed, index) => {
            const assignment = current.buttonAssignments[index]
            const downTransition = pressed && !previousButtonsRef.current[index]
            const repeatDue = pressed && assignment?.repeat && now - (lastButtonFireRef.current[index] ?? 0) >= buttonDelay
            if (assignment && (downTransition || repeatDue)) {
              lastButtonFireRef.current[index] = now
              fireAction(assignment.action, index)
            }
          })

          const axisDelay = 1000 / Math.max(1, current.advanced.axisFrequencyHz)
          if (now - lastAxisSendRef.current >= axisDelay) {
            const deltaSeconds = Math.min((now - lastAxisSendRef.current) / 1000, 0.1)
            lastAxisSendRef.current = now
            const shape = (value: number) => {
              let result = value
              if (current.advanced.useDeadband) {
                if (Math.abs(result) < current.deadzone) return 0
                result = Math.sign(result) * (Math.abs(result) - current.deadzone) / (1 - current.deadzone)
              }
              result = result * (1 - current.expo) + result ** 3 * current.expo
              if (current.advanced.circleCorrection) {
                const limited = Math.max(-Math.PI / 4, Math.min(Math.PI / 4, result))
                result = Math.tan(Math.asin(limited))
              }
              return Math.max(-1, Math.min(1, result))
            }
            const axis = (key: keyof Pick<GamepadMapping, 'roll' | 'pitch' | 'yaw' | 'throttle'>) =>
              shape(gamepad.axes[current.mapping[key]] ?? 0)
            const toPwm = (value: number) => Math.round(1500 + value * 500)
            let throttle = -axis('throttle')
            if (current.advanced.throttleModeCenterZero) throttle = Math.max(0, throttle) * 2 - 1
            if (current.advanced.throttleSmoothing) {
              const maxStep = deltaSeconds
              const difference = throttle - smoothedThrottleRef.current
              smoothedThrottleRef.current += Math.max(-maxStep, Math.min(maxStep, difference))
              throttle = smoothedThrottleRef.current
            } else {
              smoothedThrottleRef.current = throttle
            }
            actions.send({
              type: 'rc_channels_override',
              data: {
                ch1: toPwm(axis('roll')),
                ch2: toPwm(-axis('pitch')),
                ch3: toPwm(throttle),
                ch4: toPwm(axis('yaw')),
                ch5: 1500, ch6: 1500, ch7: 1500, ch8: 1500,
              },
            })
          }
        }
        previousButtonsRef.current = rawButtons
      } else if (current.connected) {
        actions.setConnected(false)
        previousButtonsRef.current = []
      }
      rafRef.current = requestAnimationFrame(pollGamepad)
    }

    rafRef.current = requestAnimationFrame(pollGamepad)
    return () => cancelAnimationFrame(rafRef.current)
  }, [])

  const axisCount = Math.max(axes.length, 4)
  const buttonCount = Math.max(buttons.length, 16)

  return (
    <div className={embedded ? 'mc-fade-in' : 'mc-workspace mc-fade-in'}>
      {!embedded && <PageHeader
        title="游戏手柄"
        description="将 USB 或蓝牙游戏手柄映射为 RC 通道输入"
        actions={<span className="flex items-center gap-2 rounded-full px-3 py-2 text-[11px] font-semibold" style={{ background: connected ? 'var(--success-dim)' : 'var(--bg-tertiary)', color: connected ? 'var(--success)' : 'var(--text-disabled)' }}><span className="mc-status-dot" style={{ background: connected ? 'var(--success)' : 'var(--text-disabled)' }} />{connected ? '已检测到手柄' : '等待手柄'}</span>}
      />}

      <PageTabs tabs={tabs} active={activeTab} onChange={setActiveTab} />

      {activeTab === 'overview' && (
        <section className="mt-5 space-y-4">
          <div className="mc-card overflow-hidden">
            <div className="border-b px-5 py-4" style={{ borderColor: 'var(--border)' }}>
              <h2 className="text-[14px] font-bold" style={{ color: 'var(--text-primary)' }}>当前手柄可视化</h2>
              <p className="mt-1 text-[11px]" style={{ color: 'var(--text-secondary)' }}>摇杆位置与按键状态会随物理手柄实时更新。</p>
            </div>
            <div className="p-5"><GamepadVisualizer connected={connected} controllerId={id} flightControllerConnected={flightControllerConnected} enabled={enabled} axes={axes} buttons={buttons} mapping={mapping} /></div>
          </div>
          <section className="mc-card p-5">
            <div className="flex items-start gap-3">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl" style={{ background: 'var(--warning-dim)', color: 'var(--warning)' }}><Icon name="warning" size={18} /></span>
              <div><h2 className="text-[14px] font-bold" style={{ color: 'var(--text-primary)' }}>安全控制</h2><p className="mt-1 text-[11px] leading-5" style={{ color: 'var(--text-secondary)' }}>手柄不会自动接管飞控；飞控断链后会立刻停止并关闭 RC 覆盖。</p></div>
            </div>
            <label className="mt-5 flex cursor-pointer items-center justify-between rounded-xl border p-3" style={{ borderColor: enabled ? 'var(--accent)' : 'var(--border)', background: enabled ? 'var(--accent-dim)' : 'var(--bg-secondary)' }}>
              <span><span className="block text-[13px] font-bold" style={{ color: 'var(--text-primary)' }}>启用手柄控制</span><span className="mt-0.5 block text-[10px]" style={{ color: 'var(--text-secondary)' }}>RC_CHANNELS_OVERRIDE · {advanced.axisFrequencyHz} Hz</span></span>
              <input type="checkbox" checked={enabled} disabled={!connected || !flightControllerConnected} onChange={(event) => setEnabled(event.target.checked)} className="h-4 w-4 rounded" style={{ accentColor: 'var(--accent)' }} />
            </label>
            {actionNotice && <p className="mt-3 rounded-lg px-3 py-2 text-[11px]" style={{ background: 'var(--accent-dim)', color: 'var(--accent)' }}>{actionNotice}</p>}
            {!flightControllerConnected && <p className="mt-3 text-[11px]" style={{ color: 'var(--warning)' }}>请先连接飞控，才能手动启用 RC 覆盖。</p>}
          </section>
        </section>
      )}

      {activeTab === 'mapping' && (
        <section className="mc-card mt-5 overflow-hidden">
          <div className="border-b px-5 py-4" style={{ borderColor: 'var(--border)' }}><h2 className="text-[14px] font-bold" style={{ color: 'var(--text-primary)' }}>轴映射与响应曲线</h2><p className="mt-1 text-[11px]" style={{ color: 'var(--text-secondary)' }}>映射修改会在下一帧输入时生效；不会自动启用控制。</p></div>
          <div className="grid grid-cols-1 gap-6 p-5 xl:grid-cols-[1fr_0.8fr]">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {mappingLabels.map((item) => <label key={item.key} className="rounded-xl border p-4" style={{ borderColor: 'var(--border)', background: 'var(--bg-secondary)' }}><span className="flex items-center justify-between"><span className="text-[13px] font-bold" style={{ color: 'var(--text-primary)' }}>{item.label}</span><span className="mc-mono text-[10px]" style={{ color: 'var(--accent)' }}>{item.channel}</span></span><select className="mc-select mt-3" value={mapping[item.key]} onChange={(event) => setMapping({ [item.key]: Number(event.target.value) })}>{Array.from({ length: axisCount }, (_, index) => <option key={index} value={index}>Axis {index}</option>)}</select></label>)}
            </div>
            <div className="space-y-5 rounded-xl border p-5" style={{ borderColor: 'var(--border)', background: 'var(--bg-tertiary)' }}>
              <div><div className="flex items-center justify-between text-[12px]"><span style={{ color: 'var(--text-secondary)' }}>死区</span><span className="mc-mono font-bold" style={{ color: 'var(--accent)' }}>{deadzone.toFixed(2)}</span></div><input className="mt-3" type="range" min="0" max="0.3" step="0.01" value={deadzone} onChange={(event) => setDeadzone(Number(event.target.value))} /></div>
              <div><div className="flex items-center justify-between text-[12px]"><span style={{ color: 'var(--text-secondary)' }}>指数</span><span className="mc-mono font-bold" style={{ color: 'var(--accent)' }}>{Math.round(expo * 100)}%</span></div><input className="mt-3" type="range" min="0" max="1" step="0.05" value={expo} onChange={(event) => setExpo(Number(event.target.value))} /></div>
            </div>
          </div>
        </section>
      )}

      {activeTab === 'buttons' && (
        <section className="mc-card mt-5 overflow-hidden">
          <div className="border-b px-5 py-4" style={{ borderColor: 'var(--border)' }}><h2 className="text-[14px] font-bold" style={{ color: 'var(--text-primary)' }}>按钮分配</h2><p className="mt-1 text-[11px]" style={{ color: 'var(--text-secondary)' }}>参考 QGroundControl：每个按钮独立保存动作与重复触发。动作仅在“启用手柄控制”后执行。</p></div>
          <div className="grid grid-cols-1 gap-3 p-5 lg:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: buttonCount }, (_, index) => {
              const assignment = buttonAssignments[index] ?? { action: 'none' as const, repeat: false }
              return <div key={index} className="grid grid-cols-[42px_1fr_auto] items-center gap-3 rounded-xl border p-3" style={{ borderColor: buttons[index] ? 'var(--accent)' : 'var(--border)', background: buttons[index] ? 'var(--accent-dim)' : 'var(--bg-secondary)' }}><span className="mc-mono grid h-9 place-items-center rounded-lg text-[11px] font-bold" style={{ background: 'var(--bg-tertiary)', color: buttons[index] ? 'var(--accent)' : 'var(--text-secondary)' }}>B{index}</span><select className="mc-select" value={assignment.action} onChange={(event) => setButtonAssignment(index, { action: event.target.value as GamepadActionId })}>{actionOptions.map((action) => <option key={action.id} value={action.id}>{action.label}</option>)}</select><label className="flex items-center gap-1 text-[10px]" style={{ color: 'var(--text-secondary)' }}><input type="checkbox" checked={assignment.repeat} disabled={assignment.action === 'none' || ['arm', 'disarm', 'toggle_arm'].includes(assignment.action)} onChange={(event) => setButtonAssignment(index, { repeat: event.target.checked })} style={{ accentColor: 'var(--accent)' }} />重复</label></div>
            })}
          </div>
        </section>
      )}

      {activeTab === 'advanced' && (
        <section className="mc-card mt-5 overflow-hidden">
          <div className="border-b px-5 py-4" style={{ borderColor: 'var(--border)' }}><h2 className="text-[14px] font-bold" style={{ color: 'var(--text-primary)' }}>高级设置</h2><p className="mt-1 text-[11px]" style={{ color: 'var(--text-secondary)' }}>参数结构与处理顺序参考 QGroundControl Joystick 实现。</p></div>
          <div className="grid grid-cols-1 gap-4 p-5 lg:grid-cols-2">
            <ToggleSetting label="摇杆中位为零油门" hint="适用于自动回中的游戏手柄油门轴；中位以下保持最小油门。" checked={advanced.throttleModeCenterZero} onChange={(value) => setAdvanced({ throttleModeCenterZero: value })} />
            <ToggleSetting label="弹簧油门平滑" hint="限制油门每秒最多变化一个完整量程，降低中位油门突变。" checked={advanced.throttleSmoothing} onChange={(value) => setAdvanced({ throttleSmoothing: value })} />
            <ToggleSetting label="启用圆形校正" hint="按 QGC 的映射方式补偿部分手柄圆形摇杆座的边缘行程。" checked={advanced.circleCorrection} onChange={(value) => setAdvanced({ circleCorrection: value })} />
            <ToggleSetting label="启用死区" hint="关闭后保留原始中心输入；死区数值仍会保存在通道映射页。" checked={advanced.useDeadband} onChange={(value) => setAdvanced({ useDeadband: value })} />
            <label className="rounded-xl border p-4" style={{ borderColor: 'var(--border)', background: 'var(--bg-secondary)' }}><span className="flex items-center justify-between text-[12px]"><span style={{ color: 'var(--text-primary)' }}>轴频率</span><strong className="mc-mono" style={{ color: 'var(--accent)' }}>{advanced.axisFrequencyHz} Hz</strong></span><input className="mt-4 w-full" type="range" min="5" max="60" step="1" value={advanced.axisFrequencyHz} onChange={(event) => setAdvanced({ axisFrequencyHz: Number(event.target.value) })} /></label>
            <label className="rounded-xl border p-4" style={{ borderColor: 'var(--border)', background: 'var(--bg-secondary)' }}><span className="flex items-center justify-between text-[12px]"><span style={{ color: 'var(--text-primary)' }}>按钮重复频率</span><strong className="mc-mono" style={{ color: 'var(--accent)' }}>{advanced.buttonFrequencyHz} Hz</strong></span><input className="mt-4 w-full" type="range" min="1" max="20" step="1" value={advanced.buttonFrequencyHz} onChange={(event) => setAdvanced({ buttonFrequencyHz: Number(event.target.value) })} /></label>
          </div>
        </section>
      )}
    </div>
  )
}
