import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { vehicleCapabilities } from '../../shared/vehicleProfiles'
import Icon from '../components/ui/Icon'
import { EmptyState } from '../components/ui/PageFrame'
import { sendClientMessage } from '../hooks/useWebSocket'
import { useConnectionStore } from '../stores/connectionStore'
import { useParameterStore } from '../stores/parameterStore'
import { useTelemetryStore } from '../stores/telemetryStore'

interface PidDefinition {
  id: string
  label: string
  min: number
  max: number
  step: number
  unit?: string
  hint: string
}

interface PidGroup {
  id: string
  title: string
  params: PidDefinition[]
}

// PX4 multicopter rate-loop definition shared by the three axes.
const rateAxis = (axis: 'ROLL' | 'PITCH' | 'YAW'): PidDefinition[] => {
  const prefix = `MC_${axis}RATE`
  const intLim = axis === 'ROLL' ? 'MC_RR_INT_LIM' : axis === 'PITCH' ? 'MC_PR_INT_LIM' : 'MC_YR_INT_LIM'
  return [
    { id: `${prefix}_K`, label: 'K', min: 0, max: 5, step: 0.05, hint: '整体增益系数，同时缩放 P/I/D' },
    { id: `${prefix}_P`, label: 'P', min: 0, max: 0.6, step: 0.01, hint: '角速度误差的即时修正力度' },
    { id: `${prefix}_I`, label: 'I', min: 0, max: 1, step: 0.01, hint: '补偿持续偏差与重心偏移' },
    { id: `${prefix}_D`, label: 'D', min: 0, max: 0.03, step: 0.0005, hint: '抑制快速变化与高频振荡' },
    { id: `${prefix}_FF`, label: 'FF', min: 0, max: 2, step: 0.01, hint: '前馈：直接叠加目标角速度' },
    { id: intLim, label: 'I Limit', min: 0, max: 1, step: 0.05, hint: '积分限幅，防止积分饱和' },
    { id: `${prefix}_MAX`, label: 'Max Rate', min: 0, max: 1800, step: 5, unit: '°/s', hint: '该轴允许的最大角速度' },
  ]
}

