// Shared ESC domain types consumed by both the local Worker and the React
// SPA. Framework-agnostic: no React, no Node-only imports. Wire messages that
// embed these types live in src/shared/types.ts.
import type { EscOperationError } from './errors'

/** How the byte channel to the ESCs is established. */
export type EscSessionMode = 'ardupilot_passthrough' | 'px4_serial_control' | 'direct'

/** Explicit physical-safety acknowledgement required to start an ESC session. */
export const ESC_SESSION_SAFETY_CONFIRMATION = 'esc_props_removed_power_stable' as const
export type EscSessionSafetyConfirmation = typeof ESC_SESSION_SAFETY_CONFIRMATION

/** Physical transport implementation behind a session. */
export type EscTransportKind = 'ardupilot_raw' | 'px4_serial_control' | 'direct'

export type EscFirmwareKind = 'am32' | 'blheli_s' | 'bluejay' | 'unknown'

/**
 * What the active transport/compatibility matrix allows. Capabilities that
 * failed hardware validation stay false even when the code paths exist
 * (docs/ESC-COMPATIBILITY.md is the source of truth).
 */
export interface EscTransportCapabilities {
  read: boolean
  write: boolean
}

/** Identity of a single detected ESC. */
export interface EscDeviceInfo {
  /** 0-based ESC index (4-way channel or direct target). */
  index: number
  /** Raw 4-way interface mode from DeviceInitFlash, null when not applicable. */
  interfaceMode: number | null
  firmwareKind: EscFirmwareKind
  firmwareName: string | null
  firmwareVersion: string | null
  mcuSignature: number | null
  mcuName: string | null
  bootloaderVersion: string | null
  layoutRevision: number | null
  /** False for unknown signature/layout: read-only, never written to. */
  writable: boolean
  /** Machine-readable reason when writable is false. */
  reason?: 'unsupported_signature_or_layout' | 'not_validated' | 'detect_failed'
}

export type EscSessionStateName = 'idle' | 'entering' | 'active' | 'orphaned' | 'exiting'

/** Absolute snapshot broadcast as `esc_session`; replaces prior state. */
export interface EscSessionSnapshot {
  state: EscSessionStateName
  sessionId: string | null
  mode: EscSessionMode | null
  ownerClientId: string | null
  /** Server-authoritative acknowledgement state for settings writes. */
  safetyConfirmed: boolean
  escCount: number
  activeJobId: string | null
  /** Epoch ms until which an orphaned session waits for reclaim. */
  recoverUntil: number | null
  /** Machine-readable reason for exiting/idle transitions. */
  reason: string | null
  capabilities: EscTransportCapabilities | null
}

export type EscSettingKind = 'bool' | 'enum' | 'number'

export type EscSettingsGroup =
  | 'essentials'
  | 'motor'
  | 'extended'
  | 'limits'
  | 'current'
  | 'sine'
  | 'brake'
  | 'servo'

/**
 * Declarative descriptor for one EEPROM-backed setting. The local runtime uses
 * offset/size to encode bytes; the frontend renders the form from the same
 * metadata so both sides share a single source of truth.
 */
export interface EscSettingsField {
  key: string
  label: string
  kind: EscSettingKind
  group: EscSettingsGroup
  /** Byte offset inside the layout's EEPROM window. */
  offset: number
  /** Field width in bytes. */
  size: number
  minLayoutRevision?: number
  maxLayoutRevision?: number
  min?: number
  max?: number
  step?: number
  unit?: string
  precision?: number
  /** Display value = raw * scale + add. */
  scale?: number
  add?: number
  /** Decoded sentinel shown as disabled instead of a numeric value. */
  disabledValue?: number
  options?: Array<{ value: number; label: string }>
  /** common: usually equal across all ESCs; perEsc: naturally individual. */
  scope: 'common' | 'perEsc'
  /** Render/apply only when another field currently equals a value. */
  visibleIf?: { key: string; equals: number }
  /** Keep visible but prevent editing when another field equals a value. */
  disabledIf?: { key: string; equals: number }
  description?: string
}

/** Decoded values keyed by EscSettingsField.key. */
export type EscSettingsValues = Record<string, number>

/** Absolute snapshot broadcast as `esc_settings` after read or write. */
export interface EscSettingsSnapshot {
  sessionId: string
  escIndex: number
  firmwareKind: EscFirmwareKind
  layoutRevision: number | null
  /** False when layout is unknown; values is then empty and only raw shows. */
  writable: boolean
  values: EscSettingsValues
  /** Raw EEPROM window, base64, always present for audit/backup. */
  rawBase64: string
}

export type EscJobKind = 'scan' | 'settings_read' | 'settings_write'

/**
 * Absolute progress snapshot broadcast as `esc_job_progress` (max 4Hz).
 * Values are totals, never deltas, so dropped frames cannot corrupt the UI.
 */
export interface EscJobProgressSnapshot {
  sessionId: string
  jobId: string
  kind: EscJobKind
  /** ESC currently being worked on, null for whole-session jobs. */
  escIndex: number | null
  /** Job-specific phase such as read, write, verify or done. */
  phase: string
  bytesDone: number
  bytesTotal: number
  /** 1-based ordinal of the current target within the batch. */
  currentTargetOrdinal: number
  targetCount: number
  message?: string
}

export interface EscJobTargetResult {
  escIndex: number
  ok: boolean
  error?: EscOperationError
}

/** Final job outcome broadcast as `esc_job_done`. Partial success is not ok. */
export interface EscJobResult {
  sessionId: string
  jobId: string
  kind: EscJobKind
  ok: boolean
  perTarget: EscJobTargetResult[]
}

export interface EscLogEntry {
  level: 'info' | 'warn' | 'error'
  text: string
  /** Epoch ms assigned by the server when the entry was produced. */
  timestamp: number
}

/** Ring-buffer capacity shared by server and client log stores. */
export const ESC_LOG_CAPACITY = 500

/** Batch flush interval for `esc_log` broadcasts, in milliseconds. */
export const ESC_LOG_FLUSH_MS = 500

/** Maximum broadcast rate for `esc_job_progress`, expressed as interval ms. */
export const ESC_PROGRESS_INTERVAL_MS = 250

/** Maximum number of ESCs a session will address (4-in-1 x2). */
export const ESC_MAX_TARGETS = 8
