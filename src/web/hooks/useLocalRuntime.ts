import { useEffect, useRef } from 'react'
import i18next from 'i18next'
import { localRuntime } from '../runtime/LocalRuntimeClient'
import { useConnectionStore } from '../stores/connectionStore'
import { useCalibrationStore } from '../stores/calibrationStore'
import { useAutotuneStore } from '../stores/autotuneStore'
import { useTelemetryStore } from '../stores/telemetryStore'

const t = i18next.t.bind(i18next)

import { useSensorStore } from '../stores/sensorStore'
import { useParameterStore } from '../stores/parameterStore'
import { useFileExplorerStore } from '../stores/fileExplorerStore'
import { useLogTransferStore } from '../stores/logTransferStore'
import { useEscStore } from '../stores/escStore'
import { useMessageRateStore } from '../stores/messageRateStore'
import { useVehicleSetupStore } from '../stores/vehicleSetupStore'
import { recordMavlinkRuntimeEvent, useMavlinkMessageStore } from '../stores/mavlinkMessageStore'
import { useShellStore } from '../stores/shellStore'
import type { RuntimeEvent, RuntimeCommand, ParamData } from '../../shared/types'
import {
  parseAttitudeData,
  parseBaroData,
  parseBatteryData,
  parseDistanceSensorData,
  parseGlobalPositionData,
  parseGpsData,
  parseImuData,
  parseOpticalFlowData,
  parseSysStatusData,
  parseVfrHudData,
} from '../utils/wireTelemetry'

/**
 * Resolve a runtime error to the current language:
 * 1. The raw message may already be a translation key passed through from a
 *    shared module (e.g. vehicleProfiles' 'errors.encode.*').
 * 2. Otherwise a known runtime error code maps to `errors.<code>`.
 * 3. Otherwise fall back to the raw runtime event.
 */
function translateRuntimeError(code: string | undefined, message: string): string {
  if (i18next.exists(message)) return i18next.t(message)
  if (code && i18next.exists(`errors.${code}`)) return i18next.t(`errors.${code}`)
  return message
}

let refCount = 0
let unsubscribeRuntime: (() => void) | null = null
let autoParamRequestPending = false
let autoParamRequestTimer: ReturnType<typeof setTimeout> | null = null
let autoParamRequestInFlight = false
let autoParamRequestId: string | null = null
let autoParamSyncGeneration: number | null = null
let autoParamRequestAttempts = 0
// Tracks the last vehicleReady seen so parameter downloads trigger only on the
// false→true edge, not on every re-broadcast connection snapshot.
let lastVehicleReady = false
let preserveParamsOnReadyRecovery = false
let activeParamGeneration: number | null = null
// Same one-shot guard for autotune session reclaim after an owner reconnect.
let autotuneReclaimAttempt: string | null = null
let paramBatch: ParamData[] = []
let paramFlushTimer: ReturnType<typeof setTimeout> | null = null

const AUTO_PARAM_INITIAL_DELAY_MS = 300
const AUTO_PARAM_RETRY_DELAY_MS = 750
const AUTO_PARAM_MAX_ATTEMPTS = 6

function flushParamBatch() {
  if (paramFlushTimer) {
    clearTimeout(paramFlushTimer)
    paramFlushTimer = null
  }
  if (paramBatch.length === 0) return
  const batch = paramBatch
  paramBatch = []
  useParameterStore.getState().addParams(batch)
}

function discardParamBatch() {
  if (paramFlushTimer) clearTimeout(paramFlushTimer)
  paramFlushTimer = null
  paramBatch = []
}

function queueParam(param: ParamData) {
  paramBatch.push(param)
  // PX4 can stream more than a thousand parameters in a burst. Updating one
  // Zustand Map and rerendering the parameter page for every packet starves
  // navigation and local runtime processing, so commit at most ten batches/second.
  if (!paramFlushTimer) {
    paramFlushTimer = setTimeout(flushParamBatch, 100)
  }
}

function queueParams(params: ParamData[]) {
  if (params.length === 0) return
  paramBatch.push(...params)
  if (!paramFlushTimer) {
    paramFlushTimer = setTimeout(flushParamBatch, 160)
  }
}

