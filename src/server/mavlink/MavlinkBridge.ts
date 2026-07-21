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

export class MavlinkBridge extends EventEmitter {
  private parser = new MavlinkParser()
  private connManager: ConnectionManager
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null
  private requestedOutputStream = false

  constructor(connManager: ConnectionManager) {
    super()
    this.connManager = connManager

    this.connManager.on('data', (data: Buffer) => {
      const messages = this.parser.parse(data)
      for (const msg of messages) {
        // A single malformed frame must not kill the entire batch - the next
        // valid frame would otherwise be lost until the buffer refills.
        try {
          this.handleMessage(msg)
        } catch (err) {
          console.error('[MAVLink] handler error for msgId', msg.msgId, err)
        }
      }
    })

    this.connManager.on('statusChange', (status: string) => {
      if (status === 'connected') {
        this.requestedOutputStream = false
        this.startHeartbeat()
      } else {
        this.requestedOutputStream = false
        this.stopHeartbeat()
      }
    })
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
    // HEARTBEAT: type=6(GCS), autopilot=8(invalid), base_mode=0, custom_mode=0, system_status=0
    const payload = Buffer.alloc(9)
    payload.writeUInt32LE(0, 0)  // custom_mode
    payload[4] = 6               // type: GCS
    payload[5] = 8               // autopilot: invalid
    payload[6] = 0               // base_mode
    payload[7] = 0               // system_status
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
    // This is the autopilot liveness signal - notify the connection manager so
    // its heartbeat-timeout monitor resets. Raw serial bytes are NOT sufficient
    // because a FC can stall mid-stream while the COM port stays open.
    this.connManager.notifyAutopilotHeartbeat()

    const customMode = msg.payload.readUInt32LE(0)
    const baseMode = msg.payload[6]
    const armed = (baseMode & 0x80) !== 0
    this.emit('message', {
      type: 'status',
      data: {
        armed,
        mode: this.getModeName(customMode),
        modeId: customMode,
        // TODO: PX4 reports failsafe via STATUSTEXT and SYS_STATUS sensor
        // flags rather than a dedicated HEARTBEAT bit. Decoding it reliably
        // requires correlating STATUSTEXT keywords - not implemented yet, so
        // we expose false to avoid lying about a safety-critical field.
        failsafe: false,
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
    const data = {
      press_abs: msg.payload.readFloatLE(4),
      press_diff: msg.payload.readFloatLE(8),
      temperature: msg.payload.readInt16LE(12) / 100,
      altitude: 44330 * (1 - Math.pow(msg.payload.readFloatLE(4) / 1013.25, 0.1903)),
    }
    this.emit('message', { type: 'sensor', msgType: 'SCALED_PRESSURE', data } as ServerMessage)
  }

  private handleAttitude(msg: MavlinkMessage) {
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
    const data = {
      command: msg.payload.readUInt16LE(0),
      result: msg.payload[2],
    }
    this.emit('message', { type: 'command_ack', data } as ServerMessage)
  }

  private handleOpticalFlow(msg: MavlinkMessage) {
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
    const value = msg.payload.readFloatLE(0)
    const paramCount = msg.payload.readUInt16LE(4)
    const paramIndex = msg.payload.readUInt16LE(6)
    const idBytes = msg.payload.subarray(8, 24)
    const id = idBytes.toString('ascii').replace(/\0/g, '')
    const paramType = msg.payload[24]

    this.emit('message', {
      type: 'param',
      data: { id, value, type: paramType, param_count: paramCount, param_index: paramIndex },
    } as ServerMessage)
  }

  private handleStatustext(msg: MavlinkMessage) {
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
    payload.writeUInt8(1, 30)       // target_system
    payload.writeUInt8(1, 31)       // target_component
    payload.writeUInt8(0, 32)       // confirmation
    const encoded = this.parser.encode(76, payload)
    this.connManager.write(encoded)
  }

  private sendParamSet(id: string, value: number, paramType: number) {
    // PARAM_SET (msg #23)
    const payload = Buffer.alloc(23)
    payload.writeFloatLE(value, 0)
    payload.writeUInt8(1, 4)  // target_system
    payload.writeUInt8(1, 5)  // target_component
    const idBuf = Buffer.alloc(16)
    Buffer.from(id, 'ascii').copy(idBuf)
    idBuf.copy(payload, 6)
    payload.writeUInt8(paramType, 22)
    const encoded = this.parser.encode(23, payload)
    this.connManager.write(encoded)
  }

  private sendParamRequestList() {
    // PARAM_REQUEST_LIST (msg #21)
    const payload = Buffer.alloc(2)
    payload.writeUInt8(1, 0)  // target_system
    payload.writeUInt8(1, 1)  // target_component
    const encoded = this.parser.encode(21, payload)
    this.connManager.write(encoded)
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
    payload.writeUInt8(1, 16)  // target_system
    payload.writeUInt8(1, 17)  // target_component
    for (let i = 8; i < 18; i++) payload.writeUInt16LE(channels[i], 18 + (i - 8) * 2)
    const encoded = this.parser.encode(70, payload)
    this.connManager.write(encoded)
  }

  private sendMotorTest(instance: number, throttle: number, duration: number) {
    // Use COMMAND_LONG with MAV_CMD_DO_MOTOR_TEST
    const params = [instance, 0, throttle, duration, 0, 0, 0]
    this.sendCommand('MAV_CMD_DO_MOTOR_TEST', params)
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
    this.stopHeartbeat()
    // Remove the listeners this bridge attached to connManager so a discarded
    // bridge cannot leak handlers onto a long-lived singleton.
    this.connManager.removeAllListeners()
  }
}
