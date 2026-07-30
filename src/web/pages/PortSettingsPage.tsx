import { NavLink } from 'react-router-dom'
import { vehicleCapabilities } from '../../shared/vehicleProfiles'
import {
  ardupilotSerialPorts,
  ARDUPILOT_SERIAL_PROTOCOLS,
  ARDUPILOT_SERIAL_BAUDS,
} from '../utils/parameterProfiles'
import { sendClientMessage } from '../hooks/useWebSocket'
import { useParameterStore } from '../stores/parameterStore'
import { useConnectionStore } from '../stores/connectionStore'
import { useTelemetryStore } from '../stores/telemetryStore'

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

function ParamSelect({ id, options, writable = true }: { id: string; options: ReadonlyArray<readonly [number, string]>; writable?: boolean }) {
  const param = useParameterStore((state) => state.params.get(id))
  const canWrite = useConnectionStore((state) => state.vehicleReady && state.canControl) && writable
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

function RateInput({ id, writable = true }: { id: string; writable?: boolean }) {
  const param = useParameterStore((state) => state.params.get(id))
  const canWrite = useConnectionStore((state) => state.vehicleReady && state.canControl) && writable
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
  const vehicleIdentity = useTelemetryStore((state) => state.vehicleIdentity)
  const serialWritable = vehicleCapabilities(vehicleIdentity).serialConfig
  // ArduPilot exposes SERIALx_* ports; PX4 uses the MAV_x instance layout.
  if (vehicleIdentity?.family === 'ardupilot') {
    return <ArduPilotSerialPorts params={params} writable={serialWritable} />
  }
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

      {vehicleIdentity && !serialWritable && (
        <p className="mc-capability-note" data-state="waiting">
          当前飞控类型（{vehicleIdentity.family}/{vehicleIdentity.vehicleClass}）尚未适配串口配置写入，控件仅供查看。
        </p>
      )}

      <div className="mc-port-table-scroll">
        <div className="mc-port-table">
          <div className="mc-port-row mc-port-row--head">
            <span>实例</span><span>端口</span><span>波特率</span><span>模式</span>
            <span>速率</span><span>流控</span><span>转发</span><span>高级</span>
          </div>
          {rows.map(({ instance, prefix, baudValue }) => (
            <div className="mc-port-row" key={instance}>
              <strong className="mc-port-instance">MAV{instance}</strong>
              <ParamSelect id={`${prefix}_CONFIG`} options={PORT_OPTIONS} writable={serialWritable} />
              <div className="mc-port-baud mc-mono">
                {baudValue ? `${Math.round(baudValue)} 8N1` : instance === 0 && params.get(`${prefix}_CONFIG`)?.value === 0 ? '无波特率参数' : '—'}
              </div>
              <ParamSelect id={`${prefix}_MODE`} options={MODE_OPTIONS} writable={serialWritable} />
              <RateInput id={`${prefix}_RATE`} writable={serialWritable} />
              <ParamSelect id={`${prefix}_RADIO_CTL`} options={RADIO_OPTIONS} writable={serialWritable} />
              <ParamSelect id={`${prefix}_FORWARD`} options={FORWARD_OPTIONS} writable={serialWritable} />
              <NavLink to="/diagnostics" className="mc-btn mc-btn-ghost">高级</NavLink>
            </div>
          ))}
        </div>
      </div>
      <footer>端口或波特率更改通常需要重启飞控后生效。</footer>
    </section>
  )
}

function ArduPilotSerialSelect({ id, options, writable }: { id: string; options: ReadonlyArray<readonly [number, string]>; writable: boolean }) {
  const param = useParameterStore((state) => state.params.get(id))
  const canWrite = useConnectionStore((state) => state.vehicleReady && state.canControl) && writable
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
      {/* Preserve a protocol/baud value the UI does not know, never drop it. */}
      {param && !known && <option value={value}>值 {value}</option>}
      {options.map(([option, label]) => <option key={option} value={option}>{label}</option>)}
    </select>
  )
}

function ArduPilotSerialPorts({ params, writable }: { params: Map<string, import('../../shared/types').ParamData>; writable: boolean }) {
  const ports = ardupilotSerialPorts(params)
  return (
    <section className="mc-port-settings mc-card">
      <header>
        <div>
          <h2>ArduPilot 串口</h2>
          <p>配置各 SERIALx 端口的协议与波特率。仅显示飞控实际返回的 SERIALx 参数。</p>
        </div>
        <span>{ports.length ? `${ports.length} 个串口` : '连接飞控后读取配置'}</span>
      </header>

      {!writable && (
        <p className="mc-capability-note" data-state="waiting">
          当前飞控类型尚未适配串口配置写入，控件仅供查看。
        </p>
      )}

      <div className="mc-port-table-scroll">
        <div className="mc-port-table">
          <div className="mc-port-row mc-port-row--head">
            <span>端口</span><span>协议</span><span>波特率</span><span>流数据速率 (SRx_*)</span>
          </div>
          {ports.length === 0 ? (
            <div className="mc-port-row"><span>暂无 SERIALx 参数</span></div>
          ) : ports.map((port) => (
            <div className="mc-port-row" key={port.index}>
              <strong className="mc-port-instance">{port.label}</strong>
              <ArduPilotSerialSelect id={port.protocolParam} options={ARDUPILOT_SERIAL_PROTOCOLS} writable={writable} />
              <ArduPilotSerialSelect id={port.baudParam} options={ARDUPILOT_SERIAL_BAUDS} writable={writable} />
              <div className="mc-port-baud mc-mono">
                {port.streamRateParams.length === 0
                  ? '—'
                  : port.streamRateParams
                    .map((id) => `${id.replace(/^SR\d+_/, '')}:${Math.round(params.get(id)?.value ?? 0)}`)
                    .join('  ')}
              </div>
            </div>
          ))}
        </div>
      </div>
      <footer>协议或波特率更改通常需要重启飞控后生效；SRx_* 流数据速率此处仅供查看。</footer>
    </section>
  )
}
