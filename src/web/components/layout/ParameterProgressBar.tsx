import { sendClientMessage } from '../../hooks/useWebSocket'
import { useConnectionStore } from '../../stores/connectionStore'
import { useParameterStore } from '../../stores/parameterStore'
import Icon from '../ui/Icon'

export default function ParameterProgressBar() {
  const send = sendClientMessage
  const vehicleReady = useConnectionStore((state) => state.vehicleReady)
  const connectionType = useConnectionStore((state) => state.type)
  const {
    loading,
    receivedCount,
    totalCount,
    retryCount,
    missingCount,
    error,
  } = useParameterStore()

  if (!loading && !error) return null

  const measuredPercent = totalCount > 0 ? receivedCount / totalCount * 100 : 0
  const percent = loading
    ? Math.min(99, Math.max(totalCount > 0 ? 1 : 6, Math.round(measuredPercent)))
    : Math.min(100, Math.round(measuredPercent))

  const retry = () => {
    useParameterStore.getState().clear()
    useParameterStore.getState().setLoading(true)
    send({ type: 'param_request_list' })
  }

  return (
    <div
      className="mc-global-param-progress"
      data-error={Boolean(error)}
      role={error ? 'alert' : 'status'}
    >
      <div
        className="mc-global-param-progress__track"
        role="progressbar"
        aria-label="飞控参数读取进度"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={totalCount > 0 ? percent : undefined}
      >
        <i style={{ width: `${percent}%` }} data-indeterminate={loading && totalCount === 0} />
      </div>
      <span className="mc-global-param-progress__label">
        {error ? (
          error
        ) : (
          <>
            正在同步飞控参数
            <strong>{totalCount > 0 ? `${receivedCount}/${totalCount}` : '等待响应'}</strong>
            {retryCount > 0 && (
              <small>正在补读第 {retryCount} 次{missingCount > 0 ? ` · 缺 ${missingCount} 项` : ''}</small>
            )}
            {connectionType === 'bluetooth' && retryCount === 0 && (
              <small>蓝牙低带宽同步 · 已临时降低遥测速率</small>
            )}
          </>
        )}
      </span>
      {error ? (
        <button type="button" disabled={!vehicleReady} onClick={retry}>
          <Icon name="refresh" size={13} />重新读取
        </button>
      ) : (
        <strong className="mc-global-param-progress__percent">{percent}%</strong>
      )}
    </div>
  )
}
