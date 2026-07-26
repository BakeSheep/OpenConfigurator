import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import Icon from '../components/ui/Icon'
import { EmptyState } from '../components/ui/PageFrame'
import { sendClientMessage } from '../hooks/useWebSocket'
import { useConnectionStore } from '../stores/connectionStore'
import { useParameterStore } from '../stores/parameterStore'
import { useTelemetryStore } from '../stores/telemetryStore'

interface PidDefinition {
  id: string
  label: string
  axis: '横滚' | '俯仰' | '偏航'
  min: number
  max: number
  step: number
  hint: string
}

interface PidGroup {
  id: string
  title: string
  description: string
  params: PidDefinition[]
}

const attitudeParams: PidDefinition[] = [
  { id: 'MC_ROLL_P', label: '姿态 P', axis: '横滚', min: 0, max: 12, step: 0.1, hint: '姿态误差到目标角速度的比例增益' },
  { id: 'MC_PITCH_P', label: '姿态 P', axis: '俯仰', min: 0, max: 12, step: 0.1, hint: '姿态误差到目标角速度的比例增益' },
  { id: 'MC_YAW_P', label: '姿态 P', axis: '偏航', min: 0, max: 5, step: 0.1, hint: '偏航误差到目标角速度的比例增益' },
]

const rateParams: PidDefinition[] = [
  { id: 'MC_ROLLRATE_P', label: '角速度 P', axis: '横滚', min: 0.01, max: 0.5, step: 0.01, hint: '决定误差的即时修正力度' },
  { id: 'MC_ROLLRATE_I', label: '角速度 I', axis: '横滚', min: 0, max: 1, step: 0.01, hint: '补偿持续偏差与重心偏移' },
  { id: 'MC_ROLLRATE_D', label: '角速度 D', axis: '横滚', min: 0, max: 0.01, step: 0.0005, hint: '抑制快速变化与高频振荡' },
  { id: 'MC_PITCHRATE_P', label: '角速度 P', axis: '俯仰', min: 0.01, max: 0.6, step: 0.01, hint: '决定误差的即时修正力度' },
  { id: 'MC_PITCHRATE_I', label: '角速度 I', axis: '俯仰', min: 0, max: 1, step: 0.01, hint: '补偿持续偏差与重心偏移' },
  { id: 'MC_PITCHRATE_D', label: '角速度 D', axis: '俯仰', min: 0, max: 0.01, step: 0.0005, hint: '抑制快速变化与高频振荡' },
  { id: 'MC_YAWRATE_P', label: '角速度 P', axis: '偏航', min: 0, max: 0.6, step: 0.01, hint: '决定误差的即时修正力度' },
  { id: 'MC_YAWRATE_I', label: '角速度 I', axis: '偏航', min: 0, max: 1, step: 0.01, hint: '补偿持续偏差与重心偏移' },
  { id: 'MC_YAWRATE_D', label: '角速度 D', axis: '偏航', min: 0, max: 0.01, step: 0.0005, hint: '抑制快速变化与高频振荡' },
]

const groups: PidGroup[] = [
  { id: 'attitude', title: '姿态控制器', description: '外环：把姿态误差转换为目标角速度。', params: attitudeParams },
  { id: 'rate', title: '角速度 PID', description: '内环：控制横滚、俯仰与偏航的角速度响应。', params: rateParams },
]

const knownIds = new Set(groups.flatMap((group) => group.params.map((param) => param.id)))
const pidLikePattern = /(?:RATE_[PID]$|_(?:P|I|D)$)/

function decimalPlaces(step: number) {
  const fraction = String(step).split('.')[1]
  return fraction?.length ?? 0
}

function valuesEqual(left: number, right: number, step: number) {
  return Math.abs(left - right) <= Math.max(step / 10, 1e-7)
}

