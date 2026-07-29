import { useRef } from 'react'
import { sendClientMessage } from '../../hooks/useWebSocket'
import { useParameterStore } from '../../stores/parameterStore'
import { EKF2_PARAMS, HGT_REF_OPTIONS } from '../../../shared/constants'
import type { ParamData } from '../../../shared/types'
import { useConnectionStore } from '../../stores/connectionStore'

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
  return (
    <div className="flex items-center justify-between py-2.5">
      <span className="text-[13px]" style={{ color: 'var(--text-primary)' }}>{label}</span>
      <button
        type="button"
        onClick={onToggle}
        disabled={!param || !canWrite}
        title={param ? undefined : '当前固件未提供此参数'}
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
  const send = sendClientMessage
  const { params } = useParameterStore()
  const canWrite = useConnectionStore((state) => state.vehicleReady && state.canControl)
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
      && !window.confirm(`确认关闭 ${label} 融合？EKF 将失去该数据源（重启飞控后生效）。`)
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
      !window.confirm(`确认将高度参考源切换为“${option?.label ?? value}”？重启飞控后生效。`)
    ) return
    send({
      type: 'param_set',
      data: { id: hgtRefParam.id, value, paramType: hgtRefParam.type },
    })
  }

  return (
    <div className="mc-card p-5">
      <h3 className="mc-section-title mb-4">EKF2 融合配置</h3>
      <div style={{ borderTop: 'none' }}>
        {renderToggle('GPS', EKF2_PARAMS.EKF2_GPS_CTRL, undefined, 0, 7)}
        <div style={{ borderTop: '1px solid var(--border)' }}>
          {renderToggle('气压计', EKF2_PARAMS.EKF2_BARO_CTRL)}
        </div>
        <div style={{ borderTop: '1px solid var(--border)' }}>
          {renderToggle('磁力计', EKF2_PARAMS.EKF2_MAG_TYPE, (value) => value !== 5, 5, 0)}
        </div>
        <div style={{ borderTop: '1px solid var(--border)' }}>
          {renderToggle('光流', EKF2_PARAMS.EKF2_OF_CTRL)}
        </div>
        <div style={{ borderTop: '1px solid var(--border)' }}>
          {renderToggle('测距仪', EKF2_PARAMS.EKF2_RNG_CTRL)}
        </div>
        <div style={{ borderTop: '1px solid var(--border)' }}>
          {renderToggle('视觉', EKF2_PARAMS.EKF2_EV_CTRL)}
        </div>
      </div>
      <div className="mt-4 pt-4" style={{ borderTop: '1px solid var(--border)' }}>
        <label className="mc-section-title block mb-1.5">高度参考源</label>
        <select
          value={hgtRefParam?.value ?? ''}
          onChange={(e) => setHgtRefParam(Number(e.target.value))}
          className="mc-select"
          disabled={!hgtRefParam || !canWrite}
          title={hgtRefParam ? undefined : '当前固件未提供 EKF2_HGT_REF'}
        >
          {!hgtRefParam && <option value="">参数不可用</option>}
          {HGT_REF_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </div>
      <p className="mt-3 text-[11px]" style={{ color: 'var(--text-disabled)' }}>修改后需重启飞控生效</p>
    </div>
  )
}
