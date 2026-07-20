import { useEffect, useRef, useCallback } from 'react'
import { useConnectionStore } from '../stores/connectionStore'
import { useTelemetryStore } from '../stores/telemetryStore'
import { useSensorStore } from '../stores/sensorStore'
import { useParameterStore } from '../stores/parameterStore'
import type { ServerMessage, ClientMessage } from '../../shared/types'

let wsInstance: WebSocket | null = null

export function useWebSocket() {
  const connStore = useConnectionStore()
  const telemetryStore = useTelemetryStore()
  const sensorStore = useSensorStore()
  const paramStore = useParameterStore()
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const unmountedRef = useRef(false)

  const connect = useCallback(() => {
    if (unmountedRef.current) return
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
      // Don't reconnect if the component unmounted on purpose
      if (unmountedRef.current) return
      console.log('[WS] Disconnected, reconnecting in 3s...')
      reconnectRef.current = setTimeout(connect, 3000)
    }

    ws.onerror = () => {
      ws.close()
    }
  }, [])

  const handleMessage = (msg: ServerMessage) => {
    switch (msg.type) {
      case 'connection':
        if (msg.data.connected) {
          connStore.setConnected(msg.data.port || '', msg.data.type || '')
        } else {
          connStore.setDisconnected()
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
        break
      case 'param':
        paramStore.addParam(msg.data)
        break
      case 'param_complete':
        paramStore.setParamComplete(msg.data.count)
        break
      case 'ekf_status':
        telemetryStore.setEkfStatus(msg.data)
        break
      case 'rc_channels':
        telemetryStore.setRcChannels(msg.data)
        break
      case 'statustext':
        console.log(`[FC] ${msg.data.text}`)
        telemetryStore.addStatusLog(msg.data.severity, msg.data.text)
        break
    }
  }

  const handleTelemetry = (msgType: string, data: any) => {
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

  const handleSensor = (msgType: string, data: any) => {
    switch (msgType) {
      case 'SCALED_IMU':
      case 'RAW_IMU':
        sensorStore.setImu(data)
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

  const send = useCallback((msg: ClientMessage) => {
    if (wsInstance && wsInstance.readyState === WebSocket.OPEN) {
      wsInstance.send(JSON.stringify(msg))
    }
  }, [])

  useEffect(() => {
    unmountedRef.current = false
    connect()
    return () => {
      unmountedRef.current = true
      if (reconnectRef.current) clearTimeout(reconnectRef.current)
      wsInstance?.close()
      wsInstance = null
    }
  }, [connect])

  return { send }
}
