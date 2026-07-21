// MAVLink v2 protocol parser and encoder
// Implements core MAVLink framing without external dependency

const MAVLINK_STX_V2 = 0xfd
const MAVLINK_STX_V1 = 0xfe

// MAVLink 2 removes trailing zero bytes from payloads. Decoders must restore
// the message's base payload length before reading fixed offsets.
const BASE_PAYLOAD_LENGTH: Record<number, number> = {
  0: 9, 1: 31, 22: 25, 24: 30, 26: 22, 27: 26, 29: 14, 30: 28,
  33: 28, 36: 21, 65: 42, 74: 20, 77: 3, 106: 44, 132: 14,
  147: 36, 230: 42, 245: 2, 253: 51,
}

// CRC extras for common message types
const CRC_EXTRA: Record<number, number> = {
  0: 50,    // HEARTBEAT
  1: 124,   // SYS_STATUS
  2: 137,   // SYSTEM_TIME
  20: 214,  // PARAM_REQUEST_READ
  21: 159,  // PARAM_REQUEST_LIST
  22: 220,  // PARAM_VALUE
  23: 168,  // PARAM_SET
  24: 24,   // GPS_RAW_INT
  25: 23,   // GPS_STATUS
  26: 170,  // SCALED_IMU
  27: 144,  // RAW_IMU
  29: 115,  // SCALED_PRESSURE
  30: 39,   // ATTITUDE
  33: 104,  // GLOBAL_POSITION_INT
  36: 104,  // SERVO_OUTPUT_RAW
  42: 150,  // MISSION_CURRENT
  62: 185,  // NAV_CONTROLLER_OUTPUT
  65: 130,  // RC_CHANNELS
  66: 124,  // REQUEST_DATA_STREAM (deprecated)
  70: 124,  // RC_CHANNELS_OVERRIDE
  73: 38,   // MISSION_ITEM_INT
  74: 20,   // VFR_HUD
  76: 152,  // COMMAND_LONG
  77: 143,  // COMMAND_ACK
  105: 130, // HIGHRES_IMU
  106: 138, // OPTICAL_FLOW_RAD
  109: 90,  // RADIO_STATUS
  111: 34,  // TIMESYNC
  116: 163, // SCALED_IMU3
  125: 130, // POWER_STATUS
  132: 85,  // DISTANCE_SENSOR
  147: 154, // BATTERY_STATUS
  148: 130, // AUTOPILOT_VERSION
  230: 163, // ESTIMATOR_STATUS
  234: 163, // HIGH_LATENCY2
  241: 134, // AUTOPILOT_VERSION
  242: 163, // ADSB_VEHICLE
  245: 130, // EXTENDED_SYS_STATE
  253: 83,  // STATUSTEXT
  259: 13,  // CAMERA_INFORMATION
}

export interface MavlinkMessage {
  msgId: number
  payload: Buffer
  seq: number
  sysId: number
  compId: number
}

export class MavlinkParser {
  private buffer: Buffer = Buffer.alloc(0)
  private seq = 0

