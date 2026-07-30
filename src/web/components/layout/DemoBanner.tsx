import { appRuntimeMode } from '../../runtime'

// Persistent notice for the static GitHub Pages preview: every value on screen
// is synthetic and no device connection or write path exists. Renders nothing
// in live builds.
export default function DemoBanner() {
  if (appRuntimeMode !== 'demo') return null
  return (
    <div className="mc-demo-banner" role="status">
      <span className="mc-demo-banner__badge">在线演示</span>
      <span>所有数据均为模拟数据，设备连接和写操作已禁用</span>
    </div>
  )
}