function acceptsParamGeneration(generation: number | undefined): boolean {
  // Ungenerated messages are accepted only outside a generation-managed sync
  // (for example a PARAM_SET echo). The local runtime always stamps list batches.
  return activeParamGeneration === null
    ? generation === undefined
    : generation === activeParamGeneration
}

function sendToRuntime(msg: RuntimeCommand) {
  return localRuntime.send(msg)
}

function clearAutomaticParamRequestTimer(): void {
  if (autoParamRequestTimer) clearTimeout(autoParamRequestTimer)
  autoParamRequestTimer = null
}

/**
 * Stop only the browser-side automatic request state. The local runtime remains the
 * authority for an already-started generation; this helper is used when a
 * user explicitly starts a refresh or when the physical link goes away.
 */
function cancelAutomaticParamRequest(): void {
  clearAutomaticParamRequestTimer()
  autoParamRequestPending = false
  autoParamRequestInFlight = false
  autoParamRequestId = null
  autoParamSyncGeneration = null
  autoParamRequestAttempts = 0
}

function prepareAutomaticParamRetry(): void {
  const connection = useConnectionStore.getState()
  autoParamRequestInFlight = false
  autoParamRequestId = null
  autoParamSyncGeneration = null
  if (!connection.vehicleReady || !connection.transportOpen) {
    cancelAutomaticParamRequest()
    return
  }
  if (autoParamRequestAttempts >= AUTO_PARAM_MAX_ATTEMPTS) {
    cancelAutomaticParamRequest()
    const { receivedCount, totalCount } = useParameterStore.getState()
    useParameterStore.getState().setParamFailed(receivedCount, totalCount)
    return
  }
  autoParamRequestPending = true
  const paramStore = useParameterStore.getState()
  paramStore.clear()
  paramStore.setLoading(true)
  // A local port authority may temporarily belong to another browser. Keep the
  // request pending, but let the next controller snapshot wake it instead of
  // burning through all retry attempts while this client is read-only.
  if (connection.canControl) scheduleAutomaticParamRequest(AUTO_PARAM_RETRY_DELAY_MS)
}

function tryStartAutomaticParamRequest(): boolean {
  const connection = useConnectionStore.getState()
  // The bridge rejects parameter downloads until both heartbeat-derived target
  // IDs are known. Keep the pending flag alive until the target event arrives.
  // Both IDs are required: the local runtime deliberately rejects a request until a
  // heartbeat-confirmed target is selected, and a system-only target can point
  // at the wrong component during discovery.
  if (
    !autoParamRequestPending
    || autoParamRequestInFlight
    || !connection.vehicleReady
    || !connection.transportOpen
    || !connection.canControl
    || connection.targetSystemId === null
    || connection.targetComponentId === null
  ) return false
  const requestId = `auto-param-${Date.now().toString(36)}-${autoParamRequestAttempts + 1}`
  autoParamRequestInFlight = true
  autoParamRequestId = requestId
  if (!sendToRuntime({ type: 'param_request_list', requestId })) {
    autoParamRequestInFlight = false
    autoParamRequestId = null
    return false
  }
  autoParamRequestAttempts += 1
  clearAutomaticParamRequestTimer()
  console.log('[FC] Automatic parameter download started')
  return true
}

function scheduleAutomaticParamRequest(delayMs = AUTO_PARAM_INITIAL_DELAY_MS): void {
  if (!autoParamRequestPending || autoParamRequestInFlight || autoParamRequestTimer) return
  // Let the local runtime finish publishing the heartbeat-derived target and
  // controller boundary before putting the parameter burst on the link.
  autoParamRequestTimer = setTimeout(() => {
    autoParamRequestTimer = null
    if (!tryStartAutomaticParamRequest() && autoParamRequestPending && !autoParamRequestInFlight) {
      scheduleAutomaticParamRequest()
    }
  }, delayMs)
}

function handleAutomaticRequestRejection(requestId: string | undefined, retryable: boolean | undefined): void {
  if (!autoParamRequestInFlight || requestId !== autoParamRequestId) return
  if (retryable !== true) {
    cancelAutomaticParamRequest()
    const { receivedCount, totalCount } = useParameterStore.getState()
    useParameterStore.getState().setParamFailed(receivedCount, totalCount)
    return
  }
  prepareAutomaticParamRetry()
}

