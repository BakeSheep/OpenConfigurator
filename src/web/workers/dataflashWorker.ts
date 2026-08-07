/// <reference lib="webworker" />
// DataFlash analysis worker: parses an ArduPilot .bin ArrayBuffer off the
// main thread and returns the same UlogAnalysisDataset shape as ulogWorker,
// so the analysis page renders both formats with identical chart components.
import { parseDataflashLog } from '../utils/dataflashAnalysis'
import type { UlogWorkerRequest, UlogWorkerResult } from '../utils/ulogAnalysis'
import i18next from 'i18next'
import { zh } from '../i18n/locales/zh'
import { en } from '../i18n/locales/en'

i18next.init({
  resources: { zh: { translation: zh }, en: { translation: en } },
  lng: 'zh',
  fallbackLng: 'zh',
  interpolation: { escapeValue: false },
})
const t = i18next.t.bind(i18next)

self.onmessage = (event: MessageEvent<UlogWorkerRequest>) => {
  void (async () => {
    try {
      await i18next.changeLanguage(event.data.language)
      const dataset = parseDataflashLog(event.data.buffer)
      ;(self as unknown as { postMessage(message: UlogWorkerResult): void })
        .postMessage({ dataset })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      ;(self as unknown as { postMessage(message: UlogWorkerResult): void })
        .postMessage({ error: t('logAnalysis.dataflashParseFailed', { message }) })
    }
  })()
}
