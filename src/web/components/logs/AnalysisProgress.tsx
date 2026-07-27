import Icon from '../ui/Icon'

const PHASE_LABELS: Record<string, string> = {
  starting: '正在准备…',
  validating: '正在校验文件…',
  normalizing: '正在规范化缓冲区…',
  indexing: '正在索引日志…',
  cataloging: '正在构建目录…',
  analyzing: '正在分析…',
  finalizing: '正在完成…',
}

interface Props {
  phase: string
  fraction: number
  fileName?: string | null
  onCancel?: () => void
}

export default function AnalysisProgress({ phase, fraction, fileName, onCancel }: Props) {
  const label = PHASE_LABELS[phase] ?? PHASE_LABELS.analyzing
  const percent = Math.round(Math.min(Math.max(fraction, 0), 1) * 100)

  return (
    <div className="mc-analysis-dropzone">
      <p style={{ margin: 0, fontSize: 14 }}>
        {label}
        {fileName && (
          <span className="mc-mono" style={{ color: 'var(--text-secondary)', marginLeft: 6 }}>
            {fileName}
          </span>
        )}
      </p>

      {/* Real progress bar — no fake smooth animation */}
      <div
        style={{
          marginTop: 10,
          width: '100%',
          maxWidth: 320,
          height: 6,
          background: 'var(--bg-secondary)',
          borderRadius: 3,
          overflow: 'hidden',
        }}
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          style={{
            width: `${percent}%`,
            height: '100%',
            background: 'var(--accent)',
            borderRadius: 3,
            transition: 'width 0.15s ease-out',
          }}
        />
      </div>

      <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 8 }}>
        <span className="mc-mono" style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
          {percent}%
        </span>
        {onCancel && (
          <button
            type="button"
            className="mc-btn mc-btn-ghost"
            style={{ fontSize: 12, padding: '2px 8px' }}
            onClick={onCancel}
          >
            <Icon name="close" size={12} /> 取消
          </button>
        )}
      </div>
    </div>
  )
}
