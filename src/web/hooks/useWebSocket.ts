import { useEffect, useRef, useCallback } from 'react'
import { useConnectionStore } from '../stores/connectionStore'
import { useTelemetryStore } from '../stores/telemetryStore'
import { useSensorStore } from '../stores/sensorStore'
import { useParameterStore } from '../stores/parameterStore'
import type { ServerMessage, ClientMessage, ParamData } from '../../shared/types'

// Module-level singleton WebSocket shared by every useWebSocket() consumer.
// Reference counting ensures the socket is only closed when the last consumer
// unmounts (the App root), so navigating between pages no longer tears down and
// recreates the connection (which previously spawned orphaned sockets).
let wsInstance: WebSocket | null = null
let refCount = 0
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let autoParamRequestPending = false
let paramBatch: ParamData[] = []
let paramFlushTimer: ReturnType<typeof setTimeout> | null = null

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
    case 'connection':
      if (msg.data.connected) {
        connStore.setConnected(msg.data.port || '', msg.data.type || '')
        // Wait for the first autopilot heartbeat before requesting parameters:
        // the backend learns the actual target system/component IDs from that
        // heartbeat, so the request cannot be sent to a stale/default target.
        discardParamBatch()
        paramStore.clear()
        paramStore.setLoading(true)
        autoParamRequestPending = true
      } else {
        autoParamRequestPending = false
        discardParamBatch()
        connStore.setDisconnected()
        // On link drop: mark telemetry data as stale (values are retained so
        // the UI can render them greyed-out, showing the last known state),
        // revert sensor health dots to offline, and clear the parameter list
        // (stale params have no "frozen display" value and could mislead the
        // user into configuring against a disconnected FC).
        telemetryStore.markAllStale()
        sensorStore.markAllOffline()
        paramStore.clear()
      }
      break
    case 'telemetry':
      handleTelemetry(msg.msgType, msg.data)
      break
    case 'sensor':
      handleSensor(msg.msgType, msg.data)
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
    case 'param_complete':
      flushParamBatch()
      paramStore.setParamComplete(msg.data.count)
      break
    case 'param_retry':
      paramStore.setParamRetry(msg.data.attempt, msg.data.missing, msg.data.total)
      break
    case 'param_failed':
      paramStore.setParamFailed(msg.data.received, msg.data.total)
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
    case 'command_ack':
      // Surface command results so the user gets feedback on arm/takeoff/etc.
      telemetryStore.addStatusLog(
        msg.data.result === 0 ? 6 : 3,
        msg.data.result === 0
          ? `指令 #${msg.data.command} 已接受`
          : `指令 #${msg.data.command} 失败 (result=${msg.data.result})`
      )
      break
    case 'statustext':
      console.log(`[FC] ${msg.data.text}`)
      telemetryStore.addStatusLog(msg.data.severity, msg.data.text)
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
      sensorStore.setSensorHealth('battery', 'ok')
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
      sensorStore.setImu(data, data.instance ?? (msgType === 'SCALED_IMU2' ? 1 : msgType === 'SCALED_IMU3' ? 2 : 0))
      break
    case 'SCALED_PRESSURE':
      sensorStore.setBaro(data)
      break
    case 'OPTICAL_FLOW_RAD':
      sensorStore.setOpticalFlow(data)
      break
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
    // Only reconnect while consumers are still mounted.
    if (refCount <= 0) return
    console.log('[WS] Disconnected, reconnecting in 3s...')
    reconnectTimer = setTimeout(connectSocket, 3000)
  }

  ws.onerror = () => {
    ws.close()
  }
}

export function useWebSocket() {
  const mountedRef = useRef(false)

  useEffect(() => {
    if (mountedRef.current) return
    mountedRef.current = true
    refCount++
    connectSocket()

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
  }, [])

  const send = useCallback((msg: ClientMessage) => {
    if (msg.type === 'param_request_list') autoParamRequestPending = false
    sendToServer(msg)
  }, [])

  return { send }
}