const groups: PidGroup[] = [
  { id: 'roll-rate', title: '横滚角速率', params: rateAxis('ROLL') },
  { id: 'pitch-rate', title: '俯仰角速率', params: rateAxis('PITCH') },
  { id: 'yaw-rate', title: '偏航角速率', params: rateAxis('YAW') },
  {
    id: 'attitude',
    title: '姿态',
    params: [
      { id: 'MC_ROLL_P', label: '横滚控制力度', min: 0, max: 12, step: 0.1, hint: '姿态外环：横滚角误差 → 目标角速度' },
      { id: 'MC_PITCH_P', label: '俯仰控制力度', min: 0, max: 12, step: 0.1, hint: '姿态外环：俯仰角误差 → 目标角速度' },
      { id: 'MC_YAW_P', label: '偏航控制力度', min: 0, max: 5, step: 0.1, hint: '姿态外环：偏航角误差 → 目标角速度' },
      { id: 'MC_YAW_WEIGHT', label: 'Yaw Weight', min: 0, max: 1, step: 0.05, hint: '偏航相对横滚/俯仰的控制优先级' },
    ],
  },
  {
    id: 'position',
    title: '位置',
    params: [
      { id: 'MPC_XY_P', label: 'XY P', min: 0, max: 2, step: 0.05, hint: '水平位置误差 → 目标速度' },
      { id: 'MPC_XY_VEL_P_ACC', label: 'XY Vel P', min: 0, max: 5, step: 0.05, hint: '水平速度环比例增益' },
      { id: 'MPC_XY_VEL_I_ACC', label: 'XY Vel I', min: 0, max: 5, step: 0.05, hint: '水平速度环积分增益（抗风）' },
      { id: 'MPC_XY_VEL_D_ACC', label: 'XY Vel D', min: 0, max: 2, step: 0.05, hint: '水平速度环微分增益' },
      { id: 'MPC_XY_CRUISE', label: 'Cruise Speed', min: 0, max: 20, step: 0.5, unit: 'm/s', hint: '任务模式默认巡航速度' },
      { id: 'MPC_XY_VEL_MAX', label: 'Max XY Speed', min: 0, max: 20, step: 0.5, unit: 'm/s', hint: '允许的最大水平速度' },
      { id: 'MPC_ACC_HOR', label: 'Acceleration', min: 0, max: 15, step: 0.5, unit: 'm/s²', hint: '定点模式水平加速度' },
      { id: 'MPC_ACC_HOR_MAX', label: 'Max Acceleration', min: 0, max: 15, step: 0.5, unit: 'm/s²', hint: '最大水平加速度' },
    ],
  },
  {
    id: 'altitude',
    title: '高度',
    params: [
      { id: 'MPC_Z_P', label: 'Z P', min: 0, max: 1.5, step: 0.05, hint: '高度误差 → 目标爬升率' },
      { id: 'MPC_Z_VEL_P_ACC', label: 'Z Vel P', min: 0, max: 15, step: 0.1, hint: '垂直速度环比例增益' },
      { id: 'MPC_Z_VEL_I_ACC', label: 'Z Vel I', min: 0, max: 3, step: 0.05, hint: '垂直速度环积分增益' },
      { id: 'MPC_Z_VEL_D_ACC', label: 'Z Vel D', min: 0, max: 2, step: 0.05, hint: '垂直速度环微分增益' },
      { id: 'MPC_THR_HOVER', label: 'Hover Throttle', min: 0, max: 0.8, step: 0.01, hint: '悬停油门估计值' },
      { id: 'MPC_THR_MIN', label: 'Min Throttle', min: 0, max: 1, step: 0.01, hint: '最小油门限制' },
      { id: 'MPC_THR_MAX', label: 'Max Throttle', min: 0, max: 1, step: 0.01, hint: '最大油门限制' },
    ],
  },
  {
    id: 'mission',
    title: '航点导航',
    params: [
      { id: 'MPC_Z_VEL_MAX_UP', label: 'Climb Speed', min: 0, max: 8, step: 0.1, unit: 'm/s', hint: '最大爬升速度' },
      { id: 'MPC_Z_VEL_MAX_DN', label: 'Descent Speed', min: 0, max: 4, step: 0.1, unit: 'm/s', hint: '最大下降速度' },
      { id: 'MPC_ACC_UP_MAX', label: 'Climb Accel', min: 0, max: 15, step: 0.5, unit: 'm/s²', hint: '最大向上加速度' },
      { id: 'MPC_ACC_DOWN_MAX', label: 'Descent Accel', min: 0, max: 15, step: 0.5, unit: 'm/s²', hint: '最大向下加速度' },
      { id: 'MPC_TKO_SPEED', label: 'Takeoff Speed', min: 0, max: 5, step: 0.1, unit: 'm/s', hint: '起飞爬升速度' },
      { id: 'MPC_LAND_SPEED', label: 'Land Speed', min: 0, max: 3, step: 0.1, unit: 'm/s', hint: '着陆下降速度' },
      { id: 'MPC_MAN_TILT_MAX', label: 'Manual Tilt', min: 0, max: 90, step: 1, unit: '°', hint: '手动模式最大倾角' },
      { id: 'MPC_MAN_Y_MAX', label: 'Manual Yaw Rate', min: 0, max: 400, step: 5, unit: '°/s', hint: '手动模式最大偏航角速度' },
    ],
  },
  {
    id: 'filters',
    title: '滤波器',
    params: [
      { id: 'IMU_GYRO_CUTOFF', label: '陀螺仪低通滤波', min: 0, max: 1000, step: 5, unit: 'Hz', hint: '陀螺仪数据低通截止频率' },
      { id: 'IMU_DGYRO_CUTOFF', label: 'D Gyro Filter', min: 0, max: 1000, step: 5, unit: 'Hz', hint: 'D 项角加速度低通截止频率' },
      { id: 'IMU_ACCEL_CUTOFF', label: '加速度低通滤波', min: 0, max: 1000, step: 5, unit: 'Hz', hint: '加速度计数据低通截止频率' },
    ],
  },
]

