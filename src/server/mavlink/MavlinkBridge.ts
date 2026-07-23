import { EventEmitter } from 'events'
import { MavlinkParser, type MavlinkMessage } from './MavlinkParser'
import { ConnectionManager } from '../connection/ConnectionManager'
import { MAVLINK_COMMANDS, PX4_MODES } from '../../shared/constants'
import type { ServerMessage, ClientMessage, RcChannelsData } from '../../shared/types'

// Reverse lookup: PX4 custom_mode id -> display name
const PX4_MODE_BY_ID: Record<number, string> = Object.values(PX4_MODES).reduce(
  (acc, m) => {
    acc[m.id] = m.name
    return acc
  },
  {} as Record<number, string>
)

const PARAM_STALL_TIMEOUT_MS = 1500
const PARAM_RETRY_BATCH_SIZE = 32
const PARAM_MAX_STALL_RETRIES = 5
const MAV_PROTOCOL_CAPABILITY_PARAM_ENCODE_BYTEWISE = 16n
const MAV_PROTOCOL_CAPABILITY_PARAM_ENCODE_C_CAST = 131072n
type ParamEncoding = 'bytewise' | 'c-cast'

export class MavlinkBridge extends EventEmitter {
  private parser = new MavlinkParser()
  private connManager: ConnectionManager
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null
  private requestedOutputStream = false
  private paramExpectedCount = 0
  private paramIndices = new Set<number>()
  private paramDownloadActive = false
  private paramRetryAttempt = 0
  private paramRetryTimer: ReturnType<typeof setTimeout> | null = null
  private paramEncoding: ParamEncoding = 'c-cast'
  private paramEncodingNegotiated = false
  private requestedAutopilotVersion = false
  private targetSysId = 1
  private targetCompId = 1

  private onData = (data: Buffer) => {
    const messages = this.parser.parse(data)
    for (const msg of messages) {
      try {
        this.handleMessage(msg)
      } catch (err) {
        console.error('[MAVLink] handler error for msgId', msg.msgId, err)
      }
    }
  }

  private onStatusChange = (status: string) => {
    this.cancelParamDownload()
    if (status === 'connected') {
      this.requestedOutputStream = false
      this.targetSysId = 1
      this.targetCompId = 1
      this.paramEncoding = 'c-cast'
      this.paramEncodingNegotiated = false
      this.requestedAutopilotVersion = false
      this.startHeartbeat()
    } else {
      this.requestedOutputStream = false
      this.stopHeartbeat()
    }
  }

  constructor(connManager: ConnectionManager) {
    super()
    this.connManager = connManager
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
    // HEARTBEAT: type=6(GCS), autopilot=8(invalid).
    // base_mode = MAV_MODE_FLAG_CUSTOM_MODE_ENABLED(1) so the FC recognises a
    // valid GCS; system_status = MAV_STATE_ACTIVE(4) so the FC sees a healthy
    // GCS and enables capability negotiation (a zero status can make PX4 treat
    // the GCS as faulty and withhold some MAVLink capabilities).
    const payload = Buffer.alloc(9)
    payload.writeUInt32LE(0, 0)  // custom_mode
    payload[4] = 6               // type: MAV_TYPE_GCS
    payload[5] = 8               // autopilot: MAV_AUTOPILOT_INVALID
    payload[6] = 1               // base_mode: MAV_MODE_FLAG_CUSTOM_MODE_ENABLED
    payload[7] = 4               // system_status: MAV_STATE_ACTIVE
    payload[8] = 3               // mavlink_version
    const msg = this.parser.encode(0, payload)
    this.connManager.write(msg)
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
    if (msg.payload.length < 8 || msg.payload[5] === 8) return
    this.connManager.notifyAutopilotHeartbeat()
    if (msg.sysId > 0 && msg.sysId < 255) {
      this.targetSysId = msg.sysId
      this.targetCompId = msg.compId
    }
    // Use the autopilot class only as an early compatibility fallback. The
    // authoritative encoding is negotiated from AUTOPILOT_VERSION capabilities.
    if (!this.paramEncodingNegotiated) {
      this.paramEncoding = msg.payload[5] === 12 ? 'bytewise' : 'c-cast'
    }
    if (!this.requestedAutopilotVersion) {
      this.requestedAutopilotVersion = true
      this.sendCommand('MAV_CMD_REQUEST_MESSAGE', [148, 0, 0, 0, 0, 0, 0])
    }

    const customMode = msg.payload.readUInt32LE(0)
    const baseMode = msg.payload[6]
    const armed = (baseMode & 0x80) !== 0
    this.emit('message', {
      type: 'status',
      data: {
        armed,
        mode: this.getModeName(customMode),
        modeId: customMode,
        // PX4 reports failsafe via STATUSTEXT / SYS_STATUS sensor flags rather
        // than a dedicated HEARTBEAT bit, so it cannot be reliably derived
        // here. Report 'unknown' instead of a misleading hardcoded false - a
        // safety-critical field must never silently claim "no failsafe".
        failsafe: 'unknown',
        systemStatus: msg.payload[7],
      },
    } as ServerMessage)

    // Ask PX4 for actuator output telemetry at 10 Hz once the first autopilot
    // heartbeat proves the MAVLink link is ready.
    if (!this.requestedOutputStream) {
      this.requestedOutputStream = true
      this.sendCommand('MAV_CMD_SET_MESSAGE_INTERVAL', [36, 100_000, 0, 0, 0, 0, 0])
    }
  }

