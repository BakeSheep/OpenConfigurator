import { useEffect, useRef } from 'react'
import { connectBackendIfEnabled } from '../runtimeMode'
import { useConnectionStore } from '../stores/connectionStore'
import { useCalibrationStore } from '../stores/calibrationStore'
import { useTelemetryStore } from '../stores/telemetryStore'
import { useSensorStore } from '../stores/sensorStore'
import { useParameterStore } from '../stores/parameterStore'
import { useFileExplorerStore } from '../stores/fileExplorerStore'
import { useLogTransferStore } from '../stores/logTransferStore'
import { useEscStore } from '../stores/escStore'
import { useMessageRateStore } from '../stores/messageRateStore'
import type { ServerMessage, ClientMessage, ParamData } from '../../shared/types'

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
let activeParamGeneration: number | null = null
let restControlToken: string | null = null
let escReclaimAttempt: string | null = null
// Same one-shot guard for calibration session reclaim after an owner reconnect.
let calibrationReclaimAttempt: string | null = null
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

function handleMessage(msg: ServerMessage) {
  const connStore = useConnectionStore.getState()
  const telemetryStore = useTelemetryStore.getState()
  const sensorStore = useSensorStore.getState()
  const paramStore = useParameterStore.getState()

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
        if (!lastVehicleReady) {
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
        // A calibration session is bound to the dropped FC link. Unlike a
        // transient WS disconnect, this permanently invalidates recovery.
        useCalibrationStore.getState().clearRecovery()
        useCalibrationStore.getState().reset()
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
          ? `指令 #${msg.data.command} 执行中${msg.data.progress == null ? '' : `（${msg.data.progress}%）`}`
          : msg.data.result === 0
          ? `指令 #${msg.data.command} 已接受`
          : `指令 #${msg.data.command} 失败 (result=${msg.data.result})`
      )
      break
    case 'motor_test_status':
      telemetryStore.addStatusLog(
        5,
        `电机 ${msg.data.instance} ${msg.data.action === 'stop' ? '停止' : '测试'}命令已发送（飞控 ACK 无实例字段，结果未确认）`,
      )
      break
    case 'statustext':
      console.log(`[FC] ${msg.data.text}`)
      telemetryStore.addStatusLog(msg.data.severity, msg.data.text)
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
      if (msg.data.operation === 'list') explorer.setListError(msg.data.message)
      else if (msg.data.operation === 'download') explorer.failDownload(msg.data.message)
      else explorer.failDeletion(msg.data.message)
      telemetryStore.addStatusLog(3, `文件操作失败：${msg.data.message}`)
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
      if (msg.data.operation === 'list') transfer.setListError(msg.data.message)
      else if (msg.data.operation === 'download') transfer.failDownload(msg.data.message)
      else transfer.failErase(msg.data.message)
      telemetryStore.addStatusLog(3, `日志操作失败：${msg.data.message}`)
      break
    }
    case 'client_error':
      // Boundary rejections (controller conflict, validation failure, rate
      // limit, ...) must reach the operator, not vanish silently.
      console.warn('[WS] Request rejected:', msg.data.code, msg.data.message)
      telemetryStore.addStatusLog(3, `请求被拒绝：${msg.data.message}${msg.data.retryable ? '（可重试）' : ''}`)
      break
    case 'operation_error':
      telemetryStore.setOperationError(msg.data)
      if (msg.data.operation === 'calibration_reclaim' && msg.data.code === 'reclaim_denied') {
        useCalibrationStore.getState().clearRecovery()
        calibrationReclaimAttempt = null
      }
      console.warn('[WS] Operation failed:', msg.data.operation, msg.data.code, msg.data.message)
      telemetryStore.addStatusLog(3, `${msg.data.operation} 操作失败：${msg.data.message}`)
      break
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
          `参数同步已${msg.data.status === 'failed' ? '失败' : '取消'}`
            + `${msg.data.reason ? `：${msg.data.reason}` : ''}`,
        )
      }
      activeParamGeneration = null
      break
    case 'target':
      // Identity always tracks the backend's target lifecycle: cleared on
      // reset/deselection so a new vehicle can never inherit a stale profile.
      telemetryStore.setVehicleIdentity(msg.data.systemId === null ? null : msg.data.identity)
      if (msg.data.reason === 'selected' && msg.data.systemId !== null) {
        telemetryStore.addStatusLog(
          6,
          `已选定飞控目标 system ${msg.data.systemId} / component ${msg.data.componentId}`,
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

function handleTelemetry(msgType: string, data: any) {
  const telemetryStore = useTelemetryStore.getState()
  const sensorStore = useSensorStore.getState()

  switch (msgType) {
    case 'ATTITUDE':
      telemetryStore.setAttitude(data)
      break
    case 'GPS_RAW_INT':
      telemetryStore.setGps(data)
      sensorStore.setSensorHealth('gps', data.fix_type >= 3 ? 'ok' : 'warning')
      break
    case 'BATTERY_STATUS':
      telemetryStore.setBattery(data)
      // Do not claim battery health without a valid voltage source: ArduPilot
      // without a battery monitor sends all-unknown voltages.
      sensorStore.setSensorHealth('battery', data.voltage == null ? 'offline' : 'ok')
      break
    case 'SYS_STATUS':
      telemetryStore.setSysStatus(data)
      break
    case 'VFR_HUD':
      telemetryStore.setVfrHud(data)
      break
    case 'GLOBAL_POSITION_INT':
      telemetryStore.setGlobalPosition(data)
      break
  }
}

function handleSensor(msgType: string, data: any) {
  const sensorStore = useSensorStore.getState()

  switch (msgType) {
    case 'SCALED_IMU':
    case 'SCALED_IMU2':
    case 'SCALED_IMU3':
    case 'RAW_IMU':
    case 'HIGHRES_IMU':
      sensorStore.setImu(
        data,
        data.instance ?? (msgType === 'SCALED_IMU2' ? 1 : msgType === 'SCALED_IMU3' ? 2 : 0),
        // Source drives per-instance stream arbitration in the store; PX4 sends
        // HIGHRES_IMU + SCALED_IMU + RAW_IMU concurrently for the same IMU.
        msgType === 'HIGHRES_IMU' ? 'HIGHRES_IMU' : msgType === 'RAW_IMU' ? 'RAW_IMU' : 'SCALED_IMU',
      )
      break
    case 'SCALED_PRESSURE':
    // Baro sample lifted out of HIGHRES_IMU for PX4 profiles that do not
    // stream SCALED_PRESSURE. The store arbitrates: SCALED_PRESSURE wins
    // while fresh, the HIGHRES fallback fills in only when it goes quiet.
    case 'HIGHRES_IMU_PRESSURE':
      sensorStore.setBaro(data, msgType)
      break
    case 'OPTICAL_FLOW':
    case 'OPTICAL_FLOW_RAD':
      sensorStore.setOpticalFlow(data)
      break
    case 'RANGEFINDER':
    case 'DISTANCE_SENSOR':
      sensorStore.setDistanceSensor(data)
      break
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

  ws.onmessage = (event) => {
    try {
      const msg: ServerMessage = JSON.parse(event.data)
      handleMessage(msg)
    } catch (err) {
      console.error('[WS] Parse error:', err)
    }
  }

  ws.onclose = () => {
    if (wsInstance === ws) {
      restControlToken = null
      autoParamRequestPending = false
      lastVehicleReady = false
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
      useCalibrationStore.getState().reset()
      calibrationReclaimAttempt = null
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
