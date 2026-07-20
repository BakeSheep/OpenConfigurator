import { useState } from 'react'
import { useWebSocket } from '../hooks/useWebSocket'
import { useSensorStore } from '../stores/sensorStore'

const sensorTabs = [
  { id: 'accel', label: '加速度计' },
  { id: 'gyro', label: '陀螺仪' },
  { id: 'mag', label: '磁力计' },
  { id: 'baro', label: '气压计' },
  { id: 'optflow', label: '光流' },
  { id: 'rangefinder', label: '测距' },
  { id: 'esc', label: 'ESC' },
  { id: 'radio', label: '遥控器' },
]

const accelSteps = ['水平放置', '左侧朝下', '右侧朝下', '机头朝下', '机头朝上', '翻转朝下']

export default function SensorPage() {
  const [activeTab, setActiveTab] = useState('accel')
  const [calibrating, setCalibrating] = useState(false)
  const [calStep, setCalStep] = useState(0)
  const [calResult, setCalResult] = useState<string | null>(null)
  const { send } = useWebSocket()
  const { opticalFlow, distanceSensor } = useSensorStore()

  const startCalibration = (type: string) => {
    setCalibrating(true); setCalStep(0); setCalResult(null)
    const params = [0, 0, 0, 0, 0, 0, 0]
    if (type === 'accel') params[0] = 1
    if (type === 'mag') params[1] = 1
    if (type === 'baro') params[2] = 1
    if (type === 'gyro') params[4] = 1
    send({ type: 'command', cmd: 'MAV_CMD_PREFLIGHT_CALIBRATION', params })
  }

  const nextStep = () => {
    if (calStep < 5) { setCalStep(calStep + 1) }
    else { setCalibrating(false); setCalResult('校准成功！请重启飞控。') }
  }

  return (
    <div className="p-5 flex gap-5 h-full">
      {/* Left tabs */}
      <div className="w-44 shrink-0 space-y-1">
        <h2 className="text-sm font-bold mb-3 px-2" style={{ color: 'var(--text-primary)' }}>传感器校准</h2>
        {sensorTabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => { setActiveTab(tab.id); setCalibrating(false); setCalResult(null) }}
            className="relative w-full text-left px-3 py-2.5 rounded-lg text-[13px] transition-all"
            style={
              activeTab === tab.id
                ? { background: 'var(--accent-dim)', color: 'var(--accent)', fontWeight: 600 }
                : { color: 'var(--text-secondary)' }
            }
            onMouseEnter={(e) => { if (activeTab !== tab.id) e.currentTarget.style.color = 'var(--text-primary)' }}
            onMouseLeave={(e) => { if (activeTab !== tab.id) e.currentTarget.style.color = 'var(--text-secondary)' }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Right content */}
      <div className="flex-1 mc-card p-6 overflow-y-auto">
        {activeTab === 'accel' && (
          <div className="space-y-6">
            <div>
              <h3 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>加速度计校准</h3>
              <p className="text-[13px] mt-1" style={{ color: 'var(--text-secondary)' }}>按照提示将无人机依次放置在 6 个方向</p>
            </div>
            {!calibrating && !calResult && (
              <button onClick={() => startCalibration('accel')} className="mc-btn mc-btn-primary px-6 py-3">
                开始校准
              </button>
            )}
            {calibrating && (
              <div className="space-y-5">
                <div className="flex items-center gap-5">
                  <div
                    className="w-20 h-20 rounded-2xl flex items-center justify-center"
                    style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border)' }}
                  >
                    <span className="mc-mono text-2xl font-bold" style={{ color: 'var(--accent)' }}>{calStep + 1}/6</span>
                  </div>
                  <div>
                    <p className="text-base font-medium" style={{ color: 'var(--text-primary)' }}>{accelSteps[calStep]}</p>
                    <p className="text-[13px] mt-0.5" style={{ color: 'var(--text-secondary)' }}>放置好后点击下方按钮</p>
                  </div>
                </div>
                <div className="w-full h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--bg-tertiary)' }}>
                  <div className="h-full rounded-full transition-all duration-300" style={{ width: `${((calStep + 1) / 6) * 100}%`, background: 'var(--accent)' }} />
                </div>
                <div className="flex gap-3">
                  <button onClick={nextStep} className="mc-btn mc-btn-success px-6 py-3">已完成放置</button>
                  <button onClick={() => setCalibrating(false)} className="mc-btn mc-btn-ghost px-5 py-3">取消</button>
                </div>
              </div>
            )}
            {calResult && (
              <div className="p-4 rounded-xl" style={{ background: 'var(--success-dim)', border: '1px solid rgba(34,197,94,.25)' }}>
                <p className="text-[13px] font-medium" style={{ color: 'var(--success)' }}>{calResult}</p>
              </div>
            )}
          </div>
        )}

        {activeTab === 'gyro' && (
          <div className="space-y-6">
            <div><h3 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>陀螺仪校准</h3><p className="text-[13px] mt-1" style={{ color: 'var(--text-secondary)' }}>请将无人机静止放置在水平面上</p></div>
            {!calResult && <button onClick={() => { startCalibration('gyro'); setTimeout(() => { setCalibrating(false); setCalResult('陀螺仪校准完成') }, 3000) }} className="mc-btn mc-btn-primary px-6 py-3">开始校准</button>}
            {calibrating && <p className="text-[13px]" style={{ color: 'var(--text-secondary)', animation: 'mc-pulse 1.5s ease-in-out infinite' }}>正在校准，请保持静止…</p>}
            {calResult && <div className="p-4 rounded-xl" style={{ background: 'var(--success-dim)', border: '1px solid rgba(34,197,94,.25)' }}><p className="text-[13px] font-medium" style={{ color: 'var(--success)' }}>{calResult}</p></div>}
          </div>
        )}

        {activeTab === 'mag' && (
          <div className="space-y-6">
            <div><h3 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>磁力计校准</h3><p className="text-[13px] mt-1" style={{ color: 'var(--text-secondary)' }}>远离金属和磁铁，沿各轴旋转无人机</p></div>
            {!calibrating && !calResult && <button onClick={() => startCalibration('mag')} className="mc-btn mc-btn-primary px-6 py-3">开始校准</button>}
            {calibrating && (
              <div className="space-y-4">
                <p className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>请沿 X/Y/Z 轴旋转无人机…</p>
                {['Mag 1', 'Mag 2', 'Mag 3'].map((m) => (
                  <div key={m} className="flex items-center gap-3">
                    <span className="text-[12px] w-12" style={{ color: 'var(--text-secondary)' }}>{m}</span>
                    <div className="flex-1 h-1.5 rounded-full" style={{ background: 'var(--bg-tertiary)' }}><div className="h-full rounded-full w-2/3" style={{ background: 'var(--success)', animation: 'mc-pulse 1.5s ease-in-out infinite' }} /></div>
                  </div>
                ))}
                <button onClick={() => { setCalibrating(false); setCalResult('磁力计校准成功！请重启飞控。') }} className="mc-btn mc-btn-ghost px-5 py-2.5">完成</button>
              </div>
            )}
            {calResult && <div className="p-4 rounded-xl" style={{ background: 'var(--success-dim)', border: '1px solid rgba(34,197,94,.25)' }}><p className="text-[13px] font-medium" style={{ color: 'var(--success)' }}>{calResult}</p></div>}
          </div>
        )}

        {activeTab === 'baro' && (
          <div className="space-y-6">
            <div><h3 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>气压计校准</h3><p className="text-[13px] mt-1" style={{ color: 'var(--text-secondary)' }}>确保无人机处于已知高度</p></div>
            <button onClick={() => startCalibration('baro')} className="mc-btn mc-btn-primary px-6 py-3">校准气压基准</button>
          </div>
        )}

        {activeTab === 'optflow' && (
          <div className="space-y-5">
            <div><h3 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>光流传感器</h3></div>
            <div className="grid grid-cols-2 gap-3">
              <div className="p-3 rounded-xl" style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border)' }}><p className="text-[11px]" style={{ color: 'var(--text-disabled)' }}>状态</p><p className="text-[13px] mt-0.5" style={{ color: 'var(--text-primary)' }}>{opticalFlow ? '在线' : '离线'}</p></div>
              <div className="p-3 rounded-xl" style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border)' }}><p className="text-[11px]" style={{ color: 'var(--text-disabled)' }}>质量</p><p className="text-[13px] mt-0.5 mc-mono" style={{ color: 'var(--text-primary)' }}>{opticalFlow?.quality ?? '--'} / 255</p></div>
            </div>
            <label className="flex items-center gap-3 text-[13px] cursor-pointer" style={{ color: 'var(--text-primary)' }}>
              <input type="checkbox" defaultChecked className="w-4 h-4 rounded" style={{ accentColor: 'var(--accent)' }} />
              启用光流融合 (EKF2_OF_CTRL)
            </label>
          </div>
        )}

        {activeTab === 'rangefinder' && (
          <div className="space-y-5">
            <div><h3 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>测距传感器</h3></div>
            <div className="grid grid-cols-2 gap-3">
              <div className="p-3 rounded-xl" style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border)' }}><p className="text-[11px]" style={{ color: 'var(--text-disabled)' }}>状态</p><p className="text-[13px] mt-0.5" style={{ color: 'var(--text-primary)' }}>{distanceSensor ? '在线' : '离线'}</p></div>
              <div className="p-3 rounded-xl" style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border)' }}><p className="text-[11px]" style={{ color: 'var(--text-disabled)' }}>距离</p><p className="text-[13px] mt-0.5 mc-mono" style={{ color: 'var(--text-primary)' }}>{distanceSensor?.current_distance ?? '--'} cm</p></div>
            </div>
            <label className="flex items-center gap-3 text-[13px] cursor-pointer" style={{ color: 'var(--text-primary)' }}>
              <input type="checkbox" defaultChecked className="w-4 h-4 rounded" style={{ accentColor: 'var(--accent)' }} />
              启用测距融合 (EKF2_RNG_CTRL)
            </label>
          </div>
        )}

        {activeTab === 'esc' && (
          <div className="space-y-5">
            <div><h3 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>ESC 校准</h3></div>
            <div className="p-4 rounded-xl" style={{ background: 'var(--danger-dim)', border: '1px solid rgba(239,68,68,.25)' }}><p className="text-[13px] font-medium" style={{ color: 'var(--danger)' }}>请移除所有螺旋桨！</p></div>
            <ol className="space-y-2 text-[13px] list-decimal list-inside" style={{ color: 'var(--text-secondary)' }}>
              <li>断开电池</li><li>油门推到最高</li><li>连接电池，等待确认声</li><li>油门拉到最低</li><li>等待校准完成</li>
            </ol>
          </div>
        )}

        {activeTab === 'radio' && (
          <div className="space-y-5">
            <div><h3 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>遥控器校准</h3><p className="text-[13px] mt-1" style={{ color: 'var(--text-secondary)' }}>将所有摇杆和开关拨到极限位置数次</p></div>
            <div className="space-y-2">
              {['Roll', 'Pitch', 'Throttle', 'Yaw'].map((ch) => (
                <div key={ch} className="flex items-center gap-3">
                  <span className="text-[12px] w-14" style={{ color: 'var(--text-secondary)' }}>{ch}</span>
                  <div className="flex-1 h-2 rounded-full relative overflow-hidden" style={{ background: 'var(--bg-tertiary)' }}>
                    <div className="absolute left-1/2 top-0 w-px h-2" style={{ background: 'var(--text-disabled)' }} />
                    <div className="h-2 rounded-full" style={{ width: '50%', background: 'var(--accent)' }} />
                  </div>
                  <span className="text-[12px] mc-mono w-10 text-right" style={{ color: 'var(--text-primary)' }}>1500</span>
                </div>
              ))}
            </div>
            <button className="mc-btn mc-btn-primary px-6 py-3">开始校准</button>
          </div>
        )}
      </div>
    </div>
  )
}