function finishAutomaticParamRequest(generation: number): void {
  if (!autoParamRequestInFlight || autoParamSyncGeneration !== generation) return
  cancelAutomaticParamRequest()
}

function retryAutomaticParamRequest(generation: number): void {
  if (!autoParamRequestInFlight || autoParamSyncGeneration !== generation) return
  prepareAutomaticParamRetry()
}

export function handleMessage(msg: RuntimeEvent) {
  const connStore = useConnectionStore.getState()
  const telemetryStore = useTelemetryStore.getState()
  const sensorStore = useSensorStore.getState()
  const paramStore = useParameterStore.getState()

  // Keep wire-message diagnostics independent from the normalized telemetry
  // stores. In particular, concurrent RAW/SCALED/HIGHRES IMU streams must each
  // retain their own liveness, measured browser receive rate, and latest frame.
  recordMavlinkRuntimeEvent(msg)

  switch (msg.type) {
    case 'hello':
      connStore.setSafetyBoundary(msg.data.safetyEpoch, msg.data.safetyAuthorityId)
      break
    case 'safety_authority':
      connStore.setSafetyBoundary(msg.data.safetyEpoch, msg.data.safetyAuthorityId)
      // A parameter request may have been waiting for a local port authority held
      // by another client. Re-evaluate it as soon as the lease boundary
      // changes instead of relying only on the periodic retry timer.
      if (autoParamRequestPending && !autoParamRequestInFlight) scheduleAutomaticParamRequest()
      break
    case 'connection': {
      const wasRawSessionActive = connStore.rawSessionActive
      const transportOpenNow = msg.data.transportOpen ?? msg.data.connected
      connStore.setConnectionSnapshot({
        status: msg.data.status ?? (msg.data.connected ? 'connected' : 'disconnected'),
        transportOpen: transportOpenNow,
        // Transport-open is not vehicle-ready. Older fallback behavior treated
        // any open serial transport as a confirmed target and could consume
        // the one-shot sync edge before the first heartbeat arrived.
        vehicleReady: msg.data.vehicleReady === true,
        rawSessionActive: msg.data.rawSessionActive ?? false,
        safetyEpoch: msg.data.safetyEpoch,
        safetyAuthorityId: msg.data.safetyAuthorityId,
        port: msg.data.port,
        type: msg.data.type,
        baudRate: msg.data.baudRate,
      })
      const vehicleReadyNow = msg.data.vehicleReady === true
      if (vehicleReadyNow) {
        // Wait for the first autopilot heartbeat before requesting parameters:
        // the local runtime learns the actual target system/component IDs from that
        // heartbeat, so the request cannot be sent to a stale/default target.
        // Only the false→true edge starts a download - the local runtime re-broadcasts
        // connection snapshots (e.g. when another client joins), and clearing an
        // already-downloaded parameter list on every snapshot would wipe it.
        if (!lastVehicleReady && !preserveParamsOnReadyRecovery) {
          cancelAutomaticParamRequest()
          discardParamBatch()
          paramStore.clear()
          paramStore.setLoading(true)
          autoParamRequestPending = true
          autoParamRequestAttempts = 0
          // vehicleReady is emitted only after the local runtime has selected a
          // heartbeat-confirmed target. Schedule after the boundary settles so
          // page-level protocol effects cannot race the automatic sync.
          scheduleAutomaticParamRequest()
        }
        preserveParamsOnReadyRecovery = false
      } else if (msg.data.rawSessionActive || (transportOpenNow && wasRawSessionActive)) {
        // An ESC raw session deliberately pauses MAVLink and drops
        // vehicleReady while keeping the same serial transport open. Preserve
        // the FC identity, synchronized parameters and ESC session state: this
        // is not a disconnect, and clearing them makes the passthrough toggle
        // appear to turn itself off even though no parameter was changed.
        cancelAutomaticParamRequest()
        discardParamBatch()
        telemetryStore.markAllStale()
        sensorStore.markAllOffline()
        preserveParamsOnReadyRecovery = false
      } else if (transportOpenNow) {
        // A soft heartbeat timeout can lower vehicleReady before the transport
        // is actually closed. Keep target-bound state until a later snapshot
        // confirms a link drop; a recovered heartbeat from the same open
        // transport must not wipe and re-download an otherwise valid cache.
        cancelAutomaticParamRequest()
        discardParamBatch()
        telemetryStore.markAllStale()
        sensorStore.markAllOffline()
        // A newly-opened transport also spends time in this state before its
        // first heartbeat. Preserve only when readiness was previously seen on
        // this same still-open transport; otherwise the upcoming ready edge is
        // the initial connection and must start a full parameter download.
        preserveParamsOnReadyRecovery = preserveParamsOnReadyRecovery || lastVehicleReady
      } else if (msg.data.reconnect) {
        // Bluetooth link dropped but the local runtime is auto-reconnecting. Keep the
        // last-known telemetry visible (greyed) instead of a full reset: the
        // link is expected back shortly. Params are cleared because they will
        // re-download automatically once the autopilot heartbeat returns.
        cancelAutomaticParamRequest()
        discardParamBatch()
        connStore.setReconnecting(msg.data.reconnect)
        telemetryStore.markAllStale()
        sensorStore.markAllOffline()
        paramStore.clear()
        preserveParamsOnReadyRecovery = false
      } else {
        cancelAutomaticParamRequest()
        discardParamBatch()
        if (!(msg.data.transportOpen ?? msg.data.connected)) connStore.setDisconnected()
        // On link drop: mark telemetry data as stale (values are retained so
        // the UI can render them greyed-out, showing the last known state),
        // revert sensor health dots to offline, and clear the parameter list
        // (stale params have no "frozen display" value and could mislead the
        // user into configuring against a disconnected FC).
        telemetryStore.markAllStale()
        sensorStore.markAllOffline()
        paramStore.clear()
        // The vehicle profile is bound to the dropped link; a later reconnect
        // must re-classify the vehicle instead of reusing the old identity.
        telemetryStore.setVehicleIdentity(null)
        // Same for the one-shot firmware snapshot: a different FC may connect.
        telemetryStore.setAutopilotVersion(null)
        // FC filesystem state is meaningless without a link.
        useFileExplorerStore.getState().reset()
        useLogTransferStore.getState().reset()
        useEscStore.getState().reset()
        useMavlinkMessageStore.getState().reset()
        useShellStore.getState().reset()
        // A calibration session is bound to the dropped FC link.
        useCalibrationStore.getState().reset()
        useAutotuneStore.getState().clearRecovery()
        useAutotuneStore.getState().reset()
        preserveParamsOnReadyRecovery = false
      }
      lastVehicleReady = vehicleReadyNow
      break
    }
    case 'telemetry':
      handleTelemetry(msg.msgType, msg.data)
      break
    case 'sensor':
      handleSensor(msg.msgType, msg.data)
      break
    case 'message_rates':
      useMessageRateStore.getState().setRates(msg.data)
      break
    case 'status':
      telemetryStore.setStatus(msg.data)
      if (autoParamRequestPending) scheduleAutomaticParamRequest()
      break
    case 'param':
      queueParam(msg.data)
      break
    case 'param_batch':
      if (!acceptsParamGeneration(msg.generation)) {
        console.warn('[Runtime] Ignoring stale parameter batch generation:', msg.generation)
        break
      }
      queueParams(msg.data)
      break
    case 'param_complete':
      if (!acceptsParamGeneration(msg.generation)) {
        console.warn('[Runtime] Ignoring stale parameter completion generation:', msg.generation)
        break
      }
      flushParamBatch()
      paramStore.setParamComplete(msg.data.count)
      if (msg.generation !== undefined) finishAutomaticParamRequest(msg.generation)
      break
    case 'param_retry':
      if (!acceptsParamGeneration(msg.generation)) {
        console.warn('[Runtime] Ignoring stale parameter retry generation:', msg.generation)
        break
      }
      flushParamBatch()
      paramStore.setParamRetry(msg.data.attempt, msg.data.missing, msg.data.total)
      break
    case 'param_failed':
      if (!acceptsParamGeneration(msg.generation)) {
        console.warn('[Runtime] Ignoring stale parameter failure generation:', msg.generation)
        break
      }
      flushParamBatch()
      paramStore.setParamFailed(msg.data.received, msg.data.total)
      break
    case 'param_set_result':
      paramStore.setWriteResult(msg.data)
      break
    case 'vehicle_config_set_result':
      useVehicleSetupStore.getState().applyConfigResult(msg.data)
      break
    case 'airframe_apply_status':
      useVehicleSetupStore.getState().setAirframeStatus(msg.data)
      break
    case 'radio_calibration_snapshot': {
      const setupStore = useVehicleSetupStore.getState()
      setupStore.applyRadioSnapshot(msg.data)
      break
    }
    case 'radio_calibration_started':
      break
    case 'ekf_status':
      telemetryStore.setEkfStatus(msg.data)
      break
    case 'rc_channels':
      telemetryStore.setRcChannels(msg.data)
      break
    case 'motor_outputs':
      telemetryStore.setMotorOutputs(msg.data)
      break
    case 'autopilot_version':
      telemetryStore.setAutopilotVersion(msg.data)
      break
    case 'link_stats':
      connStore.setLinkStats(msg.data)
      break
    case 'command_ack':
      telemetryStore.setCommandAck({
        command: msg.data.command,
        result: msg.data.result,
        requestId: msg.data.requestId,
        progress: msg.data.progress,
        terminal: msg.data.terminal,
      })
      // Surface command results so the user gets feedback on arm/takeoff/etc.
      telemetryStore.addStatusLog(
        msg.data.result === 0 || msg.data.result === 5 ? 6 : 3,
        msg.data.result === 5
          ? t('runtime.command.executing', { command: msg.data.command, progress: msg.data.progress == null ? '' : ` (${msg.data.progress}%)` })
          : msg.data.result === 0
          ? t('runtime.command.accepted', { command: msg.data.command })
          : t('runtime.command.failed', { command: msg.data.command, result: msg.data.result })
      )
      break
    case 'motor_test_status':
      telemetryStore.addStatusLog(
        5,
        t('runtime.motorTest.sent', { instance: msg.data.instance, action: msg.data.action === 'stop' ? t('runtime.motorTest.stop') : t('runtime.motorTest.test') }),
      )
      break
    case 'statustext':
      console.log(`[FC] ${msg.data.text}`)
      telemetryStore.addStatusLog(msg.data.severity, msg.data.text)
      break
    case 'shell_output':
      useShellStore.getState().append(msg.data.text)
      break
    case 'shell_status':
      useShellStore.getState().setStatus(msg.data.active, msg.data.reason)
      break
    case 'fs_list':
      useFileExplorerStore.getState().setListing(msg.data.path, msg.data.entries)
      break
    case 'fs_download_progress':
      useFileExplorerStore.getState().setDownloadProgress(
        msg.data.path,
        msg.data.receivedBytes,
        msg.data.totalBytes,
        msg.data.rateBps,
      )
      break
    case 'fs_download_complete':
      useFileExplorerStore.getState().completeDownload(
        msg.data.path,
        msg.data.artifactId,
        msg.data.fileName,
        msg.data.sizeBytes,
      )
      break
    case 'fs_delete_progress':
      useFileExplorerStore.getState().setDeleteProgress(
        msg.data.done,
        msg.data.total,
        msg.data.current,
      )
      break
    case 'fs_delete_done':
      useFileExplorerStore.getState().completeDeletion()
      break
    case 'fs_op_error': {
      const explorer = useFileExplorerStore.getState()
      const message = translateRuntimeError(msg.data.code, msg.data.message)
      if (msg.data.operation === 'list') explorer.setListError(message)
      else if (msg.data.operation === 'download') explorer.failDownload(message)
      else explorer.failDeletion(message)
      telemetryStore.addStatusLog(3, t('runtime.fileOpFailed', { message }))
      break
    }
    case 'log_list':
      useLogTransferStore.getState().setListing(msg.data.entries)
      break
    case 'log_download_progress':
      useLogTransferStore.getState().setDownloadProgress(
        msg.data.logId,
        msg.data.receivedBytes,
        msg.data.totalBytes,
        msg.data.rateBps,
      )
      break
    case 'log_download_complete':
      useLogTransferStore.getState().completeDownload(
        msg.data.logId,
        msg.data.artifactId,
        msg.data.fileName,
        msg.data.sizeBytes,
        msg.data.advertisedSizeBytes,
        msg.data.sizeAdjusted,
        msg.data.integrity,
      )
      if (msg.data.sizeAdjusted) {
        telemetryStore.addStatusLog(4, t('runtime.dataflashSizeAdjusted', {
          advertised: msg.data.advertisedSizeBytes,
          final: msg.data.sizeBytes,
        }))
      }
      break
    case 'log_erase_done':
      useLogTransferStore.getState().completeErase()
      break
    case 'log_op_error': {
      const transfer = useLogTransferStore.getState()
      const message = translateRuntimeError(msg.data.code, msg.data.message)
      if (msg.data.operation === 'list') transfer.setListError(message)
      else if (msg.data.operation === 'download') transfer.failDownload(message)
      else transfer.failErase(message)
      telemetryStore.addStatusLog(3, t('runtime.logOpFailed', { message }))
      break
    }
    case 'client_error': {
      // Boundary rejections (controller conflict, validation failure, rate
      // limit, ...) must reach the operator, not vanish silently.
      handleAutomaticRequestRejection(msg.data.requestId, msg.data.retryable)
      const message = translateRuntimeError(msg.data.code, msg.data.message)
      console.warn('[Runtime] Request rejected:', msg.data.code, msg.data.message)
      telemetryStore.addStatusLog(3, t('runtime.requestDenied', { message, retryable: msg.data.retryable ? t('runtime.retryable') : '' }))
      break
    }
    case 'operation_error': {
      handleAutomaticRequestRejection(msg.data.requestId, msg.data.retryable)
      const message = translateRuntimeError(msg.data.code, msg.data.message)
      telemetryStore.setOperationError({ ...msg.data, message })
      if (msg.data.operation === 'shell') useShellStore.getState().setStatus(false, message)
      if (msg.data.operation === 'autotune_reclaim' && msg.data.code === 'reclaim_denied') {
        useAutotuneStore.getState().clearRecovery()
        autotuneReclaimAttempt = null
      }
      console.warn('[Runtime] Operation failed:', msg.data.operation, msg.data.code, msg.data.message)
      telemetryStore.addStatusLog(3, t('runtime.opFailed', { operation: msg.data.operation, message }))
      break
    }
    case 'param_sync':
      if (msg.data.status === 'started') {
        if (activeParamGeneration !== null && msg.data.generation < activeParamGeneration) {
          console.warn('[Runtime] Ignoring stale parameter sync start:', msg.data.generation)
          break
        }
        activeParamGeneration = msg.data.generation
        if (
          autoParamRequestInFlight
          && msg.data.ownerClientId === 'local-browser'
        ) autoParamSyncGeneration = msg.data.generation
        discardParamBatch()
        paramStore.clear()
        paramStore.setLoading(true)
        break
      }
      if (activeParamGeneration !== msg.data.generation) {
        console.warn('[Runtime] Ignoring stale parameter sync ending:', msg.data.generation)
        break
      }
      // The owning client tracks normal progress via param_complete; surface
      // abnormal endings so observers also learn why a sync vanished.
      if (msg.data.status === 'failed' || msg.data.status === 'cancelled') {
        discardParamBatch()
        const { receivedCount, totalCount } = useParameterStore.getState()
        paramStore.setParamFailed(receivedCount, totalCount)
        telemetryStore.addStatusLog(
          4,
          msg.data.status === 'failed' ? t('runtime.paramSyncFailed') : t('runtime.paramSyncCancelled')
            + `${msg.data.reason ? `：${msg.data.reason}` : ''}`,
        )
      }
      if (msg.data.status === 'complete') finishAutomaticParamRequest(msg.data.generation)
      else retryAutomaticParamRequest(msg.data.generation)
      activeParamGeneration = null
      break
    case 'target':
      // Identity always tracks the local runtime's target lifecycle: cleared on
      // reset/deselection so a new vehicle can never inherit a stale profile.
      connStore.setTarget(
        msg.data.systemId,
        msg.data.componentId,
        msg.data.safetyEpoch,
        msg.data.safetyAuthorityId,
        msg.data.selectionSource,
        msg.data.conflict,
        msg.data.discovered,
      )
      telemetryStore.setVehicleIdentity(msg.data.systemId === null ? null : msg.data.identity)
      if (msg.data.reason === 'selected' && msg.data.systemId !== null) {
        telemetryStore.addStatusLog(
          6,
          t('runtime.targetSelected', { systemId: msg.data.systemId, componentId: msg.data.componentId }),
        )
      } else {
        console.log('[Runtime] target update:', msg.data)
      }
      if (autoParamRequestPending) scheduleAutomaticParamRequest()
      break
    case 'esc_session': {
      const escStore = useEscStore.getState()
      escStore.applySession(msg.data)
      break
    }
    case 'esc_session_started':
      break
    case 'esc_devices':
      useEscStore.getState().applyDevices(msg.data.sessionId, msg.data.escs)
      break
    case 'esc_settings':
      useEscStore.getState().applySettings(msg.data)
      break
    case 'esc_job_progress':
      useEscStore.getState().applyProgress(msg.data)
      break
    case 'esc_job_done':
      useEscStore.getState().applyJobDone(msg.data)
      break
    case 'esc_op_error':
      useEscStore.getState().applyOpError(msg.data)
      break
    case 'esc_log':
      useEscStore.getState().appendLog(msg.data.sessionId, msg.data.entries)
      break
    case 'calibration_update': {
      const calStore = useCalibrationStore.getState()
      calStore.applySnapshot(msg.data)
      break
    }
    case 'calibration_session_started':
      break
    case 'autotune_update': {
      const store = useAutotuneStore.getState()
      store.applySnapshot(msg.data)
      const recovery = useAutotuneStore.getState().recovery
      if (msg.data.ownerClientId === null
        && msg.data.recoverUntil !== null
        && recovery?.sessionId === msg.data.sessionId) {
        const attemptKey = recovery.sessionId + ':' + msg.data.recoverUntil
        if (autotuneReclaimAttempt !== attemptKey && sendToRuntime({
          type: 'autotune_reclaim',
          requestId: 'autotune-reclaim-' + Date.now().toString(36),
          data: recovery,
        })) autotuneReclaimAttempt = attemptKey
      } else if (msg.data.ownerClientId !== null) {
        autotuneReclaimAttempt = null
      }
      break
    }
    case 'autotune_session_started':
      autotuneReclaimAttempt = null
      useAutotuneStore.getState().setRecovery({
        sessionId: msg.data.sessionId,
        recoveryToken: msg.data.recoveryToken,
      })
      break
    default:
      console.warn('[Runtime] Unhandled runtime event type:', (msg as { type?: string }).type)
      break
  }
}