  private handleServoOutputRaw(msg: MavlinkMessage) {
    if (msg.payload.length < 21) return
    const outputs: Array<number | null> = []
    for (let i = 0; i < 16; i++) {
      const offset = i < 8 ? 4 + i * 2 : 21 + (i - 8) * 2
      outputs.push(offset + 2 <= msg.payload.length ? msg.payload.readUInt16LE(offset) : null)
    }
    while (outputs.length > 4 && outputs[outputs.length - 1] == null) outputs.pop()
    this.emit('message', {
      type: 'motor_outputs',
      data: {
        time_usec: msg.payload.readUInt32LE(0),
        port: msg.payload[20],
        outputs,
      },
    } as ServerMessage)
  }

  private handleSysStatus(msg: MavlinkMessage) {
    if (msg.payload.length < 31) return
    const voltageBattery = msg.payload.readUInt16LE(14) / 1000
    const currentBattery = msg.payload.readInt16LE(16) / 100
    const batteryRemaining = msg.payload.readInt8(30)
    this.emit('message', {
      type: 'telemetry',
      msgType: 'SYS_STATUS',
      data: { voltageBattery, currentBattery, batteryRemaining },
    } as ServerMessage)
  }

  private handleGps(msg: MavlinkMessage) {
    if (msg.payload.length < 30) return
    const data = {
      fix_type: msg.payload[28],
      lat: msg.payload.readInt32LE(8) / 1e7,
      lon: msg.payload.readInt32LE(12) / 1e7,
      alt: msg.payload.readInt32LE(16) / 1000,
      eph: msg.payload.readUInt16LE(20),
      epv: msg.payload.readUInt16LE(22),
      vel: msg.payload.readUInt16LE(24) / 100,
      cog: msg.payload.readUInt16LE(26) / 100,
      satellites_visible: msg.payload[29],
    }
    this.emit('message', { type: 'telemetry', msgType: 'GPS_RAW_INT', data } as ServerMessage)
  }

  private handleScaledImu(msg: MavlinkMessage) {
    if (msg.payload.length < 22) return
    const data = {
      xacc: msg.payload.readInt16LE(4) / 1000,
      yacc: msg.payload.readInt16LE(6) / 1000,
      zacc: msg.payload.readInt16LE(8) / 1000,
      xgyro: msg.payload.readInt16LE(10) / 1000,
      ygyro: msg.payload.readInt16LE(12) / 1000,
      zgyro: msg.payload.readInt16LE(14) / 1000,
      xmag: msg.payload.readInt16LE(16),
      ymag: msg.payload.readInt16LE(18),
      zmag: msg.payload.readInt16LE(20),
      temperature: msg.payload.length >= 24 ? msg.payload.readInt16LE(22) / 100 : 0,
    }
    this.emit('message', { type: 'sensor', msgType: 'SCALED_IMU', data } as ServerMessage)
  }

