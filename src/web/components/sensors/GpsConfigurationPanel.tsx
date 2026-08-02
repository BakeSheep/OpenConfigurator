import { useState } from 'react'
import type { AutopilotFamily, ParamData } from '../../../shared/types'
import Icon from '../ui/Icon'
import { sendClientMessage } from '../../hooks/useWebSocket'
import { useConnectionStore } from '../../stores/connectionStore'
import { useParameterStore } from '../../stores/parameterStore'
import { ARDUPILOT_SERIAL_BAUDS } from '../../utils/parameterProfiles'
import {
  ARDUPILOT_GPS_AUTO_CONFIG_OPTIONS,
  ARDUPILOT_GPS_TYPE_OPTIONS,
  PX4_GPS_BAUD_OPTIONS,
  PX4_GPS_PORT_OPTIONS,
  PX4_GPS_PROTOCOL_OPTIONS,
  ardupilotGpsNeedsSerial,
  ardupilotGpsSerialPort,
  ardupilotGpsTypeParam,
  px4GpsBaudParam,
  px4GpsDefaultPort,
  type NumericOption,
} from '../../utils/gpsConfiguration'

function ParameterSelect({
  label,
  hint,
  param,
  options,
  writable,
  disabled = false,
}: {
  label: string
  hint: string
  param: ParamData | undefined
  options: ReadonlyArray<NumericOption>
  writable: boolean
  disabled?: boolean
}) {
  const value = param ? Math.round(param.value) : ''
  const known = options.some(([option]) => option === value)
  return (
    <label className="mc-gps-config__field" data-disabled={disabled || !param || !writable || undefined}>
      <span><strong>{label}</strong><small>{param?.id ?? '参数不可用'}</small></span>
      <select
        className="mc-select"
        aria-label={param?.id ?? label}
        value={value}
        disabled={disabled || !param || !writable}
        title={hint}
        onChange={(event) => {
          if (!param) return
          sendClientMessage({
            type: 'param_set',
            requestId: `gps-${param.id}-${Date.now().toString(36)}`,
            data: { id: param.id, value: Number(event.target.value), paramType: param.type },
          })
        }}
      >
        {!param && <option value="">等待参数</option>}
        {param && !known && <option value={value}>值 {value}</option>}
        {options.map(([option, optionLabel]) => <option key={option} value={option}>{optionLabel}</option>)}
      </select>
      <small>{hint}</small>
    </label>
  )
}

function ReadonlyField({ label, value, paramId, hint }: { label: string; value: string; paramId?: string; hint: string }) {
  return (
    <div className="mc-gps-config__field" data-disabled="true">
      <span><strong>{label}</strong><small>{paramId ?? '由固件分配'}</small></span>
      <div className="mc-gps-config__readonly mc-mono">{value}</div>
      <small>{hint}</small>
    </div>
  )
}

function Px4GpsFields({ instance, writable, params }: {
  instance: 1 | 2
  writable: boolean
  params: Map<string, ParamData>
}) {
  const config = params.get(`GPS_${instance}_CONFIG`)
  const protocol = params.get(`GPS_${instance}_PROTOCOL`)
  const configuredPort = config ? Math.round(config.value) : 0
  const enabled = configuredPort !== 0
  const baudId = px4GpsBaudParam(configuredPort)
  const baud = baudId ? params.get(baudId) : undefined
  const enabledParam = config ? { ...config, value: enabled ? 1 : 0 } : undefined

  return (
    <div className="mc-gps-config__grid">
      <label className="mc-gps-config__field" data-disabled={!config || !writable || undefined}>
        <span><strong>启用 GPS</strong><small>{config?.id ?? '参数不可用'}</small></span>
        <select
          className="mc-select"
          aria-label={`GPS ${instance} 启用状态`}
          value={enabledParam ? Math.round(enabledParam.value) : ''}
          disabled={!config || !writable}
          title="PX4 使用 GPS_n_CONFIG=0 禁用实例；启用时恢复到该实例的标准 GPS 端口。"
          onChange={(event) => {
            if (!config) return
            const value = Number(event.target.value) === 0 ? 0 : (configuredPort || px4GpsDefaultPort(instance))
            sendClientMessage({
              type: 'param_set',
              requestId: `gps-${config.id}-${Date.now().toString(36)}`,
              data: { id: config.id, value, paramType: config.type },
            })
          }}
        >
          {!config && <option value="">等待参数</option>}
          <option value={0}>0: Disabled</option>
          <option value={1}>1: Enabled</option>
        </select>
        <small>禁用和端口选择共用 PX4 的 GPS_n_CONFIG 参数。</small>
      </label>
      <ParameterSelect
        label="端口"
        hint="配置运行该 GPS 驱动的 PX4 串口；更改后需要重启。"
        param={config}
        options={PX4_GPS_PORT_OPTIONS}
        writable={writable}
        disabled={!enabled}
      />
      <ParameterSelect
        label="协议"
        hint="Auto detect 会依次探测支持的串行 GPS 协议。"
        param={protocol}
        options={PX4_GPS_PROTOCOL_OPTIONS}
        writable={writable}
        disabled={!enabled}
      />
      {baudId ? (
        <ParameterSelect
          label="波特率"
          hint={`波特率属于当前物理端口（${baudId}）；GPS 驱动通常可自动探测。`}
          param={baud}
          options={PX4_GPS_BAUD_OPTIONS}
          writable={writable}
          disabled={!enabled}
        />
      ) : (
        <ReadonlyField
          label="波特率"
          value={enabled ? '此端口无独立波特率参数' : '未启用'}
          hint="选择具有 SER_*_BAUD 参数的物理串口后可配置。"
        />
      )}
    </div>
  )
}

