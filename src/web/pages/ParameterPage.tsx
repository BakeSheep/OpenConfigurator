import { useState, useMemo } from 'react'
import { useParameterStore } from '../stores/parameterStore'
import { useWebSocket } from '../hooks/useWebSocket'

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
    const arr = Array.from(params.values())
    if (!search) return arr
    const q = search.toUpperCase()
    return arr.filter((p) => p.id.toUpperCase().includes(q))
  }, [params, search])

  const grouped = useMemo(() => {
    const groups: Record<string, typeof filteredParams> = {}
    for (const p of filteredParams) {
      const prefix = p.id.split('_')[0]
      if (!groups[prefix]) groups[prefix] = []
      groups[prefix].push(p)
    }
    return groups
  }, [filteredParams])

  const saveParam = (id: string) => {
    const val = parseFloat(editValue)
    if (isNaN(val)) return
    const param = params.get(id)
    send({ type: 'param_set', data: { id, value: val, paramType: param?.type || 9 } })
    useParameterStore.getState().updateParam(id, val)
    setEditId(null)
  }

  const exportParams = () => {
    const lines = Array.from(params.values()).map((p) => `${p.id},${p.value},${p.type}`)
    const blob = new Blob([lines.join('\n')], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = 'px4_params.params'; a.click()
    URL.revokeObjectURL(url)
  }

  const toggleGroup = (prefix: string) => setCollapsed((c) => ({ ...c, [prefix]: !c[prefix] }))

  return (
    <div className="p-5 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>参数管理</h2>
          <p className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
            共 {params.size} 个参数{loading ? ` · 正在加载 ${receivedCount}/${totalCount}` : ''}
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={requestParams} disabled={loading} className="mc-btn mc-btn-primary px-4 py-2 text-[12px]">
            {loading ? `${receivedCount}/${totalCount}` : '刷新参数'}
          </button>
          <button onClick={exportParams} disabled={params.size === 0} className="mc-btn mc-btn-ghost px-4 py-2 text-[12px]">
            导出
          </button>
        </div>
      </div>

      {/* Search */}
      <input
        type="text"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="搜索参数… (EKF2_, MC_, BAT_, COM_)"
        className="mc-input"
      />

      {/* Progress */}
      {loading && (
        <div className="w-full h-1 rounded-full overflow-hidden" style={{ background: 'var(--bg-tertiary)' }}>
          <div className="h-full rounded-full transition-all" style={{ width: `${totalCount ? (receivedCount / totalCount) * 100 : 0}%`, background: 'var(--accent)' }} />
        </div>
      )}

      {/* Parameter groups */}
      <div className="space-y-3 overflow-y-auto" style={{ maxHeight: 'calc(100vh - 240px)' }}>
        {Object.entries(grouped).map(([prefix, items]) => {
          const isCollapsed = collapsed[prefix]
          return (
            <div key={prefix} className="mc-card overflow-hidden">
              {/* Group header (collapsible) */}
              <button
                onClick={() => toggleGroup(prefix)}
                className="w-full flex items-center gap-2 px-4 py-2.5 transition-colors hover:bg-white/[0.02]"
              >
                <svg
                  width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
                  strokeLinecap="round" strokeLinejoin="round"
                  className="transition-transform shrink-0"
                  style={{ color: 'var(--text-secondary)', transform: isCollapsed ? 'rotate(-90deg)' : 'none' }}
                >
                  <path d="m6 9 6 6 6-6" />
                </svg>
                <span className="mc-mono text-[12px] font-semibold" style={{ color: 'var(--text-primary)' }}>{prefix}</span>
                <span
                  className="text-[10px] px-1.5 rounded-full mc-mono"
                  style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
                >
                  {items.length}
                </span>
              </button>

              {/* Group rows */}
              {!isCollapsed && (
                <div style={{ borderTop: '1px solid var(--border)' }}>
                  {items.slice(0, 50).map((p) => (
                    <div
                      key={p.id}
                      className="flex items-center px-4 py-2.5 transition-colors hover:bg-white/[0.02]"
                      style={{ borderBottom: '1px solid var(--border)' }}
                    >
                      <span className="flex-1 text-[13px] mc-mono truncate" style={{ color: 'var(--text-secondary)' }}>{p.id}</span>
                      {editId === p.id ? (
                        <div className="flex items-center gap-2">
                          <input
                            type="number"
                            value={editValue}
                            onChange={(e) => setEditValue(e.target.value)}
                            className="w-28 rounded-lg px-2 py-1 text-[13px] mc-mono focus:outline-none"
                            style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--accent)', color: 'var(--text-primary)' }}
                            autoFocus
                            onKeyDown={(e) => e.key === 'Enter' && saveParam(p.id)}
                          />
                          <button onClick={() => saveParam(p.id)} className="mc-btn mc-btn-success px-2.5 py-1 text-[11px]">保存</button>
                          <button onClick={() => setEditId(null)} className="mc-btn mc-btn-ghost px-2.5 py-1 text-[11px]">取消</button>
                        </div>
                      ) : (
                        <button
                          onClick={() => { setEditId(p.id); setEditValue(String(p.value)) }}
                          className="text-[13px] mc-mono transition-colors hover:underline"
                          style={{ color: 'var(--accent)' }}
                        >
                          {p.value}
                        </button>
                      )}
                    </div>
                  ))}
                  {items.length > 50 && (
                    <div className="px-4 py-2 text-center text-[11px]" style={{ color: 'var(--text-disabled)', borderTop: '1px solid var(--border)' }}>
                      还有 {items.length - 50} 个参数，使用搜索缩小范围
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })}
        {params.size === 0 && !loading && (
          <div className="text-center py-16">
            <p className="text-[14px]" style={{ color: 'var(--text-secondary)' }}>暂无参数数据</p>
            <p className="text-[12px] mt-1" style={{ color: 'var(--text-disabled)' }}>连接飞控后点击「刷新参数」</p>
          </div>
        )}
      </div>
    </div>
  )
}
