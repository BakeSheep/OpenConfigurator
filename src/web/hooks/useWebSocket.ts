import { useEffect, useRef } from 'react'
import i18next from 'i18next'
import { connectBackendIfEnabled } from '../runtimeMode'
import { useConnectionStore } from '../stores/connectionStore'
import { useCalibrationStore } from '../stores/calibrationStore'
import { useTelemetryStore } from '../stores/telemetryStore'

const t = i18next.t.bind(i18next)

import { useSensorStore } from '../stores/sensorStore'
import { useParameterStore } from '../stores/parameterStore'
import { useFileExplorerStore } from '../stores/fileExplorerStore'
import { useLogTransferStore } from '../stores/logTransferStore'
import { useEscStore } from '../stores/escStore'
import { useMessageRateStore } from '../stores/messageRateStore'
import { useVehicleSetupStore } from '../stores/vehicleSetupStore'
import { recordMavlinkServerMessage, useMavlinkMessageStore } from '../stores/mavlinkMessageStore'
import { useShellStore } from '../stores/shellStore'
import type { ServerMessage, ClientMessage, ParamData } from '../../shared/types'
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
 * Resolve a server error to the current language:
 * 1. The raw message may already be a translation key passed through from a
 *    shared module (e.g. vehicleProfiles' 'errors.encode.*').
 * 2. Otherwise a known server error code maps to `errors.<code>`.
 * 3. Otherwise fall back to the raw server message.
 */
function translateServerError(code: string | undefined, message: string): string {
  if (i18next.exists(message)) return i18next.t(message)
  if (code && i18next.exists(`errors.${code}`)) return i18next.t(`errors.${code}`)
  return message
}

// Module-level singleton WebSocket shared by every useWebSocket() consumer.
// Reference counting ensures the socket is only closed when the last consumer
// unmounts (the App root), so navigating between pages no longer tears down and
// recreates the connection (which previously spawned orphaned sockets).
let wsInstance: WebSocket | null = null
let refCount = 0
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let reconnectAttempt = 0
let autoParamRequestPending = false
// Tracks the last vehicleReady seen so parameter downloads trigger only on the
// false→true edge, not on every re-broadcast connection snapshot.
let lastVehicleReady = false
let preserveParamsOnReadyRecovery = false
let activeParamGeneration: number | null = null
let restControlToken: string | null = null
let escReclaimAttempt: string | null = null
// Same one-shot guard for calibration session reclaim after an owner reconnect.
let calibrationReclaimAttempt: string | null = null
let radioReclaimAttempt: string | null = null
let paramBatch: ParamData[] = []
let paramFlushTimer: ReturnType<typeof setTimeout> | null = null

const RECONNECT_BASE_MS = 3000
const RECONNECT_MAX_MS = 30_000

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
  // navigation and WebSocket processing, so commit at most ten batches/second.
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
  // (for example a PARAM_SET echo). The server always stamps list batches.
  return activeParamGeneration === null
    ? generation === undefined
    : generation === activeParamGeneration
}

function sendToServer(msg: ClientMessage) {
  if (!wsInstance || wsInstance.readyState !== WebSocket.OPEN) return false
  wsInstance.send(JSON.stringify(msg))
  return true
}