  private handleRawImu(msg: MavlinkMessage) {
    if (msg.payload.length < 26) return
    const data = {
      xacc: msg.payload.readInt16LE(8),
      yacc: msg.payload.readInt16LE(10),
      zacc: msg.payload.readInt16LE(12),
      xgyro: msg.payload.readInt16LE(14),
      ygyro: msg.payload.readInt16LE(16),
      zgyro: msg.payload.readInt16LE(18),
      xmag: msg.payload.readInt16LE(20),
      ymag: msg.payload.readInt16LE(22),
      zmag: msg.payload.readInt16LE(24),
      temperature: msg.payload.length >= 29 ? msg.payload.readInt16LE(27) / 100 : 0,
    }
    this.emit('message', { type: 'sensor', msgType: 'RAW_IMU', data } as ServerMessage)
  }

  private handleScaledPressure(msg: MavlinkMessage) {
    if (msg.payload.length < 14) return
    const data = {
      press_abs: msg.payload.readFloatLE(4),
      press_diff: msg.payload.readFloatLE(8),
      temperature: msg.payload.readInt16LE(12) / 100,
      altitude: 44330 * (1 - Math.pow(msg.payload.readFloatLE(4) / 1013.25, 0.1903)),
    }
    this.emit('message', { type: 'sensor', msgType: 'SCALED_PRESSURE', data } as ServerMessage)
  }

  private handleAttitude(msg: MavlinkMessage) {
    if (msg.payload.length < 28) return
    const data = {
      time_boot_ms: msg.payload.readUInt32LE(0),
      roll: msg.payload.readFloatLE(4),
      pitch: msg.payload.readFloatLE(8),
      yaw: msg.payload.readFloatLE(12),
      rollspeed: msg.payload.readFloatLE(16),
      pitchspeed: msg.payload.readFloatLE(20),
      yawspeed: msg.payload.readFloatLE(24),
    }
    this.emit('message', { type: 'telemetry', msgType: 'ATTITUDE', data } as ServerMessage)
  }

  private handleGlobalPosition(msg: MavlinkMessage) {
    if (msg.payload.length < 28) return
    const data = {
      lat: msg.payload.readInt32LE(4) / 1e7,
      lon: msg.payload.readInt32LE(8) / 1e7,
      alt: msg.payload.readInt32LE(12) / 1000,
      relative_alt: msg.payload.readInt32LE(16) / 1000,
      vx: msg.payload.readInt16LE(20) / 100,
      vy: msg.payload.readInt16LE(22) / 100,
      vz: msg.payload.readInt16LE(24) / 100,
      hdg: msg.payload.readUInt16LE(26) / 100,
    }
    this.emit('message', { type: 'telemetry', msgType: 'GLOBAL_POSITION_INT', data } as ServerMessage)
  }

  private handleRcChannels(msg: MavlinkMessage) {
    // RC_CHANNELS payload: time_boot_ms(4) + chancount(1) + 18 * uint16 = 41 bytes
    // Guard explicitly so a truncated/malformed frame throws a clean no-op
    // rather than a RangeError that would otherwise be caught by the
    // per-message try/catch in the data handler.
    if (msg.payload.length < 5 + 18 * 2) return
    const channels = [
      'ch1', 'ch2', 'ch3', 'ch4', 'ch5', 'ch6', 'ch7', 'ch8',
      'ch9', 'ch10', 'ch11', 'ch12', 'ch13', 'ch14', 'ch15', 'ch16',
      'ch17', 'ch18',
    ] as const
    const data = {} as RcChannelsData
    for (let i = 0; i < channels.length; i++) {
      data[channels[i]] = msg.payload.readUInt16LE(5 + i * 2)
    }
    this.emit('message', { type: 'rc_channels', data } as ServerMessage)
  }

