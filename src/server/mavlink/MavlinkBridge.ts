import { EventEmitter } from 'events'
import {
  common,
  minimal,
  standard,
  decode,
  serialize,
  createPacketStream,
  type MavlinkMessage,
} from './codec'
import type { MavLinkPacket } from 'node-mavlink'
import { ConnectionManager } from '../connection/ConnectionManager'
import { MAVLINK_COMMANDS, PX4_MODES } from '../../shared/constants'
import type { ServerMessage, ClientMessage, ManualControlData, RcChannelsData } from '../../shared/types'

const SERIAL_PARAM_STALL_TIMEOUT_MS = 1800
const BLUETOOTH_PARAM_STALL_TIMEOUT_MS = 3500
const SERIAL_PARAM_RETRY_BATCH_SIZE = 16
const BLUETOOTH_PARAM_RETRY_BATCH_SIZE = 4
const PARAM_MAX_STALL_RETRIES = 12
const MAV_PROTOCOL_CAPABILITY_PARAM_ENCODE_BYTEWISE = 16n
const MAV_PROTOCOL_CAPABILITY_PARAM_ENCODE_C_CAST = 131072n
type ParamEncoding = 'bytewise' | 'c-cast'
type TelemetryProfile = 'normal' | 'parameter-sync'

const MAV_SYS_STATUS_SENSOR_LABELS: Array<[number, string]> = [
  [0x00000001, '陀螺仪'],
  [0x00000002, '加速度计'],
  [0x00000004, '磁力计'],
  [0x00000008, '气压计'],
  [0x00000010, '差压计'],
  [0x00000020, 'GPS'],
  [0x00000040, '光流'],
  [0x00000080, '视觉定位'],
  [0x00000100, '测距仪'],
  [0x00000400, '角速度控制'],
  [0x00000800, '姿态控制'],
  [0x00001000, '偏航估计'],
  [0x00002000, '高度估计'],
  [0x00004000, '水平位置估计'],
  [0x00008000, '电机输出'],
  [0x00010000, 'RC 输入'],
  [0x00100000, '地理围栏'],
  [0x00200000, 'AHRS'],
  [0x00400000, '地形'],
  [0x01000000, '日志'],
  [0x02000000, '电池'],
  [0x04000000, '近距传感器'],
  [0x10000000, '飞行前检查'],
  [0x20000000, '避障'],
  [0x40000000, '推进系统'],
]

const BOARD_NAMES: Record<number, string> = {
  1139: 'MicoAir405',
  1150: 'MicoAir405v2',
  1161: 'MicoAir405Mini',
  1166: 'MicoAir743',
  1176: 'MicoAir743-AIO',
  1179: 'MicoAir743v2',
}

export class MavlinkBridge extends EventEmitter {
  private connManager: ConnectionManager
  // node-mavlink ingest pipeline: raw serial bytes are written to `splitter`
  // and emerge on `parser` as framed, CRC-validated packets (see onPacket).
  private stream: ReturnType<typeof createPacketStream>
  private crcErrorCount = 0
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null
  private requestedTelemetryStreams = false
  private paramExpectedCount = 0
  private paramIndices = new Set<number>()
  private paramDownloadActive = false
  private paramRetryAttempt = 0
  private paramRetryCursor = 0
  private paramRetryTimer: ReturnType<typeof setTimeout> | null = null
  private paramEncoding: ParamEncoding = 'c-cast'
  private paramEncodingNegotiated = false
  private requestedAutopilotVersion = false
  private targetSysId = 1
  private targetCompId = 1
  private statustextChunks = new Map<number, { severity: number; text: string; nextSequence: number }>()
  private telemetryProfile: TelemetryProfile | null = null

  private onData = (data: Buffer) => {
    // Malformed bytes on a noisy link are dropped inside the splitter; writing
    // never throws for bad MAVLink, so no try/catch is needed here.
    this.stream.splitter.write(data)
  }

  private onPacket = (packet: MavLinkPacket) => {
    // Trim node-mavlink's zero-padded payload back to the frame's true length
    // so handlers that inspect msg.payload.length (servo count, statustext
    // chunk detection, param encoding) see exactly what the vehicle sent.
    // decode() re-pads per message as needed.
    const msg: MavlinkMessage = {
      msgId: packet.header.msgid,
      payload: packet.payload.subarray(0, packet.header.payloadLength),
      seq: packet.header.seq,
      sysId: packet.header.sysid,
      compId: packet.header.compid,
    }
    try {
      if (msg.sysId === this.targetSysId) {
        this.connManager.notifyAutopilotActivity()
      }
      this.handleMessage(msg)
    } catch (err) {
      console.error('[MAVLink] handler error for msgId', msg.msgId, err)
    }
  }

  private onStatusChange = (status: string) => {
    this.cancelParamDownload(false)
    if (status === 'connected') {
      this.requestedTelemetryStreams = false
      this.telemetryProfile = null
      this.targetSysId = 1
      this.targetCompId = 1
      this.paramEncoding = 'c-cast'
      this.paramEncodingNegotiated = false
      this.requestedAutopilotVersion = false
      this.statustextChunks.clear()
      this.startHeartbeat()
    } else {
      this.requestedTelemetryStreams = false
      this.stopHeartbeat()
    }
  }

