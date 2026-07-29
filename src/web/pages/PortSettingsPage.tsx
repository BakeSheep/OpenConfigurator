import { NavLink } from 'react-router-dom'
import { sendClientMessage } from '../hooks/useWebSocket'
import { useParameterStore } from '../stores/parameterStore'
import { useConnectionStore } from '../stores/connectionStore'

const PORT_OPTIONS = [
  [0, 'Disabled'],
  [101, 'TELEM 1'],
  [102, 'TELEM 2'],
  [103, 'TELEM 3'],
  [104, 'TELEM/SERIAL 4'],
  [201, 'GPS 1'],
  [202, 'GPS 2'],
  [401, 'EXT 2'],
  [1000, 'USB'],
] as const

const MODE_OPTIONS = [
  [0, 'Normal'],
  [1, 'Custom'],
  [2, 'Onboard'],
  [7, 'Minimal'],
  [8, 'External Vision'],
  [10, 'Onboard Low Bandwidth'],
  [12, 'Onboard High Bandwidth'],
] as const

const RADIO_OPTIONS = [[0, 'Disabled'], [1, 'Enabled'], [2, 'Auto-detected']] as const
const FORWARD_OPTIONS = [[0, 'Disabled'], [1, 'Enabled']] as const

const BAUD_PARAMS: Record<number, string> = {
  101: 'SER_TEL1_BAUD',
  102: 'SER_TEL2_BAUD',
  103: 'SER_TEL3_BAUD',
  104: 'SER_TEL4_BAUD',
  201: 'SER_GPS1_BAUD',
  202: 'SER_GPS2_BAUD',
  401: 'SER_EXT2_BAUD',
}

const baudParamForPort = (portValue: number | undefined) => BAUD_PARAMS[portValue ?? -1]

function ParamSelect({ id, options }: { id: string; options: ReadonlyArray<readonly [number, string]> }) {
  const param = useParameterStore((state) => state.params.get(id))
  const canWrite = useConnectionStore((state) => state.vehicleReady && state.canControl)
  const send = sendClientMessage
  const value = param ? Math.round(param.value) : ''
  const known = options.some(([option]) => option === value)

  return (
    <select
      className="mc-select"
      aria-label={id}
      value={value}
      disabled={!param || !canWrite}
      onChange={(event) => {
        if (!param) return
        send({ type: 'param_set', data: { id, value: Number(event.target.value), paramType: param.type } })
      }}
    >
      {!param && <option value="">等待参数</option>}
      {param && !known && <option value={value}>值 {value}</option>}
      {options.map(([option, label]) => <option key={option} value={option}>{label}</option>)}
    </select>
  )
}

function RateInput({ id }: { id: string }) {
  const param = useParameterStore((state) => state.params.get(id))
  const canWrite = useConnectionStore((state) => state.vehicleReady && state.canControl)
  const send = sendClientMessage
  return (
    <input
      key={`${id}-${param?.value ?? 'empty'}`}
      className="mc-input mc-mono"
      aria-label={id}
      defaultValue={param ? Math.round(param.value) : ''}
      placeholder="—"
      disabled={!param || !canWrite}
      onBlur={(event) => {
        if (!param) return
        const raw = event.target.value.trim()
        // An emptied field means "abandon the edit", not "write zero": Number('')
        // coerces to 0 and would silently zero the rate parameter.
        if (raw === '') {
          event.target.value = String(Math.round(param.value))
          return
        }
        const value = Math.round(Number(raw))
        if (!Number.isFinite(value) || value < 0) {
          event.target.value = String(Math.round(param.value))
          return
        }
        if (value !== param.value) {
          send({ type: 'param_set', data: { id, value, paramType: param.type } })
        }
      }}
    />
  )
}

export default function PortSettingsPage() {
  const params = useParameterStore((state) => state.params)
  const rows = [0, 1, 2].map((instance) => {
    const prefix = `MAV_${instance}`
    const portValue = params.get(`${prefix}_CONFIG`)?.value
    const baudParam = baudParamForPort(portValue)
    const baudValue = baudParam ? params.get(baudParam)?.value : undefined
    return { instance, prefix, baudValue }
  })

  return (
    <section className="mc-port-settings mc-card">
      <header>
        <div>
          <h2>MAVLink 端口实例</h2>
          <p>配置端口分配、消息模式与链路速率。修改值会直接写入对应 PX4 参数。</p>
        </div>
        <span>{params.size ? '参数已同步' : '连接飞控后读取配置'}</span>
      </header>

      <div className="mc-port-table-scroll">
        <div className="mc-port-table">
          <div className="mc-port-row mc-port-row--head">
            <span>实例</span><span>端口</span><span>波特率</span><span>模式</span>
            <span>速率</span><span>流控</span><span>转发</span><span>高级</span>
          </div>
          {rows.map(({ instance, prefix, baudValue }) => (
            <div className="mc-port-row" key={instance}>
              <strong className="mc-port-instance">MAV{instance}</strong>
              <ParamSelect id={`${prefix}_CONFIG`} options={PORT_OPTIONS} />
              <div className="mc-port-baud mc-mono">
                {baudValue ? `${Math.round(baudValue)} 8N1` : instance === 0 && params.get(`${prefix}_CONFIG`)?.value === 0 ? '无波特率参数' : '—'}
              </div>
              <ParamSelect id={`${prefix}_MODE`} options={MODE_OPTIONS} />
              <RateInput id={`${prefix}_RATE`} />
              <ParamSelect id={`${prefix}_RADIO_CTL`} options={RADIO_OPTIONS} />
              <ParamSelect id={`${prefix}_FORWARD`} options={FORWARD_OPTIONS} />
              <NavLink to="/diagnostics" className="mc-btn mc-btn-ghost">高级</NavLink>
            </div>
          ))}
        </div>
      </div>
      <footer>端口或波特率更改通常需要重启飞控后生效。</footer>
    </section>
  )
}
