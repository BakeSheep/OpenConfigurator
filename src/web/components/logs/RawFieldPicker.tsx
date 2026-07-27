// Field selection component for raw charting.
// Shows available fields for a topic instance; numeric fields are
// selectable via checkboxes (max 6), while string/struct fields are
// shown as informational only.
import { useMemo, useState } from 'react'
import type { UlogTopicCatalogEntry, UlogFieldCatalogEntry } from '../../log-analysis/types.js'

interface Props {
  topicEntry: UlogTopicCatalogEntry
  maxFields?: number
  onPlot: (fields: string[]) => void
}

function FieldCheckbox({
  field,
  checked,
  disabled,
  onChange,
}: {
  field: UlogFieldCatalogEntry
  checked: boolean
  disabled: boolean
  onChange: (checked: boolean) => void
}) {
  const isPlottable = field.plottable

  return (
    <label
      className="raw-field-picker__row"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '4px 0',
        cursor: isPlottable && !disabled ? 'pointer' : 'default',
        opacity: isPlottable ? 1 : 0.5,
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={!isPlottable || disabled}
        onChange={(e) => onChange(e.target.checked)}
        style={{ accentColor: 'var(--accent)' }}
      />
      <span className="mc-mono" style={{ fontSize: 13, flex: 1 }}>
        {field.path}
      </span>
      <span className="mc-mono" style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
        {field.type}
      </span>
      {field.unit && (
        <span className="mc-mono" style={{ fontSize: 11, color: 'var(--text-disabled)' }}>
          {field.unit}
        </span>
      )}
      {!isPlottable && (
        <span
          style={{
            fontSize: 10,
            color: 'var(--text-disabled)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-sm)',
            padding: '1px 4px',
          }}
        >
          非数值
        </span>
      )}
    </label>
  )
}

export default function RawFieldPicker({
  topicEntry,
  maxFields = 6,
  onPlot,
}: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const plottableFields = useMemo(
    () => topicEntry.fields.filter((f) => f.plottable),
    [topicEntry.fields],
  )

  const nonPlottableFields = useMemo(
    () => topicEntry.fields.filter((f) => !f.plottable),
    [topicEntry.fields],
  )

  const atLimit = selected.size >= maxFields

  const handleToggle = (fieldPath: string, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (checked) {
        if (next.size >= maxFields) return prev
        next.add(fieldPath)
      } else {
        next.delete(fieldPath)
      }
      return next
    })
  }

  const handlePlot = () => {
    if (selected.size === 0) return
    onPlot(Array.from(selected))
  }

  return (
    <div className="raw-field-picker">
      <div className="raw-field-picker__header">
        <span className="mc-mono" style={{ fontWeight: 600 }}>
          {topicEntry.name}[{topicEntry.multiId}]
        </span>
        <span className="mc-mono" style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
          已选 {selected.size}/{maxFields}
        </span>
      </div>

      {/* Plottable fields */}
      <div className="raw-field-picker__list">
        {plottableFields.map((field) => (
          <FieldCheckbox
            key={field.path}
            field={field}
            checked={selected.has(field.path)}
            disabled={atLimit && !selected.has(field.path)}
            onChange={(checked) => handleToggle(field.path, checked)}
          />
        ))}
      </div>

      {/* Non-plottable fields (info only) */}
      {nonPlottableFields.length > 0 && (
        <div className="raw-field-picker__info">
          <span style={{ fontSize: 11, color: 'var(--text-disabled)' }}>
            以下字段不可绘制：
          </span>
          {nonPlottableFields.map((field) => (
            <FieldCheckbox
              key={field.path}
              field={field}
              checked={false}
              disabled
              onChange={() => {/* noop */}}
            />
          ))}
        </div>
      )}

      {/* Plot button */}
      <button
        type="button"
        className="mc-btn mc-btn-primary"
        disabled={selected.size === 0}
        onClick={handlePlot}
        style={{ marginTop: 8 }}
      >
        绘制选中字段
      </button>
    </div>
  )
}
