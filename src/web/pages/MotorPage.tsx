import { useEffect, useMemo, useRef, useState } from 'react'
import i18next from 'i18next'
import { useTranslation } from 'react-i18next'
import Icon from '../components/ui/Icon'
import { PageTabs } from '../components/ui/PageFrame'
import { TabPanel } from '../components/ui/Tabs'
import { useQueryTab } from '../hooks/useQueryTab'
import { sendRuntimeCommand } from '../hooks/useLocalRuntime'
import { useConnectionStore } from '../stores/connectionStore'
import { useParameterStore } from '../stores/parameterStore'
import { useTelemetryStore } from '../stores/telemetryStore'
import type { ParamData } from '../../shared/types'
import { vehicleCapabilities } from '../../shared/vehicleProfiles'
import {
  buildFrameConfigView,
  motorFunctionOptions,
  normalizeAuthoritativeMotorCount,
  type FrameOutputChannel,
} from '../utils/vehicleConfig'
import { hasCompleteRotorGeometry } from '../utils/motorGeometry'

const t = i18next.t.bind(i18next)

interface RotorGeometry {
  index: number
  px: number
  py: number
  ccw: boolean
  output?: string
}

const fallbackQuad = [
  { px: 1, py: 1, ccw: true },
  { px: -1, py: -1, ccw: true },
  { px: 1, py: -1, ccw: false },
  { px: -1, py: 1, ccw: false },
]

const MOTOR_TAB_IDS = ['mapping', 'test'] as const

function protocolLabel(value: number) {
  const protocols: Record<number, string> = {
    [-8]: 'BDShot150',
    [-7]: 'BDShot300',
    [-6]: 'BDShot600',
    [-5]: 'DShot150',
    [-4]: 'DShot300',
    [-3]: 'DShot600',
    [-1]: 'OneShot',
  }
  return protocols[value] || (value > 0 ? `PWM ${value} Hz` : t('motor.fcDefault'))
}

function getBusProtocol(params: Map<string, ParamData>, prefix: string) {
  const values: number[] = []
  for (let timer = 0; timer < 8; timer += 1) {
    const value = params.get(`${prefix}_TIM${timer}`)?.value
    if (Number.isFinite(value) && !values.includes(value!)) values.push(value!)
  }
  if (values.length === 0) return t('motor.fcDefault')
  if (values.length > 1) return t('motor.groupedConfig')
  return protocolLabel(values[0])
}

// ArduPilot exposes one global protocol parameter. PX4 PWM_*_TIMx groups are
// board-specific and cannot be mapped safely to an output row without board
// metadata, so PX4 remains read-only here.
const ARDUPILOT_PROTOCOL_OPTIONS: ReadonlyArray<readonly [number, string]> = [
  [0, 'Normal PWM'], [1, 'OneShot'], [2, 'OneShot125'], [3, 'Brushed'],
  [4, 'DShot150'], [5, 'DShot300'], [6, 'DShot600'], [7, 'DShot1200'], [8, 'PWMRange'],
]

function ArduPilotProtocolControl({ params, canWrite }: {
  params: Map<string, ParamData>
  canWrite: boolean
}) {
  const { t } = useTranslation()
  const param = params.get('MOT_PWM_TYPE')
  const value = param ? Math.round(param.value) : null
  const known = value !== null
    && ARDUPILOT_PROTOCOL_OPTIONS.some(([option]) => option === value)
  return (
    <div className="mc-motor-global-protocol">
      <span>
        <strong>{t('motor.globalEscProtocol')}</strong>
        <small>{t('motor.globalEscProtocolHint')}</small>
      </span>
      {param && value !== null ? (
        <select
          className="mc-select"
          aria-label={t('motor.arduPilotProtocolAria')}
          title={t('motor.arduPilotProtocolTitle')}
          value={value}
          disabled={!canWrite}
          onChange={(event) => sendRuntimeCommand({
            type: 'param_set',
            data: { id: 'MOT_PWM_TYPE', value: Number(event.target.value), paramType: param.type },
          })}
        >
          {/* Preserve an unknown protocol value verbatim, never drop it. */}
          {!known && <option value={value}>{t('motor.valueN', {value: value})}</option>}
          {ARDUPILOT_PROTOCOL_OPTIONS.map(([option, label]) => (
            <option key={option} value={option}>{label}</option>
          ))}
        </select>
      ) : (
        <span className="mc-motor-protocol">{t('motor.waitingMotPwmType')}</span>
      )}
      <span className="mc-motor-param-name">MOT_PWM_TYPE</span>
    </div>
  )
}

