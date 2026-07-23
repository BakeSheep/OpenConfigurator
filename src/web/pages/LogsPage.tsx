import { useState } from 'react'
import Icon from '../components/ui/Icon'
import { PageHeader, PageTabs } from '../components/ui/PageFrame'
import { useConnectionStore } from '../stores/connectionStore'

const tabs = [{ id: 'files', label: '飞控文件' }, { id: 'analysis', label: '日志分析' }]
const folders = ['bin', 'dev', 'etc', 'fs', 'obj', 'proc', 'var']

export default function LogsPage() {
  const [activeTab, setActiveTab] = useState('files')
  const [view, setView] = useState<'grid' | 'list'>('grid')
  const connected = useConnectionStore((state) => state.status === 'connected')

  return (
    <div className="mc-workspace mc-fade-in mc-data-workspace">
      <PageHeader title="日志" description="飞控文件管理与日志分析" />
      <PageTabs tabs={tabs} active={activeTab} onChange={setActiveTab} />

      {activeTab === 'files' ? (
        <section className="mc-file-browser">
          <div className="mc-file-toolbar">
            <div className="mc-file-path"><button type="button" className="mc-icon-btn mc-icon-btn--bordered" disabled aria-label="返回上级"><Icon name="chevronDown" size={15} /></button><button type="button" className="mc-icon-btn mc-icon-btn--bordered" aria-label="刷新"><Icon name="refresh" size={15} /></button><strong className="mc-mono">/</strong></div>
            <div className="mc-file-actions">
              <button type="button" className="mc-btn mc-btn-ghost" disabled={!connected} title="后端 MAVLink FTP 支持接入后可用"><Icon name="download" size={15} />日志下载</button>
              <label>日志模式<select className="mc-select" disabled><option>0</option></select></label>
              <button type="button" className="mc-icon-btn mc-icon-btn--bordered" disabled aria-label="新建文件夹"><Icon name="folder" size={15} /></button>
              <button type="button" className="mc-icon-btn mc-icon-btn--bordered" disabled aria-label="上传文件"><Icon name="upload" size={15} /></button>
              <div className="mc-view-toggle"><button type="button" data-active={view === 'grid'} onClick={() => setView('grid')} aria-label="图标视图"><Icon name="grid" size={16} /></button><button type="button" data-active={view === 'list'} onClick={() => setView('list')} aria-label="列表视图"><Icon name="list" size={16} /></button></div>
            </div>
          </div>

          <div className={'mc-file-grid ' + (view === 'list' ? 'is-list' : '')}>
            {folders.map((folder) => (
              <button type="button" className="mc-file-item" key={folder} disabled={!connected}>
                <Icon name="folder" size={view === 'grid' ? 58 : 24} />
                <span className="mc-mono">{folder}</span>
              </button>
            ))}
          </div>
          {!connected && <div className="mc-capability-note"><Icon name="warning" size={16} /><span>连接飞控后显示文件系统；下载与上传功能需要后端 MAVLink FTP 支持。</span></div>}
        </section>
      ) : (
        <section className="mc-card mc-log-analysis">
          <span><Icon name="log" size={26} /></span>
          <h2>日志分析</h2>
          <p>下载飞控 ULog 后，可在此查看飞行阶段、故障事件和关键指标。</p>
          <button type="button" className="mc-btn mc-btn-primary" disabled><Icon name="upload" size={15} />选择日志</button>
        </section>
      )}
    </div>
  )
}
