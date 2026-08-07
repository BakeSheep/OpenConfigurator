import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import GamepadVisualizer from '../components/gamepad/GamepadVisualizer'
import Icon from '../components/ui/Icon'
import { PageTabs } from '../components/ui/PageFrame'
import { useConnectionStore } from '../stores/connectionStore'
import { useTelemetryStore } from '../stores/telemetryStore'
import { vehicleCapabilities } from '../../shared/vehicleProfiles'
import {
  useGamepadStore,
  type GamepadActionId,
} from '../stores/gamepadStore'

const TAB_KEYS = [
  { id: 'overview', label: 'joystick.tab.overview' },
  { id: 'buttons', label: 'joystick.tab.buttons' },
  { id: 'advanced', label: 'joystick.tab.advanced' },
]

const MAPPING_KEYS = [
  { key: 'throttle', label: 'joystick.mapping.throttle', channel: 'CH3' },
  { key: 'yaw', label: 'joystick.mapping.yaw', channel: 'CH4' },
  { key: 'pitch', label: 'joystick.mapping.pitch', channel: 'CH2' },
  { key: 'roll', label: 'joystick.mapping.roll', channel: 'CH1' },
] as const

const ACTION_KEYS: Array<{ id: GamepadActionId; label: string }> = [
  { id: 'none', label: 'joystick.action.none' },
  { id: 'arm', label: 'joystick.action.arm' },
  { id: 'disarm', label: 'joystick.action.disarm' },
  { id: 'toggle_arm', label: 'joystick.action.toggleArm' },
  { id: 'manual', label: 'joystick.action.manual' },
  { id: 'altitude', label: 'joystick.action.altitude' },
  { id: 'position', label: 'joystick.action.position' },
  { id: 'mission', label: 'joystick.action.mission' },
  { id: 'hold', label: 'joystick.action.hold' },
  { id: 'rtl', label: 'joystick.action.rtl' },
  { id: 'land', label: 'joystick.action.land' },
  { id: 'stabilized', label: 'joystick.action.stabilized' },
  { id: 'acro', label: 'joystick.action.acro' },
]

function ToggleSetting({ label, hint, checked, onChange }: {
  label: string
  hint: string
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  const { t } = useTranslation()
  return (
    <label className="flex cursor-pointer items-center justify-between gap-4 rounded-lg border p-3" style={{ borderColor: 'var(--border)', background: 'var(--bg-secondary)' }}>
      <span>
        <span className="block text-[12px] font-bold" style={{ color: 'var(--text-primary)' }}>{t(label)}</span>
        <span className="mt-0.5 block text-[10px] leading-4" style={{ color: 'var(--text-secondary)' }}>{t(hint)}</span>
      </span>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} className="h-4 w-4 shrink-0" style={{ accentColor: 'var(--accent)' }} />
    </label>
  )
}