function OutputProtocol({ family, label, ariaLabel }: {
  family: string
  label: string
  ariaLabel: string
}) {
  const { t } = useTranslation()
  if (family === 'px4') {
    return (
      <span
        className="mc-motor-protocol"
        aria-label={ariaLabel}
        title={t('motor.px4ProtocolHint')}
      >
        {label}
      </span>
    )
  }
  return (
    <span
      className="mc-motor-protocol"
      aria-label={ariaLabel}
      title={family === 'ardupilot' ? t('motor.arduPilotProtocolHint') : undefined}
    >
      {label}
    </span>
  )
}

function getFallbackRotor(index: number, count: number) {
  if (count === 4) return fallbackQuad[index]
  const angle = Math.PI / 2 - index * Math.PI * 2 / count
  return {
    px: Math.sin(angle),
    py: Math.cos(angle),
    ccw: index % 2 === 0,
  }
}

export default function MotorPage({ embedded = false, panel }: { embedded?: boolean; panel?: 'mapping' | 'test' }) {
  const { t } = useTranslation()
  const send = sendRuntimeCommand
  const vehicleReady = useConnectionStore((state) => state.vehicleReady)
  const canControl = useConnectionStore((state) => state.canControl)
  const rawSessionActive = useConnectionStore((state) => state.rawSessionActive)
  const targetSystemId = useConnectionStore((state) => state.targetSystemId)
  const targetComponentId = useConnectionStore((state) => state.targetComponentId)
  const safetyEpoch = useConnectionStore((state) => state.safetyEpoch)
  const safetyAuthorityId = useConnectionStore((state) => state.safetyAuthorityId)
  const connected = vehicleReady && canControl
  const params = useParameterStore((state) => state.params)
  const motorOutputs = useTelemetryStore((state) => state.motorOutputs)
  const vehicleIdentity = useTelemetryStore((state) => state.vehicleIdentity)
  const caps = vehicleCapabilities(vehicleIdentity)
  // Motor testing / actuator writes are capability-gated by the selected
  // vehicle profile; unsupported profiles keep the controls visible but
  // disabled with an explanation.
  const motorTestSupported = caps.motorTest !== 'none'
  const actuatorWritesSupported = caps.actuatorConfig
  const [safetyConfirmed, setSafetyConfirmed] = useState(false)
  const [queryPanel, setQueryPanel] = useQueryTab(MOTOR_TAB_IDS, 'mapping')
  const activePanel = panel ?? queryPanel
  const [levels, setLevels] = useState<number[]>([])
  // Family-specific frame/actuator read model: SERVOx_FUNCTION for ArduPilot,
  // PWM_MAIN/AUX_FUNCx + CA_ROTOR* for PX4.
  const frameView = useMemo(() => buildFrameConfigView(vehicleIdentity, params), [vehicleIdentity, params])
  const motorCount = normalizeAuthoritativeMotorCount(frameView?.motorCount)
  const airframeName = (params.size > 0 && frameView ? frameView.name : null)
    || t('motor.waitingFrameParams')
  const motorCountRef = useRef(motorCount ?? 0)
  // True once the user enabled motor testing or a non-zero test command was
  // sent. Merely opening/leaving this page must emit no motor-test command.
  const testActivatedRef = useRef(false)
  const safetyEpochRef = useRef(
    `${safetyAuthorityId ?? '-'}:${safetyEpoch}`,
  )
  const safetyConfirmationKeyRef = useRef<string | null>(null)

  const outputChannels = useMemo<FrameOutputChannel[]>(() => {
    const channels = frameView?.outputChannels ?? []
    if (channels.length > 0 || params.size > 0) return channels
    // No parameters yet: show placeholder rows so the table shape is visible.
    return Array.from({ length: 8 }, (_, index) => ({
      label: vehicleIdentity?.family === 'px4'
        ? `MAIN${index + 1}`
        : vehicleIdentity?.family === 'ardupilot' ? `SERVO${index + 1}` : `OUT${index + 1}`,
      paramId: vehicleIdentity?.family === 'px4'
        ? `PWM_MAIN_FUNC${index + 1}`
        : vehicleIdentity?.family === 'ardupilot'
          ? `SERVO${index + 1}_FUNCTION`
          : `OUTPUT_${index + 1}_FUNCTION`,
      functionValue: 0,
      motorInstance: null,
      port: 0,
      channel: index + 1,
    }))
  }, [frameView, params, vehicleIdentity?.family])

  const outputByMotor = useMemo(() => {
    const mapping = new Map<number, string>()
    for (const output of frameView?.outputChannels ?? []) {
      if (output.motorInstance !== null) mapping.set(output.motorInstance, output.label)
    }
    return mapping
  }, [frameView])

  const rotorLayout = useMemo(() => {
    if (motorCount === null) return { rotors: [] as RotorGeometry[], fromParameters: false }
    const parameterGeometry = Array.from({ length: motorCount }, (_, index) => ({
      px: params.get(`CA_ROTOR${index}_PX`)?.value,
      py: params.get(`CA_ROTOR${index}_PY`)?.value,
      km: params.get(`CA_ROTOR${index}_KM`)?.value,
    }))
    // Never mix a partially published CA_ROTOR* set with inferred positions.
    // A hybrid set produces a physically misleading frame drawing.
    const fromParameters = hasCompleteRotorGeometry(parameterGeometry)
    const rotors = Array.from({ length: motorCount }, (_, index) => {
      const fallback = getFallbackRotor(index, motorCount)
      const { px, py, km } = parameterGeometry[index]
      return {
        index,
        px: fromParameters ? px! : fallback.px,
        py: fromParameters ? py! : fallback.py,
        ccw: Number.isFinite(km) && km !== 0 ? km! > 0 : fallback.ccw,
        output: outputByMotor.get(index + 1),
      }
    })
    return { rotors, fromParameters }
  }, [motorCount, outputByMotor, params])
  const rotors = rotorLayout.rotors

  useEffect(() => {
    const nextCount = motorCount ?? 0
    const previousCount = motorCountRef.current
    if (
      testActivatedRef.current
      && previousCount > 0
      && previousCount !== nextCount
    ) {
      send({
        type: 'motor_test_batch',
        data: {
          instances: Array.from({ length: previousCount }, (_, index) => index + 1),
          throttle: 0,
          duration: 0,
        },
      })
      testActivatedRef.current = false
      setSafetyConfirmed(false)
    }
    motorCountRef.current = nextCount
    setLevels((current) => Array.from({ length: motorCount ?? 0 }, (_, index) => current[index] || 0))
  }, [motorCount, send])

  useEffect(() => {
    const epoch = `${safetyAuthorityId ?? '-'}:${safetyEpoch}`
    if (epoch === safetyEpochRef.current) return
    safetyEpochRef.current = epoch

    // Target/readiness changes and every ESC raw-session boundary invalidate
    // the physical props-removed confirmation. Never carry that acknowledgement
    // into a resumed MAVLink session, even when the motor count is unchanged.
    testActivatedRef.current = false
    safetyConfirmationKeyRef.current = null
    setSafetyConfirmed(false)
    setLevels(Array.from({ length: motorCountRef.current }, () => 0))
  }, [safetyAuthorityId, safetyEpoch])

  useEffect(() => () => {
    // Stop frames are sent only after motor testing was actually activated;
    // page navigation alone must not touch the motors (safety requirement,
    // and ArduPilot rejected stray PX4 stop commands with UNSUPPORTED).
    if (!testActivatedRef.current) return
    const instances = Array.from({ length: motorCountRef.current }, (_, index) => index + 1)
    if (instances.length > 0) {
      send({ type: 'motor_test_batch', data: { instances, throttle: 0, duration: 0 } })
    }
  }, [send])

  const sendMotorLevel = (index: number, level: number) => {
    const connection = useConnectionStore.getState()
    const liveSafetyKey = `${connection.safetyAuthorityId ?? '-'}:${connection.safetyEpoch}`
    const liveMotorTestSupported = vehicleCapabilities(
      useTelemetryStore.getState().vehicleIdentity,
    ).motorTest !== 'none'
    if (
      !connection.vehicleReady
      || !connection.canControl
      || !safetyConfirmed
      || !liveMotorTestSupported
      || connection.targetSystemId === null
      || connection.targetComponentId === null
      || motorCount === null
      || index < 0
      || index >= motorCount
      || (level > 0 && (
        connection.safetyAuthorityId === null
        || connection.safetyEpoch !== safetyEpoch
        || connection.safetyAuthorityId !== safetyAuthorityId
        || safetyConfirmationKeyRef.current !== liveSafetyKey
      ))
    ) return
    const throttle = Math.max(0, Math.min(100, level))
    if (throttle > 0) testActivatedRef.current = true
    setLevels((current) => current.map((value, motorIndex) => motorIndex === index ? throttle : value))
    send({
      type: 'motor_test',
      data: {
        instance: index + 1,
        throttle,
        duration: throttle > 0 ? 2 : 0,
        ...(throttle > 0 ? { propsRemoved: true } : {}),
      },
      ...(throttle > 0 ? {
        expectedSafetyEpoch: connection.safetyEpoch,
        expectedSafetyAuthorityId: connection.safetyAuthorityId!,
      } : {}),
    })
  }

  const sendAllLevel = (level: number) => {
    const connection = useConnectionStore.getState()
    const liveSafetyKey = `${connection.safetyAuthorityId ?? '-'}:${connection.safetyEpoch}`
    const liveMotorTestSupported = vehicleCapabilities(
      useTelemetryStore.getState().vehicleIdentity,
    ).motorTest !== 'none'
    if (
      !connection.vehicleReady
      || !connection.canControl
      || !safetyConfirmed
      || !liveMotorTestSupported
      || connection.targetSystemId === null
      || connection.targetComponentId === null
      || motorCount === null
    ) return
    const throttle = Math.max(0, Math.min(100, level))
    if (throttle > 0 && (
      connection.safetyAuthorityId === null
      || connection.safetyEpoch !== safetyEpoch
      || connection.safetyAuthorityId !== safetyAuthorityId
      || safetyConfirmationKeyRef.current !== liveSafetyKey
    )) return
    if (throttle > 0) testActivatedRef.current = true
    setLevels(Array.from({ length: motorCount }, () => throttle))
    send({
      type: 'motor_test_batch',
      data: {
        instances: Array.from({ length: motorCount }, (_, index) => index + 1),
        throttle,
        duration: throttle > 0 ? 2 : 0,
        ...(throttle > 0 ? { propsRemoved: true } : {}),
      },
      ...(throttle > 0 ? {
        expectedSafetyEpoch: connection.safetyEpoch,
        expectedSafetyAuthorityId: connection.safetyAuthorityId!,
      } : {}),
    })
  }

  const stopMotor = (index: number) => sendMotorLevel(index, 0)
  const stopAll = () => sendAllLevel(0)

  const setSafety = (checked: boolean) => {
    if (checked) {
      const connection = useConnectionStore.getState()
      if (
        !connection.vehicleReady
        || !connection.canControl
        || connection.safetyAuthorityId === null
        || connection.safetyEpoch !== safetyEpoch
        || connection.safetyAuthorityId !== safetyAuthorityId
      ) return
      safetyConfirmationKeyRef.current = `${connection.safetyAuthorityId}:${connection.safetyEpoch}`
    }
    if (!checked) safetyConfirmationKeyRef.current = null
    if (checked) testActivatedRef.current = true
    if (!checked && safetyConfirmed) stopAll()
    setSafetyConfirmed(checked)
  }

  const updateOutputFunction = (paramId: string, value: number) => {
    const param = params.get(paramId)
    if (!param || !actuatorWritesSupported) return
    send({
      type: 'param_set',
      data: { id: paramId, value, paramType: param.type },
    })
  }

  const commonLevel = levels.length > 0 && levels.every((level) => level === levels[0]) ? levels[0] : 0

  const changePanel = (panel: string) => {
    if (panel !== 'mapping' && panel !== 'test') return
    if (!panel) setQueryPanel(panel)
  }

  // URL history navigation can also leave the test panel. Apply the same
  // physical stop/confirmation reset as an explicit tab click.
  useEffect(() => {
    if (activePanel !== 'mapping' || !safetyConfirmed) return
    stopAll()
    setSafetyConfirmed(false)
  }, [activePanel, safetyConfirmed])

  return (
    <div className={embedded ? 'mc-fade-in mc-motor-page' : 'mc-workspace mc-fade-in mc-motor-page'}>
      {!panel && <PageTabs
        tabs={[{ id: 'mapping', label: t('motor.tabMapping') }, { id: 'test', label: t('motor.tabTest') }]}
        active={activePanel}
        onChange={changePanel}
        ariaLabel={t('motor.title')}
        idBase="motor-settings"
      />}

      {vehicleIdentity && !motorTestSupported && (
        <div className="mc-capability-note" data-state="waiting">
          <Icon name="warning" size={15} />
          <span>{t('motor.capabilityNote', { family: vehicleIdentity.family, vehicleClass: vehicleIdentity.vehicleClass })}</span>
        </div>
      )}

      <TabPanel idBase="motor-settings" tabId={activePanel}>
      <section className="mc-motor-workspace">
        {activePanel === 'mapping' && <div className="mc-motor-output-panel" role="region" aria-label={t('motor.tabMapping')} tabIndex={0}>
          {vehicleIdentity?.family === 'ardupilot' && (
            <ArduPilotProtocolControl
              params={params}
              canWrite={connected && actuatorWritesSupported}
            />
          )}
          <div className="mc-motor-output-head">
            <span>{t('motor.physicalOutput')}</span>
            <span>{t('motor.realtimeValue')}</span>
            <span>{t('motor.function')}</span>
            <span>{t('motor.escProtocol')}</span>
            <span>{t('motor.param')}</span>
          </div>
          <div className="mc-motor-output-rows">
            {outputChannels.length === 0 ? (
              <div className="mc-motor-output-empty">{t('motor.noOutputParams')}</div>
            ) : outputChannels.map((output) => {
              const param = params.get(output.paramId)
              const functionValue = param ? Math.round(param.value) : output.functionValue
              const functionOptions = motorCount === null
                ? []
                : motorFunctionOptions(vehicleIdentity?.family ?? 'unknown', motorCount)
              const isKnownFunction = functionValue === 0
                || functionOptions.some((option) => option.value === functionValue)
              const liveValue = motorOutputs?.port === output.port
                ? motorOutputs.outputs[output.channel - 1]
                : null
              const protocol = vehicleIdentity?.family === 'px4'
                ? getBusProtocol(params, output.paramId.split('_FUNC')[0])
                : frameView?.protocolLabel ?? t('motor.unknown')
              return (
                <div className="mc-motor-output-row" key={output.paramId}>
                  <span className="mc-motor-channel" data-assigned={output.motorInstance !== null} title={`PORT ${output.port}`}>
                    <strong>{output.label}</strong>
                  </span>
                  <span className="mc-motor-live-value" title={liveValue == null ? undefined : `${liveValue} µs`}>
                    {liveValue != null && (
                      <i
                        className="mc-motor-live-value__fill"
                        style={{ width: `${(Math.max(0, Math.min(1, (liveValue - 1000) / 1000)) * 100).toFixed(1)}%` }}
                      />
                    )}
                    <span>{liveValue == null ? '-' : liveValue}</span>
                  </span>
                  <select
                    className="mc-select"
                    value={functionValue}
                    disabled={!connected || !param || !actuatorWritesSupported || functionOptions.length === 0}
                    onChange={(event) => updateOutputFunction(output.paramId, Number(event.target.value))}
                    aria-label={t('motor.outputFunctionAria', { label: output.label })}
                  >
                    {!isKnownFunction && <option value={functionValue}>Function {functionValue}</option>}
                    {functionOptions.length === 0 && isKnownFunction && <option value={functionValue}>{t('motor.valueN', {value: functionValue})}</option>}
                    {functionOptions.map((option) => (
                      <option value={option.value} key={option.value}>{option.label}</option>
                    ))}
                  </select>
                  <OutputProtocol
                    family={vehicleIdentity?.family ?? 'unknown'}
                    label={protocol}
                    ariaLabel={t('motor.escProtocolAria', { label: output.label })}
                  />
                  <span className="mc-motor-param-name">{output.paramId}</span>
                </div>
              )
            })}
          </div>
        </div>}

        {activePanel === 'test' && <aside className="mc-motor-test-panel mc-motor-test-panel--standalone">
          {motorCount === null ? (
            <div className="mc-capability-note" data-state="waiting">
              <Icon name="warning" size={15} />
              <span>{t('motor.motorCountWaiting')}</span>
            </div>
          ) : (
            <AirframeDiagram
              rotors={rotors}
              airframeName={airframeName}
              geometrySource={vehicleIdentity?.family === 'ardupilot'
                ? t('motor.geometryArduPilot')
                : rotorLayout.fromParameters ? t('motor.geometryPx4') : t('motor.geometryFallback')}
            />
          )}

          <label className="mc-motor-safety">
            <input
              type="checkbox"
              checked={safetyConfirmed}
              disabled={!connected || !motorTestSupported || motorCount === null}
              onChange={(event) => setSafety(event.target.checked)}
            />
            <span>
              <strong>{t('motor.enableMotorTest')}</strong>
              <small><Icon name="warning" size={14} />{t('motor.removeProps')}</small>
            </span>
          </label>

          <div
            className="mc-motor-sliders"
            data-disabled={!connected || !safetyConfirmed || motorCount === null}
          >
            <MotorSlider
              label="ALL"
              level={commonLevel}
              disabled={!connected || !safetyConfirmed || motorCount === null}
              onChange={sendAllLevel}
              onStop={stopAll}
              all
            />
            {levels.map((level, index) => (
              <MotorSlider
                key={index}
                label={`M${index + 1}`}
                level={level}
                disabled={!connected || !safetyConfirmed || motorCount === null}
                onChange={(value) => sendMotorLevel(index, value)}
                onStop={() => stopMotor(index)}
              />
            ))}
          </div>
        </aside>}
      </section>
      </TabPanel>
    </div>
  )
}