  private handleVfrHud(msg: MavlinkMessage) {
    if (msg.payload.length < 20) return
    const finite = (value: number) => Number.isFinite(value) ? value : 0
    const data = {
      airspeed: finite(msg.payload.readFloatLE(0)),
      groundspeed: finite(msg.payload.readFloatLE(4)),
      alt: finite(msg.payload.readFloatLE(8)),
      climb: finite(msg.payload.readFloatLE(12)),
      heading: msg.payload.readInt16LE(16),
      throttle: msg.payload.readUInt16LE(18),
    }
    this.emit('message', { type: 'telemetry', msgType: 'VFR_HUD', data } as ServerMessage)
  }

  private handleCommandAck(msg: MavlinkMessage) {
    if (msg.payload.length < 3) return
    const data = {
      command: msg.payload.readUInt16LE(0),
      result: msg.payload[2],
    }
    this.emit('message', { type: 'command_ack', data } as ServerMessage)
  }

  private handleOpticalFlow(msg: MavlinkMessage) {
    if (msg.payload.length < 44) return
    const data = {
      sensor_id: msg.payload[42],
      flow_x: msg.payload.readFloatLE(12),
      flow_y: msg.payload.readFloatLE(16),
      flow_comp_m_x: msg.payload.readFloatLE(20),
      flow_comp_m_y: msg.payload.readFloatLE(24),
      quality: msg.payload[43],
      ground_distance: msg.payload.readFloatLE(36),
    }
    this.emit('message', { type: 'sensor', msgType: 'OPTICAL_FLOW_RAD', data } as ServerMessage)
  }

  private handleDistanceSensor(msg: MavlinkMessage) {
    if (msg.payload.length < 13) return
    const data = {
      min_distance: msg.payload.readUInt16LE(4),
      max_distance: msg.payload.readUInt16LE(6),
      current_distance: msg.payload.readUInt16LE(8),
      type: msg.payload[10],
      id: msg.payload[11],
      orientation: msg.payload[12],
      signal_quality: msg.payload.length > 38 ? msg.payload[38] : 0,
    }
    this.emit('message', { type: 'sensor', msgType: 'DISTANCE_SENSOR', data } as ServerMessage)
  }

  private handleBattery(msg: MavlinkMessage) {
    // BATTERY_STATUS wire layout (common.xml, fields sorted by type size desc):
    //   id              u8    @0
    //   current_consumed  i32  @4    (mAh)
    //   energy_consumed   i32  @8    (hJ)
    //   temperature       i16  @12   (centi-degC)
    //   voltages[10]      u16  @14   (mV each)
    //   current_battery   i16  @34   (centi-A)
    //   battery_remaining i8   @36   (percent, -1=unknown)
    // Previous code read consumed_mah from offset 0 (the `id` byte) - garbage.
    if (msg.payload.length < 37) return
    const cellVoltages = Array.from({ length: 10 }, (_, index) => msg.payload.readUInt16LE(14 + index * 2))
      .filter((voltage) => voltage > 0 && voltage < 0xffff)
    const data = {
      voltage: cellVoltages.reduce((sum, voltage) => sum + voltage, 0) / 1000,
      current: msg.payload.readInt16LE(34) / 100,
      consumed_mah: msg.payload.readInt32LE(4),
      remaining: msg.payload.readInt8(36),
    }
    this.emit('message', { type: 'telemetry', msgType: 'BATTERY_STATUS', data } as ServerMessage)
  }

  private handleEstimatorStatus(msg: MavlinkMessage) {
    if (msg.payload.length < 42) return
    // ESTIMATOR_STATUS (msg #230). The previous code read `health_flags` AND
    // `control_mode_flags` from the SAME offset 40 - a duplicate read bug.
    // ESTIMATOR_STATUS has no `control_mode_flags` field; the EkfStatusData
    // type field has been removed to match. Innovation offsets are left
    // unchanged (PX4-specific estimator innovation magnitudes, already in use
    // by DashboardPage).
    const data = {
      health_flags: msg.payload.readUInt16LE(40),
      innovation_vel: msg.payload.readFloatLE(8),
      innovation_pos: msg.payload.readFloatLE(12),
      innovation_hgt: msg.payload.readFloatLE(16),
      innovation_mag: msg.payload.readFloatLE(20),
      gps_check_fail_flags: msg.payload.length >= 44 ? msg.payload.readUInt16LE(42) : 0,
    }
    this.emit('message', { type: 'ekf_status', data } as ServerMessage)
  }

