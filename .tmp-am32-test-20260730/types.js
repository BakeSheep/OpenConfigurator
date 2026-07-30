"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ESC_MAX_TARGETS = exports.ESC_PROGRESS_INTERVAL_MS = exports.ESC_LOG_FLUSH_MS = exports.ESC_LOG_CAPACITY = void 0;
/** Ring-buffer capacity shared by server and client log stores. */
exports.ESC_LOG_CAPACITY = 500;
/** Batch flush interval for `esc_log` broadcasts, in milliseconds. */
exports.ESC_LOG_FLUSH_MS = 500;
/** Maximum broadcast rate for `esc_job_progress`, expressed as interval ms. */
exports.ESC_PROGRESS_INTERVAL_MS = 250;
/** Maximum number of ESCs a session will address (4-in-1 x2). */
exports.ESC_MAX_TARGETS = 8;
