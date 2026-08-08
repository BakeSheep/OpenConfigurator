import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import GamepadVisualizer from '../components/gamepad/GamepadVisualizer'
import Icon from '../components/ui/Icon'
import { PageTabs } from '../components/ui/PageFrame'
import { useConnectionStore } from '../stores/connectionStore'
import { useTelemetryStore } from '../stores/telemetryStore'
import { availableModes, vehicleCapabilities } from '../../shared/vehicleProfiles'
import {
  useGamepadStore,
  type GamepadActionId,
} from '../stores/gamepadStore'
import {
  canRepeatGamepadAction,
  createModeGamepadAction,
  normalizeGamepadActionForIdentity,
} from '../utils/gamepadActions'
import {
  axisFunction,
  remapAxisFunction,
  type GamepadAxisFunction,
} from '../utils/gamepadMapping'
import {
  loadConnectionPresets,
  saveConnectionPresets,
  updateConnectionPresetGamepadPreference,
} from '../utils/connectionPresets'

const TAB_KEYS = [
  { id: 'overview', label: 'joystick.tab.overview' },
  { id: 'buttons', label: 'joystick.tab.buttons' },
]

const STICK_AXES = [
  { axis: 0, label: 'joystick.visualizer.leftX' },
  { axis: 1, label: 'joystick.visualizer.leftY' },
  { axis: 2, label: 'joystick.visualizer.rightX' },
  { axis: 3, label: 'joystick.visualizer.rightY' },
] as const

const AXIS_FUNCTION_OPTIONS: Array<{ key: GamepadAxisFunction; label: string; channel: string }> = [
  { key: 'throttle', label: 'joystick.mapping.throttle', channel: 'CH3' },
  { key: 'yaw', label: 'joystick.mapping.yaw', channel: 'CH4' },
  { key: 'pitch', label: 'joystick.mapping.pitch', channel: 'CH2' },
  { key: 'roll', label: 'joystick.mapping.roll', channel: 'CH1' },
]

