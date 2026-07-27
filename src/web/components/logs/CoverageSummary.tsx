// Detailed coverage breakdown: discovered vs analyzed vs raw-only vs
// unsupported topic instances, discovered vs plottable fields, and warnings.
import type { UlogAnalysisDataset } from '../../log-analysis/types.js'

interface Props {
  dataset: UlogAnalysisDataset
}

export default function CoverageSummary({ dataset }: Props) {
  const cov = dataset.coverage

  return (
    <div className="coverage-summary">
      <div className="coverage-summary__grid">
        <div className="coverage-summary__cell">
          <span>已发现主题实例</span>
          <strong className="mc-mono">{cov.discoveredTopicInstances}</strong>
        </div>
        <div className="coverage-summary__cell">
          <span>已分析主题实例</span>
          <strong className="mc-mono">{cov.analyzedTopicInstances}</strong>
        </div>
        <div className="coverage-summary__cell">
          <span>仅原始主题实例</span>
          <strong className="mc-mono">{cov.rawOnlyTopicInstances}</strong>
        </div>
        <div className="coverage-summary__cell">
          <span>未支持主题实例</span>
          <strong className="mc-mono">{cov.unsupportedTopicInstances}</strong>
        </div>
        <div className="coverage-summary__cell">
          <span>已发现字段</span>
          <strong className="mc-mono">{cov.discoveredFields}</strong>
        </div>
        <div className="coverage-summary__cell">
          <span>可绘图字段</span>
          <strong className="mc-mono">{cov.plottableFields}</strong>
        </div>
      </div>

      {cov.warnings.length > 0 && (
        <ul className="coverage-summary__warnings">
          {cov.warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      )}
    </div>
  )
}