function handleTelemetry(msgType: string, wireData: unknown) {
  const telemetryStore = useTelemetryStore.getState()
  const sensorStore = useSensorStore.getState()

  switch (msgType) {
    case 'ATTITUDE': {
      const data = parseAttitudeData(wireData)
      if (!data) break
      telemetryStore.setAttitude(data)
      break
    }
    case 'GPS_RAW_INT': {
      const data = parseGpsData(wireData)
      if (!data) break
      telemetryStore.setGps(data)
      sensorStore.setSensorHealth('gps', data.fix_type >= 3 ? 'ok' : 'warning')
      break
    }
    case 'BATTERY_STATUS': {
      const data = parseBatteryData(wireData)
      if (!data) break
      telemetryStore.setBattery(data)
      // Do not claim battery health without a valid voltage source: ArduPilot
      // without a battery monitor sends all-unknown voltages.
      sensorStore.setSensorHealth(
        'battery',
        typeof data.voltage === 'number' && Number.isFinite(data.voltage) && data.voltage > 0 ? 'ok' : 'offline',
      )
      break
    }
    case 'SYS_STATUS': {
      const data = parseSysStatusData(wireData)
      if (!data) break
      telemetryStore.setSysStatus(data)
      break
    }
    case 'VFR_HUD': {
      const data = parseVfrHudData(wireData)
      if (!data) break
      telemetryStore.setVfrHud(data)
      break
    }
    case 'GLOBAL_POSITION_INT': {
      const data = parseGlobalPositionData(wireData)
      if (!data) break
      telemetryStore.setGlobalPosition(data)
      break
    }
  }
}