function MotorSlider({
  label,
  level,
  disabled,
  onChange,
  onStop,
  all = false,
}: {
  label: string
  level: number
  disabled: boolean
  onChange: (value: number) => void
  onStop: () => void
  all?: boolean
}) {
  const { t } = useTranslation()
  return (
    <label className="mc-motor-slider" data-all={all}>
      <strong>{Math.round(level)}%</strong>
      <input
        type="range"
        min="0"
        max="100"
        value={level}
        disabled={disabled}
        aria-label={t('motor.testThrottle', {label: label})}
        onChange={(event) => onChange(Number(event.target.value))}
        onPointerUp={onStop}
        onPointerCancel={onStop}
        onKeyUp={onStop}
        onBlur={onStop}
      />
      <span>{label}</span>
    </label>
  )
}

function AirframeDiagram({ rotors, airframeName, geometrySource }: { rotors: RotorGeometry[]; airframeName: string; geometrySource: string }) {
  const { t } = useTranslation()
  const scale = Math.max(1, ...rotors.flatMap((rotor) => [Math.abs(rotor.px), Math.abs(rotor.py)]))
  const points = rotors.map((rotor) => ({
    ...rotor,
    x: 60 + rotor.py / scale * 37,
    y: 60 - rotor.px / scale * 37,
  }))

  return (
    <div className="mc-airframe-diagram">
      <svg viewBox="0 0 120 120" role="img" aria-label={t('motor.airframeAria', {count: rotors.length})}>
        <text x="60" y="5" className="mc-airframe-front">FRONT</text>
        <path d="M56.5 12 L60 7.5 L63.5 12" className="mc-airframe-front-arrow" />
        {points.map((rotor) => (
          <line key={`arm-${rotor.index}`} x1="60" y1="60" x2={rotor.x} y2={rotor.y} className="mc-airframe-arm" />
        ))}
        <rect x="53" y="53" width="14" height="14" rx="2.5" className="mc-airframe-body" />
        <path d="M56.5 53 L60 48 L63.5 53" className="mc-airframe-nose" />
        {points.map((rotor) => (
          <g
            key={rotor.index}
            className="mc-airframe-rotor"
            data-direction={rotor.ccw ? 'ccw' : 'cw'}
            transform={`translate(${rotor.x} ${rotor.y})`}
          >
            <title>{`Motor ${rotor.index + 1} · ${rotor.ccw ? 'CCW' : 'CW'}${rotor.output ? ` · ${rotor.output}` : ''}`}</title>
            <circle r="9.5" className="mc-airframe-rotor-ring" />
            <circle r="6.6" className="mc-airframe-prop" />
            <circle r="4" className="mc-airframe-hub" />
            <text y="1.5" className="mc-airframe-motor-number">{rotor.index + 1}</text>
            <text y="-12" className="mc-airframe-direction">{rotor.ccw ? '↺  CCW' : 'CW  ↻'}</text>
            <text y="13.5" className="mc-airframe-output">{rotor.output || t('motor.unassigned')}</text>
          </g>
        ))}
      </svg>
      <strong>{airframeName.toUpperCase()}</strong>
      <small>{geometrySource}</small>
    </div>
  )
}
