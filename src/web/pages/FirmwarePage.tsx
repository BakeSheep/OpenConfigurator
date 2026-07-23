import { useState } from 'react'
import Icon, { type IconName } from '../components/ui/Icon'
import { PageHeader, PageTabs } from '../components/ui/PageFrame'
import { useConnectionStore } from '../stores/connectionStore'

const tabs = [{ id: 'online', label: '在线升级' }, { id: 'local', label: '本地升级' }, { id: 'dfu', label: 'DFU 烧录' }]
const vehicles: Array<{ id: string; name: string; icon: IconName; mark: string }> = [
  { id: 'multirotor', name: '多旋翼', icon: 'motor', mark: 'QUAD' },
  { id: 'helicopter', name: '直升机', icon: 'flight', mark: 'HELI' },
  { id: 'plane', name: '固定翼', icon: 'flight', mark: 'WING' },
  { id: 'rover', name: '车/船', icon: 'hardware', mark: 'ROVER' },
  { id: 'submarine', name: '潜水艇', icon: 'sensor', mark: 'UUV' },
  { id: 'tracker', name: '天线跟踪', icon: 'rtk', mark: 'TRACK' },
]

export default function FirmwarePage() {
  const [activeTab, setActiveTab] = useState('online')
  const [vehicle, setVehicle] = useState('multirotor')
  const { status, port } = useConnectionStore()
  const connected = status === 'connected'
  const selectedVehicle = vehicles.find((item) => item.id === vehicle) ?? vehicles[0]

  return (
    <div className="mc-workspace mc-fade-in mc-data-workspace">
      <PageHeader title="固件升级" description="飞控固件在线升级或本地固件刷写" />
      <PageTabs tabs={tabs} active={activeTab} onChange={setActiveTab} />

      <div className="mc-firmware-layout">
        <section className="mc-card mc-firmware-vehicles">
          <h2>{activeTab === 'online' ? '选择机型' : activeTab === 'local' ? '选择本地固件' : 'DFU 设备'}</h2>
          {activeTab === 'online' ? (
            <div>
              {vehicles.map((item) => (
                <button type="button" key={item.id} data-active={vehicle === item.id} onClick={() => setVehicle(item.id)}>
                  <span><Icon name={item.icon} size={46} /><i>{item.mark}</i></span>
                  <strong>{item.name}</strong>
                </button>
              ))}
            </div>
          ) : (
            <div className="mc-firmware-dropzone">
              <Icon name="upload" size={28} />
              <strong>{activeTab === 'local' ? '选择 .px4 固件文件' : '等待 DFU 设备'}</strong>
              <p>{activeTab === 'local' ? '固件校验和兼容性检查将在刷写前完成。' : '请按住 BOOT 键连接飞控。'}</p>
              <button type="button" className="mc-btn mc-btn-primary" disabled>选择文件</button>
            </div>
          )}
        </section>

        <aside className="mc-card mc-firmware-version">
          <h2>选择版本</h2>
          <dl>
            <div><dt>飞控型号</dt><dd>{connected ? port || '已连接设备' : '未识别'}</dd></div>
            <div><dt>当前固件</dt><dd>{connected ? 'PX4' : '—'}</dd></div>
            <div><dt>当前机型</dt><dd>{selectedVehicle.name}</dd></div>
            <div><dt>固件类型</dt><dd><select className="mc-select" defaultValue="stable" disabled={!connected}><option value="stable">稳定版</option><option value="beta">测试版</option><option value="dev">开发版</option></select></dd></div>
          </dl>
          <div className="mc-capability-note"><Icon name="warning" size={15} /><span>刷写功能尚未接入后端；当前页面不会向飞控发送升级指令。</span></div>
        </aside>
      </div>
    </div>
  )
}
