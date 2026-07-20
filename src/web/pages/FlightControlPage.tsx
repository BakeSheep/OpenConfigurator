import { useState } from 'react'
import { useTelemetryStore } from '../stores/telemetryStore'
import { useSensorStore } from '../stores/sensorStore'
import { useWebSocket } from '../hooks/useWebSocket'
import { PX4_MODES } from '../../shared/constants'

export default function FlightControlPage() {
  const { status, battery, gps, ekfStatus } = useTelemetryStore()
  const { sensorHealth } = useSensorStore()
  const { send } = useWebSocket()
  const [takeoffAlt, setTakeoffAlt] = useState(2.5)
  const [confirmArm, setConfirmArm] = useState(false)

  const armed = status?.armed || false

  const arm = () => {
    if (!confirmArm) { setConfirmArm(true); setTimeout(() => setConfirmArm(false), 3000); return }
    send({ type: 'command', cmd: 'MAV_CMD_COMPONENT_ARM_DISARM', params: [1, 0, 0, 0, 0, 0, 0] })
    setConfirmArm(false)
  }
  const disarm = () => send({ type: 'command', cmd: 'MAV_CMD_COMPONENT_ARM_DISARM', params: [0, 0, 0, 0, 0, 0, 0] })
  const takeoff = () => send({ type: 'command', cmd: 'MAV_CMD_NAV_TAKEOFF', params: [0, 0, 0, 0, 0, 0, takeoffAlt] })
  const land = () => send({ type: 'command', cmd: 'MAV_CMD_NAV_LAND', params: [0, 0, 0, 0, 0, 0, 0] })
  const rtl = () => send({ type: 'command', cmd: 'MAV_CMD_NAV_RETURN_TO_LAUNCH', params: [0, 0, 0, 0, 0, 0, 0] })
  const setMode = (modeId: number) => send({ type: 'command', cmd: 'MAV_CMD_DO_SET_MODE', params: [1, modeId, 0, 0, 0, 0, 0] })

  const checks = [
    { label: 'GPS 锁定', ok: (gps?.fix_type || 0) >= 3 },
    { label: '电池电量 > 20%', ok: (battery?.remaining || 0) > 20 },
    { label: 'IMU 正常', ok: sensorHealth.imu === 'ok' },
    { label: '气压计正常', ok: sensorHealth.baro === 'ok' },
    { label: 'EKF 正常', ok: !!ekfStatus },
  ]
  const allPass = checks.every((c) => c.ok)

  return (
    <div className="p-5 space-y-5">
      <div>
        <h2 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>飞行控制</h2>
        <p className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>解锁、起飞、模式切换与紧急操作</p>
      </div>

      {/* Status banner */}
      <div
        className="rounded-2xl border p-5 flex items-center gap-4"
        style={
          armed
            ? { background: 'var(--success-dim)', borderColor: 'rgba(34,197,94,.25)' }
            : { background: 'var(--bg-secondary)', borderColor: 'var(--border)' }
        }
      >
        <div
          className="w-12 h-12 rounded-xl flex items-center justify-center"
          style={{ background: armed ? 'rgba(34,197,94,.2)' : 'var(--bg-tertiary)' }}
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke={armed ? 'var(--success)' : 'var(--text-disabled)'} strokeWidth="2">
            <path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z" />
          </svg>
        </div>
        <div>
          <p className="text-lg font-bold" style={{ color: armed ? 'var(--success)' : 'var(--text-primary)' }}>{armed ? '已解锁' : '已上锁'}</p>
          <p className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>模式: {status?.mode || '--'}</p>
        </div>
        <div className="ml-auto">
          {!armed ? (
            <button
              onClick={arm}
              className="mc-btn px-8 py-3.5 text-[14px]"
              style={
                confirmArm
                  ? { background: 'var(--warning)', color: '#000', animation: 'mc-pulse 1s ease-in-out infinite' }
                  : { background: 'var(--success)', color: '#fff', boxShadow: '0 4px 16px rgba(34,197,94,.3)' }
              }
            >
              {confirmArm ? '再次点击确认解锁' : '解锁 (Arm)'}
            </button>
          ) : (
            <button onClick={disarm} className="mc-btn px-8 py-3.5 text-[14px]" style={{ background: 'var(--danger)', color: '#fff', boxShadow: '0 4px 16px rgba(239,68,68,.3)' }}>
              上锁 (Disarm)
            </button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* Flight commands */}
        <div className="mc-card p-5 space-y-5">
          <h3 className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>飞行指令</h3>
          <div>
            <div className="flex justify-between text-[12px] mb-2">
              <span style={{ color: 'var(--text-secondary)' }}>起飞高度</span>
              <span className="mc-mono" style={{ color: 'var(--accent)' }}>{takeoffAlt}m</span>
            </div>
            <input type="range" min="1" max="10" step="0.5" value={takeoffAlt} onChange={(e) => setTakeoffAlt(Number(e.target.value))} />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <button
              onClick={takeoff}
              disabled={!armed}
              className="mc-btn py-3 text-[13px] disabled:opacity-30"
              style={{ background: 'var(--accent-dim)', color: 'var(--accent)', border: '1px solid rgba(59,130,246,.3)' }}
            >
              起飞
            </button>
            <button
              onClick={land}
              className="mc-btn py-3 text-[13px]"
              style={{ background: 'var(--warning-dim)', color: 'var(--warning)', border: '1px solid rgba(245,158,11,.3)' }}
            >
              降落
            </button>
            <button
              onClick={rtl}
              className="mc-btn py-3 text-[13px]"
              style={{ background: 'var(--info-dim)', color: 'var(--info)', border: '1px solid rgba(99,102,241,.3)' }}
            >
              返航
            </button>
          </div>
        </div>

        {/* Flight modes */}
        <div className="mc-card p-5">
          <h3 className="text-[14px] font-semibold mb-4" style={{ color: 'var(--text-primary)' }}>飞行模式</h3>
          <div className="grid grid-cols-3 gap-2">
            {Object.values(PX4_MODES).map((mode) => (
              <button
                key={mode.id}
                onClick={() => setMode(mode.id)}
                className="mc-btn py-2.5 text-[12px]"
                style={
                  status?.modeId === mode.id
                    ? { background: 'var(--accent)', color: '#fff', boxShadow: '0 2px 8px var(--accent-glow)' }
                    : { background: 'var(--bg-tertiary)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }
                }
              >
                {mode.name}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Preflight checklist + Emergency */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <div className="mc-card p-5">
          <h3 className="text-[14px] font-semibold mb-4" style={{ color: 'var(--text-primary)' }}>飞行前检查</h3>
          <div className="space-y-3">
            {checks.map((c) => (
              <div key={c.label} className="flex items-center gap-3">
                <span
                  className="w-5 h-5 rounded-md flex items-center justify-center text-[10px] font-bold"
                  style={
                    c.ok
                      ? { background: 'var(--success-dim)', color: 'var(--success)' }
                      : { background: 'var(--danger-dim)', color: 'var(--danger)' }
                  }
                >
                  {c.ok ? '✓' : '✗'}
                </span>
                <span className="text-[13px]" style={{ color: c.ok ? 'var(--text-primary)' : 'var(--danger)' }}>{c.label}</span>
              </div>
            ))}
          </div>
          <div
            className="mt-4 p-3 rounded-xl text-[13px] font-medium"
            style={
              allPass
                ? { background: 'var(--success-dim)', color: 'var(--success)' }
                : { background: 'var(--danger-dim)', color: 'var(--danger)' }
            }
          >
            {allPass ? '所有检查通过，可以解锁' : '存在未通过的检查项'}
          </div>
        </div>

        {/* Emergency + additional controls */}
        <div className="space-y-5">
          <div className="mc-card p-5" style={{ borderColor: 'rgba(239,68,68,.25)' }}>
            <h3 className="text-[14px] font-semibold mb-3" style={{ color: 'var(--danger)' }}>紧急操作</h3>
            <button
              onClick={disarm}
              className="mc-btn w-full py-4 text-[14px]"
              style={{ background: 'var(--danger-dim)', color: 'var(--danger)', border: '2px solid rgba(239,68,68,.4)' }}
            >
              紧急上锁 (Kill Switch)
            </button>
          </div>
          <div className="mc-card p-5">
            <h3 className="text-[14px] font-semibold mb-3" style={{ color: 'var(--text-primary)' }}>快捷操作</h3>
            <div className="grid grid-cols-2 gap-3">
              <button onClick={() => setMode(PX4_MODES.AUTO_LOITER.id)} className="mc-btn mc-btn-ghost py-2.5 text-[12px]">悬停 (Loiter)</button>
              <button onClick={() => setMode(PX4_MODES.POSCTL.id)} className="mc-btn mc-btn-ghost py-2.5 text-[12px]">定点 (Position)</button>
              <button onClick={() => setMode(PX4_MODES.ALTCTL.id)} className="mc-btn mc-btn-ghost py-2.5 text-[12px]">定高 (Altitude)</button>
              <button onClick={() => setMode(PX4_MODES.STABILIZED.id)} className="mc-btn mc-btn-ghost py-2.5 text-[12px]">自稳 (Stabilized)</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