const CORE_ACTION_KEYS: Array<{ id: GamepadActionId; label: string }> = [
  { id: 'none', label: 'joystick.action.none' },
  { id: 'arm', label: 'joystick.action.arm' },
  { id: 'disarm', label: 'joystick.action.disarm' },
  { id: 'toggle_arm', label: 'joystick.action.toggleArm' },
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
    connected, axes, buttons, mapping, buttonAssignments,
    deadzone, expo, advanced, enabled, actionNotice,
    setEnabled, setDeadzone, setExpo,
    setMapping, setButtonAssignment, setAdvanced,
  } = gamepadState
  const [activeTab, setActiveTab] = useState('overview')
  const flightControllerConnected = useConnectionStore((state) => state.vehicleReady && state.canControl)
  const activePresetId = useConnectionStore((state) => state.activePresetId)
  const vehicleIdentity = useTelemetryStore((state) => state.vehicleIdentity)
  const profileWritable = vehicleCapabilities(vehicleIdentity).writeOperations
  const manualControlAvailable = flightControllerConnected && profileWritable

  const buttonCount = Math.max(buttons.length, 16)

  const tabs = useMemo(() => TAB_KEYS.map((tab) => ({ ...tab, label: t(tab.label) })), [t])
  const actionOptions = useMemo(() => [
    ...CORE_ACTION_KEYS.map((action) => ({ ...action, label: t(action.label) })),
    ...availableModes(vehicleIdentity).flatMap((mode) => {
      const id = createModeGamepadAction(vehicleIdentity, mode.id)
      return id ? [{ id, label: mode.name }] : []
    }),
  ], [t, vehicleIdentity])

  const setEnabledForActivePreset = (nextEnabled: boolean) => {
    setEnabled(nextEnabled)
    if (!activePresetId) return
    const presets = loadConnectionPresets()
    const updated = updateConnectionPresetGamepadPreference(presets, activePresetId, nextEnabled)
    if (updated !== presets) saveConnectionPresets(updated)
  }

  return (
    <div className={embedded ? 'mc-fade-in' : 'mc-workspace mc-fade-in'}>

      <PageTabs tabs={tabs} active={activeTab} onChange={setActiveTab} />

      {activeTab === 'overview' && (
        <section className="mt-4 space-y-3">
          <div className="mc-card overflow-hidden p-4">
            <div className="grid items-stretch gap-4 lg:grid-cols-[minmax(360px,0.9fr)_minmax(360px,1.1fr)]">
              <GamepadVisualizer connected={connected} axes={axes} buttons={buttons} />

              <div className="grid content-start gap-3">
                <section className="rounded-xl border p-3" style={{ background: enabled ? 'var(--accent-dim)' : 'var(--bg-secondary)', borderColor: enabled ? 'var(--accent)' : 'var(--border)' }}>
                  <label className="flex cursor-pointer items-center justify-between gap-4">
                    <span>
                      <span className="block text-[12px] font-bold" style={{ color: 'var(--text-primary)' }}>{t('joystick.enableControl')}</span>
                      <span className="mt-0.5 block text-[10px]" style={{ color: 'var(--text-secondary)' }}>MANUAL_CONTROL · {advanced.axisFrequencyHz} Hz</span>
                    </span>
                    <input type="checkbox" checked={enabled} disabled={!manualControlAvailable} onChange={(event) => setEnabledForActivePreset(event.target.checked)} className="h-4 w-4 rounded" style={{ accentColor: 'var(--accent)' }} />
                  </label>
                  {actionNotice && <p className="mt-2 rounded-lg px-2.5 py-1.5 text-[10px]" style={{ background: 'var(--bg-secondary)', color: 'var(--accent)' }}>{actionNotice}</p>}
                  {!flightControllerConnected && <p className="mt-2 text-[10px]" style={{ color: 'var(--warning)' }}>{t('joystick.connectFirst')}</p>}
                  {flightControllerConnected && !profileWritable && <p className="mt-2 text-[10px]" style={{ color: 'var(--warning)' }}>{t('joystick.readOnlyFc')}</p>}
                </section>

                <section className="rounded-xl border p-4" style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border)' }}>
                  <p className="mc-section-title mb-3">{t('joystick.channelMapping')}</p>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {STICK_AXES.map((item) => {
                      const selectedFunction = axisFunction(mapping, item.axis) ?? ''
                      const value = Math.max(-1, Math.min(1, axes[item.axis] ?? 0))
                      return (
                        <label key={item.axis} className="grid grid-cols-[minmax(64px,0.55fr)_minmax(112px,1fr)] items-center gap-2 rounded-lg border p-2.5" style={{ borderColor: 'var(--border)', background: 'var(--bg-tertiary)' }}>
                          <span>
                            <span className="block text-[9px]" style={{ color: 'var(--text-disabled)' }}>{t(item.label)}</span>
                            <span className="mc-mono mt-0.5 block text-[12px] font-semibold" style={{ color: 'var(--text-primary)' }}>{value.toFixed(3)}</span>
                          </span>
                          <select
                            className="mc-select"
                            value={selectedFunction}
                            onChange={(event) => setMapping(remapAxisFunction(mapping, item.axis, event.target.value as GamepadAxisFunction))}
                          >
                            {!selectedFunction && <option value="" disabled>—</option>}
                            {AXIS_FUNCTION_OPTIONS.map((option) => (
                              <option key={option.key} value={option.key}>{t(option.label)} · {option.channel}</option>
                            ))}
                          </select>
                        </label>
                      )
                    })}
                  </div>
                </section>

                <section className="rounded-xl border p-4" style={{ background: 'var(--bg-tertiary)', borderColor: 'var(--border)' }}>
                  <div className="space-y-4">
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
                </section>
              </div>
            </div>
          </div>

          <section className="mc-card overflow-hidden">
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
              const selectedAction = normalizeGamepadActionForIdentity(assignment.action, vehicleIdentity)
              const selectedActionAvailable = actionOptions.some((action) => action.id === selectedAction)
              return (
                <div key={index} className="grid grid-cols-[36px_1fr_auto] items-center gap-2 rounded-lg border p-2" style={{ borderColor: buttons[index] ? 'var(--accent)' : 'var(--border)', background: buttons[index] ? 'var(--accent-dim)' : 'var(--bg-secondary)' }}>
                  <span className="mc-mono grid h-8 place-items-center rounded-md text-[10px] font-bold" style={{ background: 'var(--bg-tertiary)', color: buttons[index] ? 'var(--accent)' : 'var(--text-secondary)' }}>B{index}</span>
                  <select className="mc-select" value={selectedAction} onChange={(event) => setButtonAssignment(index, { action: event.target.value as GamepadActionId })}>
                    {!selectedActionAvailable && (
                      <option value={selectedAction} disabled>{t('joystick.action.unavailableAssigned')}</option>
                    )}
                    {actionOptions.map((action) => <option key={action.id} value={action.id}>{action.label}</option>)}
                  </select>
                  <label className="flex items-center gap-1 text-[10px]" style={{ color: 'var(--text-secondary)' }}>
                    <input type="checkbox" checked={assignment.repeat} disabled={!canRepeatGamepadAction(assignment.action)} onChange={(event) => setButtonAssignment(index, { repeat: event.target.checked })} style={{ accentColor: 'var(--accent)' }} />
                    {t('joystick.repeat')}
                  </label>
                </div>
              )
            })}
          </div>
        </section>
      )}

    </div>
  )
}
