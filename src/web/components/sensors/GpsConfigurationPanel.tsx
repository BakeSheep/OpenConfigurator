import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AutopilotFamily, ParamData } from '../../../shared/types'
import Icon from '../ui/Icon'
import { TabPanel, Tabs } from '../ui/Tabs'
import { sendRuntimeCommand } from '../../hooks/useLocalRuntime'
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

const GPS_INSTANCES = [1, 2] as const

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
  const { t } = useTranslation()
  const value = param ? Math.round(param.value) : ''
  const known = options.some(([option]) => option === value)
  return (
    <label className="mc-gps-config__field" data-disabled={disabled || !param || !writable || undefined}>
      <span><strong>{label}</strong><small>{param?.id ?? t('sensor.gps.paramUnavailable')}</small></span>
      <select
        className="mc-select"
        aria-label={param?.id ?? label}
        value={value}
        disabled={disabled || !param || !writable}
        title={hint}
        onChange={(event) => {
          if (!param) return
          sendRuntimeCommand({
            type: 'param_set',
            requestId: `gps-${param.id}-${Date.now().toString(36)}`,
            data: { id: param.id, value: Number(event.target.value), paramType: param.type },
          })
        }}
      >
        {!param && <option value="">{t('sensor.gps.waitingParam')}</option>}
        {param && !known && <option value={value}>{t('sensor.gps.valueOption', { value })}</option>}
        {options.map(([option, optionLabel]) => <option key={option} value={option}>{optionLabel}</option>)}
      </select>
      <small>{hint}</small>
    </label>
  )
}

