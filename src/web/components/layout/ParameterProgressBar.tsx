import { useTranslation } from 'react-i18next'
import { sendRuntimeCommand } from '../../hooks/useLocalRuntime'
import { useConnectionStore } from '../../stores/connectionStore'
import { useParameterStore } from '../../stores/parameterStore'
import Icon from '../ui/Icon'

export default function ParameterProgressBar() {
  const { t } = useTranslation()
  const send = sendRuntimeCommand
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
        aria-label={t('parameter.progress.ariaLabel')}
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
            {t('parameter.progress.syncing')}
            <strong>{totalCount > 0 ? `${receivedCount}/${totalCount}` : t('parameter.progress.waitingResponse')}</strong>
            {retryCount > 0 && (
              <small>{t('parameter.progress.retrying', { count: retryCount })}{missingCount > 0 ? t('parameter.progress.missing', { count: missingCount }) : ''}</small>
            )}
            {connectionType === 'bluetooth' && retryCount === 0 && (
              <small>{t('parameter.progress.bluetoothLowBandwidth')}</small>
            )}
          </>
        )}
      </span>
      {error ? (
        <button type="button" disabled={!vehicleReady} onClick={retry}>
          <Icon name="refresh" size={13} />{t('parameter.progress.reread')}
        </button>
      ) : (
        <strong className="mc-global-param-progress__percent">{percent}%</strong>
      )}
    </div>
  )
}
