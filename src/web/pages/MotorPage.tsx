import { useEffect, useMemo, useRef, useState } from 'react'
import Icon from '../components/ui/Icon'
import { PageTabs } from '../components/ui/PageFrame'
import { sendClientMessage } from '../hooks/useWebSocket'
import { useConnectionStore } from '../stores/connectionStore'
import { useParameterStore } from '../stores/parameterStore'
import { useTelemetryStore } from '../stores/telemetryStore'
import type { ParamData } from '../../shared/types'
import { vehicleCapabilities } from '../../shared/vehicleProfiles'
import {
  buildFrameConfigView,
  motorFunctionOptions,
  type FrameOutputChannel,
} from '../utils/vehicleConfig'

const MAX_MOTORS = 12

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

function clampMotorCount(value: number | undefined) {
  if (!Number.isFinite(value)) return 4
  return Math.min(MAX_MOTORS, Math.max(1, Math.round(value!)))
}

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
  return protocols[value] || (value > 0 ? `PWM ${value} Hz` : '飞控默认')
}

function getBusProtocol(params: Map<string, ParamData>, prefix: string) {
  const values: number[] = []
  for (let timer = 0; timer < 8; timer += 1) {
    const value = params.get(`${prefix}_TIM${timer}`)?.value
    if (Number.isFinite(value) && !values.includes(value!)) values.push(value!)
  }
  if (values.length === 0) return '飞控默认'
  if (values.length > 1) return '分组配置'
  return protocolLabel(values[0])
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

export default function MotorPage({ embedded = false }: { embedded?: boolean }) {
  const send = sendClientMessage
  const connected = useConnectionStore((state) => state.vehicleReady && state.canControl)
  const { params, loading, receivedCount, totalCount } = useParameterStore()
  const motorOutputs = useTelemetryStore((state) => state.motorOutputs)
  const vehicleIdentity = useTelemetryStore((state) => state.vehicleIdentity)
  const caps = vehicleCapabilities(vehicleIdentity)
  // Motor testing / actuator writes are capability-gated by the selected
  // vehicle profile; unsupported profiles keep the controls visible but
  // disabled with an explanation.
  const motorTestSupported = caps.motorTest !== 'none'
  const actuatorWritesSupported = caps.actuatorConfig
  const [safetyConfirmed, setSafetyConfirmed] = useState(false)
  const [activePanel, setActivePanel] = useState<'mapping' | 'test'>('mapping')
  const [levels, setLevels] = useState<number[]>([])
  // Family-specific frame/actuator read model: SERVOx_FUNCTION for ArduPilot,
  // PWM_MAIN/AUX_FUNCx + CA_ROTOR* for PX4.
  const frameView = useMemo(() => buildFrameConfigView(vehicleIdentity, params), [vehicleIdentity, params])
  const motorCount = clampMotorCount(frameView?.motorCount ?? undefined)
  const airframeName = (params.size > 0 && frameView ? frameView.name : null)
    || (motorCount === 4 ? 'Quadrotor' : `${motorCount} Motor Geometry`)
  const motorCountRef = useRef(motorCount)

  const outputChannels = useMemo<FrameOutputChannel[]>(() => {
    const channels = frameView?.outputChannels ?? []
    if (channels.length > 0 || params.size > 0) return channels
    // No parameters yet: show placeholder rows so the table shape is visible.
    return Array.from({ length: 8 }, (_, index) => ({
      label: `MAIN${index + 1}`,
      paramId: `PWM_MAIN_FUNC${index + 1}`,
      functionValue: 0,
      motorInstance: null,
      port: 0,
      channel: index + 1,
    }))
  }, [frameView, params])

  const outputByMotor = useMemo(() => {
    const mapping = new Map<number, string>()
    for (const output of frameView?.outputChannels ?? []) {
      if (output.motorInstance !== null) mapping.set(output.motorInstance, output.label)
    }
    return mapping
  }, [frameView])

  const rotors = useMemo<RotorGeometry[]>(() => {
    return Array.from({ length: motorCount }, (_, index) => {
      const fallback = getFallbackRotor(index, motorCount)
      const px = params.get(`CA_ROTOR${index}_PX`)?.value
      const py = params.get(`CA_ROTOR${index}_PY`)?.value
      const km = params.get(`CA_ROTOR${index}_KM`)?.value
      const hasPosition = Number.isFinite(px) && Number.isFinite(py)
      return {
        index,
        px: hasPosition ? px! : fallback.px,
        py: hasPosition ? py! : fallback.py,
        ccw: Number.isFinite(km) && km !== 0 ? km! > 0 : fallback.ccw,
        output: outputByMotor.get(index + 1),
      }
    })
  }, [motorCount, outputByMotor, params])

  useEffect(() => {
    motorCountRef.current = motorCount
    setLevels((current) => Array.from({ length: motorCount }, (_, index) => current[index] || 0))
  }, [motorCount])

  useEffect(() => () => {
    for (let index = 0; index < motorCountRef.current; index += 1) {
      send({ type: 'motor_test', data: { instance: index + 1, throttle: 0, duration: 0 } })
    }
  }, [send])

  const sendMotorLevel = (index: number, level: number) => {
    if (!connected || !safetyConfirmed || !motorTestSupported) return
    const throttle = Math.max(0, Math.min(100, level))
    setLevels((current) => current.map((value, motorIndex) => motorIndex === index ? throttle : value))
    send({
      type: 'motor_test',
      data: {
        instance: index + 1,
        throttle,
        duration: throttle > 0 ? 2 : 0,
        ...(throttle > 0 ? { propsRemoved: true } : {}),
      },
    })
  }

  const sendAllLevel = (level: number) => {
    if (!connected || !safetyConfirmed || !motorTestSupported) return
    const throttle = Math.max(0, Math.min(100, level))
    setLevels(Array.from({ length: motorCount }, () => throttle))
    for (let index = 0; index < motorCount; index += 1) {
      send({
        type: 'motor_test',
        data: {
          instance: index + 1,
          throttle,
          duration: throttle > 0 ? 2 : 0,
          ...(throttle > 0 ? { propsRemoved: true } : {}),
        },
      })
    }
  }

  const stopMotor = (index: number) => sendMotorLevel(index, 0)
  const stopAll = () => sendAllLevel(0)

  const setSafety = (checked: boolean) => {
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
    if (panel === 'mapping' && safetyConfirmed) {
      stopAll()
      setSafetyConfirmed(false)
    }
    setActivePanel(panel)
  }

  return (
    <div className={embedded ? 'mc-fade-in mc-motor-page' : 'mc-workspace mc-fade-in mc-motor-page'}>
      <div className="flex items-center gap-3 mb-4">
        <span className="mc-motor-param-status" data-loading={loading}>
          <i />
          {loading ? `参数读取中 ${receivedCount}/${totalCount || '…'}` : `${params.size} 个参数已同步`}
        </span>
      </div>

      <div className="mc-motor-toolbar">
        <strong>执行器输出与无桨测试</strong>
        <p>输出功能来自飞控参数；修改下拉框会直接写入对应的 <span className="mc-mono">*_FUNCx</span> 参数。</p>
      </div>

      {vehicleIdentity && !motorTestSupported && (
        <div className="mc-capability-note" data-state="waiting">
          <Icon name="warning" size={15} />
          <span>当前飞控类型（{vehicleIdentity.family}/{vehicleIdentity.vehicleClass}）尚未适配电机测试与输出写入，控件已禁用，仅供查看。</span>
        </div>
      )}

      <PageTabs tabs={[{ id: 'mapping', label: '输出映射' }, { id: 'test', label: '电机测试' }]} active={activePanel} onChange={changePanel} />

      <section className="mc-motor-workspace">
        {activePanel === 'mapping' && <div className="mc-motor-output-panel">
          <div className="mc-motor-output-head">
            <span>物理输出</span>
            <span>实时值</span>
            <span>功能</span>
            <span>电调协议</span>
            <span>参数</span>
          </div>
          <div className="mc-motor-output-rows">
            {outputChannels.length === 0 ? (
              <div className="mc-motor-output-empty">当前飞控没有提供输出功能参数（PX4：PWM_MAIN/AUX_FUNCx；ArduPilot：SERVOx_FUNCTION）。</div>
            ) : outputChannels.map((output) => {
              const param = params.get(output.paramId)
              const functionValue = param ? Math.round(param.value) : output.functionValue
              const functionOptions = motorFunctionOptions(vehicleIdentity?.family ?? 'unknown', motorCount)
              const isKnownFunction = functionValue === 0
                || functionOptions.some((option) => option.value === functionValue)
              const liveValue = motorOutputs?.port === output.port
                ? motorOutputs.outputs[output.channel - 1]
                : null
              const protocol = vehicleIdentity?.family === 'px4'
                ? getBusProtocol(params, output.paramId.split('_FUNC')[0])
                : frameView?.protocolLabel ?? '未知'
              return (
                <div className="mc-motor-output-row" key={output.paramId}>
                  <span className="mc-motor-channel" data-assigned={output.motorInstance !== null}>
                    <strong>{output.label}</strong>
                    <small>PORT {output.port}</small>
                  </span>
                  <span className="mc-motor-live-value">{liveValue == null ? '—' : liveValue}</span>
                  <select
                    className="mc-select"
                    value={functionValue}
                    disabled={!connected || !param || !actuatorWritesSupported || functionOptions.length === 0}
                    onChange={(event) => updateOutputFunction(output.paramId, Number(event.target.value))}
                    aria-label={`${output.label} 输出功能`}
                  >
                    {!isKnownFunction && <option value={functionValue}>Function {functionValue}</option>}
                    {functionOptions.length === 0 && isKnownFunction && <option value={functionValue}>值 {functionValue}</option>}
                    {functionOptions.map((option) => (
                      <option value={option.value} key={option.value}>{option.label}</option>
                    ))}
                  </select>
                  <span className="mc-motor-protocol">{protocol}</span>
                  <span className="mc-motor-param-name">{output.paramId}</span>
                </div>
              )
            })}
          </div>
        </div>}

        {activePanel === 'test' && <aside className="mc-motor-test-panel mc-motor-test-panel--standalone">
          <p className="mc-motor-test-intro">手动控制各逻辑电机，用于验证输出映射、位置与方向</p>
          <AirframeDiagram
            rotors={rotors}
            airframeName={airframeName}
            geometrySource={vehicleIdentity?.family === 'ardupilot'
              ? '布局基于 FRAME_CLASS/FRAME_TYPE 推断'
              : '位置与方向来自 CA_ROTOR* 参数'}
          />

          <label className="mc-motor-safety">
            <input
              type="checkbox"
              checked={safetyConfirmed}
              disabled={!connected || !motorTestSupported}
              onChange={(event) => setSafety(event.target.checked)}
            />
            <span>
              <strong>启用电机测试</strong>
              <small><Icon name="warning" size={14} />请先拆除所有螺旋桨</small>
            </span>
          </label>

          <div className="mc-motor-sliders" data-disabled={!connected || !safetyConfirmed}>
            <MotorSlider
              label="ALL"
              level={commonLevel}
              disabled={!connected || !safetyConfirmed}
              onChange={sendAllLevel}
              onStop={stopAll}
              all
            />
            {levels.map((level, index) => (
              <MotorSlider
                key={index}
                label={`M${index + 1}`}
                level={level}
                disabled={!connected || !safetyConfirmed}
                onChange={(value) => sendMotorLevel(index, value)}
                onStop={() => stopMotor(index)}
              />
            ))}
          </div>
        </aside>}
      </section>
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
  return (
    <label className="mc-motor-slider" data-all={all}>
      <strong>{Math.round(level)}%</strong>
      <input
        type="range"
        min="0"
        max="100"
        value={level}
        disabled={disabled}
        aria-label={`${label} 测试油门`}
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
  const scale = Math.max(1, ...rotors.flatMap((rotor) => [Math.abs(rotor.px), Math.abs(rotor.py)]))
  const points = rotors.map((rotor) => ({
    ...rotor,
    x: 50 + rotor.py / scale * 33,
    y: 50 - rotor.px / scale * 33,
  }))

  return (
    <div className="mc-airframe-diagram">
      <svg viewBox="0 0 100 100" role="img" aria-label={`${rotors.length} 电机机架布局`}>
        <text x="50" y="7" className="mc-airframe-front">FRONT</text>
        <path d="M47 12 L50 8 L53 12" className="mc-airframe-front-arrow" />
        {points.map((rotor) => (
          <line key={`arm-${rotor.index}`} x1="50" y1="50" x2={rotor.x} y2={rotor.y} className="mc-airframe-arm" />
        ))}
        <rect x="44" y="44" width="12" height="12" rx="2" className="mc-airframe-body" />
        <path d="M47 44 L50 40 L53 44" className="mc-airframe-nose" />
        {points.map((rotor) => (
          <g
            key={rotor.index}
            className="mc-airframe-rotor"
            data-direction={rotor.ccw ? 'ccw' : 'cw'}
            transform={`translate(${rotor.x} ${rotor.y})`}
          >
            <title>{`Motor ${rotor.index + 1} · ${rotor.ccw ? 'CCW' : 'CW'}${rotor.output ? ` · ${rotor.output}` : ''}`}</title>
            <circle r="10.5" className="mc-airframe-rotor-ring" />
            <circle r="7.2" className="mc-airframe-prop" />
            <circle r="4.2" className="mc-airframe-hub" />
            <text y="1.6" className="mc-airframe-motor-number">{rotor.index + 1}</text>
            <text y="-13" className="mc-airframe-direction">{rotor.ccw ? '↺ CCW' : 'CW ↻'}</text>
            <text y="15.5" className="mc-airframe-output">{rotor.output || '未分配'}</text>
          </g>
        ))}
      </svg>
      <strong>{airframeName.toUpperCase()}</strong>
      <small>{geometrySource}</small>
    </div>
  )
}
