import { useMemo, useState } from 'react'
import Icon from '../components/ui/Icon'
import { EmptyState, PageHeader } from '../components/ui/PageFrame'
import { useWebSocket } from '../hooks/useWebSocket'
import { useParameterStore } from '../stores/parameterStore'

export default function ParameterPage() {
  const { params, loading, totalCount, receivedCount } = useParameterStore()
  const { send } = useWebSocket()
  const [search, setSearch] = useState('')
  const [editId, setEditId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})

  const requestParams = () => {
    useParameterStore.getState().setLoading(true)
    useParameterStore.getState().clear()
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
    const value = Number.parseFloat(editValue)
    if (!Number.isFinite(value)) return
    const param = params.get(id)
    send({ type: 'param_set', data: { id, value, paramType: param?.type ?? 9 } })
    useParameterStore.getState().updateParam(id, value)
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
    <div className="mc-workspace mc-fade-in">
      <PageHeader
        title="参数"
        description={'管理飞控参数' + (loading ? ' · 正在接收 ' + receivedCount + '/' + totalCount : ' · 已缓存 ' + params.size + ' 项')}
        actions={
          <>
            <button type="button" className="mc-btn mc-btn-ghost" onClick={exportParams} disabled={params.size === 0}>
              <Icon name="log" size={15} />导出
            </button>
            <button type="button" className="mc-btn mc-btn-primary" onClick={requestParams} disabled={loading}>
              <Icon name="refresh" size={15} />{loading ? receivedCount + '/' + totalCount : '刷新参数'}
            </button>
          </>
        }
      />

      <div className="relative mb-4">
        <Icon name="search" size={17} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-disabled)' }} />
        <input className="mc-input pl-10" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索参数（例如 EKF2_、MC_、BAT_、COM_）" />
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
            const isCollapsed = collapsed[prefix]
            return (
              <section key={prefix} className="mc-card overflow-hidden">
                <button
                  type="button"
                  className="flex w-full items-center gap-3 px-5 py-3 text-left"
                  onClick={() => setCollapsed((current) => ({ ...current, [prefix]: !current[prefix] }))}
                >
                  <Icon name="chevronDown" size={15} style={{ color: 'var(--text-secondary)', transform: isCollapsed ? 'rotate(-90deg)' : undefined, transition: 'transform 160ms ease' }} />
                  <span className="mc-mono text-[13px] font-bold" style={{ color: 'var(--text-primary)' }}>{prefix}</span>
                  <span className="rounded-full px-2 py-0.5 text-[10px]" style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}>{items.length}</span>
                </button>
                {!isCollapsed && (
                  <div className="border-t" style={{ borderColor: 'var(--border)' }}>
                    {items.slice(0, 50).map((param) => (
                      <div key={param.id} className="flex items-center gap-3 border-b px-5 py-2.5 last:border-b-0" style={{ borderColor: 'var(--border)' }}>
                        <span className="min-w-0 flex-1 truncate mc-mono text-[12px]" style={{ color: 'var(--text-primary)' }}>{param.id}</span>
                        {editId === param.id ? (
                          <div className="flex items-center gap-2">
                            <input autoFocus className="mc-input h-8 w-28" value={editValue} onChange={(event) => setEditValue(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') saveParam(param.id); if (event.key === 'Escape') setEditId(null) }} />
                            <button type="button" className="mc-btn mc-btn-primary h-8" onClick={() => saveParam(param.id)}>保存</button>
                          </div>
                        ) : (
                          <button type="button" className="mc-mono rounded-md px-2.5 py-1.5 text-[12px] transition-colors hover:bg-[var(--bg-tertiary)]" style={{ color: 'var(--accent)' }} onClick={() => { setEditId(param.id); setEditValue(String(param.value)) }}>
                            {param.value}
                          </button>
                        )}
                        <span className="hidden rounded px-1.5 py-0.5 text-[10px] sm:inline" style={{ background: 'var(--bg-tertiary)', color: 'var(--text-disabled)' }}>T{param.type}</span>
                      </div>
                    ))}
                    {items.length > 50 && <p className="px-5 py-3 text-[11px]" style={{ color: 'var(--text-secondary)' }}>还有 {items.length - 50} 个参数，请使用搜索缩小范围。</p>}
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
