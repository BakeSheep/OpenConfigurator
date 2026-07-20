import { useState } from 'react'
import { useWebSocket } from '../../hooks/useWebSocket'
import { useParameterStore } from '../../stores/parameterStore'
import { EKF2_PARAMS, HGT_REF_OPTIONS } from '../../../shared/constants'

function Toggle({ label, paramId, enabled, onToggle }: { label: string; paramId: string; enabled: boolean; onToggle: (id: string, val: number) => void }) {
  return (
    <div className="flex items-center justify-between py-2.5">
      <span className="text-[13px]" style={{ color: 'var(--text-primary)' }}>{label}</span>
      <button
        onClick={() => onToggle(paramId, enabled ? 0 : 1)}
        className="relative transition-colors"
        style={{
          width: 40,
          height: 22,
          borderRadius: 11,
          background: enabled ? 'var(--accent)' : 'var(--bg-hover)',
          border: '1px solid ' + (enabled ? 'var(--accent)' : 'var(--border)'),
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
  const { send } = useWebSocket()
  const { params } = useParameterStore()
  const [hgtRef, setHgtRef] = useState(0)

  const getParamValue = (id: string) => params.get(id)?.value ?? 0
  const toggleParam = (id: string, val: number) => send({ type: 'param_set', data: { id, value: val, paramType: 9 } })
  const setHgtRefParam = (val: number) => { setHgtRef(val); send({ type: 'param_set', data: { id: EKF2_PARAMS.EKF2_HGT_REF, value: val, paramType: 9 } }) }

  return (
    <div className="mc-card p-5">
      <h3 className="mc-section-title mb-4">EKF2 融合配置</h3>
      <div style={{ borderTop: 'none' }}>
        <Toggle label="GPS" paramId={EKF2_PARAMS.EKF2_GPS_CTRL} enabled={getParamValue(EKF2_PARAMS.EKF2_GPS_CTRL) > 0} onToggle={toggleParam} />
        <div style={{ borderTop: '1px solid var(--border)' }}>
          <Toggle label="气压计" paramId={EKF2_PARAMS.EKF2_BARO_CTRL} enabled={getParamValue(EKF2_PARAMS.EKF2_BARO_CTRL) > 0} onToggle={toggleParam} />
        </div>
        <div style={{ borderTop: '1px solid var(--border)' }}>
          <Toggle label="磁力计" paramId={EKF2_PARAMS.EKF2_MAG_CTRL} enabled={getParamValue(EKF2_PARAMS.EKF2_MAG_CTRL) > 0} onToggle={toggleParam} />
        </div>
        <div style={{ borderTop: '1px solid var(--border)' }}>
          <Toggle label="光流" paramId={EKF2_PARAMS.EKF2_OF_CTRL} enabled={getParamValue(EKF2_PARAMS.EKF2_OF_CTRL) > 0} onToggle={toggleParam} />
        </div>
        <div style={{ borderTop: '1px solid var(--border)' }}>
          <Toggle label="测距仪" paramId={EKF2_PARAMS.EKF2_RNG_CTRL} enabled={getParamValue(EKF2_PARAMS.EKF2_RNG_CTRL) > 0} onToggle={toggleParam} />
        </div>
        <div style={{ borderTop: '1px solid var(--border)' }}>
          <Toggle label="视觉" paramId={EKF2_PARAMS.EKF2_EV_CTRL} enabled={getParamValue(EKF2_PARAMS.EKF2_EV_CTRL) > 0} onToggle={toggleParam} />
        </div>
      </div>
      <div className="mt-4 pt-4" style={{ borderTop: '1px solid var(--border)' }}>
        <label className="mc-section-title block mb-1.5">高度参考源</label>
        <select value={hgtRef} onChange={(e) => setHgtRefParam(Number(e.target.value))} className="mc-select">
          {HGT_REF_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </div>
      <p className="mt-3 text-[11px]" style={{ color: 'var(--text-disabled)' }}>修改后需重启飞控生效</p>
    </div>
  )
}
