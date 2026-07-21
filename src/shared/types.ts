// MAVLink message types and shared interfaces between frontend and backend

export interface AttitudeData {
  roll: number
  pitch: number
  yaw: number
  rollspeed: number
  pitchspeed: number
  yawspeed: number
  time_boot_ms: number
}

export interface GpsData {
  fix_type: number
  lat: number
  lon: number
  alt: number
  eph: number
  epv: number
  vel: number
  cog: number
  satellites_visible: number
}

export interface BatteryData {
  voltage: number
  current: number
  remaining: number
  consumed_mah: number
}

export interface ImuData {
  xacc: number
  yacc: number
  zacc: number
  xgyro: number
  ygyro: number
  zgyro: number
  xmag: number
  ymag: number
  zmag: number
  temperature: number
}

export interface BaroData {
  press_abs: number
  press_diff: number
  temperature: number
  altitude: number
}

export interface OpticalFlowData {
  flow_x: number
  flow_y: number
  flow_comp_m_x: number
  flow_comp_m_y: number
  quality: number
  ground_distance: number
  sensor_id: number
}

export interface DistanceSensorData {
  current_distance: number
  min_distance: number
  max_distance: number
  signal_quality: number
  type: number
  id: number
  orientation: number
}

export interface EkfStatusData {
  health_flags: number
  innovation_vel: number
  innovation_pos: number
  innovation_hgt: number
  innovation_mag: number
  gps_check_fail_flags: number
}

export interface VehicleStatus {
  armed: boolean
  mode: string
  modeId: number
  // TODO: PX4 reports failsafe via STATUSTEXT / SYS_STATUS rather than a
  // dedicated HEARTBEAT bit. Currently always false - do not rely on it for
  // safety decisions until STATUSTEXT parsing is implemented.
  failsafe: boolean
  systemStatus: number
}

export interface ParamData {
  id: string
  value: number
  type: number
  param_count: number
  param_index: number
}

export interface RcChannelsData {
  ch1: number
  ch2: number
  ch3: number
  ch4: number
  ch5: number
  ch6: number
  ch7: number
  ch8: number
  ch9?: number
  ch10?: number
  ch11?: number
  ch12?: number
  ch13?: number
  ch14?: number
  ch15?: number
  ch16?: number
  ch17?: number
  ch18?: number
}

export interface MotorOutputData {
  time_usec: number
  port: number
  /** Raw PWM output in microseconds; null means the channel was not present. */
  outputs: Array<number | null>
}

// WebSocket message types (server -> client)
export type ServerMessage =
  | { type: 'telemetry'; msgType: string; data: any }
  | { type: 'sensor'; msgType: string; data: any }
  | { type: 'param'; data: ParamData }
  | { type: 'param_complete'; data: { count: number } }
  | { type: 'status'; data: VehicleStatus }
  | { type: 'connection'; data: { connected: boolean; port?: string; type?: string } }
  | { type: 'command_ack'; data: { command: number; result: number } }
  | { type: 'statustext'; data: { severity: number; text: string } }
  | { type: 'rc_channels'; data: RcChannelsData }
  | { type: 'ekf_status'; data: EkfStatusData }
  | { type: 'motor_outputs'; data: MotorOutputData }

// WebSocket message types (client -> server)
export type ClientMessage =
  | { type: 'command'; cmd: string; params: number[] }
  | { type: 'param_set'; data: { id: string; value: number; paramType: number } }
  | { type: 'param_request_list' }
  | { type: 'rc_channels_override'; data: RcChannelsData }
  | { type: 'motor_test'; data: { instance: number; throttle: number; duration: number } }

export interface PortInfo {
  path: string
  manufacturer?: string
  friendlyName?: string
  bluetoothAddress?: string
  recommended?: boolean
  productId?: string
  vendorId?: string
  pnpId?: string
}

export interface ConnectionConfig {
  type: 'serial' | 'bluetooth'
  port: string
  baudRate: number
  // Optional identifiers from the Web Serial chooser - used to match the
  // browser-selected device back to a Windows SPP COM port on the backend.
  vendorId?: string
  productId?: string
  bluetoothServiceClassId?: string
}

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error'