  constructor(connManager: ConnectionManager) {
    super()
    this.connManager = connManager
    this.stream = createPacketStream(() => {
      // CRC failure = corrupted frame (common on noisy Bluetooth SPP). Count
      // for link-quality diagnostics; the frame itself is already discarded.
      this.crcErrorCount++
    })
    this.stream.parser.on('data', this.onPacket)
    this.connManager.on('data', this.onData)
    this.connManager.on('statusChange', this.onStatusChange)
  }

  private startHeartbeat() {
    this.heartbeatInterval = setInterval(() => {
      this.sendHeartbeat()
    }, 1000)
  }

  private stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval)
      this.heartbeatInterval = null
    }
  }

  private sendHeartbeat() {
    // HEARTBEAT as a GCS: type=GCS(6), autopilot=INVALID(8),
    // base_mode=CUSTOM_MODE_ENABLED(1), system_status=ACTIVE(4). A healthy,
    // valid GCS heartbeat makes PX4 enable capability negotiation (a zero
    // status can make PX4 treat the GCS as faulty and withhold capabilities).
    const hb = new minimal.Heartbeat()
    hb.customMode = 0
    hb.type = 6
    hb.autopilot = 8
    hb.baseMode = 1
    hb.systemStatus = 4
    hb.mavlinkVersion = 3
    this.connManager.write(serialize(hb))
  }

  private handleMessage(msg: MavlinkMessage) {
    switch (msg.msgId) {
      case 0: // HEARTBEAT
        this.handleHeartbeat(msg)
        break
      case 1: // SYS_STATUS
        this.handleSysStatus(msg)
        break
      case 24: // GPS_RAW_INT
        this.handleGps(msg)
        break
      case 26: // SCALED_IMU
        this.handleScaledImu(msg)
        break
      case 27: // RAW_IMU
        this.handleRawImu(msg)
        break
      case 105: // HIGHRES_IMU
        this.handleHighresImu(msg)
        break
      case 116: // SCALED_IMU2
      case 129: // SCALED_IMU3
        this.handleScaledImu(msg)
        break
      case 29: // SCALED_PRESSURE
        this.handleScaledPressure(msg)
        break
      case 30: // ATTITUDE
        this.handleAttitude(msg)
        break
      case 33: // GLOBAL_POSITION_INT
        this.handleGlobalPosition(msg)
        break
      case 36: // SERVO_OUTPUT_RAW
        this.handleServoOutputRaw(msg)
        break
      case 65: // RC_CHANNELS
        this.handleRcChannels(msg)
        break
      case 74: // VFR_HUD
        this.handleVfrHud(msg)
        break
      case 77: // COMMAND_ACK
        this.handleCommandAck(msg)
        break
      case 106: // OPTICAL_FLOW_RAD
        this.handleOpticalFlow(msg)
        break
      case 132: // DISTANCE_SENSOR
        this.handleDistanceSensor(msg)
        break
      case 147: // BATTERY_STATUS
        this.handleBattery(msg)
        break
      case 148: // AUTOPILOT_VERSION
        this.handleAutopilotVersion(msg)
        break
      case 230: // ESTIMATOR_STATUS
        this.handleEstimatorStatus(msg)
        break
      case 245: // EXTENDED_SYS_STATE
        this.handleExtendedSysState(msg)
        break
      case 22: // PARAM_VALUE
        this.handleParamValue(msg)
        break
      case 253: // STATUSTEXT
        this.handleStatustext(msg)
        break
    }
  }

  private handleHeartbeat(msg: MavlinkMessage) {
    const hb = decode<minimal.Heartbeat>(0, msg.payload)
    // Ignore heartbeats from non-autopilot components (autopilot=INVALID(8)),
    // e.g. a companion computer, camera, or gimbal sharing the MAVLink system.
    if (!hb || hb.autopilot === 8) return
    this.connManager.notifyAutopilotHeartbeat()
    if (msg.sysId > 0 && msg.sysId < 255) {
      this.targetSysId = msg.sysId
      this.targetCompId = msg.compId
    }
    // Use the autopilot class only as an early compatibility fallback. The
    // authoritative encoding is negotiated from AUTOPILOT_VERSION capabilities.
    if (!this.paramEncodingNegotiated) {
      this.paramEncoding = hb.autopilot === 12 ? 'bytewise' : 'c-cast'
    }
    if (!this.requestedAutopilotVersion) {
      this.requestedAutopilotVersion = true
      this.sendCommand('MAV_CMD_REQUEST_MESSAGE', [148, 0, 0, 0, 0, 0, 0])
    }

    const armed = (hb.baseMode & 0x80) !== 0
    const mode = this.getMode(hb.customMode)
    this.emit('message', {
      type: 'status',
      data: {
        armed,
        mode: mode.name,
        modeId: mode.id,
        // PX4 reports failsafe via STATUSTEXT / SYS_STATUS sensor flags rather
        // than a dedicated HEARTBEAT bit, so it cannot be reliably derived
        // here. Report 'unknown' instead of a misleading hardcoded false - a
        // safety-critical field must never silently claim "no failsafe".
        failsafe: 'unknown',
        systemStatus: hb.systemStatus,
      },
    } as ServerMessage)

    // Ask PX4 for the streams used by the live UI once the first autopilot
    // heartbeat proves the MAVLink link is ready. Some PX4 profiles publish
    // HIGHRES_IMU instead of SCALED_IMU by default, so support and request
    // both. The bridge normalizes either format into the shared ImuData shape.
    if (!this.requestedTelemetryStreams) {
      this.requestedTelemetryStreams = true
      this.applyTelemetryProfile('normal')
    }
  }

  private handleServoOutputRaw(msg: MavlinkMessage) {
    if (msg.payload.length < 21) return
    const d = decode<common.ServoOutputRaw>(36, msg.payload)
    if (!d) return
    const servoValues = [
      d.servo1Raw, d.servo2Raw, d.servo3Raw, d.servo4Raw,
      d.servo5Raw, d.servo6Raw, d.servo7Raw, d.servo8Raw,
      d.servo9Raw, d.servo10Raw, d.servo11Raw, d.servo12Raw,
      d.servo13Raw, d.servo14Raw, d.servo15Raw, d.servo16Raw,
    ]
    // A servo output is only "present" if its bytes were actually transmitted.
    // Trailing absent channels stay null (not 0), keyed off the frame's true
    // length, so the UI does not draw motors the vehicle never reported.
    const outputs: Array<number | null> = servoValues.map((value, i) => {
      const offset = i < 8 ? 4 + i * 2 : 21 + (i - 8) * 2
      return offset + 2 <= msg.payload.length ? value : null
    })
    while (outputs.length > 4 && outputs[outputs.length - 1] == null) outputs.pop()
    this.emit('message', {
      type: 'motor_outputs',
      data: {
        time_usec: d.timeUsec,
        port: d.port,
        outputs,
      },
    } as ServerMessage)
  }

  private handleSysStatus(msg: MavlinkMessage) {
    const d = decode<common.SysStatus>(1, msg.payload)
    if (!d) return
    // These are bitmask fields; node-mavlink types them as the sensor enum, so
    // widen to number for the bitwise/comparison logic below.
    const sensorsPresent: number = d.onboardControlSensorsPresent
    const sensorsEnabled: number = d.onboardControlSensorsEnabled
    const sensorsHealth: number = d.onboardControlSensorsHealth
    const voltageBattery = d.voltageBattery / 1000
    const currentBattery = d.currentBattery / 100
    // battery_remaining is at wire offset 30. The previous hand-rolled parser
    // read offset 18 (drop_rate_comm) - a latent bug fixed by this migration.
    const batteryRemaining = d.batteryRemaining
    const prearmCheckMask = 0x10000000
    const supportsPreflightCheck = (sensorsPresent & prearmCheckMask) !== 0
    const unhealthySensorMask = (sensorsEnabled & ~sensorsHealth) >>> 0
    const unhealthySensors = MAV_SYS_STATUS_SENSOR_LABELS
      .filter(([mask]) => (unhealthySensorMask & mask) !== 0)
      .map(([, label]) => label)
    const knownMask = MAV_SYS_STATUS_SENSOR_LABELS.reduce((mask, [sensorMask]) => (mask | sensorMask) >>> 0, 0)
    const unknownMask = (unhealthySensorMask & ~knownMask) >>> 0
    if (unknownMask !== 0) unhealthySensors.push(`未知系统 0x${unknownMask.toString(16).padStart(8, '0')}`)
    this.emit('message', {
      type: 'telemetry',
      msgType: 'SYS_STATUS',
      data: {
        voltageBattery,
        currentBattery,
        batteryRemaining,
        sensorsPresent,
        sensorsEnabled,
        sensorsHealth,
        unhealthySensorMask,
        unhealthySensors,
        sensorsHealthy: sensorsEnabled !== 0
          ? unhealthySensorMask === 0
          : null,
        preflightCheck: supportsPreflightCheck
          ? (sensorsHealth & prearmCheckMask) !== 0
          : null,
      },
    } as ServerMessage)
  }

  private handleGps(msg: MavlinkMessage) {
    const d = decode<common.GpsRawInt>(24, msg.payload)
    if (!d) return
    const data = {
      fix_type: d.fixType,
      lat: d.lat / 1e7,
      lon: d.lon / 1e7,
      alt: d.alt / 1000,
      eph: d.eph,
      epv: d.epv,
      vel: d.vel / 100,
      cog: d.cog / 100,
      satellites_visible: d.satellitesVisible,
    }
    this.emit('message', { type: 'telemetry', msgType: 'GPS_RAW_INT', data } as ServerMessage)
  }

  private handleScaledImu(msg: MavlinkMessage) {
    const d = decode<common.ScaledImu>(msg.msgId, msg.payload)
    if (!d) return
    const data = {
      instance: msg.msgId === 116 ? 1 : msg.msgId === 129 ? 2 : 0,
      xacc: d.xacc / 1000,
      yacc: d.yacc / 1000,
      zacc: d.zacc / 1000,
      xgyro: d.xgyro / 1000,
      ygyro: d.ygyro / 1000,
      zgyro: d.zgyro / 1000,
      xmag: d.xmag,
      ymag: d.ymag,
      zmag: d.zmag,
      temperature: d.temperature / 100,
    }
    this.emit('message', { type: 'sensor', msgType: msg.msgId === 116 ? 'SCALED_IMU2' : msg.msgId === 129 ? 'SCALED_IMU3' : 'SCALED_IMU', data } as ServerMessage)
  }

  private handleHighresImu(msg: MavlinkMessage) {
    const d = decode<common.HighresImu>(105, msg.payload)
    if (!d) return
    const standardGravity = 9.80665
    const data = {
      instance: d.id,
      // Keep the frontend's existing units: acceleration in g, angular speed
      // in rad/s, and magnetic field in milligauss.
      xacc: d.xacc / standardGravity,
      yacc: d.yacc / standardGravity,
      zacc: d.zacc / standardGravity,
      xgyro: d.xgyro,
      ygyro: d.ygyro,
      zgyro: d.zgyro,
      xmag: d.xmag * 1000,
      ymag: d.ymag * 1000,
      zmag: d.zmag * 1000,
      temperature: d.temperature,
    }
    this.emit('message', { type: 'sensor', msgType: 'HIGHRES_IMU', data } as ServerMessage)
  }

  private handleRawImu(msg: MavlinkMessage) {
    const d = decode<common.RawImu>(27, msg.payload)
    if (!d) return
    const data = {
      instance: d.id,
      xacc: d.xacc,
      yacc: d.yacc,
      zacc: d.zacc,
      xgyro: d.xgyro,
      ygyro: d.ygyro,
      zgyro: d.zgyro,
      xmag: d.xmag,
      ymag: d.ymag,
      zmag: d.zmag,
      temperature: d.temperature / 100,
    }
    this.emit('message', { type: 'sensor', msgType: 'RAW_IMU', data } as ServerMessage)
  }

  private handleScaledPressure(msg: MavlinkMessage) {
    const d = decode<common.ScaledPressure>(29, msg.payload)
    if (!d) return
    const data = {
      press_abs: d.pressAbs,
      press_diff: d.pressDiff,
      temperature: d.temperature / 100,
      altitude: 44330 * (1 - Math.pow(d.pressAbs / 1013.25, 0.1903)),
    }
    this.emit('message', { type: 'sensor', msgType: 'SCALED_PRESSURE', data } as ServerMessage)
  }

  private handleAttitude(msg: MavlinkMessage) {
    const d = decode<common.Attitude>(30, msg.payload)
    if (!d) return
    const data = {
      time_boot_ms: d.timeBootMs,
      roll: d.roll,
      pitch: d.pitch,
      yaw: d.yaw,
      rollspeed: d.rollspeed,
      pitchspeed: d.pitchspeed,
      yawspeed: d.yawspeed,
    }
    this.emit('message', { type: 'telemetry', msgType: 'ATTITUDE', data } as ServerMessage)
  }

  private handleGlobalPosition(msg: MavlinkMessage) {
    const d = decode<common.GlobalPositionInt>(33, msg.payload)
    if (!d) return
    const data = {
      lat: d.lat / 1e7,
      lon: d.lon / 1e7,
      alt: d.alt / 1000,
      relative_alt: d.relativeAlt / 1000,
      vx: d.vx / 100,
      vy: d.vy / 100,
      vz: d.vz / 100,
      hdg: d.hdg / 100,
    }
    this.emit('message', { type: 'telemetry', msgType: 'GLOBAL_POSITION_INT', data } as ServerMessage)
  }

  private handleRcChannels(msg: MavlinkMessage) {
    const d = decode<common.RcChannels>(65, msg.payload)
    if (!d) return
    // node-mavlink decodes the size-grouped wire layout (18 uint16 channels
    // after time_boot_ms, then chancount/rssi), removing the manual offset
    // arithmetic that previously shifted channels when it was done wrong.
    const data = {
      ch1: d.chan1Raw, ch2: d.chan2Raw, ch3: d.chan3Raw, ch4: d.chan4Raw,
      ch5: d.chan5Raw, ch6: d.chan6Raw, ch7: d.chan7Raw, ch8: d.chan8Raw,
      ch9: d.chan9Raw, ch10: d.chan10Raw, ch11: d.chan11Raw, ch12: d.chan12Raw,
      ch13: d.chan13Raw, ch14: d.chan14Raw, ch15: d.chan15Raw, ch16: d.chan16Raw,
      ch17: d.chan17Raw, ch18: d.chan18Raw,
    } as RcChannelsData
    this.emit('message', { type: 'rc_channels', data } as ServerMessage)
  }

  private handleVfrHud(msg: MavlinkMessage) {
    const d = decode<common.VfrHud>(74, msg.payload)
    if (!d) return
    const finite = (value: number) => Number.isFinite(value) ? value : 0
    const data = {
      airspeed: finite(d.airspeed),
      groundspeed: finite(d.groundspeed),
      alt: finite(d.alt),
      climb: finite(d.climb),
      heading: d.heading,
      throttle: d.throttle,
    }
    this.emit('message', { type: 'telemetry', msgType: 'VFR_HUD', data } as ServerMessage)
  }

  private handleCommandAck(msg: MavlinkMessage) {
    const d = decode<common.CommandAck>(77, msg.payload)
    if (!d) return
    const data = {
      command: d.command,
      result: d.result,
    }
    this.emit('message', { type: 'command_ack', data } as ServerMessage)
  }

  private handleOpticalFlow(msg: MavlinkMessage) {
    const d = decode<common.OpticalFlowRad>(106, msg.payload)
    if (!d) return
    const data = {
      sensor_id: d.sensorId,
      flow_x: d.integratedX,
      flow_y: d.integratedY,
      flow_comp_m_x: d.integratedXgyro,
      flow_comp_m_y: d.integratedYgyro,
      quality: d.quality,
      ground_distance: d.distance,
    }
    this.emit('message', { type: 'sensor', msgType: 'OPTICAL_FLOW_RAD', data } as ServerMessage)
  }

  private handleDistanceSensor(msg: MavlinkMessage) {
    const d = decode<common.DistanceSensor>(132, msg.payload)
    if (!d) return
    const data = {
      min_distance: d.minDistance,
      max_distance: d.maxDistance,
      current_distance: d.currentDistance,
      type: d.type,
      id: d.id,
      orientation: d.orientation,
      signal_quality: msg.payload.length > 38 ? d.signalQuality : 0,
    }
    this.emit('message', { type: 'sensor', msgType: 'DISTANCE_SENSOR', data } as ServerMessage)
  }

  private handleBattery(msg: MavlinkMessage) {
    const d = decode<common.BatteryStatus>(147, msg.payload)
    if (!d) return
    const cellVoltages = (d.voltages ?? []).filter((voltage) => voltage > 0 && voltage < 0xffff)
    const data = {
      voltage: cellVoltages.reduce((sum, voltage) => sum + voltage, 0) / 1000,
      current: d.currentBattery / 100,
      consumed_mah: d.currentConsumed,
      remaining: d.batteryRemaining,
    }
    this.emit('message', { type: 'telemetry', msgType: 'BATTERY_STATUS', data } as ServerMessage)
  }

  private handleEstimatorStatus(msg: MavlinkMessage) {
    const d = decode<common.EstimatorStatus>(230, msg.payload)
    if (!d) return
    // Field names preserved from the previous implementation. gps_check_fail is
    // a PX4-specific trailer past the standard 42-byte message, so it is still
    // read from the raw payload when present.
    const data = {
      health_flags: d.flags,
      innovation_vel: d.velRatio,
      innovation_pos: d.posHorizRatio,
      innovation_hgt: d.posVertRatio,
      innovation_mag: d.magRatio,
      gps_check_fail_flags: msg.payload.length >= 44 ? msg.payload.readUInt16LE(42) : 0,
    }
    this.emit('message', { type: 'ekf_status', data } as ServerMessage)
  }

  private handleExtendedSysState(msg: MavlinkMessage) {
    // vtol_state and landed_state
  }

  private handleParamValue(msg: MavlinkMessage) {
    // Parameter storage in this GCS belongs to the selected autopilot
    // component. Ignore unrelated camera/gimbal parameter broadcasts.
    if (msg.sysId !== this.targetSysId || msg.compId !== this.targetCompId) return
    // Restore a trimmed v2 payload to PARAM_VALUE's 25-byte base before reading
    // the type byte (offset 24) and id (offsets 8..23).
    const payload = msg.payload.length >= 25
      ? msg.payload
      : Buffer.concat([msg.payload, Buffer.alloc(25 - msg.payload.length)])
    const paramType = payload[24]
    const value = this.decodeParamValue(payload, paramType)
    const paramCount = payload.readUInt16LE(4)
    const paramIndex = payload.readUInt16LE(6)
    const idBytes = payload.subarray(8, 24)
    const id = idBytes.toString('ascii').replace(/\0/g, '')

    this.emit('message', {
      type: 'param',
      data: { id, value, type: paramType, param_count: paramCount, param_index: paramIndex },
    } as ServerMessage)

    if (!this.paramDownloadActive) return

    // The first valid count belongs to this list transaction and is
    // authoritative. Chasing later outliers can leave the UI permanently
    // waiting for an index that does not exist in this download.
    if (
      this.paramExpectedCount === 0
      && paramCount > 0
      && paramCount < 0xffff
      && paramIndex >= 0
      && paramIndex < paramCount
    ) {
      this.paramExpectedCount = paramCount
    }
    if (this.paramExpectedCount > 0 && paramIndex < this.paramExpectedCount) {
      const previousSize = this.paramIndices.size
      this.paramIndices.add(paramIndex)
      if (this.paramIndices.size > previousSize) {
        // Any new index proves the link is making progress. Give the list
        // stream another quiet window before requesting individual gaps.
        this.paramRetryAttempt = 0
        this.scheduleParamRetry()
      }
    }

    if (this.paramExpectedCount > 0 && this.paramIndices.size >= this.paramExpectedCount) {
      this.completeParamDownload()
    }
  }

  private handleStatustext(msg: MavlinkMessage) {
    // Restore the trimmed v2 payload to STATUSTEXT's 54-byte base so the id and
    // chunk_seq extension fields (offsets 51/53) read correctly even when the
    // vehicle trimmed trailing zero bytes (node-mavlink hands us the exact
    // on-wire length).
    const payload = msg.payload.length >= 54
      ? msg.payload
      : Buffer.concat([msg.payload, Buffer.alloc(54 - msg.payload.length)])
    const severity = payload[0]
    const rawText = payload.subarray(1, 51)
    const terminatorIndex = rawText.indexOf(0)
    const text = rawText.subarray(0, terminatorIndex >= 0 ? terminatorIndex : rawText.length).toString('utf8')
    const id = payload.readUInt16LE(51)
    const chunkSequence = payload[53]
    const chunkComplete = terminatorIndex >= 0 || rawText.length < 50

    // id === 0 marks a single, non-chunked message: emit directly.
    if (id === 0) {
      if (text) this.emit('message', { type: 'statustext', data: { severity, text } } as ServerMessage)
      return
    }

    if (chunkSequence === 0) {
      if (chunkComplete) {
        if (text) this.emit('message', { type: 'statustext', data: { severity, text } } as ServerMessage)
      } else {
        this.statustextChunks.set(id, { severity, text, nextSequence: 1 })
      }
      return
    }

    const pending = this.statustextChunks.get(id)
    if (!pending || pending.nextSequence !== chunkSequence) {
      this.statustextChunks.delete(id)
      return
    }

    pending.text += text
    pending.nextSequence++
    if (chunkComplete) {
      this.statustextChunks.delete(id)
      this.emit('message', {
        type: 'statustext',
        data: { severity: pending.severity, text: pending.text },
      } as ServerMessage)
    }
  }

  // Send commands from frontend
  handleClientMessage(msg: ClientMessage) {
    switch (msg.type) {
      case 'command':
        this.sendCommand(msg.cmd, msg.params)
        break
      case 'param_set':
        this.sendParamSet(msg.data.id, msg.data.value, msg.data.paramType)
        break
      case 'param_request_list':
        this.sendParamRequestList()
        break
      case 'manual_control':
        this.sendManualControl(msg.data)
        break
      case 'motor_test':
        this.sendMotorTest(msg.data.instance, msg.data.throttle, msg.data.duration)
        break
    }
  }

  private sendCommand(cmd: string, params: number[]) {
    const cmdId = (MAVLINK_COMMANDS as any)[cmd]
    if (!cmdId) return

    // COMMAND_LONG (msg #76). CommandLong exposes param1..7 as the underscore-
    // prefixed serialized fields.
    const command = new common.CommandLong()
    command._param1 = params[0] ?? 0
    command._param2 = params[1] ?? 0
    command._param3 = params[2] ?? 0
    command._param4 = params[3] ?? 0
    command._param5 = params[4] ?? 0
    command._param6 = params[5] ?? 0
    command._param7 = params[6] ?? 0
    command.command = cmdId
    command.targetSystem = this.targetSysId
    command.targetComponent = this.targetCompId
    command.confirmation = 0
    this.connManager.write(serialize(command))
  }

  private sendParamSet(id: string, value: number, paramType: number) {
    // PARAM_SET (msg #23). PX4 bytewise encoding places the raw typed bytes in
    // the float param_value field, so build those 4 bytes with writeParamValue
    // and reinterpret them as the float the wire field expects.
    const valueBuf = Buffer.alloc(4)
    this.writeParamValue(valueBuf, value, paramType)
    const paramSet = new common.ParamSet()
    paramSet.paramValue = valueBuf.readFloatLE(0)
    paramSet.targetSystem = this.targetSysId
    paramSet.targetComponent = this.targetCompId
    paramSet.paramId = id
    paramSet.paramType = paramType
    this.connManager.write(serialize(paramSet))
  }

  private sendParamRequestList() {
    this.cancelParamDownload(false)
    this.paramExpectedCount = 0
    this.paramIndices.clear()
    this.paramDownloadActive = true
    this.paramRetryAttempt = 0
    this.paramRetryCursor = 0
    this.applyTelemetryProfile('parameter-sync')
    this.writeParamRequestList()
    this.scheduleParamRetry()
  }

  private handleAutopilotVersion(msg: MavlinkMessage) {
    if (
      msg.payload.length < 8
      || msg.sysId !== this.targetSysId
      || msg.compId !== this.targetCompId
    ) return

    const d = decode<standard.AutopilotVersion>(148, msg.payload)
    if (!d) return
    // capabilities is a uint64 bitmask (bigint at runtime); node-mavlink types
    // it as an enum, so cast to bigint for the capability bit tests below.
    const capabilities = d.capabilities as unknown as bigint
    if ((capabilities & MAV_PROTOCOL_CAPABILITY_PARAM_ENCODE_BYTEWISE) !== 0n) {
      this.paramEncoding = 'bytewise'
      this.paramEncodingNegotiated = true
    } else if ((capabilities & MAV_PROTOCOL_CAPABILITY_PARAM_ENCODE_C_CAST) !== 0n) {
      this.paramEncoding = 'c-cast'
      this.paramEncodingNegotiated = true
    }

    if (msg.payload.length < 60) return
    const flightSwVersion = d.flightSwVersion
    const major = (flightSwVersion >>> 24) & 0xff
    const minor = (flightSwVersion >>> 16) & 0xff
    const patch = (flightSwVersion >>> 8) & 0xff
    const boardVersion = d.boardVersion
    const upperBoardId = boardVersion >>> 16
    const lowerBoardId = boardVersion & 0xffff
    const boardId = BOARD_NAMES[upperBoardId] ? upperBoardId : BOARD_NAMES[lowerBoardId] ? lowerBoardId : upperBoardId || lowerBoardId
    const firmwareVersion = `${major}.${minor}.${patch}`
    this.emit('message', {
      type: 'autopilot_version',
      data: {
        boardId,
        boardName: BOARD_NAMES[boardId] ?? (boardId ? `Board ${boardId}` : 'PX4 Flight Controller'),
        firmwareVersion,
        firmwareLabel: `PX4 v${firmwareVersion}`,
        // vendor/product are at wire offsets 32/34. The previous parser read
        // 56/58 (inside os_custom_version) - a latent bug fixed by node-mavlink.
        vendorId: d.vendorId,
        productId: d.productId,
      },
    } as ServerMessage)
  }

  private writeParamRequestList() {
    // PARAM_REQUEST_LIST (msg #21)
    const request = new common.ParamRequestList()
    request.targetSystem = this.targetSysId
    request.targetComponent = this.targetCompId
    this.connManager.write(serialize(request))
  }

  private decodeParamValue(payload: Buffer, paramType: number) {
    if (this.paramEncoding === 'c-cast') return payload.readFloatLE(0)

    switch (paramType) {
      case 1: return payload.readUInt8(0)       // MAV_PARAM_TYPE_UINT8
      case 2: return payload.readInt8(0)        // MAV_PARAM_TYPE_INT8
      case 3: return payload.readUInt16LE(0)    // MAV_PARAM_TYPE_UINT16
      case 4: return payload.readInt16LE(0)     // MAV_PARAM_TYPE_INT16
      case 5: return payload.readUInt32LE(0)    // MAV_PARAM_TYPE_UINT32
      case 6: return payload.readInt32LE(0)     // MAV_PARAM_TYPE_INT32
      case 9: return payload.readFloatLE(0)     // MAV_PARAM_TYPE_REAL32
      default: return payload.readFloatLE(0)
    }
  }

  private writeParamValue(payload: Buffer, value: number, paramType: number) {
    if (this.paramEncoding === 'c-cast' || paramType === 9) {
      payload.writeFloatLE(value, 0)
      return
    }

    const integer = Math.trunc(value)
    switch (paramType) {
      case 1:
        payload.writeUInt8(Math.min(0xff, Math.max(0, integer)), 0)
        break
      case 2:
        payload.writeInt8(Math.min(0x7f, Math.max(-0x80, integer)), 0)
        break
      case 3:
        payload.writeUInt16LE(Math.min(0xffff, Math.max(0, integer)), 0)
        break
      case 4:
        payload.writeInt16LE(Math.min(0x7fff, Math.max(-0x8000, integer)), 0)
        break
      case 5:
        payload.writeUInt32LE(Math.min(0xffffffff, Math.max(0, integer)), 0)
        break
      case 6:
        payload.writeInt32LE(Math.min(0x7fffffff, Math.max(-0x80000000, integer)), 0)
        break
      default:
        payload.writeFloatLE(value, 0)
        break
    }
  }

  private sendParamRequestRead(index: number) {
    // PARAM_REQUEST_READ (msg #20): an empty param_id with a non-negative
    // param_index asks PX4 to retransmit that exact missing list entry.
    const request = new common.ParamRequestRead()
    request.paramIndex = index
    request.targetSystem = this.targetSysId
    request.targetComponent = this.targetCompId
    request.paramId = ''
    this.connManager.write(serialize(request))
  }

  private scheduleParamRetry() {
    if (!this.paramDownloadActive) return
    if (this.paramRetryTimer) clearTimeout(this.paramRetryTimer)
    const timeout = this.connManager.config?.type === 'bluetooth'
      ? BLUETOOTH_PARAM_STALL_TIMEOUT_MS
      : SERIAL_PARAM_STALL_TIMEOUT_MS
    this.paramRetryTimer = setTimeout(() => this.retryMissingParams(), timeout)
  }

  private retryMissingParams() {
    this.paramRetryTimer = null
    if (!this.paramDownloadActive) return

    if (this.paramRetryAttempt >= PARAM_MAX_STALL_RETRIES) {
      this.failParamDownload()
      return
    }

    this.paramRetryAttempt += 1
    if (this.paramExpectedCount === 0) {
      // No PARAM_VALUE arrived at all: repeat the list request rather than
      // guessing indices before PX4 has reported the parameter count.
      this.writeParamRequestList()
      this.emit('message', {
        type: 'param_retry',
        data: { attempt: this.paramRetryAttempt, missing: 0, total: 0 },
      } as ServerMessage)
    } else {
      const missing: number[] = []
      for (let index = 0; index < this.paramExpectedCount; index += 1) {
        if (!this.paramIndices.has(index)) missing.push(index)
      }

      if (missing.length === 0) {
        this.completeParamDownload()
        return
      }

      const batchSize = this.connManager.config?.type === 'bluetooth'
        ? BLUETOOTH_PARAM_RETRY_BATCH_SIZE
        : SERIAL_PARAM_RETRY_BATCH_SIZE
      const requestCount = Math.min(batchSize, missing.length)
      for (let offset = 0; offset < requestCount; offset += 1) {
        const missingIndex = (this.paramRetryCursor + offset) % missing.length
        this.sendParamRequestRead(missing[missingIndex])
      }
      // Rotate through all gaps instead of repeatedly hammering the first
      // permanently missing index and starving later recoverable entries.
      this.paramRetryCursor = (this.paramRetryCursor + requestCount) % missing.length
      this.emit('message', {
        type: 'param_retry',
        data: {
          attempt: this.paramRetryAttempt,
          missing: missing.length,
          total: this.paramExpectedCount,
        },
      } as ServerMessage)
    }
    this.scheduleParamRetry()
  }

  private completeParamDownload() {
    this.paramDownloadActive = false
    if (this.paramRetryTimer) {
      clearTimeout(this.paramRetryTimer)
      this.paramRetryTimer = null
    }
    this.emit('message', {
      type: 'param_complete',
      data: { count: this.paramExpectedCount },
    } as ServerMessage)
    this.applyTelemetryProfile('normal')
  }

  private failParamDownload() {
    this.paramDownloadActive = false
    if (this.paramRetryTimer) {
      clearTimeout(this.paramRetryTimer)
      this.paramRetryTimer = null
    }
    this.emit('message', {
      type: 'param_failed',
      data: { received: this.paramIndices.size, total: this.paramExpectedCount },
    } as ServerMessage)
    this.applyTelemetryProfile('normal')
  }

  private cancelParamDownload(restoreTelemetry = true) {
    this.paramDownloadActive = false
    if (this.paramRetryTimer) {
      clearTimeout(this.paramRetryTimer)
      this.paramRetryTimer = null
    }
    if (restoreTelemetry) this.applyTelemetryProfile('normal')
  }

  private applyTelemetryProfile(profile: TelemetryProfile) {
    if (this.telemetryProfile === profile || this.connManager.status !== 'connected') return
    this.telemetryProfile = profile
    const intervalUs = profile === 'parameter-sync' ? 500_000 : 50_000
    const servoIntervalUs = profile === 'parameter-sync' ? 500_000 : 100_000
    this.sendCommand('MAV_CMD_SET_MESSAGE_INTERVAL', [36, servoIntervalUs, 0, 0, 0, 0, 0])
    for (const messageId of [26, 105, 116, 129]) {
      this.sendCommand('MAV_CMD_SET_MESSAGE_INTERVAL', [messageId, intervalUs, 0, 0, 0, 0, 0])
    }
  }

  private sendManualControl(data: ManualControlData) {
    // MANUAL_CONTROL (msg #69) is PX4's MAVLink joystick input path used by
    // COM_RC_IN_MODE=1. RC_CHANNELS_OVERRIDE feeds the simulated receiver
    // pipeline instead and does not satisfy MAVLink-only manual-control health.
    const control = new common.ManualControl()
    control.x = Math.max(-1000, Math.min(1000, Math.round(data.x)))
    control.y = Math.max(-1000, Math.min(1000, Math.round(data.y)))
    control.z = Math.max(0, Math.min(1000, Math.round(data.z)))
    control.r = Math.max(-1000, Math.min(1000, Math.round(data.r)))
    control.buttons = (data.buttons ?? 0) & 0xffff
    control.target = this.targetSysId
    this.connManager.write(serialize(control))
  }

  private sendMotorTest(instance: number, throttle: number, duration: number) {
    // PX4 handles individual motor testing through MAV_CMD_ACTUATOR_TEST.
    // Values >= 1000 in param5 are PX4-internal actuator functions with the
    // 1000 transport offset. Motors 1..12 are functions 101..112, so an
    // external GCS must send 1101..1112. This works across PX4 versions and
    // avoids confusing the internal function ID with MAVLink's enum values.
    const outputFunction = 1100 + instance
    const shouldRelease = duration <= 0 || throttle <= 0
    const value = shouldRelease ? Number.NaN : Math.max(0, Math.min(1, throttle / 100))
    const timeout = shouldRelease ? 0 : Math.max(0, duration)
    this.sendCommand('MAV_CMD_ACTUATOR_TEST', [value, timeout, 0, 0, outputFunction, 0, 0])
  }

  // PX4 custom_mode layout: reserved[0..15], main_mode[16..23],
  // sub_mode[24..31]. Auto modes share main_mode=4 and differ by sub-mode.
  private getMode(customMode: number): { id: number; name: string } {
    const mainMode = customMode > 0xffff ? (customMode >>> 16) & 0xff : customMode
    const subMode = customMode > 0xffff ? (customMode >>> 24) & 0xff : 0
    const exact = Object.values(PX4_MODES).find((mode) =>
      mode.mainMode === mainMode && mode.subMode === subMode
    )
    const mainOnly = Object.values(PX4_MODES).find((mode) =>
      mode.mainMode === mainMode && mode.subMode === 0
    )
    const mode = exact ?? mainOnly
    return mode ?? { id: customMode, name: `Mode ${mainMode}${subMode ? `.${subMode}` : ''}` }
  }

  destroy() {
    this.cancelParamDownload()
    this.stopHeartbeat()
    this.stream.parser.removeAllListeners()
    this.stream.splitter.unpipe(this.stream.parser)
    this.connManager.off('data', this.onData)
    this.connManager.off('statusChange', this.onStatusChange)
  }
}
