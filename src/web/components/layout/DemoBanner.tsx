import { useTranslation } from 'react-i18next'
import { appRuntimeMode } from '../../runtime'

// Persistent notice for the static GitHub Pages preview: every value on screen
// is synthetic and no device connection or write path exists. Renders nothing
// in live builds.
export default function DemoBanner() {
  const { t } = useTranslation()
  if (appRuntimeMode !== 'demo') return null
  return (
    <div className="mc-demo-banner" role="status">
      <span className="mc-demo-banner__badge">{t('demo.badge')}</span>
      <span>{t('demo.message')}</span>
      <a href="https://github.com/BakeSheep/OpenConfigurator/releases/latest" target="_blank" rel="noreferrer">
        {t('demo.latestRelease')}
      </a>
    </div>
  )
}