export function handleMessage(msg: ServerMessage) {
  const connStore = useConnectionStore.getState()
  const telemetryStore = useTelemetryStore.getState()
  const sensorStore = useSensorStore.getState()
  const paramStore = useParameterStore.getState()

  // Keep wire-message diagnostics independent from the normalized telemetry
  // stores. In particular, concurrent RAW/SCALED/HIGHRES IMU streams must each
  // retain their own liveness, measured browser receive rate, and latest frame.
  recordMavlinkServerMessage(msg)

  switch (msg.type) {
    case 'hello':
      restControlToken = msg.data.restControlToken
      connStore.setClientId(msg.data.clientId)
      break
    case 'controller':
      connStore.setController(msg.data.clientId, msg.data.expiresAt)
      break
    case 'connection': {
      const wasRawSessionActive = connStore.rawSessionActive
      const transportOpenNow = msg.data.transportOpen ?? msg.data.connected
      connStore.setConnectionSnapshot({
        status: msg.data.status ?? (msg.data.connected ? 'connected' : 'disconnected'),
        transportOpen: transportOpenNow,
        vehicleReady: msg.data.vehicleReady ?? msg.data.connected,
        rawSessionActive: msg.data.rawSessionActive ?? false,
        port: msg.data.port,
        type: msg.data.type,
        baudRate: msg.data.baudRate,
      })
      const vehicleReadyNow = msg.data.vehicleReady ?? msg.data.connected
      if (vehicleReadyNow) {
        // Wait for the first autopilot heartbeat before requesting parameters:
        // the backend learns the actual target system/component IDs from that
        // heartbeat, so the request cannot be sent to a stale/default target.
        // Only the false→true edge starts a download - the backend re-broadcasts
        // connection snapshots (e.g. when another client joins), and clearing an
        // already-downloaded parameter list on every snapshot would wipe it.
        if (!lastVehicleReady && !preserveParamsOnReadyRecovery) {
          discardParamBatch()
          paramStore.clear()
          paramStore.setLoading(true)
          autoParamRequestPending = true
          // vehicleReady is emitted only after the backend has selected a
          // heartbeat-confirmed target. Start immediately so page-level
          // protocol effects (for example DataFlash log enumeration) cannot
          // win the link and reject the automatic parameter sync as busy.
          if (sendToServer({ type: 'param_request_list' })) {
            autoParamRequestPending = false
            console.log('[FC] Automatic parameter download started')
          }
        }
        preserveParamsOnReadyRecovery = false
      } else if (msg.data.rawSessionActive || (transportOpenNow && wasRawSessionActive)) {
        // An ESC raw session deliberately pauses MAVLink and drops
        // vehicleReady while keeping the same serial transport open. Preserve
        // the FC identity, synchronized parameters and ESC session state: this
        // is not a disconnect, and clearing them makes the passthrough toggle
        // appear to turn itself off even though no parameter was changed.
        autoParamRequestPending = false
        discardParamBatch()
        telemetryStore.markAllStale()
        sensorStore.markAllOffline()
        preserveParamsOnReadyRecovery = false
      } else if (transportOpenNow) {
        // A soft heartbeat timeout can lower vehicleReady before the transport
        // is actually closed. Keep target-bound state until a later snapshot
        // confirms a link drop; a recovered heartbeat from the same open
        // transport must not wipe and re-download an otherwise valid cache.
        autoParamRequestPending = false
        discardParamBatch()
        telemetryStore.markAllStale()
        sensorStore.markAllOffline()
        preserveParamsOnReadyRecovery = true
      } else if (msg.data.reconnect) {
        // Bluetooth link dropped but the backend is auto-reconnecting. Keep the
        // last-known telemetry visible (greyed) instead of a full reset: the
        // link is expected back shortly. Params are cleared because they will
        // re-download automatically once the autopilot heartbeat returns.
        autoParamRequestPending = false
        discardParamBatch()
        connStore.setReconnecting(msg.data.reconnect)
        telemetryStore.markAllStale()
        sensorStore.markAllOffline()
        paramStore.clear()
        preserveParamsOnReadyRecovery = false
      } else {
        autoParamRequestPending = false
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
        // A calibration session is bound to the dropped FC link. Unlike a
        // transient WS disconnect, this permanently invalidates recovery.
        useCalibrationStore.getState().clearRecovery()
        useCalibrationStore.getState().reset()
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
      if (autoParamRequestPending && sendToServer({ type: 'param_request_list' })) {
        autoParamRequestPending = false
        console.log('[FC] Automatic parameter download started')
      }
      break
    case 'param':
      queueParam(msg.data)
      break
    case 'param_batch':
      if (!acceptsParamGeneration(msg.generation)) {
        console.warn('[WS] Ignoring stale parameter batch generation:', msg.generation)
        break
      }
      queueParams(msg.data)
      break
    case 'param_complete':
      if (!acceptsParamGeneration(msg.generation)) {
        console.warn('[WS] Ignoring stale parameter completion generation:', msg.generation)
        break
      }
      flushParamBatch()
      paramStore.setParamComplete(msg.data.count)
      break
    case 'param_retry':
      if (!acceptsParamGeneration(msg.generation)) {
        console.warn('[WS] Ignoring stale parameter retry generation:', msg.generation)
        break
      }
      flushParamBatch()
      paramStore.setParamRetry(msg.data.attempt, msg.data.missing, msg.data.total)
      break
    case 'param_failed':
      if (!acceptsParamGeneration(msg.generation)) {
        console.warn('[WS] Ignoring stale parameter failure generation:', msg.generation)
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
      const recovery = useVehicleSetupStore.getState().radioRecovery
      if (msg.data.ownerClientId === null && msg.data.recoverUntil !== null && recovery?.sessionId === msg.data.sessionId) {
        const attemptKey = recovery.sessionId + ':' + msg.data.recoverUntil
        if (radioReclaimAttempt !== attemptKey && sendToServer({
          type: 'radio_calibration_reclaim',
          requestId: 'radio-reclaim-' + Date.now().toString(36),
          data: recovery,
        })) radioReclaimAttempt = attemptKey
      } else if (msg.data.ownerClientId !== null) {
        radioReclaimAttempt = null
      }
      break
    }
    case 'radio_calibration_started':
      radioReclaimAttempt = null
      useVehicleSetupStore.getState().setRadioRecovery({
        sessionId: msg.data.sessionId,
        recoveryToken: msg.data.recoveryToken,
      })
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
          ? t('websocket.command.executing', { command: msg.data.command, progress: msg.data.progress == null ? '' : ` (${msg.data.progress}%)` })
          : msg.data.result === 0
          ? t('websocket.command.accepted', { command: msg.data.command })
          : t('websocket.command.failed', { command: msg.data.command, result: msg.data.result })
      )
      break
    case 'motor_test_status':
      telemetryStore.addStatusLog(
        5,
        t('websocket.motorTest.sent', { instance: msg.data.instance, action: msg.data.action === 'stop' ? t('websocket.motorTest.stop') : t('websocket.motorTest.test') }),
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
        msg.data.downloadId,
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
      const message = translateServerError(msg.data.code, msg.data.message)
      if (msg.data.operation === 'list') explorer.setListError(message)
      else if (msg.data.operation === 'download') explorer.failDownload(message)
      else explorer.failDeletion(message)
      telemetryStore.addStatusLog(3, t('websocket.fileOpFailed', { message }))
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
        msg.data.downloadId,
        msg.data.fileName,
        msg.data.sizeBytes,
      )
      break
    case 'log_erase_done':
      useLogTransferStore.getState().completeErase()
      break
    case 'log_op_error': {
      const transfer = useLogTransferStore.getState()
      const message = translateServerError(msg.data.code, msg.data.message)
      if (msg.data.operation === 'list') transfer.setListError(message)
      else if (msg.data.operation === 'download') transfer.failDownload(message)
      else transfer.failErase(message)
      telemetryStore.addStatusLog(3, t('websocket.logOpFailed', { message }))
      break
    }
    case 'client_error': {
      // Boundary rejections (controller conflict, validation failure, rate
      // limit, ...) must reach the operator, not vanish silently.
      const message = translateServerError(msg.data.code, msg.data.message)
      console.warn('[WS] Request rejected:', msg.data.code, msg.data.message)
      telemetryStore.addStatusLog(3, t('websocket.requestDenied', { message, retryable: msg.data.retryable ? t('websocket.retryable') : '' }))
      break
    }
    case 'operation_error': {
      const message = translateServerError(msg.data.code, msg.data.message)
      telemetryStore.setOperationError({ ...msg.data, message })
      if (msg.data.operation === 'shell') useShellStore.getState().setStatus(false, message)
      if (msg.data.operation === 'calibration_reclaim' && msg.data.code === 'reclaim_denied') {
        useCalibrationStore.getState().clearRecovery()
        calibrationReclaimAttempt = null
      }
      if (msg.data.operation === 'radio_calibration_reclaim' && msg.data.code === 'reclaim_denied') {
        useVehicleSetupStore.getState().clearRadioRecovery()
        radioReclaimAttempt = null
      }
      console.warn('[WS] Operation failed:', msg.data.operation, msg.data.code, msg.data.message)
      telemetryStore.addStatusLog(3, t('websocket.opFailed', { operation: msg.data.operation, message }))
      break
    }
    case 'param_sync':
      if (msg.data.status === 'started') {
        if (activeParamGeneration !== null && msg.data.generation < activeParamGeneration) {
          console.warn('[WS] Ignoring stale parameter sync start:', msg.data.generation)
          break
        }
        activeParamGeneration = msg.data.generation
        discardParamBatch()
        paramStore.clear()
        paramStore.setLoading(true)
        break
      }
      if (activeParamGeneration !== msg.data.generation) {
        console.warn('[WS] Ignoring stale parameter sync ending:', msg.data.generation)
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
          msg.data.status === 'failed' ? t('websocket.paramSyncFailed') : t('websocket.paramSyncCancelled')
            + `${msg.data.reason ? `：${msg.data.reason}` : ''}`,
        )
      }
      activeParamGeneration = null
      break
    case 'target':
      // Identity always tracks the backend's target lifecycle: cleared on
      // reset/deselection so a new vehicle can never inherit a stale profile.
      connStore.setTarget(msg.data.systemId, msg.data.componentId)
      telemetryStore.setVehicleIdentity(msg.data.systemId === null ? null : msg.data.identity)
      if (msg.data.reason === 'selected' && msg.data.systemId !== null) {
        telemetryStore.addStatusLog(
          6,
          t('websocket.targetSelected', { systemId: msg.data.systemId, componentId: msg.data.componentId }),
        )
      } else {
        console.log('[WS] target update:', msg.data)
      }
      break
    case 'esc_session': {
      const escStore = useEscStore.getState()
      escStore.applySession(msg.data)
      const recovery = useEscStore.getState().recovery
      if (
        msg.data.state === 'orphaned'
        && recovery?.sessionId === msg.data.sessionId
      ) {
        const attemptKey = recovery.sessionId + ':' + (msg.data.recoverUntil ?? 0)
        if (escReclaimAttempt !== attemptKey && sendToServer({
          type: 'esc_session_reclaim',
          data: recovery,
        })) {
          escReclaimAttempt = attemptKey
        }
      } else if (msg.data.state === 'active' || msg.data.state === 'idle') {
        escReclaimAttempt = null
      }
      break
    }
    case 'esc_session_started':
      escReclaimAttempt = null
      useEscStore.getState().setRecovery(msg.data)
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
      if (msg.data.code === 'invalid_recovery_token' || msg.data.code === 'session_not_found') {
        useEscStore.getState().clearRecovery()
        escReclaimAttempt = null
      }
      break
    case 'esc_log':
      useEscStore.getState().appendLog(msg.data.sessionId, msg.data.entries)
      break
    case 'calibration_update': {
      const calStore = useCalibrationStore.getState()
      calStore.applySnapshot(msg.data)
      const recovery = useCalibrationStore.getState().recovery
      // Auto-reclaim once when our owned session is recoverable after a
      // reconnect. On success the server re-sends calibration_session_started.
      if (
        msg.data.ownerClientId === null
        && msg.data.recoverUntil !== null
        && recovery?.sessionId === msg.data.sessionId
      ) {
        const attemptKey = recovery.sessionId + ':' + (msg.data.recoverUntil ?? 0)
        if (calibrationReclaimAttempt !== attemptKey && sendToServer({
          type: 'calibration_reclaim',
          requestId: 'cal-reclaim-' + Date.now().toString(36),
          data: recovery,
        })) {
          calibrationReclaimAttempt = attemptKey
        }
      } else if (msg.data.ownerClientId !== null) {
        calibrationReclaimAttempt = null
      }
      break
    }
    case 'calibration_session_started':
      calibrationReclaimAttempt = null
      radioReclaimAttempt = null
      useCalibrationStore.getState().setRecovery({
        sessionId: msg.data.sessionId,
        recoveryToken: msg.data.recoveryToken,
      })
      break
    default:
      console.warn('[WS] Unhandled server message type:', (msg as { type?: string }).type)
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

function connectSocket() {
  // Reuse an existing open/connecting connection instead of spawning a new one.
  if (wsInstance && (wsInstance.readyState === WebSocket.OPEN || wsInstance.readyState === WebSocket.CONNECTING)) {
    return
  }

  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const host = window.location.hostname
  // In dev mode, connect to backend port directly
  const port = import.meta.env.DEV ? '3000' : window.location.port
  const url = `${protocol}//${host}:${port}/ws`

  const ws = new WebSocket(url)
  wsInstance = ws

  ws.onopen = () => {
    reconnectAttempt = 0
    console.log('[WS] Connected to server')
  }

  ws.onmessage = (event) => processServerMessage(event.data)

  ws.onclose = () => {
    if (wsInstance === ws) {
      restControlToken = null
      autoParamRequestPending = false
      lastVehicleReady = false
      preserveParamsOnReadyRecovery = false
      activeParamGeneration = null
      discardParamBatch()
      useConnectionStore.getState().setDisconnected()
      useTelemetryStore.getState().markAllStale()
      useTelemetryStore.getState().setVehicleIdentity(null)
      useTelemetryStore.getState().setAutopilotVersion(null)
      useSensorStore.getState().markAllOffline()
      useParameterStore.getState().clear()
      useLogTransferStore.getState().reset()
      useEscStore.getState().reset()
      useShellStore.getState().reset()
      useCalibrationStore.getState().reset()
      useVehicleSetupStore.getState().reset()
      calibrationReclaimAttempt = null
      radioReclaimAttempt = null
    }
    // Only reconnect while consumers are still mounted.
    if (refCount <= 0) return
    // Exponential backoff with jitter: a dead backend should not be hammered
    // at a fixed cadence by every open tab.
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** reconnectAttempt)
      + Math.floor(Math.random() * 500)
    reconnectAttempt += 1
    console.log(`[WS] Disconnected, reconnecting in ${(delay / 1000).toFixed(1)}s...`)
    reconnectTimer = setTimeout(connectSocket, delay)
  }

  ws.onerror = () => {
    ws.close()
  }
}

/** Parse and dispatch one wire message without letting either failure escape the event callback. */
export function processServerMessage(raw: string): void {
  let msg: ServerMessage
  try {
    msg = JSON.parse(raw) as ServerMessage
  } catch (error) {
    console.error('[WS] Parse error:', error)
    return
  }

  try {
    handleMessage(msg)
  } catch (error) {
    console.error('[WS] Message handler error:', error)
  }
}

/** Send through the App-owned socket without mounting another socket lifecycle. */
export function sendClientMessage(msg: ClientMessage): boolean {
  // Demo runtime installs an interceptor (via startDemoMode) that fully
  // handles messages without a socket. It is NEVER registered in live mode,
  // so the no-socket safety property below is preserved for real links.
  if (demoClientMessageInterceptor) return demoClientMessageInterceptor(msg)
  if (msg.type === 'param_request_list') autoParamRequestPending = false
  return sendToServer(msg)
}

// Demo-only client message interceptor. Registered exclusively by
// startDemoMode(); its lifecycle is owned by the demo module.
type DemoClientMessageInterceptor = (msg: ClientMessage) => boolean
let demoClientMessageInterceptor: DemoClientMessageInterceptor | null = null

export function setDemoClientMessageInterceptor(interceptor: DemoClientMessageInterceptor | null): void {
  demoClientMessageInterceptor = interceptor
}

// Stable stub for disabled (demo) mode: always reports failure, and stays
// referentially identical so consumers can keep it in dependency arrays.
const sendDisabled = (_msg: ClientMessage): boolean => false

export function getRestControlHeaders(): Record<string, string> {
  return restControlToken
    ? { 'X-SkyLab-Control-Token': restControlToken }
    : {}
}

export function useWebSocket(enabled = true) {
  const mountedRef = useRef(false)

  useEffect(() => {
    // Demo/static builds never open a socket: without one, sendClientMessage
    // always returns false, so no write can ever be faked as delivered.
    if (mountedRef.current) return
    const started = connectBackendIfEnabled(enabled, () => {
      mountedRef.current = true
      refCount++
      connectSocket()
    })
    if (!started) return

    return () => {
      mountedRef.current = false
      refCount--
      if (refCount <= 0) {
        refCount = 0
        if (reconnectTimer) {
          clearTimeout(reconnectTimer)
          reconnectTimer = null
        }
        wsInstance?.close()
        wsInstance = null
      }
    }
  }, [enabled])

  return { send: enabled ? sendClientMessage : sendDisabled }
}