function ArduPilotGpsFields({ instance, writable, params }: {
  instance: 1 | 2
  writable: boolean
  params: Map<string, ParamData>
}) {
  const type = ardupilotGpsTypeParam(params, instance)
  const enabled = Boolean(type && Math.round(type.value) !== 0)
  const needsSerial = ardupilotGpsNeedsSerial(type?.value)
  const port = needsSerial ? ardupilotGpsSerialPort(params, instance) : null
  const baud = port ? params.get(port.baudParam) : undefined
  const autoConfig = params.get('GPS_AUTO_CONFIG')

  return (
    <div className="mc-gps-config__grid">
      <label className="mc-gps-config__field" data-disabled={!type || !writable || undefined}>
        <span><strong>启用 GPS</strong><small>{type?.id ?? '参数不可用'}</small></span>
        <select
          className="mc-select"
          aria-label={`GPS ${instance} 启用状态`}
          value={type ? (enabled ? 1 : 0) : ''}
          disabled={!type || !writable}
          title="ArduPilot 以 GPSn_TYPE=0 禁用实例；重新启用时使用 Auto 类型。"
          onChange={(event) => {
            if (!type) return
            const value = Number(event.target.value) === 0 ? 0 : (Math.round(type.value) || 1)
            sendClientMessage({
              type: 'param_set',
              requestId: `gps-${type.id}-${Date.now().toString(36)}`,
              data: { id: type.id, value, paramType: type.type },
            })
          }}
        >
          {!type && <option value="">等待参数</option>}
          <option value={0}>0: Disabled</option>
          <option value={1}>1: Enabled</option>
        </select>
        <small>ArduPilot 使用 GPSn_TYPE=0/非零控制该实例。</small>
      </label>
      <ParameterSelect
        label="GPS 类型"
        hint="这是接收机/传输类型，不是 PX4 的协议编号；更改后需要重启。"
        param={type}
        options={ARDUPILOT_GPS_TYPE_OPTIONS}
        writable={writable}
        disabled={!enabled}
      />
      <ReadonlyField
        label="端口"
        value={!enabled ? '未启用' : !needsSerial ? '无需串口' : port?.label ?? '未分配 GPS 串口'}
        paramId={port?.protocolParam}
        hint="ArduPilot 按 SERIALx_PROTOCOL=5 的先后顺序分配 GPS1/GPS2；请在“端口”页面修改。"
      />
      {needsSerial && port ? (
        <ParameterSelect
          label="波特率"
          hint="ArduPilot SERIALx_BAUD 使用千波特简码；GPS 驱动也会尝试自动探测。"
          param={baud}
          options={ARDUPILOT_SERIAL_BAUDS}
          writable={writable}
          disabled={!enabled}
        />
      ) : (
        <ReadonlyField
          label="波特率"
          value={!enabled ? '未启用' : needsSerial ? '等待 GPS 串口' : '不适用'}
          hint="DroneCAN、MAVLink、MSP、HIL 与 External AHRS 类型不使用 SERIALx 波特率。"
        />
      )}
      <ParameterSelect
        label="自动配置"
        hint="该参数对两个 GPS 实例全局生效；选项来自 ArduPilot 官方定义。"
        param={autoConfig}
        options={ARDUPILOT_GPS_AUTO_CONFIG_OPTIONS}
        writable={writable}
      />
    </div>
  )
}

export default function GpsConfigurationPanel({ family, writable, compact = false }: { family: AutopilotFamily; writable: boolean; compact?: boolean }) {
  const [instance, setInstance] = useState<1 | 2>(1)
  const params = useParameterStore((state) => state.params)
  const canControl = useConnectionStore((state) => state.vehicleReady && state.canControl)
  const canWrite = canControl && writable

  return (
    <section className={`mc-card mc-gps-config${compact ? ' mc-gps-config--compact' : ''}`}>
      <header>
        <div><span className="mc-eyebrow">CONFIGURATION</span><h2>GPS 参数设置</h2></div>
        <span>{family === 'px4' ? 'PX4' : family === 'ardupilot' ? 'ArduPilot' : '等待识别飞控'}</span>
      </header>
      <div className="mc-gps-config__tabs" role="tablist" aria-label="GPS 实例">
        {([1, 2] as const).map((item) => (
          <button key={item} type="button" role="tab" aria-selected={instance === item} data-active={instance === item} onClick={() => setInstance(item)}>
            GPS {item}
          </button>
        ))}
      </div>
      {family === 'px4' && <Px4GpsFields instance={instance} writable={canWrite} params={params} />}
      {family === 'ardupilot' && <ArduPilotGpsFields instance={instance} writable={canWrite} params={params} />}
      {family === 'unknown' && <p className="mc-gps-config__empty">连接并识别 PX4 或受支持的 ArduPilot 飞控后显示 GPS 配置。</p>}
      <footer><Icon name="warning" size={14} /><span>GPS 类型、协议、端口或波特率更改通常需要重启飞控后生效。</span></footer>
    </section>
  )
}
