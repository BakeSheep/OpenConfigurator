import { useEffect, useMemo, useRef, useState } from 'react'
import Icon from '../components/ui/Icon'
import { EmptyState } from '../components/ui/PageFrame'
import { sendClientMessage } from '../hooks/useWebSocket'
import { useParameterStore } from '../stores/parameterStore'
import { useConnectionStore } from '../stores/connectionStore'
import { useTelemetryStore } from '../stores/telemetryStore'
import { vehicleCapabilities } from '../../shared/vehicleProfiles'
import { parameterEnumLabel, parameterEnumOptions, parameterEnumValuesMatch } from '../utils/parameterEnumMetadata'
import { parameterGroupKey, parameterMetadata, parameterSearchText } from '../utils/parameterMetadata'

// PX4 circuit-breaker parameters disable safety protections outright; writing
// them by accident must require an explicit confirmation.
const DANGEROUS_PARAM_PREFIXES = ['CBRK_']

const INTEGER_PARAM_RANGES: Record<number, readonly [number, number]> = {
  1: [0, 0xff],
  2: [-0x80, 0x7f],
  3: [0, 0xffff],
  4: [-0x8000, 0x7fff],
  5: [0, 0xffffffff],
  6: [-0x80000000, 0x7fffffff],
  // JS numbers cannot exactly represent the full 64-bit integer domain. Keep
  // writes inside the exact range instead of silently rounding an unsafe value.
  7: [0, Number.MAX_SAFE_INTEGER],
  8: [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
}

function validateParamValue(value: number, type: number): string | null {
  if (!Number.isFinite(value)) return '参数值必须是有限数值'
  if (type === 9) return Number.isFinite(Math.fround(value)) ? null : '参数值超出 REAL32 范围'
  if (type === 10) return null
  const range = INTEGER_PARAM_RANGES[type]
  if (!range) return `不支持 MAV_PARAM_TYPE ${type}`
  if (!Number.isInteger(value) || value < range[0] || value > range[1]) {
    return `参数值必须位于 ${range[0]}–${range[1]} 范围内`
  }
  return null
}
export default function ParameterPage({ embedded = false }: { embedded?: boolean }) {
  const { params, loading, totalCount, receivedCount } = useParameterStore()
  const send = sendClientMessage
  const canAccess = useConnectionStore((state) => state.vehicleReady && state.canControl)
  const vehicleIdentity = useTelemetryStore((state) => state.vehicleIdentity)
  const profileWritable = vehicleCapabilities(vehicleIdentity).writeOperations
  const canWrite = canAccess && profileWritable
  const [search, setSearch] = useState('')
  const [editId, setEditId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [editRaw, setEditRaw] = useState(false)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [visibleCounts, setVisibleCounts] = useState<Record<string, number>>({})
  const [pendingWrite, setPendingWrite] = useState<{ id: string; value: number } | null>(null)
  const [writeError, setWriteError] = useState<string | null>(null)
  const writeTimer = useRef<number | null>(null)

  useEffect(() => {
    if (!pendingWrite) return
    const echoedValue = params.get(pendingWrite.id)?.value
    if (echoedValue === undefined || Math.abs(echoedValue - pendingWrite.value) > 1e-6) return
    if (writeTimer.current !== null) window.clearTimeout(writeTimer.current)
    writeTimer.current = null
    setPendingWrite(null)
  }, [params, pendingWrite])

  useEffect(() => () => {
    if (writeTimer.current !== null) window.clearTimeout(writeTimer.current)
  }, [])

  const requestParams = () => {
    if (!canAccess) return
    useParameterStore.getState().clear()
    useParameterStore.getState().setLoading(true)
    send({ type: 'param_request_list' })
  }

  const filteredParams = useMemo(() => {
    const values = Array.from(params.values())
    if (!search) return values
    const query = search.toUpperCase()
    return values.filter((param) => parameterSearchText(param.id, vehicleIdentity).includes(query))
  }, [params, search, vehicleIdentity])

  const groups = useMemo(() => {
    const result: Record<string, typeof filteredParams> = {}
    for (const param of filteredParams) {
      const prefix = parameterGroupKey(param.id)
      if (!result[prefix]) result[prefix] = []
      result[prefix].push(param)
    }
    return result
  }, [filteredParams])

  const saveParam = (id: string) => {
    if (!canWrite) return
    const param = params.get(id)
    if (!param) return
    const rawValue = editValue.trim()
    const parsedValue = rawValue === '' ? Number.NaN : Number(rawValue)
    if (!Number.isFinite(parsedValue)) {
      setWriteError(`${id} 不是有效数值`)
      return
    }
    const value = parsedValue
    const rangeError = validateParamValue(value, param.type)
    if (rangeError) {
      setWriteError(`${id}：${rangeError}`)
      return
    }
    if (
      DANGEROUS_PARAM_PREFIXES.some((prefix) => id.startsWith(prefix))
      && !window.confirm(
        `${id} 是安全熔断（circuit breaker）参数，错误的值会直接禁用关键安全保护。\n确认写入 ${value} 吗？`,
      )
    ) return
    setWriteError(null)
    setPendingWrite({ id, value })
    send({ type: 'param_set', requestId: `param-${id}-${Date.now().toString(36)}`, data: { id, value, paramType: param.type } })
    if (writeTimer.current !== null) window.clearTimeout(writeTimer.current)
    writeTimer.current = window.setTimeout(() => {
      setPendingWrite((current) => {
        if (current?.id === id) setWriteError(`${id} 未收到飞控回读确认`)
        return current?.id === id ? null : current
      })
    }, 5000)
    setEditId(null)
  }

  const exportParams = () => {
    const content = Array.from(params.values()).map((param) => [param.id, param.value, param.type].join(',')).join('\n')
    const blob = new Blob([content], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${vehicleIdentity?.family ?? 'autopilot'}_params.params`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className={embedded ? 'mc-fade-in' : 'mc-workspace mc-fade-in mc-workspace--wide'}>
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <span className="text-[12px] font-semibold" style={{ color: 'var(--text-secondary)' }}>
          {loading ? '正在接收 ' + receivedCount + '/' + totalCount : (params.size || totalCount) + ' 个参数'}
        </span>
        <span className="flex-1" />
        <button type="button" className="mc-btn mc-btn-primary" onClick={requestParams} disabled={!canAccess || loading}>
          <Icon name="refresh" size={15} />{loading ? receivedCount + '/' + totalCount : '重新同步'}
        </button>
        <button type="button" className="mc-btn mc-btn-ghost" onClick={exportParams} disabled={params.size === 0}><Icon name="log" size={15} />导出参数</button>
      </div>

      {!canAccess && <div className="mc-capability-note" data-state="waiting"><Icon name="warning" size={15} /><span>连接飞控并取得控制权后可同步参数。</span></div>}
      {canAccess && !profileWritable && <div className="mc-capability-note" data-state="waiting"><Icon name="warning" size={15} /><span>当前飞控类型尚未开放写操作；参数可同步、搜索和导出，但不能修改。</span></div>}
      {writeError && <div className="mc-capability-note" data-state="error"><Icon name="warning" size={15} /><span>{writeError}</span></div>}

      <div className="mc-param-search">
        <Icon name="search" size={17} aria-hidden="true" />
        <input className="mc-input" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索参数名、中文名称或说明…" />
      </div>

      {loading && (
        <div className="mb-4 h-1.5 overflow-hidden rounded-full" style={{ background: 'var(--bg-tertiary)' }}>
          <i className="block h-full rounded-full" style={{ width: totalCount ? receivedCount / totalCount * 100 + '%' : '8%', background: 'var(--accent)' }} />
        </div>
      )}

      {params.size === 0 && !loading ? (
        <EmptyState icon="parameters" description="连接飞控后，点击“刷新参数”读取可配置参数。" />
      ) : (
        <div className="space-y-3">
          {Object.entries(groups).map(([prefix, items]) => {
            const isCollapsed = search ? false : (collapsed[prefix] ?? true)
            const groupLabel = parameterMetadata(items[0]?.id ?? prefix, vehicleIdentity).groupLabel
            return (
              <section key={prefix} className="mc-card overflow-hidden">
                <button
                  type="button"
                  className="mc-param-group__header"
                  onClick={() => setCollapsed((current) => ({ ...current, [prefix]: current[prefix] === undefined ? false : !current[prefix] }))}
                >
                  <Icon name="chevronDown" size={15} style={{ color: 'var(--text-secondary)', transform: isCollapsed ? 'rotate(-90deg)' : undefined, transition: 'transform 160ms ease' }} />
                  <span><strong className="mc-mono">{prefix}</strong><small>{groupLabel}</small></span>
                  <i className="mc-mono">{items.length}</i>
                </button>
                {!isCollapsed && (
                  <div className="mc-param-group__body">
                    {items.slice(0, visibleCounts[prefix] ?? 80).map((param) => {
                      const metadata = parameterMetadata(param.id, vehicleIdentity)
                      const enumOptions = parameterEnumOptions(param.id, vehicleIdentity)
                      const enumLabel = parameterEnumLabel(param.id, param.value, vehicleIdentity)
                      const knownEnumValue = enumOptions
                        ?.some((option) => parameterEnumValuesMatch(option.value, param.value)) ?? false
                      const editorOptions = enumOptions && !knownEnumValue
                        ? [{ value: param.value, label: '当前固件未收录的值' }, ...enumOptions]
                        : enumOptions
                      return (
                      <div key={param.id} className="mc-param-row">
                        <div className="mc-param-row__identity">
                          <span>
                            <code>{param.id}</code>
                            <strong>{metadata.title}</strong>
                            {metadata.unit && <i>{metadata.unit}</i>}
                          </span>
                          <p>{metadata.description}</p>
                        </div>
                        {editId === param.id ? (
                          <div className="mc-param-row__editor">
                            {editorOptions && !editRaw ? (
                              <select
                                autoFocus
                                aria-label={`${param.id} 枚举值`}
                                className="mc-input mc-param-row__select h-8"
                                value={editValue}
                                onChange={(event) => setEditValue(event.target.value)}
                                onKeyDown={(event) => { if (event.key === 'Enter') saveParam(param.id); if (event.key === 'Escape') setEditId(null) }}
                              >
                                {editorOptions.map((option) => (
                                  <option key={option.value} value={option.value}>{option.value}: {option.label}</option>
                                ))}
                              </select>
                            ) : (
                              <input autoFocus className="mc-input h-8 w-28" value={editValue} onChange={(event) => setEditValue(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') saveParam(param.id); if (event.key === 'Escape') setEditId(null) }} />
                            )}
                            {editorOptions && (
                              <button type="button" className="mc-btn mc-btn-ghost h-8 mc-param-row__raw-toggle" onClick={() => setEditRaw((current) => !current)}>
                                {editRaw ? '选项' : '原始值'}
                              </button>
                            )}
                            <button type="button" className="mc-btn mc-btn-primary h-8" disabled={!canWrite || pendingWrite !== null} onClick={() => saveParam(param.id)}>保存</button>
                          </div>
                        ) : (
                          <button type="button" disabled={!canWrite || pendingWrite !== null} className="mc-param-row__value mc-mono" onClick={() => { setEditId(param.id); setEditValue(String(param.value)); setEditRaw(false) }}>
                            {pendingWrite?.id === param.id ? '确认中…' : enumLabel ? `${param.value}: ${enumLabel}` : param.value}
                          </button>
                        )}
                        <span className="mc-param-row__type mc-mono">T{param.type}</span>
                      </div>
                    )})}
                    {items.length > (visibleCounts[prefix] ?? 80) && (
                      <button type="button" className="mc-load-more" onClick={() => setVisibleCounts((current) => ({ ...current, [prefix]: (current[prefix] ?? 80) + 80 }))}>
                        显示更多 · 还有 {items.length - (visibleCounts[prefix] ?? 80)} 项
                      </button>
                    )}
                  </div>
                )}
              </section>
            )
          })}
        </div>
      )}
    </div>
  )
}