function handleSensor(msgType: string, wireData: unknown) {
  const sensorStore = useSensorStore.getState()

  switch (msgType) {
    case 'SCALED_IMU':
    case 'SCALED_IMU2':
    case 'SCALED_IMU3':
    case 'RAW_IMU':
    case 'HIGHRES_IMU': {
      const data = parseImuData(wireData)
      if (!data) break
      sensorStore.setImu(
        data,
        data.instance ?? (msgType === 'SCALED_IMU2' ? 1 : msgType === 'SCALED_IMU3' ? 2 : 0),
        // Source drives per-instance stream arbitration in the store; PX4 sends
        // HIGHRES_IMU + SCALED_IMU + RAW_IMU concurrently for the same IMU.
        msgType === 'HIGHRES_IMU' ? 'HIGHRES_IMU' : msgType === 'RAW_IMU' ? 'RAW_IMU' : 'SCALED_IMU',
      )
      break
    }
    case 'SCALED_PRESSURE':
    // Baro sample lifted out of HIGHRES_IMU for PX4 profiles that do not
    // stream SCALED_PRESSURE. The store arbitrates: SCALED_PRESSURE wins
    // while fresh, the HIGHRES fallback fills in only when it goes quiet.
    case 'HIGHRES_IMU_PRESSURE': {
      const data = parseBaroData(wireData)
      if (!data) break
      sensorStore.setBaro(data, msgType)
      break
    }
    case 'OPTICAL_FLOW':
    case 'OPTICAL_FLOW_RAD': {
      const data = parseOpticalFlowData(wireData)
      if (!data) break
      sensorStore.setOpticalFlow(data)
      break
    }
    case 'RANGEFINDER':
    case 'DISTANCE_SENSOR': {
      const data = parseDistanceSensorData(wireData)
      if (!data) break
      sensorStore.setDistanceSensor(data)
      break
    }
  }
}

