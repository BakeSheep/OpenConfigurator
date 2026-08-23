/** Shared worker lifecycle payloads used by BluetoothWorker and SerialWorker. */

export interface ReconnectProgress {
  attempt: number
  maxAttempts: number
  delayMs: number
  lastError?: string
}

export interface ReconnectTerminalReason {
  code: string
  message: string
  attempt: number
  timestamp: number
}