const knownIds = new Set(groups.flatMap((group) => group.params.map((param) => param.id)))
const groupOfParam = new Map(groups.flatMap((group) => group.params.map((param) => [param.id, group.id] as const)))
const pidLikePattern = /(?:RATE_[PID]$|_(?:P|I|D)$)/

function decimalPlaces(step: number) {
  const fraction = String(step).split('.')[1]
  return fraction?.length ?? 0
}

function roundToStep(value: number, step: number) {
  return Number(value.toFixed(Math.max(decimalPlaces(step), 4)))
}

// MAVLink params travel as float32 (~7 significant digits), so the FC echoes
// 0.35 back as 0.3499999940395355. Strip that noise before displaying or
// stepping, otherwise +/- produces micro-increments off the ugly raw value.
function sanitizeFloat(value: number) {
  return Number.parseFloat(value.toPrecision(7))
}

function formatValue(value: number, step: number) {
  return String(roundToStep(sanitizeFloat(value), step))
}

function valuesEqual(left: number, right: number, step: number) {
  return Math.abs(left - right) <= Math.max(step / 10, 1e-7)
}

// Toggle the scroll-fade hints of a card viewport straight on the DOM: this
// fires on every scroll frame and must not re-render the page.
function updateFades(element: HTMLDivElement | null) {
  if (!element?.parentElement) return
  const viewport = element.parentElement
  viewport.dataset.fadeTop = element.scrollTop > 2 ? 'true' : 'false'
  viewport.dataset.fadeBottom = element.scrollTop + element.clientHeight < element.scrollHeight - 2 ? 'true' : 'false'
}

