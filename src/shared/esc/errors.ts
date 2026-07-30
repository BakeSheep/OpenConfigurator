// Shared ESC error vocabulary. Both the backend session/protocol layers and
// the frontend store consume these codes; keep this module framework-agnostic
// (no React, no Node-only imports).

export type EscErrorCode =
  | 'not_supported'
  | 'busy'
  | 'invalid_state'
  | 'not_owner'
  | 'session_exists'
  | 'session_not_found'
  | 'invalid_recovery_token'
  | 'armed'
  | 'arming_state_unknown'
  | 'link_unavailable'
  | 'link_lost'
  | 'timeout'
  | 'crc_mismatch'
  | 'nack'
  | 'echo_mismatch'
  | 'verify_failed'
  | 'unsupported_signature_or_layout'
  | 'address_guard'
  | 'target_mismatch'
  | 'precondition_failed'
  | 'validation_failed'
  | 'cancelled'
  | 'internal'

/** Wire-friendly error snapshot broadcast as `esc_op_error`. */
export interface EscOperationError {
  operation: string
  code: EscErrorCode
  message: string
  retryable: boolean
  escIndex?: number
}

/** Codes that a caller may retry without changing anything else. */
const RETRYABLE_CODES: ReadonlySet<EscErrorCode> = new Set([
  'busy',
  'timeout',
  'crc_mismatch',
  'nack',
  'echo_mismatch',
  'link_lost',
])

export class EscError extends Error {
  readonly code: EscErrorCode
  readonly retryable: boolean
  readonly escIndex?: number
  readonly cause?: unknown

  constructor(
    code: EscErrorCode,
    message: string,
    options: { retryable?: boolean; escIndex?: number; cause?: unknown } = {},
  ) {
    super(message)
    this.name = 'EscError'
    this.code = code
    this.retryable = options.retryable ?? RETRYABLE_CODES.has(code)
    if (options.escIndex !== undefined) this.escIndex = options.escIndex
    if (options.cause !== undefined) this.cause = options.cause
  }

  toOperationError(operation: string): EscOperationError {
    return {
      operation,
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.escIndex !== undefined ? { escIndex: this.escIndex } : {}),
    }
  }
}

/** Normalize unknown thrown values into an EscError without losing context. */
export function toEscError(error: unknown, fallbackCode: EscErrorCode = 'internal'): EscError {
  if (error instanceof EscError) return error
  const message = error instanceof Error ? error.message : String(error)
  return new EscError(fallbackCode, message, { cause: error })
}
