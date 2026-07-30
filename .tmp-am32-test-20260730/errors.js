"use strict";
// Shared ESC error vocabulary. Both the backend session/protocol layers and
// the frontend store consume these codes; keep this module framework-agnostic
// (no React, no Node-only imports).
Object.defineProperty(exports, "__esModule", { value: true });
exports.EscError = void 0;
exports.toEscError = toEscError;
/** Codes that a caller may retry without changing anything else. */
const RETRYABLE_CODES = new Set([
    'busy',
    'timeout',
    'crc_mismatch',
    'nack',
    'echo_mismatch',
    'link_lost',
]);
class EscError extends Error {
    code;
    retryable;
    escIndex;
    cause;
    constructor(code, message, options = {}) {
        super(message);
        this.name = 'EscError';
        this.code = code;
        this.retryable = options.retryable ?? RETRYABLE_CODES.has(code);
        if (options.escIndex !== undefined)
            this.escIndex = options.escIndex;
        if (options.cause !== undefined)
            this.cause = options.cause;
    }
    toOperationError(operation) {
        return {
            operation,
            code: this.code,
            message: this.message,
            retryable: this.retryable,
            ...(this.escIndex !== undefined ? { escIndex: this.escIndex } : {}),
        };
    }
}
exports.EscError = EscError;
/** Normalize unknown thrown values into an EscError without losing context. */
function toEscError(error, fallbackCode = 'internal') {
    if (error instanceof EscError)
        return error;
    const message = error instanceof Error ? error.message : String(error);
    return new EscError(fallbackCode, message, { cause: error });
}
