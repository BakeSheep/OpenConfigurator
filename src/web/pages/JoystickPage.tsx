import { useState } from 'react'
import GamepadVisualizer from '../components/gamepad/GamepadVisualizer'
import Icon from '../components/ui/Icon'
import { PageTabs } from '../components/ui/PageFrame'
import { useConnectionStore } from '../stores/connectionStore'
import {
  useGamepadStore,
  type GamepadActionId,
} from '../stores/gamepadStore'

const tabs = [
  { id: 'overview', label: '手柄状态' },
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

function ToggleSetting({ label, hint, checked, onChange }: {
  label: string
  hint: string
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-4 rounded-lg border p-3" style={{ borderColor: 'var(--border)', background: 'var(--bg-secondary)' }}>
      <span>
        <span className="block text-[12px] font-bold" style={{ color: 'var(--text-primary)' }}>{label}</span>
        <span className="mt-0.5 block text-[10px] leading-4" style={{ color: 'var(--text-secondary)' }}>{hint}</span>
      </span>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} className="h-4 w-4 shrink-0" style={{ accentColor: 'var(--accent)' }} />
    </label>
  )
}

export default function JoystickPage({ embedded = false }: { embedded?: boolean }) {
  const gamepadState = useGamepadStore()
  const {
    connected, id, axes, buttons, mapping, buttonAssignments,
    deadzone, expo, advanced, enabled, actionNotice,
    setEnabled, setDeadzone, setExpo,
    setMapping, setButtonAssignment, setAdvanced,
  } = gamepadState
  const [activeTab, setActiveTab] = useState('overview')
  const flightControllerConnected = useConnectionStore((state) => state.vehicleReady && state.canControl)

  const axisCount = Math.max(axes.length, 4)
  const buttonCount = Math.max(buttons.length, 16)

  return (
    <div className={embedded ? 'mc-fade-in' : 'mc-workspace mc-fade-in'}>

      <PageTabs tabs={tabs} active={activeTab} onChange={setActiveTab} />

      {activeTab === 'overview' && (
        <section className="mt-4 space-y-3">
          {/* Enable control merged into the visualizer card */}
          <div className="mc-card overflow-hidden p-4">
            <label className="mb-4 flex cursor-pointer items-center justify-between rounded-lg border p-3" style={{ borderColor: enabled ? 'var(--accent)' : 'var(--border)', background: enabled ? 'var(--accent-dim)' : 'var(--bg-secondary)' }}>
              <span>
                <span className="block text-[12px] font-bold" style={{ color: 'var(--text-primary)' }}>启用手柄控制</span>
                <span className="mt-0.5 block text-[10px]" style={{ color: 'var(--text-secondary)' }}>MANUAL_CONTROL · {advanced.axisFrequencyHz} Hz</span>
              </span>
              <input type="checkbox" checked={enabled} disabled={!connected || !flightControllerConnected} onChange={(event) => setEnabled(event.target.checked)} className="h-4 w-4 rounded" style={{ accentColor: 'var(--accent)' }} />
            </label>
            {actionNotice && <p className="-mt-2 mb-3 rounded-lg px-3 py-1.5 text-[11px]" style={{ background: 'var(--accent-dim)', color: 'var(--accent)' }}>{actionNotice}</p>}
            {!flightControllerConnected && <p className="-mt-2 mb-3 text-[10px]" style={{ color: 'var(--warning)' }}>请先连接飞控。</p>}
            <GamepadVisualizer connected={connected} controllerId={id} flightControllerConnected={flightControllerConnected} enabled={enabled} axes={axes} buttons={buttons} mapping={mapping} />
          </div>

          {/* Channel mapping integrated below */}
          <div className="mc-card overflow-hidden">
            <div className="border-b px-4 py-3" style={{ borderColor: 'var(--border)' }}>
              <h2 className="text-[13px] font-bold" style={{ color: 'var(--text-primary)' }}>通道映射与响应曲线</h2>
            </div>
            <div className="grid grid-cols-1 gap-4 p-4 xl:grid-cols-[1fr_0.7fr]">
              <div className="grid grid-cols-2 gap-2">
                {mappingLabels.map((item) => (
                  <label key={item.key} className="rounded-lg border p-3" style={{ borderColor: 'var(--border)', background: 'var(--bg-secondary)' }}>
                    <span className="flex items-center justify-between">
                      <span className="text-[12px] font-bold" style={{ color: 'var(--text-primary)' }}>{item.label}</span>
                      <span className="mc-mono text-[10px]" style={{ color: 'var(--accent)' }}>{item.channel}</span>
                    </span>
                    <select className="mc-select mt-2" value={mapping[item.key]} onChange={(event) => setMapping({ [item.key]: Number(event.target.value) })}>
                      {Array.from({ length: axisCount }, (_, index) => <option key={index} value={index}>Axis {index}</option>)}
                    </select>
                  </label>
                ))}
              </div>
              <div className="space-y-4 rounded-lg border p-4" style={{ borderColor: 'var(--border)', background: 'var(--bg-tertiary)' }}>
                <div>
                  <div className="flex items-center justify-between text-[11px]">
                    <span style={{ color: 'var(--text-secondary)' }}>死区</span>
                    <span className="mc-mono font-bold" style={{ color: 'var(--accent)' }}>{deadzone.toFixed(2)}</span>
                  </div>
                  <input className="mt-2 w-full" type="range" min="0" max="0.3" step="0.01" value={deadzone} onChange={(event) => setDeadzone(Number(event.target.value))} />
                </div>
                <div>
                  <div className="flex items-center justify-between text-[11px]">
                    <span style={{ color: 'var(--text-secondary)' }}>指数</span>
                    <span className="mc-mono font-bold" style={{ color: 'var(--accent)' }}>{Math.round(expo * 100)}%</span>
                  </div>
                  <input className="mt-2 w-full" type="range" min="0" max="1" step="0.05" value={expo} onChange={(event) => setExpo(Number(event.target.value))} />
                </div>
              </div>
            </div>
          </div>
        </section>
      )}

      {activeTab === 'buttons' && (
        <section className="mc-card mt-4 overflow-hidden">
          <div className="border-b px-4 py-3" style={{ borderColor: 'var(--border)' }}>
            <h2 className="text-[13px] font-bold" style={{ color: 'var(--text-primary)' }}>按钮分配</h2>
            <p className="mt-0.5 text-[10px]" style={{ color: 'var(--text-secondary)' }}>动作仅在"启用手柄控制"后执行。</p>
          </div>
          <div className="grid grid-cols-1 gap-2 p-4 lg:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: buttonCount }, (_, index) => {
              const assignment = buttonAssignments[index] ?? { action: 'none' as const, repeat: false }
              return (
                <div key={index} className="grid grid-cols-[36px_1fr_auto] items-center gap-2 rounded-lg border p-2" style={{ borderColor: buttons[index] ? 'var(--accent)' : 'var(--border)', background: buttons[index] ? 'var(--accent-dim)' : 'var(--bg-secondary)' }}>
                  <span className="mc-mono grid h-8 place-items-center rounded-md text-[10px] font-bold" style={{ background: 'var(--bg-tertiary)', color: buttons[index] ? 'var(--accent)' : 'var(--text-secondary)' }}>B{index}</span>
                  <select className="mc-select" value={assignment.action} onChange={(event) => setButtonAssignment(index, { action: event.target.value as GamepadActionId })}>
                    {actionOptions.map((action) => <option key={action.id} value={action.id}>{action.label}</option>)}
                  </select>
                  <label className="flex items-center gap-1 text-[10px]" style={{ color: 'var(--text-secondary)' }}>
                    <input type="checkbox" checked={assignment.repeat} disabled={assignment.action === 'none' || ['arm', 'disarm', 'toggle_arm'].includes(assignment.action)} onChange={(event) => setButtonAssignment(index, { repeat: event.target.checked })} style={{ accentColor: 'var(--accent)' }} />
                    重复
                  </label>
                </div>
              )
            })}
          </div>
        </section>
      )}

      {activeTab === 'advanced' && (
        <section className="mc-card mt-4 overflow-hidden">
          <div className="border-b px-4 py-3" style={{ borderColor: 'var(--border)' }}>
            <h2 className="text-[13px] font-bold" style={{ color: 'var(--text-primary)' }}>高级设置</h2>
          </div>
          <div className="grid grid-cols-1 gap-3 p-4 lg:grid-cols-2">
            <ToggleSetting label="摇杆中位为零油门" hint="适用于自动回中的游戏手柄油门轴。" checked={advanced.throttleModeCenterZero} onChange={(value) => setAdvanced({ throttleModeCenterZero: value })} />
            <ToggleSetting label="弹簧油门平滑" hint="限制油门每秒最多变化一个完整量程。" checked={advanced.throttleSmoothing} onChange={(value) => setAdvanced({ throttleSmoothing: value })} />
            <ToggleSetting label="启用圆形校正" hint="补偿圆形摇杆座的边缘行程。" checked={advanced.circleCorrection} onChange={(value) => setAdvanced({ circleCorrection: value })} />
            <ToggleSetting label="启用死区" hint="关闭后保留原始中心输入。" checked={advanced.useDeadband} onChange={(value) => setAdvanced({ useDeadband: value })} />
            <label className="rounded-lg border p-3" style={{ borderColor: 'var(--border)', background: 'var(--bg-secondary)' }}>
              <span className="flex items-center justify-between text-[11px]">
                <span style={{ color: 'var(--text-primary)' }}>轴频率</span>
                <strong className="mc-mono" style={{ color: 'var(--accent)' }}>{advanced.axisFrequencyHz} Hz</strong>
              </span>
              <input className="mt-3 w-full" type="range" min="5" max="60" step="1" value={advanced.axisFrequencyHz} onChange={(event) => setAdvanced({ axisFrequencyHz: Number(event.target.value) })} />
            </label>
            <label className="rounded-lg border p-3" style={{ borderColor: 'var(--border)', background: 'var(--bg-secondary)' }}>
              <span className="flex items-center justify-between text-[11px]">
                <span style={{ color: 'var(--text-primary)' }}>按钮重复频率</span>
                <strong className="mc-mono" style={{ color: 'var(--accent)' }}>{advanced.buttonFrequencyHz} Hz</strong>
              </span>
              <input className="mt-3 w-full" type="range" min="1" max="20" step="1" value={advanced.buttonFrequencyHz} onChange={(event) => setAdvanced({ buttonFrequencyHz: Number(event.target.value) })} />
            </label>
          </div>
        </section>
      )}
    </div>
  )
}
