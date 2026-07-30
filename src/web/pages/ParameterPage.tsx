import { useEffect, useMemo, useRef, useState } from 'react'
import Icon from '../components/ui/Icon'
import { EmptyState } from '../components/ui/PageFrame'
import { sendClientMessage } from '../hooks/useWebSocket'
import { useParameterStore } from '../stores/parameterStore'
import { useConnectionStore } from '../stores/connectionStore'

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
  const canWrite = useConnectionStore((state) => state.vehicleReady && state.canControl)
  const [search, setSearch] = useState('')
  const [editId, setEditId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
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
    if (!canWrite) return
    useParameterStore.getState().clear()
    useParameterStore.getState().setLoading(true)
    send({ type: 'param_request_list' })
  }

  const filteredParams = useMemo(() => {
    const values = Array.from(params.values())
    if (!search) return values
    const query = search.toUpperCase()
    return values.filter((param) => param.id.toUpperCase().includes(query))
  }, [params, search])

  const groups = useMemo(() => {
    const result: Record<string, typeof filteredParams> = {}
    for (const param of filteredParams) {
      const prefix = param.id.split('_')[0]
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
    anchor.download = 'px4_params.params'
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
        <button type="button" className="mc-btn mc-btn-primary" onClick={requestParams} disabled={!canWrite || loading}>
          <Icon name="refresh" size={15} />{loading ? receivedCount + '/' + totalCount : '重新同步'}
        </button>
        <button type="button" className="mc-btn mc-btn-ghost" onClick={exportParams} disabled={params.size === 0}><Icon name="log" size={15} />导出参数</button>
      </div>

      {!canWrite && <div className="mc-capability-note" data-state="waiting"><Icon name="warning" size={15} /><span>连接飞控并取得控制权后可同步或修改参数。</span></div>}
      {writeError && <div className="mc-capability-note" data-state="error"><Icon name="warning" size={15} /><span>{writeError}</span></div>}

      <div className="relative mb-4">
        <Icon name="search" size={17} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-disabled)' }} />
        <input className="mc-input pl-10" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索参数名…" />
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
            return (
              <section key={prefix} className="mc-card overflow-hidden">
                <button
                  type="button"
                  className="flex w-full items-center gap-3 px-5 py-3 text-left"
                  onClick={() => setCollapsed((current) => ({ ...current, [prefix]: current[prefix] === undefined ? false : !current[prefix] }))}
                >
                  <Icon name="chevronDown" size={15} style={{ color: 'var(--text-secondary)', transform: isCollapsed ? 'rotate(-90deg)' : undefined, transition: 'transform 160ms ease' }} />
                  <span className="mc-mono text-[13px] font-bold" style={{ color: 'var(--text-primary)' }}>{prefix}</span>
                  <span className="rounded-full px-2 py-0.5 text-[10px]" style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}>{items.length}</span>
                </button>
                {!isCollapsed && (
                  <div className="border-t" style={{ borderColor: 'var(--border)' }}>
                    {items.slice(0, visibleCounts[prefix] ?? 80).map((param) => (
                      <div key={param.id} className="flex items-center gap-3 border-b px-5 py-2.5 last:border-b-0" style={{ borderColor: 'var(--border)' }}>
                        <span className="min-w-0 flex-1 truncate mc-mono text-[12px]" style={{ color: 'var(--text-primary)' }}>{param.id}</span>
                        {editId === param.id ? (
                          <div className="flex items-center gap-2">
                            <input autoFocus className="mc-input h-8 w-28" value={editValue} onChange={(event) => setEditValue(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') saveParam(param.id); if (event.key === 'Escape') setEditId(null) }} />
                            <button type="button" className="mc-btn mc-btn-primary h-8" disabled={!canWrite || pendingWrite !== null} onClick={() => saveParam(param.id)}>保存</button>
                          </div>
                        ) : (
                          <button type="button" disabled={!canWrite || pendingWrite !== null} className="mc-mono rounded-md px-2.5 py-1.5 text-[12px] transition-colors hover:bg-[var(--bg-tertiary)]" style={{ color: 'var(--accent)' }} onClick={() => { setEditId(param.id); setEditValue(String(param.value)) }}>
                            {pendingWrite?.id === param.id ? '确认中…' : param.value}
                          </button>
                        )}
                        <span className="hidden rounded px-1.5 py-0.5 text-[10px] sm:inline" style={{ background: 'var(--bg-tertiary)', color: 'var(--text-disabled)' }}>T{param.type}</span>
                      </div>
                    ))}
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