  parse(data: Buffer): MavlinkMessage[] {
    this.buffer = Buffer.concat([this.buffer, data])
    const messages: MavlinkMessage[] = []

    while (this.buffer.length > 0) {
      // Find start byte
      const stxIndex = this.buffer.indexOf(MAVLINK_STX_V2)
      const stxV1Index = this.buffer.indexOf(MAVLINK_STX_V1)

      let startIdx = -1
      let isV2 = true

      if (stxIndex === -1 && stxV1Index === -1) {
        this.buffer = Buffer.alloc(0)
        break
      } else if (stxIndex === -1) {
        startIdx = stxV1Index
        isV2 = false
      } else if (stxV1Index === -1) {
        startIdx = stxIndex
        isV2 = true
      } else {
        if (stxIndex <= stxV1Index) {
          startIdx = stxIndex
          isV2 = true
        } else {
          startIdx = stxV1Index
          isV2 = false
        }
      }

      if (startIdx > 0) {
        this.buffer = this.buffer.subarray(startIdx)
      }

      if (isV2) {
        // MAVLink v2: STX(1) + LEN(1) + INCOMPAT(1) + COMPAT(1) + SEQ(1) + SYSID(1) + COMPID(1) + MSGID(3) + PAYLOAD + CRC(2)
        if (this.buffer.length < 12) break

        const payloadLen = this.buffer[1]
        const incompatFlags = this.buffer[2]
        const hasSignature = (incompatFlags & 0x01) !== 0
        const totalLen = 12 + payloadLen + (hasSignature ? 13 : 0)

        if (this.buffer.length < totalLen) break

        const seq = this.buffer[4]
        const sysId = this.buffer[5]
        const compId = this.buffer[6]
        const msgId = this.buffer[7] | (this.buffer[8] << 8) | (this.buffer[9] << 16)
        const payload = this.restoreV2Payload(msgId, this.buffer.subarray(10, 10 + payloadLen))

        messages.push({ msgId, payload: Buffer.from(payload), seq, sysId, compId })
        this.buffer = this.buffer.subarray(totalLen)
      } else {
        // MAVLink v1: STX(1) + LEN(1) + SEQ(1) + SYSID(1) + COMPID(1) + MSGID(1) + PAYLOAD + CRC(2)
        if (this.buffer.length < 8) break

        const payloadLen = this.buffer[1]
        const totalLen = 8 + payloadLen

        if (this.buffer.length < totalLen) break

        const seq = this.buffer[2]
        const sysId = this.buffer[3]
        const compId = this.buffer[4]
        const msgId = this.buffer[5]
        const payload = this.buffer.subarray(6, 6 + payloadLen)

        messages.push({ msgId, payload: Buffer.from(payload), seq, sysId, compId })
        this.buffer = this.buffer.subarray(totalLen)
      }
    }

    return messages
  }

  // Encode a MAVLink v2 message
  encode(msgId: number, payload: Buffer, sysId = 255, compId = 190): Buffer {
    const len = payload.length
    const header = Buffer.from([
      MAVLINK_STX_V2,
      len,
      0, // incompat flags
      0, // compat flags
      this.seq & 0xff,
      sysId,
      compId,
      msgId & 0xff,
      (msgId >> 8) & 0xff,
      (msgId >> 16) & 0xff,
    ])
    this.seq++

    // Calculate CRC
    const crcData = Buffer.concat([header.subarray(1), payload])
    const crcExtra = CRC_EXTRA[msgId] || 0
    const crc = this.crc16(crcData, crcExtra)

    const crcBuf = Buffer.from([crc & 0xff, (crc >> 8) & 0xff])
    return Buffer.concat([header, payload, crcBuf])
  }

  private crc16(data: Buffer, extra: number): number {
    let crc = 0xffff
    for (let i = 0; i < data.length; i++) {
      let tmp = data[i] ^ (crc & 0xff)
      tmp ^= (tmp << 4) & 0xff
      crc = ((crc >> 8) ^ (tmp << 8) ^ (tmp << 3) ^ (tmp >> 4)) & 0xffff
    }
    // Add CRC extra
    let tmp = extra ^ (crc & 0xff)
    tmp ^= (tmp << 4) & 0xff
    crc = ((crc >> 8) ^ (tmp << 8) ^ (tmp << 3) ^ (tmp >> 4)) & 0xffff
    return crc
  }

  getNextSeq(): number {
    return this.seq
  }

  private restoreV2Payload(msgId: number, payload: Buffer): Buffer {
    const baseLength = BASE_PAYLOAD_LENGTH[msgId]
    if (!baseLength || payload.length >= baseLength) return Buffer.from(payload)
    const restored = Buffer.alloc(baseLength)
    payload.copy(restored)
    return restored
  }
}
