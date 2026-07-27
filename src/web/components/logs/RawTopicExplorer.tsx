// Grouped topic browser for raw ULog data exploration.
// Topics are grouped by name; each instance is a disclosure row showing
// field list, analysis status, and a "Plot" action.
import { useMemo, useState } from 'react'
import type { UlogTopicCatalogEntry, UlogFieldCatalogEntry } from '../../log-analysis/types.js'

interface Props {
  catalog: readonly UlogTopicCatalogEntry[]
  onSelectTopic?: (entry: UlogTopicCatalogEntry) => void
}

interface TopicGroup {
  name: string
  instances: UlogTopicCatalogEntry[]
}

function formatTimeRange(startSec: number | null, endSec: number | null): string {
  if (startSec == null && endSec == null) return '—'
  const s = startSec != null ? `${startSec.toFixed(1)} 秒` : '?'
  const e = endSec != null ? `${endSec.toFixed(1)} 秒` : '?'
  return `${s} – ${e}`
}

function FieldRow({ field }: { field: UlogFieldCatalogEntry }) {
  return (
    <div className="raw-topic__field-row">
      <span className="raw-topic__field-name mc-mono">{field.path}</span>
      <span className="raw-topic__field-type mc-mono">{field.type}</span>
      {field.unit && (
        <span className="raw-topic__field-unit mc-mono">{field.unit}</span>
      )}
      {!field.plottable && (
        <span className="raw-topic__field-badge">非数值</span>
      )}
    </div>
  )
}

function InstanceRow({
  entry,
  onSelect,
}: {
  entry: UlogTopicCatalogEntry
  onSelect?: (entry: UlogTopicCatalogEntry) => void
}) {
  const [open, setOpen] = useState(false)
  const plottableFields = useMemo(
    () => entry.fields.filter((f) => f.plottable).map((f) => f.path),
    [entry.fields],
  )

  return (
    <div className="raw-topic__instance">
      <button
        type="button"
        className="raw-topic__instance-header"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="raw-topic__chevron">{open ? '▾' : '▸'}</span>
        <span className="mc-mono">
          {entry.name}[{entry.multiId}]
        </span>
        <span className="raw-topic__meta mc-mono">
          {entry.sampleCount.toLocaleString()} 条采样
        </span>
        <span className="raw-topic__meta mc-mono">
          {formatTimeRange(entry.firstTimeSec, entry.lastTimeSec)}
        </span>
      </button>

      {open && (
        <div className="raw-topic__instance-body">
          {/* Analysis status */}
          {entry.consumedBy.length > 0 && (
            <div className="raw-topic__status">
              <span className="raw-topic__status-label">分析模块：</span>
              {entry.consumedBy.map((mod) => (
                <span key={mod} className="raw-topic__badge">
                  {mod}
                </span>
              ))}
            </div>
          )}

          {/* Warnings */}
          {entry.warnings.length > 0 && (
            <div className="raw-topic__warnings">
              {entry.warnings.map((w, i) => (
                <p key={i} style={{ margin: 0, color: 'var(--warning)', fontSize: 12 }}>
                  {w}
                </p>
              ))}
            </div>
          )}

          {/* Field list */}
          <div className="raw-topic__fields">
            <div className="raw-topic__fields-header">
              <span>字段</span>
              <span>类型</span>
              <span>单位</span>
            </div>
            {entry.fields.map((field) => (
              <FieldRow key={field.path} field={field} />
            ))}
          </div>

          {/* Plot action */}
          {onSelect && plottableFields.length > 0 && (
            <button
              type="button"
              className="mc-btn mc-btn-primary"
              style={{ marginTop: 8 }}
              onClick={() => onSelect(entry)}
            >
              选择要绘制的字段
            </button>
          )}
        </div>
      )}
    </div>
  )
}

export default function RawTopicExplorer({ catalog, onSelectTopic }: Props) {
  const [search, setSearch] = useState('')

  // Group topics by name
  const groups = useMemo<TopicGroup[]>(() => {
    const map = new Map<string, UlogTopicCatalogEntry[]>()
    for (const entry of catalog) {
      const list = map.get(entry.name) ?? []
      list.push(entry)
      map.set(entry.name, list)
    }
    return Array.from(map.entries())
      .map(([name, instances]) => ({ name, instances }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [catalog])

  // Filter by search term
  const filteredGroups = useMemo(() => {
    const term = search.toLowerCase().trim()
    if (!term) return groups
    return groups
      .map((g) => ({
        ...g,
        instances: g.instances.filter(
          (inst) =>
            g.name.toLowerCase().includes(term) ||
            inst.fields.some((f) => f.path.toLowerCase().includes(term)),
        ),
      }))
      .filter((g) => g.instances.length > 0)
  }, [groups, search])

  const totalInstances = catalog.length
  const shownInstances = filteredGroups.reduce((sum, g) => sum + g.instances.length, 0)

  return (
    <div className="raw-topic-explorer">
      {/* Search filter */}
      <div className="raw-topic-explorer__toolbar">
        <input
          type="text"
          className="mc-input"
          placeholder="搜索主题或字段…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ flex: 1, maxWidth: 320 }}
        />
        <span className="mc-mono" style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
          {shownInstances}/{totalInstances} 实例
        </span>
      </div>

      {/* Topic groups */}
      <div className="raw-topic-explorer__groups">
        {filteredGroups.map((group) => (
          <div key={group.name} className="raw-topic-explorer__group">
            <div className="raw-topic-explorer__group-header">
              <span className="mc-mono" style={{ fontWeight: 600 }}>
                {group.name}
              </span>
              <span className="mc-mono" style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                {group.instances.length} 实例
              </span>
            </div>
            {group.instances.map((entry) => (
              <InstanceRow
                key={`${entry.name}_${entry.multiId}`}
                entry={entry}
                onSelect={onSelectTopic}
              />
            ))}
          </div>
        ))}

        {filteredGroups.length === 0 && (
          <p style={{ color: 'var(--text-disabled)', fontSize: 13, padding: '12px 0' }}>
            没有匹配的主题
          </p>
        )}
      </div>
    </div>
  )
}
