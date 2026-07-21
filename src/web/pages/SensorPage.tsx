import { useState } from 'react'
import Icon from '../components/ui/Icon'
import { PageHeader, PageTabs } from '../components/ui/PageFrame'
import { useWebSocket } from '../hooks/useWebSocket'
import { useSensorStore } from '../stores/sensorStore'

const tabs = [
  { id: 'imu', label: 'IMU' },
  { id: 'mag', label: '罗盘' },
  { id: 'gps', label: 'GPS' },
  { id: 'optflow', label: '光流' },
  { id: 'rangefinder', label: '测距仪' },
  { id: 'hardware', label: 'HW ID' },
]

const accelSteps = ['水平放置', '左侧朝下', '右侧朝下', '机头朝下', '机头朝上', '翻转朝下']

type CalibrationType = 'accel' | 'gyro' | 'mag' | 'baro'

function InfoMetric({ label, value, tone = 'var(--text-primary)' }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-xl border px-4 py-3" style={{ background: 'var(--bg-tertiary)', borderColor: 'var(--border)' }}>
      <p className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>{label}</p>
      <p className="mt-1 mc-mono text-[14px] font-bold" style={{ color: tone }}>{value}</p>
    </div>
  )
}

export default function SensorPage() {
  const [activeTab, setActiveTab] = useState('imu')
  const [calibrating, setCalibrating] = useState<CalibrationType | null>(null)
  const [calStep, setCalStep] = useState(0)
  const [calResult, setCalResult] = useState<string | null>(null)
  const { send } = useWebSocket()
  const imu = useSensorStore((state) => state.imu)
  const opticalFlow = useSensorStore((state) => state.opticalFlow)
  const distanceSensor = useSensorStore((state) => state.distanceSensor)
  const sensorHealth = useSensorStore((state) => state.sensorHealth)

  const startCalibration = (type: CalibrationType) => {
    const params = [0, 0, 0, 0, 0, 0, 0]
    if (type === 'accel') params[0] = 1
    if (type === 'mag') params[1] = 1
    if (type === 'baro') params[2] = 1
    if (type === 'gyro') params[4] = 1
    setCalibrating(type)
    setCalStep(0)
    setCalResult(null)
    send({ type: 'command', cmd: 'MAV_CMD_PREFLIGHT_CALIBRATION', params })
  }

  const finishCalibration = (message: string) => {
    setCalibrating(null)
    setCalResult(message)
  }

  const nextAccelStep = () => {
    if (calStep < accelSteps.length - 1) {
      setCalStep((step) => step + 1)
      return
    }
    finishCalibration('加速度计校准完成，请重启飞控后确认结果。')
  }

  return (
    <div className="mc-workspace mc-fade-in">
      <PageHeader title="传感器" description="查看、校准并验证飞控传感器" />
      <PageTabs tabs={tabs} active={activeTab} onChange={(tab) => { setActiveTab(tab); setCalibrating(null); setCalResult(null) }} />

      <section className="mc-card mt-5 overflow-hidden">
        {activeTab === 'imu' && (
          <>
            <div className="border-b px-5 py-5" style={{ borderColor: 'var(--border)' }}>
              <div className="flex items-center gap-3">
                <span className="grid h-10 w-10 place-items-center rounded-xl" style={{ background: 'var(--accent-dim)', color: 'var(--accent)' }}><Icon name="sensor" size={20} /></span>
                <div>
                  <h2 className="text-[16px] font-bold" style={{ color: 'var(--text-primary)' }}>IMU 校准</h2>
                  <p className="mt-1 text-[12px]" style={{ color: 'var(--text-secondary)' }}>加速度计、陀螺仪和气压计校准工具</p>
                </div>
              </div>
            </div>
            <div className="grid grid-cols-1 gap-4 p-5 xl:grid-cols-[1.2fr_0.8fr]">
              <div>
                {calibrating === 'accel' ? (
                  <div className="rounded-xl border p-5" style={{ borderColor: 'var(--accent)', background: 'var(--accent-dim)' }}>
                    <p className="mc-eyebrow">加速度计校准</p>
                    <div className="mt-5 flex items-center gap-5">
                      <span className="grid h-20 w-20 place-items-center rounded-2xl bg-[var(--bg-secondary)] mc-mono text-[22px] font-bold" style={{ color: 'var(--accent)' }}>{calStep + 1}/6</span>
                      <div>
                        <h3 className="text-[18px] font-bold" style={{ color: 'var(--text-primary)' }}>{accelSteps[calStep]}</h3>
                        <p className="mt-1 text-[12px]" style={{ color: 'var(--text-secondary)' }}>请稳定放置飞行器后再继续下一步。</p>
                      </div>
                    </div>
                    <div className="mt-5 h-1.5 overflow-hidden rounded-full" style={{ background: 'var(--bg-secondary)' }}>
                      <i className="block h-full rounded-full" style={{ width: ((calStep + 1) / 6) * 100 + '%', background: 'var(--accent)' }} />
                    </div>
                    <div className="mt-5 flex gap-3">
                      <button type="button" className="mc-btn mc-btn-primary" onClick={nextAccelStep}>已完成放置</button>
                      <button type="button" className="mc-btn mc-btn-ghost" onClick={() => setCalibrating(null)}>取消</button>
                    </div>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                    {[
                      ['加速度计', '6 面放置校准', 'accel'],
                      ['陀螺仪', '静止姿态校准', 'gyro'],
                      ['气压计', '气压高度基准', 'baro'],
                    ].map(([title, description, type]) => (
                      <button
                        key={type}
                        type="button"
                        className="rounded-xl border p-4 text-left transition-colors hover:bg-[var(--bg-tertiary)]"
                        style={{ borderColor: 'var(--border)', background: 'var(--bg-secondary)' }}
                        onClick={() => startCalibration(type as CalibrationType)}
                      >
                        <span className="grid h-8 w-8 place-items-center rounded-lg" style={{ background: 'var(--accent-dim)', color: 'var(--accent)' }}><Icon name="sensor" size={16} /></span>
                        <h3 className="mt-4 text-[14px] font-bold" style={{ color: 'var(--text-primary)' }}>{title}</h3>
                        <p className="mt-1 text-[11px]" style={{ color: 'var(--text-secondary)' }}>{description}</p>
                      </button>
                    ))}
                  </div>
                )}
                {calibrating === 'gyro' && (
                  <div className="mt-4 rounded-xl p-4" style={{ background: 'var(--warning-dim)', color: 'var(--warning)' }}>
                    <p className="text-[13px] font-semibold">请保持飞行器静止并平放。</p>
                    <button type="button" className="mc-btn mt-3" style={{ background: 'var(--bg-secondary)', color: 'var(--warning)' }} onClick={() => finishCalibration('陀螺仪校准完成。')}>完成校准</button>
                  </div>
                )}
                {calibrating === 'baro' && (
                  <div className="mt-4 rounded-xl p-4" style={{ background: 'var(--accent-dim)', color: 'var(--accent)' }}>
                    <p className="text-[13px] font-semibold">已发送气压计校准指令，请等待飞控回应。</p>
                    <button type="button" className="mc-btn mt-3" style={{ background: 'var(--bg-secondary)', color: 'var(--accent)' }} onClick={() => finishCalibration('气压计基准已更新。')}>确认完成</button>
                  </div>
                )}
              </div>
              <div className="grid grid-cols-2 gap-3 self-start">
                <InfoMetric label="加速度 X" value={imu ? imu.xacc.toFixed(0) : '—'} />
                <InfoMetric label="加速度 Y" value={imu ? imu.yacc.toFixed(0) : '—'} />
                <InfoMetric label="加速度 Z" value={imu ? imu.zacc.toFixed(0) : '—'} />
                <InfoMetric label="IMU 状态" value={sensorHealth.imu === 'ok' ? '在线' : '离线'} tone={sensorHealth.imu === 'ok' ? 'var(--success)' : 'var(--text-disabled)'} />
              </div>
            </div>
          </>
        )}

        {activeTab === 'mag' && (
          <div className="p-5">
            <div className="max-w-xl">
              <span className="grid h-10 w-10 place-items-center rounded-xl" style={{ background: 'var(--accent-dim)', color: 'var(--accent)' }}><Icon name="sensor" size={20} /></span>
              <h2 className="mt-4 text-[17px] font-bold" style={{ color: 'var(--text-primary)' }}>罗盘校准</h2>
              <p className="mt-2 text-[13px] leading-6" style={{ color: 'var(--text-secondary)' }}>远离金属、磁铁和高电流线束，沿所有轴缓慢旋转飞行器。</p>
              {calibrating === 'mag' ? (
                <div className="mt-5 rounded-xl border p-5" style={{ borderColor: 'var(--accent)', background: 'var(--accent-dim)' }}>
                  <p className="text-[13px] font-semibold" style={{ color: 'var(--accent)' }}>正在收集罗盘样本，请持续旋转飞行器。</p>
                  <div className="mt-4 h-1.5 overflow-hidden rounded-full" style={{ background: 'var(--bg-secondary)' }}><i className="block h-full w-2/3 animate-pulse rounded-full" style={{ background: 'var(--accent)' }} /></div>
                  <button type="button" className="mc-btn mc-btn-primary mt-5" onClick={() => finishCalibration('罗盘校准完成，请重启飞控。')}>完成校准</button>
                </div>
              ) : <button type="button" className="mc-btn mc-btn-primary mt-5" onClick={() => startCalibration('mag')}>开始校准</button>}
            </div>
          </div>
        )}

        {activeTab === 'gps' && (
          <div className="p-5">
            <h2 className="text-[17px] font-bold" style={{ color: 'var(--text-primary)' }}>GPS 状态</h2>
            <p className="mt-2 text-[13px]" style={{ color: 'var(--text-secondary)' }}>当前页面会在飞控连接后显示定位状态、卫星数与定位质量。</p>
            <div className="mt-5 grid max-w-2xl grid-cols-1 gap-3 sm:grid-cols-3">
              <InfoMetric label="设备状态" value={sensorHealth.gps === 'ok' ? '在线' : '等待数据'} tone={sensorHealth.gps === 'ok' ? 'var(--success)' : 'var(--text-disabled)'} />
              <InfoMetric label="定位模式" value="自动检测" />
              <InfoMetric label="融合状态" value="EKF 管理" />
            </div>
          </div>
        )}

        {activeTab === 'optflow' && (
          <div className="p-5">
            <h2 className="text-[17px] font-bold" style={{ color: 'var(--text-primary)' }}>光流传感器</h2>
            <div className="mt-5 grid max-w-2xl grid-cols-1 gap-3 sm:grid-cols-3">
              <InfoMetric label="状态" value={opticalFlow ? '在线' : '未检测'} tone={opticalFlow ? 'var(--success)' : 'var(--text-disabled)'} />
              <InfoMetric label="质量" value={opticalFlow ? String(opticalFlow.quality) + ' / 255' : '—'} />
              <InfoMetric label="融合" value="EKF2_OF_CTRL" />
            </div>
          </div>
        )}

        {activeTab === 'rangefinder' && (
          <div className="p-5">
            <h2 className="text-[17px] font-bold" style={{ color: 'var(--text-primary)' }}>测距仪</h2>
            <div className="mt-5 grid max-w-2xl grid-cols-1 gap-3 sm:grid-cols-3">
              <InfoMetric label="状态" value={distanceSensor ? '在线' : '未检测'} tone={distanceSensor ? 'var(--success)' : 'var(--text-disabled)'} />
              <InfoMetric label="当前距离" value={distanceSensor ? String(distanceSensor.current_distance) + ' cm' : '—'} />
              <InfoMetric label="量程" value={distanceSensor ? String(distanceSensor.max_distance) + ' cm' : '—'} />
            </div>
          </div>
        )}

        {activeTab === 'hardware' && (
          <div className="p-5">
            <h2 className="text-[17px] font-bold" style={{ color: 'var(--text-primary)' }}>硬件识别</h2>
            <p className="mt-2 text-[13px]" style={{ color: 'var(--text-secondary)' }}>连接飞控后将在此显示飞控板、传感器与外设的硬件标识信息。</p>
          </div>
        )}
      </section>

      {calResult && (
        <div className="mt-4 flex items-center gap-3 rounded-xl border px-4 py-3" style={{ borderColor: 'color-mix(in srgb, var(--success) 34%, transparent)', background: 'var(--success-dim)', color: 'var(--success)' }}>
          <Icon name="check" size={18} />
          <span className="text-[13px] font-semibold">{calResult}</span>
        </div>
      )}
    </div>
  )
}
