// Paged tabular display for raw time series data.
// Shows time column + selected field columns with simple windowed paging.
// Uses .mc-mono for numbers and first/prev/next/last navigation.
import { useMemo, useState } from 'react'

interface Props {
  times: number[]
  values: Record<string, number[]>
  fields: string[]
  pageSize?: number
}

function formatNumber(val: number | undefined): string {
  if (val == null || !Number.isFinite(val)) return '—'
  // Show up to 6 significant digits, trim trailing zeros
  return val.toPrecision(6).replace(/\.?0+$/, '')
}

function formatTime(t: number): string {
  return t.toFixed(4)
}

export default function RawDataTable({
  times,
  values,
  fields,
  pageSize = 100,
}: Props) {
  const totalRows = times.length
  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize))
  const [page, setPage] = useState(0)

  // Clamp page if data shrinks
  const safePage = Math.min(page, totalPages - 1)

  const startRow = safePage * pageSize
  const endRow = Math.min(startRow + pageSize, totalRows)

  const visibleRows = useMemo(() => {
    const rows: Array<{ time: number; values: Record<string, number | undefined> }> = []
    for (let i = startRow; i < endRow; i++) {
      const row: Record<string, number | undefined> = {}
      for (const field of fields) {
        row[field] = values[field]?.[i]
      }
      rows.push({ time: times[i], values: row })
    }
    return rows
  }, [times, values, fields, startRow, endRow])

  if (totalRows === 0) {
    return (
      <div className="raw-data-table" style={{ padding: '16px 0', color: 'var(--text-disabled)', fontSize: 13 }}>
        暂无数据
      </div>
    )
  }

  const goTo = (p: number) => setPage(Math.max(0, Math.min(p, totalPages - 1)))

  return (
    <div className="raw-data-table">
      {/* Table */}
      <div style={{ overflowX: 'auto' }}>
        <table
          className="mc-mono"
          style={{
            width: '100%',
            borderCollapse: 'collapse',
            fontSize: 12,
            lineHeight: 1.5,
          }}
        >
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border)' }}>
              <th
                style={{
                  textAlign: 'right',
                  padding: '4px 8px',
                  color: 'var(--text-secondary)',
                  fontWeight: 600,
                  whiteSpace: 'nowrap',
                }}
              >
                时间（秒）
              </th>
              {fields.map((f) => (
                <th
                  key={f}
                  style={{
                    textAlign: 'right',
                    padding: '4px 8px',
                    color: 'var(--text-secondary)',
                    fontWeight: 600,
                    whiteSpace: 'nowrap',
                  }}
                >
                  {f}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((row, i) => (
              <tr
                key={startRow + i}
                style={{
                  borderBottom: '1px solid var(--border)',
                  background: i % 2 === 0 ? 'transparent' : 'var(--bg-tertiary)',
                }}
              >
                <td
                  style={{
                    textAlign: 'right',
                    padding: '2px 8px',
                    color: 'var(--text-secondary)',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {formatTime(row.time)}
                </td>
                {fields.map((f) => (
                  <td
                    key={f}
                    style={{
                      textAlign: 'right',
                      padding: '2px 8px',
                      color: 'var(--text-primary)',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {formatNumber(row.values[f])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      <div
        className="raw-data-table__nav"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '8px 0',
          gap: 8,
        }}
      >
        <span className="mc-mono" style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
          行 {startRow + 1}–{endRow} / {totalRows}
        </span>
        <div style={{ display: 'flex', gap: 4 }}>
          <button
            type="button"
            className="mc-btn mc-btn-ghost"
            disabled={safePage === 0}
            onClick={() => goTo(0)}
            title="第一页"
          >
            ⟪
          </button>
          <button
            type="button"
            className="mc-btn mc-btn-ghost"
            disabled={safePage === 0}
            onClick={() => goTo(safePage - 1)}
            title="上一页"
          >
            ⟨
          </button>
          <span
            className="mc-mono"
            style={{ fontSize: 12, padding: '0 8px', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center' }}
          >
            {safePage + 1} / {totalPages}
          </span>
          <button
            type="button"
            className="mc-btn mc-btn-ghost"
            disabled={safePage >= totalPages - 1}
            onClick={() => goTo(safePage + 1)}
            title="下一页"
          >
            ⟩
          </button>
          <button
            type="button"
            className="mc-btn mc-btn-ghost"
            disabled={safePage >= totalPages - 1}
            onClick={() => goTo(totalPages - 1)}
            title="最后一页"
          >
            ⟫
          </button>
        </div>
      </div>
    </div>
  )
}