export default function JoystickPage({ embedded = false }: { embedded?: boolean }) {
  const { t } = useTranslation()
  const gamepadState = useGamepadStore()
  const {
    connected, id, axes, buttons, mapping, buttonAssignments,
    deadzone, expo, advanced, enabled, actionNotice,
    setEnabled, setDeadzone, setExpo,
    setMapping, setButtonAssignment, setAdvanced,
  } = gamepadState
  const [activeTab, setActiveTab] = useState('overview')
  const flightControllerConnected = useConnectionStore((state) => state.vehicleReady && state.canControl)
  const vehicleIdentity = useTelemetryStore((state) => state.vehicleIdentity)
  const profileWritable = vehicleCapabilities(vehicleIdentity).writeOperations
  const manualControlAvailable = flightControllerConnected && profileWritable

  const axisCount = Math.max(axes.length, 4)
  const buttonCount = Math.max(buttons.length, 16)

  const tabs = useMemo(() => TAB_KEYS.map((tab) => ({ ...tab, label: t(tab.label) })), [t])
  const mappingLabels = useMemo(() => MAPPING_KEYS.map((item) => ({ ...item, label: t(item.label) })), [t])
  const actionOptions = useMemo(() => ACTION_KEYS.map((action) => ({ ...action, label: t(action.label) })), [t])

  return (
    <div className={embedded ? 'mc-fade-in' : 'mc-workspace mc-fade-in'}>

      <PageTabs tabs={tabs} active={activeTab} onChange={setActiveTab} />

      {activeTab === 'overview' && (
        <section className="mt-4 space-y-3">
          {/* Enable control merged into the visualizer card */}
          <div className="mc-card overflow-hidden p-4">
            <label className="mb-4 flex cursor-pointer items-center justify-between rounded-lg border p-3" style={{ borderColor: enabled ? 'var(--accent)' : 'var(--border)', background: enabled ? 'var(--accent-dim)' : 'var(--bg-secondary)' }}>
              <span>
                <span className="block text-[12px] font-bold" style={{ color: 'var(--text-primary)' }}>{t('joystick.enableControl')}</span>
                <span className="mt-0.5 block text-[10px]" style={{ color: 'var(--text-secondary)' }}>MANUAL_CONTROL · {advanced.axisFrequencyHz} Hz</span>
              </span>
              <input type="checkbox" checked={enabled} disabled={!connected || !manualControlAvailable} onChange={(event) => setEnabled(event.target.checked)} className="h-4 w-4 rounded" style={{ accentColor: 'var(--accent)' }} />
            </label>
            {actionNotice && <p className="-mt-2 mb-3 rounded-lg px-3 py-1.5 text-[11px]" style={{ background: 'var(--accent-dim)', color: 'var(--accent)' }}>{actionNotice}</p>}
            {!flightControllerConnected && <p className="-mt-2 mb-3 text-[10px]" style={{ color: 'var(--warning)' }}>{t('joystick.connectFirst')}</p>}
            {flightControllerConnected && !profileWritable && <p className="-mt-2 mb-3 text-[10px]" style={{ color: 'var(--warning)' }}>{t('joystick.readOnlyFc')}</p>}
            <GamepadVisualizer connected={connected} controllerId={id} flightControllerConnected={manualControlAvailable} enabled={enabled} axes={axes} buttons={buttons} mapping={mapping} />
          </div>

          {/* Channel mapping integrated below */}
          <div className="mc-card overflow-hidden">
            <div className="border-b px-4 py-3" style={{ borderColor: 'var(--border)' }}>
              <h2 className="text-[13px] font-bold" style={{ color: 'var(--text-primary)' }}>{t('joystick.channelMapping')}</h2>
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
                    <span style={{ color: 'var(--text-secondary)' }}>{t('joystick.deadzone')}</span>
                    <span className="mc-mono font-bold" style={{ color: 'var(--accent)' }}>{deadzone.toFixed(2)}</span>
                  </div>
                  <input className="mt-2 w-full" type="range" min="0" max="0.3" step="0.01" value={deadzone} onChange={(event) => setDeadzone(Number(event.target.value))} />
                </div>
                <div>
                  <div className="flex items-center justify-between text-[11px]">
                    <span style={{ color: 'var(--text-secondary)' }}>{t('joystick.expo')}</span>
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
            <h2 className="text-[13px] font-bold" style={{ color: 'var(--text-primary)' }}>{t('joystick.buttonAssignment')}</h2>
            <p className="mt-0.5 text-[10px]" style={{ color: 'var(--text-secondary)' }}>{t('joystick.buttonHint')}</p>
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
                    {t('joystick.repeat')}
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
            <h2 className="text-[13px] font-bold" style={{ color: 'var(--text-primary)' }}>{t('joystick.advancedSettings')}</h2>
          </div>
          <div className="grid grid-cols-1 gap-3 p-4 lg:grid-cols-2">
            <ToggleSetting label="joystick.throttleCenterZero" hint="joystick.throttleCenterZeroHint" checked={advanced.throttleModeCenterZero} onChange={(value) => setAdvanced({ throttleModeCenterZero: value })} />
            <ToggleSetting label="joystick.throttleSmoothing" hint="joystick.throttleSmoothingHint" checked={advanced.throttleSmoothing} onChange={(value) => setAdvanced({ throttleSmoothing: value })} />
            <ToggleSetting label="joystick.circleCorrection" hint="joystick.circleCorrectionHint" checked={advanced.circleCorrection} onChange={(value) => setAdvanced({ circleCorrection: value })} />
            <ToggleSetting label="joystick.useDeadband" hint="joystick.useDeadbandHint" checked={advanced.useDeadband} onChange={(value) => setAdvanced({ useDeadband: value })} />
            <label className="rounded-lg border p-3" style={{ borderColor: 'var(--border)', background: 'var(--bg-secondary)' }}>
              <span className="flex items-center justify-between text-[11px]">
                <span style={{ color: 'var(--text-primary)' }}>{t('joystick.axisFrequency')}</span>
                <strong className="mc-mono" style={{ color: 'var(--accent)' }}>{advanced.axisFrequencyHz} Hz</strong>
              </span>
              <input className="mt-3 w-full" type="range" min="5" max="60" step="1" value={advanced.axisFrequencyHz} onChange={(event) => setAdvanced({ axisFrequencyHz: Number(event.target.value) })} />
            </label>
            <label className="rounded-lg border p-3" style={{ borderColor: 'var(--border)', background: 'var(--bg-secondary)' }}>
              <span className="flex items-center justify-between text-[11px]">
                <span style={{ color: 'var(--text-primary)' }}>{t('joystick.buttonFrequency')}</span>
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
