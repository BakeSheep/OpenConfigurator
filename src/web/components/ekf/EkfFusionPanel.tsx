import { useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { sendClientMessage } from '../../hooks/useWebSocket'
import { useParameterStore } from '../../stores/parameterStore'
import { EKF2_PARAMS, HGT_REF_OPTIONS } from '../../../shared/constants'
import type { ParamData } from '../../../shared/types'
import { vehicleCapabilities } from '../../../shared/vehicleProfiles'
import { ekfSourceFields } from '../../utils/parameterProfiles'
import { useConnectionStore } from '../../stores/connectionStore'
import { useTelemetryStore } from '../../stores/telemetryStore'

function Toggle({
  label,
  param,
  enabled,
  canWrite,
  onToggle,
}: {
  label: string
  param?: ParamData
  enabled: boolean
  canWrite: boolean
  onToggle: () => void
}) {
  const { t } = useTranslation()
  return (
    <div className="flex items-center justify-between py-2.5">
      <span className="text-[13px]" style={{ color: 'var(--text-primary)' }}>{label}</span>
      <button
        type="button"
        onClick={onToggle}
        disabled={!param || !canWrite}
        title={param ? undefined : t('ekf.paramNotAvailable')}
        className="relative transition-colors"
        style={{
          width: 40,
          height: 22,
          borderRadius: 11,
          background: enabled ? 'var(--accent)' : 'var(--bg-hover)',
          border: '1px solid ' + (enabled ? 'var(--accent)' : 'var(--border)'),
          opacity: param && canWrite ? 1 : 0.55,
          cursor: param && canWrite ? 'pointer' : 'not-allowed',
        }}
      >
        <span
          className="absolute rounded-full transition-all"
          style={{
            top: 2,
            width: 16,
            height: 16,
            background: '#fff',
            left: enabled ? 21 : 3,
            boxShadow: '0 1px 3px rgba(0,0,0,.3)',
          }}
        />
      </button>
    </div>
  )
}

export default function EkfFusionPanel() {
  const { t } = useTranslation()
  const send = sendClientMessage
  const { params } = useParameterStore()
  const vehicleIdentity = useTelemetryStore((state) => state.vehicleIdentity)
  // EKF configuration writes are capability-gated by the vehicle profile so
  // PX4 EKF2 parameters are never written to a different stack.
  const ekfWritable = vehicleCapabilities(vehicleIdentity).ekfConfig
  const canWrite = useConnectionStore((state) => state.vehicleReady && state.canControl) && ekfWritable
  const previousEnabledValues = useRef(new Map<string, number>())
  const hgtRefParam = params.get(EKF2_PARAMS.EKF2_HGT_REF)

  const toggleParam = (
    label: string,
    id: string,
    isEnabled: (value: number) => boolean,
    offValue: number,
    defaultOnValue: number,
  ) => {
    const param = params.get(id)
    if (!param || !canWrite) return
    const enabled = isEnabled(param.value)
    // Disabling a fusion source removes safety-critical EKF inputs; require an
    // explicit confirmation so a stray click cannot drop e.g. GPS fusion.
    if (
      enabled
      && !window.confirm(t('ekf.confirmDisableFusion', { label }))
    ) return
    if (enabled) previousEnabledValues.current.set(id, param.value)
    const value = enabled
      ? offValue
      : (previousEnabledValues.current.get(id) ?? defaultOnValue)
    send({ type: 'param_set', data: { id, value, paramType: param.type } })
  }

  const renderToggle = (
    label: string,
    id: string,
    isEnabled = (value: number) => value > 0,
    offValue = 0,
    defaultOnValue = 1,
  ) => {
    const param = params.get(id)
    return (
      <Toggle
        label={label}
        param={param}
        enabled={param ? isEnabled(param.value) : false}
        canWrite={canWrite}
        onToggle={() => toggleParam(label, id, isEnabled, offValue, defaultOnValue)}
      />
    )
  }

  const setHgtRefParam = (value: number) => {
    if (!hgtRefParam || !canWrite) return
    const option = HGT_REF_OPTIONS.find((candidate) => candidate.value === value)
    if (
      !window.confirm(t('ekf.confirmHgtRef', { source: option ? t(option.label) : String(value) }))
    ) return
    send({
      type: 'param_set',
      data: { id: hgtRefParam.id, value, paramType: hgtRefParam.type },
    })
  }

  // ArduPilot exposes EKF3 source sets instead of PX4's EKF2 toggles. Swap
  // only the configuration controls by profile; AHRS_EKF_TYPE / EK3_ENABLE
  // are never auto-written.
  const ekfSources = ekfSourceFields(vehicleIdentity)
  const setSourceParam = (id: string, value: number) => {
    const param = params.get(id)
    if (!param || !canWrite) return
    if (
      !window.confirm(t('ekf.confirmModifySource', { id }))
    ) return
    send({ type: 'param_set', data: { id, value, paramType: param.type } })
  }

  if (ekfSources.length > 0) {
    return (
      <div className="mc-card p-5">
        <h3 className="mc-section-title mb-4">{t('ekf.ekf3SourceConfig')}</h3>
        <div className="space-y-3">
          {ekfSources.map((field) => {
            const param = params.get(field.id)
            const value = param ? Math.round(param.value) : ''
            const known = field.options.some((option) => option.value === value)
            return (
              <div key={field.id}>
                <label className="mc-section-title block mb-1.5">{field.label}<small className="mc-mono ml-2" style={{ color: 'var(--text-disabled)' }}>{field.id}</small></label>
                <select
                  className="mc-select"
                  value={value}
                  disabled={!param || !canWrite}
                  title={param ? undefined : t('ekf.paramNotAvailable')}
                  onChange={(event) => setSourceParam(field.id, Number(event.target.value))}
                >
                  {!param && <option value="">{t('ekf.paramUnavailable')}</option>}
                  {/* Preserve an unknown protocol value instead of dropping it. */}
                  {param && !known && <option value={value}>{t('ekf.valueLabel', { value })}</option>}
                  {field.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </div>
            )
          })}
        </div>
        <p className="mt-3 text-[11px]" style={{ color: 'var(--text-disabled)' }}>{t('ekf.ekf3Footnote')}</p>
      </div>
    )
  }

  return (
    <div className="mc-card p-5">
      <h3 className="mc-section-title mb-4">{t('ekf.ekf2FusionConfig')}</h3>
      <div style={{ borderTop: 'none' }}>
        {renderToggle('GPS', EKF2_PARAMS.EKF2_GPS_CTRL, undefined, 0, 7)}
        <div style={{ borderTop: '1px solid var(--border)' }}>
          {renderToggle(t('ekf.barometer'), EKF2_PARAMS.EKF2_BARO_CTRL)}
        </div>
        <div style={{ borderTop: '1px solid var(--border)' }}>
          {renderToggle(t('ekf.magnetometer'), EKF2_PARAMS.EKF2_MAG_TYPE, (value) => value !== 5, 5, 0)}
        </div>
        <div style={{ borderTop: '1px solid var(--border)' }}>
          {renderToggle(t('ekf.opticalFlow'), EKF2_PARAMS.EKF2_OF_CTRL)}
        </div>
        <div style={{ borderTop: '1px solid var(--border)' }}>
          {renderToggle(t('ekf.rangeFinder'), EKF2_PARAMS.EKF2_RNG_CTRL)}
        </div>
        <div style={{ borderTop: '1px solid var(--border)' }}>
          {renderToggle(t('ekf.vision'), EKF2_PARAMS.EKF2_EV_CTRL)}
        </div>
      </div>
      <div className="mt-4 pt-4" style={{ borderTop: '1px solid var(--border)' }}>
        <label className="mc-section-title block mb-1.5">{t('ekf.heightRefSource')}</label>
        <select
          value={hgtRefParam?.value ?? ''}
          onChange={(e) => setHgtRefParam(Number(e.target.value))}
          className="mc-select"
          disabled={!hgtRefParam || !canWrite}
          title={hgtRefParam ? undefined : t('ekf.hgtRefNotAvailable')}
        >
          {!hgtRefParam && <option value="">{t('ekf.paramUnavailable')}</option>}
          {HGT_REF_OPTIONS.map((o) => <option key={o.value} value={o.value}>{t(o.label)}</option>)}
        </select>
      </div>
      <p className="mt-3 text-[11px]" style={{ color: 'var(--text-disabled)' }}>{t('ekf.rebootRequired')}</p>
    </div>
  )
}