  private handleExtendedSysState(msg: MavlinkMessage) {
    // vtol_state and landed_state
  }

  private handleParamValue(msg: MavlinkMessage) {
    if (msg.payload.length < 25) return
    // Parameter storage in this GCS belongs to the selected autopilot
    // component. Ignore unrelated camera/gimbal parameter broadcasts.
    if (msg.sysId !== this.targetSysId || msg.compId !== this.targetCompId) return
    const paramType = msg.payload[24]
    const value = this.decodeParamValue(msg.payload, paramType)
    const paramCount = msg.payload.readUInt16LE(4)
    const paramIndex = msg.payload.readUInt16LE(6)
    const idBytes = msg.payload.subarray(8, 24)
    const id = idBytes.toString('ascii').replace(/\0/g, '')

    this.emit('message', {
      type: 'param',
      data: { id, value, type: paramType, param_count: paramCount, param_index: paramIndex },
    } as ServerMessage)

    if (!this.paramDownloadActive) return

    this.paramExpectedCount = Math.max(this.paramExpectedCount, paramCount)
    if (paramIndex < paramCount) {
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
    if (msg.payload.length < 2) return
    const severity = msg.payload[0]
    const text = msg.payload.subarray(1).toString('ascii').replace(/\0/g, '')
    this.emit('message', { type: 'statustext', data: { severity, text } } as ServerMessage)
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
      case 'rc_channels_override':
        this.sendRcChannelsOverride(msg.data)
        break
      case 'motor_test':
        this.sendMotorTest(msg.data.instance, msg.data.throttle, msg.data.duration)
        break
    }
  }

  private sendCommand(cmd: string, params: number[]) {
    const cmdId = (MAVLINK_COMMANDS as any)[cmd]
    if (!cmdId) return

    // COMMAND_LONG (msg #76)
    const payload = Buffer.alloc(33)
    for (let i = 0; i < 7 && i < params.length; i++) {
      payload.writeFloatLE(params[i], i * 4)
    }
    payload.writeUInt16LE(cmdId, 28) // command
    payload.writeUInt8(this.targetSysId, 30)       // target_system
    payload.writeUInt8(this.targetCompId, 31)      // target_component
    payload.writeUInt8(0, 32)       // confirmation
    const encoded = this.parser.encode(76, payload)
    this.connManager.write(encoded)
  }

  private sendParamSet(id: string, value: number, paramType: number) {
    // PARAM_SET (msg #23)
    const payload = Buffer.alloc(23)
    this.writeParamValue(payload, value, paramType)
    payload.writeUInt8(this.targetSysId, 4)  // target_system
    payload.writeUInt8(this.targetCompId, 5)  // target_component
    const idBuf = Buffer.alloc(16)
    Buffer.from(id, 'ascii').copy(idBuf)
    idBuf.copy(payload, 6)
    payload.writeUInt8(paramType, 22)
    const encoded = this.parser.encode(23, payload)
    this.connManager.write(encoded)
  }

  private sendParamRequestList() {
    this.cancelParamDownload()
    this.paramExpectedCount = 0
    this.paramIndices.clear()
    this.paramDownloadActive = true
    this.paramRetryAttempt = 0
    this.writeParamRequestList()
    this.scheduleParamRetry()
  }

