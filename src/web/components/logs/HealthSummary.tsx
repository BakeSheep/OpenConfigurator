// Quality and coverage strip shown below the page header. Displays log quality
// indicator (based on dropout rate) and coverage stats as compact chips.
import type { UlogAnalysisDataset } from '../../log-analysis/types.js'

interface Props {
  dataset: UlogAnalysisDataset
}

function dropoutQuality(dataset: UlogAnalysisDataset): { label: string; className: string } {
  const { dropoutCount } = dataset.timeline
  if (dropoutCount === 0) return { label: '无丢帧', className: 'health-chip--healthy' }
  if (dropoutCount < 10) return { label: `${dropoutCount} 次丢帧`, className: 'health-chip--notice' }
  if (dropoutCount < 100) return { label: `${dropoutCount} 次丢帧`, className: 'health-chip--warning' }
  return { label: `${dropoutCount} 次丢帧`, className: 'health-chip--critical' }
}

export default function HealthSummary({ dataset }: Props) {
  const quality = dropoutQuality(dataset)
  const cov = dataset.coverage

  return (
    <div className="health-summary" aria-label="日志质量与覆盖">
      <span className={`health-chip ${quality.className}`}>
        {quality.label}
      </span>
      <span className="health-chip">
        已发现 {cov.discoveredTopicInstances} 主题
      </span>
      <span className="health-chip">
        已分析 {cov.analyzedTopicInstances}
      </span>
      {cov.rawOnlyTopicInstances > 0 && (
        <span className="health-chip health-chip--notice">
          仅原始 {cov.rawOnlyTopicInstances}
        </span>
      )}
      {cov.unsupportedTopicInstances > 0 && (
        <span className="health-chip health-chip--warning">
          未支持 {cov.unsupportedTopicInstances}
        </span>
      )}
      <span className="health-chip">
        {cov.plottableFields}/{cov.discoveredFields} 可绘图字段
      </span>
      {dataset.metadata.hadAppendedData && (
        <span className="health-chip health-chip--notice">
          含追加数据
        </span>
      )}
    </div>
  )
}
