import { useEffect, useRef, useState } from 'react'
import { PX4_MODES } from '../../shared/constants'
import Icon from '../components/ui/Icon'
import { PageHeader } from '../components/ui/PageFrame'
import { useWebSocket } from '../hooks/useWebSocket'
import { useConnectionStore } from '../stores/connectionStore'
import { useSensorStore } from '../stores/sensorStore'
import { useTelemetryStore } from '../stores/telemetryStore'

export default function FlightControlPage() {
  const { send } = useWebSocket()
  const vehicle = useTelemetryStore((state) => state.status)
  const battery = useTelemetryStore((state) => state.battery)
  const gps = useTelemetryStore((state) => state.gps)
  const ekfStatus = useTelemetryStore((state) => state.ekfStatus)
  const sensorHealth = useSensorStore((state) => state.sensorHealth)
  const connected = useConnectionStore((state) => state.status === 'connected')
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
    send({ type: 'command', cmd: 'MAV_CMD_COMPONENT_ARM_DISARM', params: [1, 0, 0, 0, 0, 0, 0] })
    setArmConfirmation(false)
  }

  const disarm = () => send({ type: 'command', cmd: 'MAV_CMD_COMPONENT_ARM_DISARM', params: [0, 0, 0, 0, 0, 0, 0] })
  const command = (cmd: string, params: number[]) => send({ type: 'command', cmd, params })
  const setMode = (modeId: number) => command('MAV_CMD_DO_SET_MODE', [1, modeId, 0, 0, 0, 0, 0])

  const checks = [
    { label: 'GPS 锁定', ok: (gps?.fix_type ?? 0) >= 3 },
    { label: '电池电量 > 20%', ok: (battery?.remaining ?? 0) > 20 },
    { label: 'IMU 正常', ok: sensorHealth.imu === 'ok' },
    { label: '气压计正常', ok: sensorHealth.baro === 'ok' },
    { label: 'EKF 正常', ok: Boolean(ekfStatus) },
  ]
  const allChecksPassed = checks.every((check) => check.ok)

  return (
    <div className="mc-workspace mc-fade-in">
      <PageHeader title="飞行控制" description="解锁、起飞、模式切换与飞行前安全检查" />

      <section className="mc-card overflow-hidden">
        <div className="flex flex-col gap-5 p-5 md:flex-row md:items-center">
          <span className="grid h-12 w-12 place-items-center rounded-xl" style={{ background: armed ? 'var(--success-dim)' : 'var(--bg-tertiary)', color: armed ? 'var(--success)' : 'var(--text-disabled)' }}>
            <Icon name="flight" size={23} />
          </span>
          <div className="flex-1">
            <p className="text-[18px] font-bold" style={{ color: armed ? 'var(--success)' : 'var(--text-primary)' }}>{armed ? '已解锁' : '已上锁'}</p>
            <p className="mt-1 text-[12px]" style={{ color: 'var(--text-secondary)' }}>{connected ? '当前模式：' + (vehicle?.mode ?? '—') : '飞控未连接，所有指令已锁定。'}</p>
          </div>
          {!armed ? (
            <button type="button" disabled={!connected} className="mc-btn min-h-11 px-6 text-[14px]" style={{ background: armConfirmation ? 'var(--warning)' : 'var(--success)', color: '#fff', animation: armConfirmation ? 'mc-pulse 1s ease-in-out infinite' : undefined }} onClick={arm}>
              {armConfirmation ? '再次点击确认解锁' : '解锁飞行器'}
            </button>
          ) : (
            <button type="button" className="mc-btn mc-btn-danger min-h-11 px-6 text-[14px]" onClick={disarm}>上锁飞行器</button>
          )}
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
              <button type="button" className="mc-btn mc-btn-primary min-h-10" disabled={!connected || !armed} onClick={() => command('MAV_CMD_NAV_TAKEOFF', [0, 0, 0, 0, 0, 0, takeoffAltitude])}>起飞</button>
              <button type="button" className="mc-btn min-h-10" disabled={!connected} style={{ background: 'var(--warning-dim)', color: 'var(--warning)' }} onClick={() => command('MAV_CMD_NAV_LAND', [0, 0, 0, 0, 0, 0, 0])}>降落</button>
              <button type="button" className="mc-btn min-h-10" disabled={!connected} style={{ background: 'var(--info-dim)', color: 'var(--info)' }} onClick={() => command('MAV_CMD_NAV_RETURN_TO_LAUNCH', [0, 0, 0, 0, 0, 0, 0])}>返航</button>
            </div>
          </div>
        </div>

        <div className="mc-card overflow-hidden">
          <div className="border-b px-5 py-4" style={{ borderColor: 'var(--border)' }}>
            <h2 className="text-[14px] font-bold" style={{ color: 'var(--text-primary)' }}>飞行模式</h2>
            <p className="mt-1 text-[11px]" style={{ color: 'var(--text-secondary)' }}>模式切换通过 MAV_CMD_DO_SET_MODE 执行。</p>
          </div>
          <div className="grid grid-cols-2 gap-2 p-5 sm:grid-cols-3">
            {Object.values(PX4_MODES).map((mode) => (
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

      <section className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-[1fr_0.75fr]">
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
          </div>
        </div>

        <div className="mc-card overflow-hidden" style={{ borderColor: 'color-mix(in srgb, var(--danger) 35%, var(--border))' }}>
          <div className="border-b px-5 py-4" style={{ borderColor: 'var(--border)' }}>
            <h2 className="text-[14px] font-bold" style={{ color: 'var(--danger)' }}>紧急操作</h2>
            <p className="mt-1 text-[11px]" style={{ color: 'var(--text-secondary)' }}>仅在必要时使用；会立即向飞控发送上锁命令。</p>
          </div>
          <div className="p-5">
            <button type="button" className="mc-btn mc-btn-danger min-h-12 w-full text-[14px]" disabled={!connected} onClick={disarm}>紧急上锁（Kill Switch）</button>
          </div>
        </div>
      </section>
    </div>
  )
}