/** Start the one worker shared by the root application. */
export function startLocalRuntime() {
  localRuntime.start()
  if (!unsubscribeRuntime) unsubscribeRuntime = localRuntime.subscribe(handleMessage)
}

/** Parse and dispatch one wire message without letting either failure escape the event callback. */
export function processRuntimeEvent(raw: string): void {
  let msg: RuntimeEvent
  try {
    msg = JSON.parse(raw) as RuntimeEvent
  } catch (error) {
    console.error('[Runtime] Parse error:', error)
    return
  }

  try {
    handleMessage(msg)
  } catch (error) {
    console.error('[Runtime] Message handler error:', error)
  }
}

/** Send through the App-owned socket without mounting another local Worker lifecycle. */
export function sendRuntimeCommand(msg: RuntimeCommand): boolean {
  // Demo runtime installs an interceptor (via startDemoMode) that fully
  // handles messages without a socket. It is NEVER registered in live mode,
  // so the no-socket safety property below is preserved for real links.
  if (demoRuntimeCommandInterceptor) return demoRuntimeCommandInterceptor(msg)
  if (msg.type === 'param_request_list') cancelAutomaticParamRequest()
  return sendToRuntime(msg)
}

// Demo-only client message interceptor. Registered exclusively by
// startDemoMode(); its lifecycle is owned by the demo module.
type DemoRuntimeCommandInterceptor = (msg: RuntimeCommand) => boolean
let demoRuntimeCommandInterceptor: DemoRuntimeCommandInterceptor | null = null

export function setDemoRuntimeCommandInterceptor(interceptor: DemoRuntimeCommandInterceptor | null): void {
  demoRuntimeCommandInterceptor = interceptor
}

// Stable stub for disabled (demo) mode: always reports failure, and stays
// referentially identical so consumers can keep it in dependency arrays.
const sendDisabled = (_msg: RuntimeCommand): boolean => false

export function useLocalRuntime(enabled = true) {
  const mountedRef = useRef(false)

  useEffect(() => {
    if (mountedRef.current) return
    if (!enabled) return
    mountedRef.current = true
    refCount++
    startLocalRuntime()

    return () => {
      mountedRef.current = false
      refCount--
      if (refCount <= 0) {
        refCount = 0
        unsubscribeRuntime?.()
        unsubscribeRuntime = null
        void localRuntime.stop()
      }
    }
  }, [enabled])

  return { send: enabled ? sendRuntimeCommand : sendDisabled }
}
