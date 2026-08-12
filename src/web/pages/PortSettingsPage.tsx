import { NavLink } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
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

// Common PX4 SER_*_BAUD values (8N1). 0 keeps the firmware's auto baud.
const PX4_BAUD_OPTIONS = [
  [0, 'Auto'],
  [9600, '9600 8N1'],
  [19200, '19200 8N1'],
  [38400, '38400 8N1'],
  [57600, '57600 8N1'],
  [115200, '115200 8N1'],
  [230400, '230400 8N1'],
  [460800, '460800 8N1'],
  [921600, '921600 8N1'],
  [1500000, '1500000 8N1'],
  [3000000, '3000000 8N1'],
] as const

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

function localizedOptionLabel(label: string, t: ReturnType<typeof useTranslation>['t']): string {
  if (label === 'Disabled') return t('common.disabled')
  if (label === 'Enabled') return t('common.enabled')
  if (label === 'Auto') return t('common.auto')
  if (label === 'Auto-detected') return t('portSettings.autoDetected')
  return label
}

function ParamSelect({ id, options, writable = true }: { id: string; options: ReadonlyArray<readonly [number, string]>; writable?: boolean }) {
  const { t } = useTranslation()
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
      {!param && <option value="">{t('portSettings.waitingForParams')}</option>}
      {param && !known && <option value={value}>{t('portSettings.valueLabel', { value })}</option>}
      {options.map(([option, label]) => <option key={option} value={option}>{localizedOptionLabel(label, t)}</option>)}
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
  const { t } = useTranslation()
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
    return { instance, prefix, baudParam }
  })

  return (
    <section className="mc-port-settings mc-card">
      <header>
        <div>
          <h3>{t('portSettings.mavlinkPortInstances')}</h3>
          <p>{t('portSettings.mavlinkDescription')}</p>
        </div>
        <span>{params.size ? t('portSettings.paramsSynced') : t('portSettings.connectToRead')}</span>
      </header>

      {vehicleIdentity && !serialWritable && (
        <p className="mc-capability-note" data-state="waiting">
          {t('portSettings.serialWriteNotAdapted', { type: `${vehicleIdentity.family}/${vehicleIdentity.vehicleClass}` })}
        </p>
      )}

      <div className="mc-port-table-scroll">
        <div className="mc-port-table">
          <div className="mc-port-row mc-port-row--head">
            <span>{t('portSettings.colInstance')}</span><span>{t('common.port')}</span><span>{t('common.baudRate')}</span><span>{t('portSettings.colMode')}</span>
            <span>{t('portSettings.colRate')}</span><span>{t('portSettings.colFlowControl')}</span><span>{t('portSettings.colForward')}</span><span>{t('common.advanced')}</span>
          </div>
          {rows.map(({ instance, prefix, baudParam }) => (
            <div className="mc-port-row" key={instance}>
              <strong className="mc-port-instance">MAV{instance}</strong>
              <ParamSelect id={`${prefix}_CONFIG`} options={PORT_OPTIONS} writable={serialWritable} />
              {baudParam ? (
                <ParamSelect id={baudParam} options={PX4_BAUD_OPTIONS} writable={serialWritable} />
              ) : (
                <div className="mc-port-baud mc-mono">
                  {instance === 0 && params.get(`${prefix}_CONFIG`)?.value === 0 ? t('portSettings.noBaudParam') : '-'}
                </div>
              )}
              <ParamSelect id={`${prefix}_MODE`} options={MODE_OPTIONS} writable={serialWritable} />
              <RateInput id={`${prefix}_RATE`} writable={serialWritable} />
              <ParamSelect id={`${prefix}_RADIO_CTL`} options={RADIO_OPTIONS} writable={serialWritable} />
              <ParamSelect id={`${prefix}_FORWARD`} options={FORWARD_OPTIONS} writable={serialWritable} />
              <NavLink to="/diagnostics" className="mc-btn mc-btn-ghost">{t('portSettings.advanced')}</NavLink>
            </div>
          ))}
        </div>
      </div>
      <footer>{t('portSettings.rebootHint')}</footer>
    </section>
  )
}

function ArduPilotSerialSelect({ id, options, writable }: { id: string; options: ReadonlyArray<readonly [number, string]>; writable: boolean }) {
  const { t } = useTranslation()
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
      {!param && <option value="">{t('portSettings.waitingForParams')}</option>}
      {/* Preserve a protocol/baud value the UI does not know, never drop it. */}
      {param && !known && <option value={value}>{t('portSettings.valueLabel', { value })}</option>}
      {options.map(([option, label]) => <option key={option} value={option}>{localizedOptionLabel(label, t)}</option>)}
    </select>
  )
}

function ArduPilotSerialPorts({ params, writable }: { params: Map<string, import('../../shared/types').ParamData>; writable: boolean }) {
  const { t } = useTranslation()
  const ports = ardupilotSerialPorts(params)
  return (
    <section className="mc-port-settings mc-card">
      <header>
        <div>
          <h3>{t('portSettings.ardupilotSerial')}</h3>
          <p>{t('portSettings.ardupilotSerialDesc')}</p>
        </div>
        <span>{ports.length ? t('portSettings.serialCount', { count: ports.length }) : t('portSettings.connectToRead')}</span>
      </header>

      {!writable && (
        <p className="mc-capability-note" data-state="waiting">
          {t('portSettings.serialWriteNotAdaptedSimple')}
        </p>
      )}

      <div className="mc-port-table-scroll">
        <div className="mc-port-table">
          <div className="mc-port-row mc-port-row--head">
            <span>{t('common.port')}</span><span>{t('portSettings.colProtocol')}</span><span>{t('common.baudRate')}</span><span>{t('portSettings.colStreamRate')}</span>
          </div>
          {ports.length === 0 ? (
            <div className="mc-port-row"><span>{t('portSettings.noSerialParams')}</span></div>
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
      <footer>{t('portSettings.ardupilotRebootHint')}</footer>
    </section>
  )
}
