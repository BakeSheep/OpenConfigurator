/// <reference lib="webworker" />
// DataFlash analysis worker: parses an ArduPilot .bin ArrayBuffer off the
// main thread and returns the same UlogAnalysisDataset shape as ulogWorker,
// so the analysis page renders both formats with identical chart components.
import { parseDataflashLog } from '../utils/dataflashAnalysis'
import type { UlogWorkerResult } from '../utils/ulogAnalysis'

self.onmessage = (event: MessageEvent<ArrayBuffer>) => {
  try {
    const dataset = parseDataflashLog(event.data)
    ;(self as unknown as { postMessage(message: UlogWorkerResult): void })
      .postMessage({ dataset })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    ;(self as unknown as { postMessage(message: UlogWorkerResult): void })
      .postMessage({ error: `DataFlash 日志解析失败：${message}` })
  }
}