  private handleAutopilotVersion(msg: MavlinkMessage) {
    if (
      msg.payload.length < 8
      || msg.sysId !== this.targetSysId
      || msg.compId !== this.targetCompId
    ) return

    const capabilities = msg.payload.readBigUInt64LE(0)
    if ((capabilities & MAV_PROTOCOL_CAPABILITY_PARAM_ENCODE_BYTEWISE) !== 0n) {
      this.paramEncoding = 'bytewise'
      this.paramEncodingNegotiated = true
    } else if ((capabilities & MAV_PROTOCOL_CAPABILITY_PARAM_ENCODE_C_CAST) !== 0n) {
      this.paramEncoding = 'c-cast'
      this.paramEncodingNegotiated = true
    }
  }

  private writeParamRequestList() {
    // PARAM_REQUEST_LIST (msg #21)
    const payload = Buffer.alloc(2)
    payload.writeUInt8(this.targetSysId, 0)  // target_system
    payload.writeUInt8(this.targetCompId, 1)  // target_component
    const encoded = this.parser.encode(21, payload)
    this.connManager.write(encoded)
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
    const payload = Buffer.alloc(20)
    payload.writeInt16LE(index, 0)
    payload.writeUInt8(this.targetSysId, 2)
    payload.writeUInt8(this.targetCompId, 3)
    const encoded = this.parser.encode(20, payload)
    this.connManager.write(encoded)
  }

  private scheduleParamRetry() {
    if (!this.paramDownloadActive) return
    if (this.paramRetryTimer) clearTimeout(this.paramRetryTimer)
    this.paramRetryTimer = setTimeout(() => this.retryMissingParams(), PARAM_STALL_TIMEOUT_MS)
  }

  private retryMissingParams() {
    this.paramRetryTimer = null
    if (!this.paramDownloadActive) return

    if (this.paramRetryAttempt >= PARAM_MAX_STALL_RETRIES) {
      this.paramDownloadActive = false
      this.emit('message', {
        type: 'param_failed',
        data: { received: this.paramIndices.size, total: this.paramExpectedCount },
      } as ServerMessage)
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

      for (const index of missing.slice(0, PARAM_RETRY_BATCH_SIZE)) {
        this.sendParamRequestRead(index)
      }
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
  }

  private cancelParamDownload() {
    this.paramDownloadActive = false
    if (this.paramRetryTimer) {
      clearTimeout(this.paramRetryTimer)
      this.paramRetryTimer = null
    }
  }

  private sendRcChannelsOverride(data: RcChannelsData) {
    // RC_CHANNELS_OVERRIDE (msg #70)
    const payload = Buffer.alloc(38)
    const channels = [
      data.ch1, data.ch2, data.ch3, data.ch4,
      data.ch5, data.ch6, data.ch7, data.ch8,
      data.ch9 || 0, data.ch10 || 0, data.ch11 || 0, data.ch12 || 0,
      data.ch13 || 0, data.ch14 || 0, data.ch15 || 0, data.ch16 || 0,
      data.ch17 || 0, data.ch18 || 0,
    ]
    for (let i = 0; i < 8; i++) payload.writeUInt16LE(channels[i], i * 2)
    payload.writeUInt8(this.targetSysId, 16)  // target_system
    payload.writeUInt8(this.targetCompId, 17)  // target_component
    for (let i = 8; i < 18; i++) payload.writeUInt16LE(channels[i], 18 + (i - 8) * 2)
    const encoded = this.parser.encode(70, payload)
    this.connManager.write(encoded)
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

  // Resolve a PX4 main-mode custom_mode value to a human-readable name.
  // PX4 encodes mode in custom_mode as (main_mode << 16) | sub_mode; the
  // simple main_mode IDs used by this GCS match the PX4_MODES table.
  private getModeName(customMode: number): string {
    // PX4 stores main_mode in the high 16 bits, but many tools also report
    // the plain main_mode id directly. Support both.
    const mainMode = customMode > 0xffff ? customMode >>> 16 : customMode
    return PX4_MODE_BY_ID[mainMode] || `Mode ${customMode}`
  }

  destroy() {
    this.cancelParamDownload()
    this.stopHeartbeat()
    this.connManager.off('data', this.onData)
    this.connManager.off('statusChange', this.onStatusChange)
  }
}