function ReadonlyField({ label, value, paramId, hint }: { label: string; value: string; paramId?: string; hint: string }) {
  const { t } = useTranslation()
  return (
    <div className="mc-gps-config__field" data-disabled="true">
      <span><strong>{label}</strong><small>{paramId ?? t('sensor.gps.firmwareAssigned')}</small></span>
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
  const { t } = useTranslation()
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
        <span><strong>{t('sensor.gps.enableGps')}</strong><small>{config?.id ?? t('sensor.gps.paramUnavailable')}</small></span>
        <select
          className="mc-select"
          aria-label={t('sensor.gps.instanceEnableAria', { instance })}
          value={enabledParam ? Math.round(enabledParam.value) : ''}
          disabled={!config || !writable}
          title={t('sensor.gps.px4DisableHint')}
          onChange={(event) => {
            if (!config) return
            const value = Number(event.target.value) === 0 ? 0 : (configuredPort || px4GpsDefaultPort(instance))
            sendRuntimeCommand({
              type: 'param_set',
              requestId: `gps-${config.id}-${Date.now().toString(36)}`,
              data: { id: config.id, value, paramType: config.type },
            })
          }}
        >
          {!config && <option value="">{t('sensor.gps.waitingParam')}</option>}
          <option value={0}>0: {t('common.disabled')}</option>
          <option value={1}>1: {t('common.enabled')}</option>
        </select>
        <small>{t('sensor.gps.px4ConfigShared')}</small>
      </label>
      <ParameterSelect
        label={t('common.port')}
        hint={t('sensor.gps.px4PortHint')}
        param={config}
        options={PX4_GPS_PORT_OPTIONS}
        writable={writable}
        disabled={!enabled}
      />
      <ParameterSelect
        label={t('sensor.gps.protocol')}
        hint={t('sensor.gps.px4ProtocolHint')}
        param={protocol}
        options={PX4_GPS_PROTOCOL_OPTIONS}
        writable={writable}
        disabled={!enabled}
      />
      {baudId ? (
        <ParameterSelect
          label={t('common.baudRate')}
          hint={t('sensor.gps.px4BaudHint', { baudId })}
          param={baud}
          options={PX4_GPS_BAUD_OPTIONS}
          writable={writable}
          disabled={!enabled}
        />
      ) : (
        <ReadonlyField
          label={t('common.baudRate')}
          value={enabled ? t('sensor.gps.noIndependentBaud') : t('sensor.gps.notEnabled')}
          hint={t('sensor.gps.px4BaudHintEmpty')}
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
  const { t } = useTranslation()
  const type = ardupilotGpsTypeParam(params, instance)
  const enabled = Boolean(type && Math.round(type.value) !== 0)
  const needsSerial = ardupilotGpsNeedsSerial(type?.value)
  const port = needsSerial ? ardupilotGpsSerialPort(params, instance) : null
  const baud = port ? params.get(port.baudParam) : undefined
  const autoConfig = params.get('GPS_AUTO_CONFIG')

  return (
    <div className="mc-gps-config__grid">
      <label className="mc-gps-config__field" data-disabled={!type || !writable || undefined}>
        <span><strong>{t('sensor.gps.enableGps')}</strong><small>{type?.id ?? t('sensor.gps.paramUnavailable')}</small></span>
        <select
          className="mc-select"
          aria-label={t('sensor.gps.instanceEnableAria', { instance })}
          value={type ? (enabled ? 1 : 0) : ''}
          disabled={!type || !writable}
          title={t('sensor.gps.arduPilotDisableHint')}
          onChange={(event) => {
            if (!type) return
            const value = Number(event.target.value) === 0 ? 0 : (Math.round(type.value) || 1)
            sendRuntimeCommand({
              type: 'param_set',
              requestId: `gps-${type.id}-${Date.now().toString(36)}`,
              data: { id: type.id, value, paramType: type.type },
            })
          }}
        >
          {!type && <option value="">{t('sensor.gps.waitingParam')}</option>}
          <option value={0}>0: {t('common.disabled')}</option>
          <option value={1}>1: {t('common.enabled')}</option>
        </select>
        <small>{t('sensor.gps.arduPilotTypeControlHint')}</small>
      </label>
      <ParameterSelect
        label={t('sensor.gps.typeLabel')}
        hint={t('sensor.gps.arduPilotTypeHint')}
        param={type}
        options={ARDUPILOT_GPS_TYPE_OPTIONS}
        writable={writable}
        disabled={!enabled}
      />
      <ReadonlyField
        label={t('common.port')}
        value={!enabled ? t('sensor.gps.notEnabled') : !needsSerial ? t('sensor.gps.noSerialRequired') : port?.label ?? t('sensor.gps.noGpsSerialAssigned')}
        paramId={port?.protocolParam}
        hint={t('sensor.gps.arduPilotPortHint')}
      />
      {needsSerial && port ? (
        <ParameterSelect
          label={t('common.baudRate')}
          hint={t('sensor.gps.arduPilotBaudHint')}
          param={baud}
          options={ARDUPILOT_SERIAL_BAUDS}
          writable={writable}
          disabled={!enabled}
        />
      ) : (
        <ReadonlyField
          label={t('common.baudRate')}
          value={!enabled ? t('sensor.gps.notEnabled') : needsSerial ? t('sensor.gps.waitingGpsSerial') : t('sensor.gps.notApplicable')}
          hint={t('sensor.gps.arduPilotNoBaudHint')}
        />
      )}
      <ParameterSelect
        label={t('sensor.gps.autoConfig')}
        hint={t('sensor.gps.arduPilotAutoConfigHint')}
        param={autoConfig}
        options={ARDUPILOT_GPS_AUTO_CONFIG_OPTIONS}
        writable={writable}
      />
    </div>
  )
}

export default function GpsConfigurationPanel({ family, writable, compact = false }: { family: AutopilotFamily; writable: boolean; compact?: boolean }) {
  const { t } = useTranslation()
  const [instance, setInstance] = useState<1 | 2>(1)
  const params = useParameterStore((state) => state.params)
  const canControl = useConnectionStore((state) => state.vehicleReady && state.canControl)
  const canWrite = canControl && writable

  return (
    <section className={`mc-card mc-gps-config${compact ? ' mc-gps-config--compact' : ''}`}>
      <header>
        <div><h3>{t('sensor.gps.configTitle')}</h3></div>
        <span>{family === 'px4' ? 'PX4' : family === 'ardupilot' ? 'ArduPilot' : t('sensor.gps.waitingFcIdentify')}</span>
      </header>
      <Tabs
        tabs={GPS_INSTANCES.map((item) => ({ id: String(item), label: `GPS ${item}` }))}
        active={String(instance)}
        onChange={(id) => setInstance(id === '2' ? 2 : 1)}
        ariaLabel={t('sensor.gps.instanceAria')}
        idBase="gps-configuration"
        className="mc-gps-config__tabs"
      />
      {GPS_INSTANCES.map((item) => (
        <TabPanel
          key={item}
          idBase="gps-configuration"
          tabId={String(item)}
          hidden={instance !== item}
          tabIndex={instance === item ? 0 : -1}
        >
          {family === 'px4' && <Px4GpsFields instance={item} writable={canWrite} params={params} />}
          {family === 'ardupilot' && <ArduPilotGpsFields instance={item} writable={canWrite} params={params} />}
          {family === 'unknown' && <p className="mc-gps-config__empty">{t('sensor.gps.emptyHint')}</p>}
        </TabPanel>
      ))}
      <footer><Icon name="warning" size={14} /><span>{t('sensor.gps.footerHint')}</span></footer>
    </section>
  )
}
