import { useEffect, useRef, useState } from 'react'
import { availableModes, vehicleCapabilities } from '../../shared/vehicleProfiles'
import Icon from '../components/ui/Icon'
import { PageHeader } from '../components/ui/PageFrame'
import { sendClientMessage } from '../hooks/useWebSocket'
import { useConnectionStore } from '../stores/connectionStore'
import { useSensorStore } from '../stores/sensorStore'
import { useTelemetryStore } from '../stores/telemetryStore'

export default function FlightControlPage() {
  const send = sendClientMessage
  const vehicle = useTelemetryStore((state) => state.status)
  const vehicleIdentity = useTelemetryStore((state) => state.vehicleIdentity)
  const battery = useTelemetryStore((state) => state.battery)
  const gps = useTelemetryStore((state) => state.gps)
  const ekfStatus = useTelemetryStore((state) => state.ekfStatus)
  const preflightCheck = useTelemetryStore((state) => state.preflightCheck)
  const sensorsHealthy = useTelemetryStore((state) => state.sensorsHealthy)
  const unhealthySensors = useTelemetryStore((state) => state.unhealthySensors)
  const statusLogs = useTelemetryStore((state) => state.statusLogs)
  const isTelemetryStale = useTelemetryStore((state) => state.isStale)
  const sensorHealth = useSensorStore((state) => state.sensorHealth)
  const opticalFlow = useSensorStore((state) => state.opticalFlow)
  const distanceSensor = useSensorStore((state) => state.distanceSensor)
  const isSensorStale = useSensorStore((state) => state.isStale)
  const vehicleReady = useConnectionStore((state) => state.vehicleReady)
  const canControl = useConnectionStore((state) => state.canControl)
  const connected = vehicleReady && canControl
  const [takeoffAltitude, setTakeoffAltitude] = useState(2.5)
  const [armConfirmation, setArmConfirmation] = useState(false)
  const confirmationTimer = useRef<number | null>(null)
  const armed = vehicle?.armed ?? false

  useEffect(() => () => {
    if (confirmationTimer.current !== null) window.clearTimeout(confirmationTimer.current)
  }, [])

  const arm = () => {
    if (!armConfirmation) {
      setArmConfirmation(true)
      confirmationTimer.current = window.setTimeout(() => setArmConfirmation(false), 3000)
      return
    }
    send({
      type: 'command',
      cmd: 'MAV_CMD_COMPONENT_ARM_DISARM',
      params: [1, 0, 0, 0, 0, 0, 0],
      safetyConfirmation: 'arm',
    })
    // Clear the pending 3 s reset timer so it cannot fire after a successful
    // confirmation and needlessly toggle state later.
    if (confirmationTimer.current !== null) {
      window.clearTimeout(confirmationTimer.current)
      confirmationTimer.current = null
    }
    setArmConfirmation(false)
  }

  const disarm = () => send({
    type: 'command',
    cmd: 'MAV_CMD_COMPONENT_ARM_DISARM',
    params: [0, 0, 0, 0, 0, 0, 0],
    safetyConfirmation: 'disarm',
  })
  const command = (cmd: string, params: number[]) => send({ type: 'command', cmd, params })
  const modeOptions = availableModes(vehicleIdentity)
  const caps = vehicleCapabilities(vehicleIdentity)
  const setMode = (modeId: number) =>
    send({ type: 'set_flight_mode', data: { modeId } })

  const hasGpsPosition = (gps?.fix_type ?? 0) >= 3
  const hasValidOpticalFlow = sensorHealth.opticalFlow === 'ok'
    && !isSensorStale('opticalFlow')
    && (opticalFlow?.quality ?? 0) > 0
  const hasValidRangefinder = sensorHealth.rangefinder === 'ok'
    && !isSensorStale('distanceSensor')
    && distanceSensor !== null
    && distanceSensor.current_distance >= distanceSensor.min_distance
    && distanceSensor.current_distance <= distanceSensor.max_distance
    && distanceSensor.signal_quality !== 1
  const hasFlowPosition = hasValidOpticalFlow && hasValidRangefinder
  const sysStatusFresh = !isTelemetryStale('sysStatus')
  const systemHealthLabel = unhealthySensors.length > 0
    ? `飞控系统健康（${unhealthySensors.join('、')}异常）`
    : '飞控系统健康'
  const checks = [
    { label: '位置源（GPS 或光流+测距）', ok: hasGpsPosition || hasFlowPosition },
    { label: '电池电量 > 20%', ok: (battery?.remaining ?? 0) > 20 },
    { label: 'IMU 正常', ok: sensorHealth.imu === 'ok' && !isSensorStale('imu') },
    { label: '气压计正常', ok: sensorHealth.baro === 'ok' && !isSensorStale('baro') },
    { label: 'EKF 正常', ok: ekfStatus !== null && !isTelemetryStale('ekfStatus') && ekfStatus.health_flags !== 0 },
    { label: systemHealthLabel, ok: sysStatusFresh && sensorsHealthy === true },
    ...(preflightCheck === null
      ? []
      : [{ label: '飞控预检', ok: sysStatusFresh && preflightCheck === true }]),
  ]
  const allChecksPassed = checks.every((check) => check.ok)
  const latestArmMessage = statusLogs.find((entry) =>
    /arm|arming|解锁|preflight|pre-arm/i.test(entry.text)
  )

  return (
    <div className="mc-workspace mc-workspace--standard mc-fade-in">
      <PageHeader title="飞行操作" description="集中执行解锁、模式切换和导航指令；所有写操作均要求飞控已就绪且控制权可用。" />

      {!connected && (
        <div className="mc-capability-note" data-state="waiting">
          <Icon name="warning" size={15} />
          <span>{!vehicleReady ? '等待飞控心跳，当前仅可查看保留的遥测数据。' : '另一客户端正在控制飞控，当前页面保持只读。'}</span>
        </div>
      )}

      {connected && !caps.arm && (
        <div className="mc-capability-note" data-state="waiting">
          <Icon name="warning" size={15} />
          <span>当前飞控类型（{vehicleIdentity ? `${vehicleIdentity.family}/${vehicleIdentity.vehicleClass}` : '未识别'}）尚未适配飞行控制写操作，本页仅供查看。目前仅支持 PX4 与 ArduCopter。</span>
        </div>
      )}

      <section className="mc-card overflow-hidden mt-4">
        <div className="flex flex-col gap-5 p-5 md:flex-row md:items-center">
          <span className="grid h-12 w-12 place-items-center rounded-xl" style={{ background: armed ? 'var(--success-dim)' : 'var(--bg-tertiary)', color: armed ? 'var(--success)' : 'var(--text-disabled)' }}>
            <Icon name="flight" size={23} />
          </span>
          <div className="flex-1">
            <p className="text-[18px] font-bold" style={{ color: armed ? 'var(--success)' : 'var(--text-primary)' }}>{armed ? '已解锁' : '已上锁'}</p>
            <p className="mt-1 text-[12px]" style={{ color: 'var(--text-secondary)' }}>{connected ? '当前模式：' + (vehicle?.mode ?? '—') : '飞控未连接，所有指令已锁定。'}</p>
          </div>
          {!armed && (
            <button type="button" disabled={!connected || !allChecksPassed || !caps.arm} className="mc-btn min-h-11 px-6 text-[14px]" style={{ background: armConfirmation ? 'var(--warning)' : 'var(--success)', color: '#fff', animation: armConfirmation ? 'mc-pulse 1s ease-in-out infinite' : undefined }} onClick={arm}>
              {armConfirmation ? '再次点击确认解锁' : caps.arm ? '解锁飞行器' : '解锁未适配'}
            </button>
          )}
          <button type="button" className="mc-btn mc-btn-danger min-h-11 px-6 text-[14px]" disabled={!connected || !armed || !caps.arm} onClick={disarm} title="立即发送普通上锁命令；这不是强制断电 Kill Switch。">立即上锁</button>
        </div>
      </section>

      <section className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-2">
        <div className="mc-card overflow-hidden">
          <div className="border-b px-5 py-4" style={{ borderColor: 'var(--border)' }}>
            <h2 className="text-[14px] font-bold" style={{ color: 'var(--text-primary)' }}>飞行指令</h2>
            <p className="mt-1 text-[11px]" style={{ color: 'var(--text-secondary)' }}>飞行器解锁后才可执行起飞指令。</p>
          </div>
          <div className="space-y-5 p-5">
            <div>
              <div className="flex items-center justify-between">
                <span className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>起飞高度</span>
                <span className="mc-mono font-bold" style={{ color: 'var(--accent)' }}>{takeoffAltitude.toFixed(1)}m</span>
              </div>
              <input className="mt-4" type="range" min="1" max="10" step="0.5" value={takeoffAltitude} onChange={(event) => setTakeoffAltitude(Number(event.target.value))} />
            </div>
            <div className="grid grid-cols-3 gap-3">
              <button
                type="button"
                className="mc-btn mc-btn-primary min-h-10"
                disabled={!connected || !armed || !allChecksPassed || !caps.guidedTakeoff}
                onClick={() => send({
                  type: 'command',
                  cmd: 'MAV_CMD_NAV_TAKEOFF',
                  params: [0, 0, 0, 0, 0, 0, takeoffAltitude],
                  safetyConfirmation: 'takeoff',
                })}
              >
                起飞
              </button>
              <button type="button" className="mc-btn min-h-10" disabled={!connected || !armed || !caps.setMode} style={{ background: 'var(--warning-dim)', color: 'var(--warning)' }} onClick={() => command('MAV_CMD_NAV_LAND', [0, 0, 0, 0, 0, 0, 0])}>降落</button>
              <button type="button" className="mc-btn min-h-10" disabled={!connected || !armed || !caps.setMode} style={{ background: 'var(--info-dim)', color: 'var(--info)' }} onClick={() => command('MAV_CMD_NAV_RETURN_TO_LAUNCH', [0, 0, 0, 0, 0, 0, 0])}>返航</button>
            </div>
          </div>
        </div>

        <div className="mc-card overflow-hidden">
          <div className="border-b px-5 py-4" style={{ borderColor: 'var(--border)' }}>
            <h2 className="text-[14px] font-bold" style={{ color: 'var(--text-primary)' }}>飞行模式</h2>
            <p className="mt-1 text-[11px]" style={{ color: 'var(--text-secondary)' }}>模式切换通过 MAV_CMD_DO_SET_MODE 执行。</p>
          </div>
          <div className="grid grid-cols-2 gap-2 p-5 sm:grid-cols-3">
            {modeOptions.length === 0 && (
              <p className="col-span-full text-[12px]" style={{ color: 'var(--text-secondary)' }}>
                当前飞控类型尚未适配模式切换（仅支持 PX4 与 ArduCopter）。
              </p>
            )}
            {modeOptions.map((mode) => (
              <button
                key={mode.id}
                type="button"
                disabled={!connected}
                className="mc-btn min-h-10"
                style={vehicle?.modeId === mode.id ? { background: 'var(--accent)', color: '#fff' } : { background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
                onClick={() => setMode(mode.id)}
              >
                {mode.name}
              </button>
            ))}
          </div>
        </div>
      </section>

      <section className="mt-4 grid grid-cols-1 gap-4">
        <div className="mc-card overflow-hidden">
          <div className="border-b px-5 py-4" style={{ borderColor: 'var(--border)' }}>
            <h2 className="text-[14px] font-bold" style={{ color: 'var(--text-primary)' }}>飞行前检查</h2>
          </div>
          <div className="grid grid-cols-1 gap-x-6 gap-y-3 p-5 sm:grid-cols-2">
            {checks.map((check) => (
              <div key={check.label} className="flex items-center gap-3">
                <span className="grid h-6 w-6 place-items-center rounded-lg" style={{ background: check.ok ? 'var(--success-dim)' : 'var(--danger-dim)', color: check.ok ? 'var(--success)' : 'var(--danger)' }}>
                  <Icon name={check.ok ? 'check' : 'warning'} size={14} />
                </span>
                <span className="text-[13px]" style={{ color: check.ok ? 'var(--text-primary)' : 'var(--text-secondary)' }}>{check.label}</span>
              </div>
            ))}
            <div className="col-span-full mt-2 rounded-xl px-4 py-3 text-[12px] font-semibold" style={{ background: allChecksPassed ? 'var(--success-dim)' : 'var(--warning-dim)', color: allChecksPassed ? 'var(--success)' : 'var(--warning)' }}>
              {allChecksPassed ? '所有检查通过，可以按安全流程解锁。' : '仍有检查项未通过，请确认飞控状态后再起飞。'}
            </div>
            {latestArmMessage && (
              <div className="col-span-full rounded-xl px-4 py-3 text-[11px]" style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}>
                飞控最近反馈：{latestArmMessage.text}
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  )
}