export default function PidTuningPage() {
  const { params, loading, lastWriteResult } = useParameterStore()
  const connectedAndControllable = useConnectionStore((state) => state.vehicleReady && state.canControl)
  const armed = useTelemetryStore((state) => state.status?.armed ?? false)
  const vehicleIdentity = useTelemetryStore((state) => state.vehicleIdentity)
  const pidWritable = vehicleCapabilities(vehicleIdentity).pidConfig
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [pending, setPending] = useState<{ requestId: string; id: string; value: number } | null>(null)
  const [feedback, setFeedback] = useState<{ id: string; kind: 'success' | 'error' } | null>(null)
  const timeoutRef = useRef<number | null>(null)
  const feedbackTimerRef = useRef<number | null>(null)
  // PID writes are capability-gated: an unadapted profile keeps the page
  // read-only instead of writing PX4 gains to a different stack.
  const canWrite = connectedAndControllable && !armed && pidWritable

  // Card-corner result badge: success/error only, auto-dismissed shortly after.
  const flashFeedback = (id: string, kind: 'success' | 'error') => {
    if (feedbackTimerRef.current !== null) window.clearTimeout(feedbackTimerRef.current)
    setFeedback({ id, kind })
    feedbackTimerRef.current = window.setTimeout(() => setFeedback(null), 3500)
  }

  useEffect(() => {
    if (!pending || !lastWriteResult || lastWriteResult.requestId !== pending.requestId) return
    if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current)
    timeoutRef.current = null
    flashFeedback(pending.id, lastWriteResult.accepted ? 'success' : 'error')
    setDrafts((current) => {
      const next = { ...current }
      delete next[pending.id]
      return next
    })
    setPending(null)
  }, [lastWriteResult, pending])

  useEffect(() => () => {
    if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current)
    if (feedbackTimerRef.current !== null) window.clearTimeout(feedbackTimerRef.current)
  }, [])

  const availableGroups = useMemo(() => groups.map((group) => ({
    ...group,
    params: group.params.filter((definition) => params.has(definition.id)),
  })).filter((group) => group.params.length > 0), [params])

  const otherPidParams = useMemo(() => Array.from(params.values())
    .filter((param) => !knownIds.has(param.id) && pidLikePattern.test(param.id))
    .sort((a, b) => a.id.localeCompare(b.id)), [params])

  const requestParams = () => {
    if (!connectedAndControllable || loading) return
    useParameterStore.getState().clear()
    useParameterStore.getState().setLoading(true)
    sendClientMessage({ type: 'param_request_list' })
  }

  const commit = (definition: PidDefinition, value: number) => {
    const param = params.get(definition.id)
    if (!param || !canWrite || pending) return
    if (!Number.isFinite(value)) {
      setDrafts((current) => {
        const next = { ...current }
        delete next[definition.id]
        return next
      })
      return
    }
    const boundedValue = roundToStep(Math.min(definition.max, Math.max(definition.min, value)), definition.step)
    if (valuesEqual(boundedValue, param.value, definition.step)) {
      setDrafts((current) => {
        const next = { ...current }
        delete next[definition.id]
        return next
      })
      return
    }
    const requestId = `pid-${definition.id}-${Date.now().toString(36)}`
    setFeedback(null)
    setPending({ requestId, id: definition.id, value: boundedValue })
    setDrafts((current) => ({ ...current, [definition.id]: formatValue(boundedValue, definition.step) }))
    useParameterStore.getState().setWriteResult(null)
    sendClientMessage({
      type: 'param_set',
      requestId,
      data: { id: definition.id, value: boundedValue, paramType: param.type },
    })
    if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current)
    timeoutRef.current = window.setTimeout(() => {
      setPending((current) => {
        if (current?.requestId === requestId) {
          setDrafts((draft) => {
            const next = { ...draft }
            delete next[definition.id]
            return next
          })
          flashFeedback(definition.id, 'error')
          return null
        }
        return current
      })
    }, 5000)
  }

  const nudge = (definition: PidDefinition, direction: 1 | -1) => {
    const param = params.get(definition.id)
    if (!param) return
    const draft = drafts[definition.id]
    const base = draft !== undefined && Number.isFinite(Number(draft)) ? Number(draft) : sanitizeFloat(param.value)
    commit(definition, roundToStep(base + direction * definition.step, definition.step))
  }

  const totalCount = availableGroups.reduce((count, group) => count + group.params.length, 0)

  return (
    <div className="mc-pid-page mc-fade-in">
      <section className="mc-card mc-pid-intro">
        <div>
          <span className="mc-pid-intro__eyebrow">MULTICOPTER CONTROL</span>
          <h2>
            <i
              className="mc-pid-write-dot"
              data-ok={canWrite || undefined}
              title={armed ? '飞行器已解锁，参数写入已禁用' : canWrite ? '飞控已上锁且具备控制权，可以提交参数' : '连接飞控并取得控制权后可修改参数'}
            />
            扩展调参
          </h2>
          <p>点击 − / + 或拖动滑条微调，也可直接输入数值后回车写入飞控。页面只显示当前飞控实际返回的参数。</p>
        </div>
        <div className="mc-pid-intro__status">
          <strong>{totalCount}</strong>
          <span>个可调参数</span>
          <button type="button" className="mc-btn mc-btn-ghost" onClick={requestParams} disabled={!connectedAndControllable || loading}>
            <Icon name="refresh" size={14} />{loading ? '同步中' : '重新同步'}
          </button>
        </div>
      </section>

      {params.size === 0 && !loading ? (
        <EmptyState icon="parameters" description="连接飞控并同步参数后，这里会显示可用的控制参数。" />
      ) : availableGroups.length === 0 && !loading ? (
        <EmptyState icon="parameters" description="当前参数集中没有识别到 PX4 多旋翼控制参数。" />
      ) : (
        <div className="mc-pid-grid">
          {availableGroups.map((group) => {
            const groupFeedback = feedback && groupOfParam.get(feedback.id) === group.id ? feedback : null
            return (
              <section key={group.id} className="mc-card mc-pid-group">
                <header>
                  <h3>{group.title}</h3>
                  {groupFeedback && (
                    <i
                      className="mc-pid-group__result"
                      data-kind={groupFeedback.kind}
                      title={groupFeedback.kind === 'success' ? '写入成功' : '写入失败'}
                    >
                      <Icon name={groupFeedback.kind === 'success' ? 'check' : 'warning'} size={11} strokeWidth={2.4} />
                    </i>
                  )}
                  <span className="mc-mono">{group.params.length}</span>
                </header>
                <div className="mc-pid-viewport" data-fade-top="false" data-fade-bottom="false">
                  <div className="mc-pid-scroll" ref={updateFades} onScroll={(event) => updateFades(event.currentTarget)}>
                    {group.params.map((definition) => {
                      const param = params.get(definition.id)!
                      const draft = drafts[definition.id]
                      const displayValue = draft ?? formatValue(param.value, definition.step)
                      const numericDraft = Number(displayValue)
                      const sliderValue = Number.isFinite(numericDraft) ? numericDraft : sanitizeFloat(param.value)
                      const progress = Math.min(100, Math.max(0, (sliderValue - definition.min) / (definition.max - definition.min) * 100))
                      const isPending = pending?.id === definition.id
                      const isDirty = draft !== undefined && !isPending
                      return (
                        <div key={definition.id} className="mc-pid-item" data-pending={isPending || undefined}>
                          <div className="mc-pid-item__top">
                            <label htmlFor={`pid-${definition.id}`} title={`${definition.id} — ${definition.hint}`}>
                              {definition.label}
                              {definition.unit && <small>{definition.unit}</small>}
                            </label>
                            <div className="mc-pid-stepper" data-dirty={isDirty || undefined}>
                              <button
                                type="button"
                                aria-label={`减小 ${definition.label}`}
                                disabled={!canWrite || pending !== null}
                                onClick={() => nudge(definition, -1)}
                              >−</button>
                              <input
                                id={`pid-${definition.id}`}
                                type="text"
                                inputMode="decimal"
                                className="mc-mono"
                                value={displayValue}
                                disabled={!canWrite || (pending !== null && !isPending)}
                                onChange={(event) => setDrafts((current) => ({ ...current, [definition.id]: event.target.value }))}
                                onBlur={(event) => { if (!isPending) commit(definition, Number(event.target.value)) }}
                                onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }}
                              />
                              <button
                                type="button"
                                aria-label={`增大 ${definition.label}`}
                                disabled={!canWrite || pending !== null}
                                onClick={() => nudge(definition, 1)}
                              >+</button>
                            </div>
                          </div>
                          <input
                            type="range"
                            className="mc-pid-item__slider"
                            min={definition.min}
                            max={definition.max}
                            step={definition.step}
                            value={sliderValue}
                            disabled={!canWrite || pending !== null}
                            aria-label={`${group.title} ${definition.label} 滑动微调`}
                            style={{ '--pid-progress': `${progress}%` } as CSSProperties}
                            onChange={(event) => setDrafts((current) => ({ ...current, [definition.id]: event.target.value }))}
                            onPointerUp={(event) => commit(definition, Number(event.currentTarget.value))}
                            onKeyUp={(event) => commit(definition, Number(event.currentTarget.value))}
                          />
                        </div>
                      )
                    })}
                  </div>
                </div>
              </section>
            )
          })}
        </div>
      )}

      {otherPidParams.length > 0 && (
        <details className="mc-card mc-pid-other">
          <summary>检测到另外 {otherPidParams.length} 个控制相关参数 <span>在“完整参数”中精确编辑</span></summary>
          <div>{otherPidParams.map((param) => <span key={param.id}><code>{param.id}</code><b>{param.value}</b></span>)}</div>
        </details>
      )}
    </div>
  )
}