export default function PidTuningPage() {
  const { params, loading, lastWriteResult } = useParameterStore()
  const connectedAndControllable = useConnectionStore((state) => state.vehicleReady && state.canControl)
  const armed = useTelemetryStore((state) => state.status?.armed ?? false)
  const [drafts, setDrafts] = useState<Record<string, number>>({})
  const [pending, setPending] = useState<{ requestId: string; id: string; value: number } | null>(null)
  const [feedback, setFeedback] = useState<{ id: string; kind: 'success' | 'error'; text: string } | null>(null)
  const timeoutRef = useRef<number | null>(null)
  const canWrite = connectedAndControllable && !armed

  useEffect(() => {
    if (!pending || !lastWriteResult || lastWriteResult.requestId !== pending.requestId) return
    if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current)
    timeoutRef.current = null
    const acceptedValue = lastWriteResult.acceptedValue ?? lastWriteResult.requestedValue
    if (lastWriteResult.accepted) {
      setDrafts((current) => ({ ...current, [pending.id]: acceptedValue }))
      setFeedback({ id: pending.id, kind: 'success', text: `已写入 ${acceptedValue}` })
    } else {
      setDrafts((current) => ({ ...current, [pending.id]: params.get(pending.id)?.value ?? pending.value }))
      setFeedback({ id: pending.id, kind: 'error', text: lastWriteResult.reason || '飞控拒绝了该参数值' })
    }
    setPending(null)
  }, [lastWriteResult, params, pending])

  useEffect(() => () => {
    if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current)
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
    const boundedValue = Math.min(definition.max, Math.max(definition.min, value))
    if (valuesEqual(boundedValue, param.value, definition.step)) {
      setDrafts((current) => ({ ...current, [definition.id]: param.value }))
      return
    }
    const requestId = `pid-${definition.id}-${Date.now().toString(36)}`
    setFeedback(null)
    setPending({ requestId, id: definition.id, value: boundedValue })
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
          setDrafts((draft) => ({ ...draft, [definition.id]: useParameterStore.getState().params.get(definition.id)?.value ?? value }))
          setFeedback({ id: definition.id, kind: 'error', text: '未收到飞控写入确认' })
          return null
        }
        return current
      })
    }, 5000)
  }

  return (
    <div className="mc-pid-page mc-fade-in">
      <section className="mc-card mc-pid-intro">
        <div>
          <span className="mc-pid-intro__eyebrow">MULTICOPTER CONTROL</span>
          <h2>PID 调参</h2>
          <p>滑动时仅预览数值，松开后才向飞控写入。页面只显示当前飞控实际返回的参数。</p>
        </div>
        <div className="mc-pid-intro__status">
          <strong>{availableGroups.reduce((count, group) => count + group.params.length, 0)}</strong>
          <span>个可调参数</span>
          <button type="button" className="mc-btn mc-btn-ghost" onClick={requestParams} disabled={!connectedAndControllable || loading}>
            <Icon name="refresh" size={14} />{loading ? '同步中' : '重新同步'}
          </button>
        </div>
      </section>

      <div className="mc-capability-note" data-state={armed ? 'error' : canWrite ? 'ready' : 'waiting'}>
        <Icon name={canWrite ? 'check' : 'warning'} size={15} />
        <span>{armed ? '飞行器已解锁，PID 写入已禁用；请先上锁并确保螺旋桨区域安全。' : canWrite ? '飞控已上锁且具备控制权，可以提交参数。调参后请进行低风险验证。' : '连接飞控并取得控制权后可修改 PID 参数。'}</span>
      </div>

      {params.size === 0 && !loading ? (
        <EmptyState icon="parameters" description="连接飞控并同步参数后，这里会显示可用的 PID 控制项。" />
      ) : availableGroups.length === 0 && !loading ? (
        <EmptyState icon="parameters" description="当前参数集中没有识别到 PX4 多旋翼 PID 参数。" />
      ) : (
        <div className="mc-pid-groups">
          {availableGroups.map((group) => (
            <section key={group.id} className="mc-card mc-pid-group">
              <header><div><h3>{group.title}</h3><p>{group.description}</p></div><span>{group.params.length} 项</span></header>
              <div className="mc-pid-list">
                {group.params.map((definition) => {
                  const liveValue = params.get(definition.id)?.value ?? definition.min
                  const value = drafts[definition.id] ?? liveValue
                  const progress = (value - definition.min) / (definition.max - definition.min) * 100
                  const isPending = pending?.id === definition.id
                  const itemFeedback = feedback?.id === definition.id ? feedback : null
                  return (
                    <div key={definition.id} className="mc-pid-row" data-pending={isPending || undefined}>
                      <div className="mc-pid-row__identity">
                        <span>{definition.axis}</span>
                        <div><strong>{definition.label}</strong><code>{definition.id}</code></div>
                      </div>
                      <div className="mc-pid-row__control">
                        <div className="mc-pid-row__value">
                          <span>{definition.min}</span>
                          <output>{isPending ? '写入中…' : value.toFixed(decimalPlaces(definition.step))}</output>
                          <span>{definition.max}</span>
                        </div>
                        <input
                          type="range"
                          min={definition.min}
                          max={definition.max}
                          step={definition.step}
                          value={value}
                          disabled={!canWrite || pending !== null}
                          aria-label={`${definition.axis} ${definition.label}`}
                          style={{ '--pid-progress': `${Math.min(100, Math.max(0, progress))}%` } as CSSProperties}
                          onChange={(event) => setDrafts((current) => ({ ...current, [definition.id]: Number(event.target.value) }))}
                          onPointerUp={(event) => commit(definition, Number(event.currentTarget.value))}
                          onKeyUp={(event) => commit(definition, Number(event.currentTarget.value))}
                        />
                        <div className="mc-pid-row__meta">
                          <span>{definition.hint}</span>
                          {itemFeedback && <b data-kind={itemFeedback.kind}>{itemFeedback.text}</b>}
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            </section>
          ))}
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
