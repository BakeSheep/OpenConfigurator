// Demo mode: feeds every zustand store with realistic synthetic telemetry so
// the UI can be showcased without a flight controller. Active in two places:
// the dev-only `?demo=1` query parameter, and dedicated screenshot/UI tests.
// Demo mode never opens a local serial port, so the faked `vehicleReady` can
// never coexist with a real flight controller link, and no device write can
// ever be reported as successful.
import { useConnectionStore } from '../stores/connectionStore'
import { useTelemetryStore } from '../stores/telemetryStore'
import { useSensorStore } from '../stores/sensorStore'
import { useParameterStore } from '../stores/parameterStore'
import { useEscStore } from '../stores/escStore'
import { useCalibrationStore } from '../stores/calibrationStore'
import { setDemoRuntimeCommandInterceptor } from '../hooks/useLocalRuntime'
import { createCalibrationDemo } from './calibrationDemo'
import type { ParamData } from '../../shared/types'
import { dashboardCustomVarsStorageKey } from '../runtime'

const deg = Math.PI / 180

// [id, value, type] - MAV_PARAM_TYPE: 2=INT8-ish handled as 6 here, 6=INT32, 9=REAL32
const DEMO_PARAMS: Array<[string, number, number]> = [
  // Rate / attitude controller
  ['MC_ROLLRATE_P', 0.145, 9], ['MC_ROLLRATE_I', 0.2, 9], ['MC_ROLLRATE_D', 0.0036, 9], ['MC_ROLLRATE_K', 1.0, 9],
  ['MC_PITCHRATE_P', 0.152, 9], ['MC_PITCHRATE_I', 0.2, 9], ['MC_PITCHRATE_D', 0.0038, 9], ['MC_PITCHRATE_K', 1.0, 9],
  ['MC_YAWRATE_P', 0.21, 9], ['MC_YAWRATE_I', 0.11, 9], ['MC_YAWRATE_D', 0.0, 9], ['MC_YAWRATE_K', 1.0, 9],
  ['MC_ROLL_P', 6.5, 9], ['MC_PITCH_P', 6.5, 9], ['MC_YAW_P', 2.8, 9], ['MC_YAW_WEIGHT', 0.4, 9],
  ['MC_ROLLRATE_MAX', 220.0, 9], ['MC_PITCHRATE_MAX', 220.0, 9], ['MC_YAWRATE_MAX', 200.0, 9],
  ['MC_AIRMODE', 1, 6], ['MC_BAT_SCALE_EN', 1, 6],
  // Position controller
  ['MPC_XY_P', 0.95, 9], ['MPC_XY_VEL_P_ACC', 1.8, 9], ['MPC_XY_VEL_I_ACC', 0.4, 9], ['MPC_XY_VEL_D_ACC', 0.2, 9],
  ['MPC_Z_P', 1.0, 9], ['MPC_Z_VEL_P_ACC', 4.0, 9], ['MPC_Z_VEL_I_ACC', 2.0, 9],
  ['MPC_XY_VEL_MAX', 12.0, 9], ['MPC_XY_CRUISE', 5.0, 9], ['MPC_Z_VEL_MAX_UP', 3.0, 9], ['MPC_Z_VEL_MAX_DN', 1.5, 9],
  ['MPC_TKO_SPEED', 1.5, 9], ['MPC_LAND_SPEED', 0.7, 9], ['MPC_THR_HOVER', 0.42, 9], ['MPC_THR_MIN', 0.12, 9],
  ['MPC_THR_MAX', 1.0, 9], ['MPC_MAN_TILT_MAX', 35.0, 9], ['MPC_TILTMAX_AIR', 45.0, 9], ['MPC_HOLD_DZ', 0.1, 9],
  ['MPC_ACC_HOR_MAX', 5.0, 9], ['MPC_JERK_AUTO', 4.0, 9], ['MPC_POS_MODE', 4, 6],
  // EKF2
  ['EKF2_GPS_CTRL', 7, 6], ['EKF2_BARO_CTRL', 1, 6], ['EKF2_MAG_TYPE', 0, 6], ['EKF2_OF_CTRL', 1, 6],
  ['EKF2_RNG_CTRL', 1, 6], ['EKF2_EV_CTRL', 0, 6], ['EKF2_HGT_REF', 1, 6], ['EKF2_MULTI_IMU', 2, 6],
  ['EKF2_GPS_DELAY', 110.0, 9], ['EKF2_GPS_POS_X', 0.02, 9], ['EKF2_GPS_POS_Z', -0.05, 9],
  ['EKF2_MAG_DECL', -4.6, 9], ['EKF2_MAG_NOISE', 0.05, 9], ['EKF2_RNG_DELAY', 5.0, 9],
  ['EKF2_MIN_RNG', 0.1, 9], ['EKF2_TERR_NOISE', 5.0, 9], ['EKF2_ACC_NOISE', 0.35, 9], ['EKF2_GYR_NOISE', 0.015, 9],
  // Battery
  ['BAT1_N_CELLS', 4, 6], ['BAT1_V_EMPTY', 3.5, 9], ['BAT1_V_CHARGED', 4.2, 9], ['BAT1_CAPACITY', 5200.0, 9],
  ['BAT1_V_DIV', 18.18, 9], ['BAT1_A_PER_V', 36.4, 9], ['BAT_CRIT_THR', 0.1, 9], ['BAT_LOW_THR', 0.18, 9],
  ['BAT_EMERGEN_THR', 0.05, 9],
  // Commander / failsafe
  ['COM_ARM_WO_GPS', 0, 6], ['COM_ARM_MAG_STR', 2, 6], ['COM_ARM_SWISBTN', 0, 6], ['COM_DISARM_LAND', 2.0, 9],
  ['COM_DISARM_PRFLT', 10.0, 9], ['COM_FLTMODE1', 8, 6], ['COM_FLTMODE4', 2, 6], ['COM_FLTMODE6', 5, 6],
  ['COM_LOW_BAT_ACT', 3, 6], ['COM_OBL_RC_ACT', 2, 6], ['COM_RC_LOSS_T', 0.5, 9], ['COM_OF_LOSS_T', 1.0, 9],
  ['COM_PREARM_MODE', 1, 6], ['COM_RC_IN_MODE', 3, 6], ['COM_TAKEOFF_ACT', 0, 6],
  // Return to launch / geofence
  ['RTL_RETURN_ALT', 60.0, 9], ['RTL_DESCEND_ALT', 30.0, 9], ['RTL_LAND_DELAY', 0.0, 9], ['RTL_TYPE', 0, 6],
  ['GF_ACTION', 2, 6], ['GF_MAX_HOR_DIST', 500.0, 9], ['GF_MAX_VER_DIST', 120.0, 9],
  ['MIS_DIST_1WP', 900.0, 9], ['MIS_TAKEOFF_ALT', 2.5, 9], ['NAV_ACC_RAD', 10.0, 9], ['NAV_RCL_ACT', 2, 6],
  // Sensors / calibration
  ['SENS_BOARD_ROT', 0, 6], ['SENS_FLOW_MINHGT', 0.08, 9], ['SENS_FLOW_MAXHGT', 25.0, 9], ['SENS_FLOW_ROT', 2, 6],
  ['CAL_ACC0_ID', 2490378, 6], ['CAL_GYRO0_ID', 2490378, 6], ['CAL_MAG0_ID', 396809, 6], ['CAL_MAG0_ROT', 0, 6],
  ['CAL_ACC0_XOFF', 0.041, 9], ['CAL_ACC0_YOFF', -0.018, 9], ['CAL_ACC0_ZOFF', 0.126, 9],
  ['CAL_GYRO0_XOFF', -0.0032, 9], ['CAL_GYRO0_YOFF', 0.0011, 9], ['CAL_GYRO0_ZOFF', 0.0007, 9],
  ['CAL_MAG0_XOFF', 0.084, 9], ['CAL_MAG0_YOFF', -0.132, 9], ['CAL_MAG0_ZOFF', 0.067, 9],
  ['IMU_GYRO_CUTOFF', 40.0, 9], ['IMU_DGYRO_CUTOFF', 30.0, 9], ['IMU_ACCEL_CUTOFF', 30.0, 9], ['IMU_GYRO_RATEMAX', 400, 6],
  // RC
  ['RC1_MIN', 1000.0, 9], ['RC1_MAX', 2000.0, 9], ['RC1_TRIM', 1500.0, 9], ['RC1_REV', 1.0, 9], ['RC1_DZ', 10.0, 9],
  ['RC2_MIN', 1000.0, 9], ['RC2_MAX', 2000.0, 9], ['RC2_TRIM', 1500.0, 9], ['RC2_REV', -1.0, 9],
  ['RC3_MIN', 1000.0, 9], ['RC3_MAX', 2000.0, 9], ['RC3_TRIM', 1500.0, 9],
  ['RC4_MIN', 1000.0, 9], ['RC4_MAX', 2000.0, 9], ['RC4_TRIM', 1500.0, 9],
  ['RC_MAP_ROLL', 1, 6], ['RC_MAP_PITCH', 2, 6], ['RC_MAP_THROTTLE', 3, 6], ['RC_MAP_YAW', 4, 6],
  ['RC_MAP_FLTMODE', 5, 6], ['RC_MAP_ARM_SW', 6, 6], ['RC_CHAN_CNT', 16, 6],
  // Actuators / PWM
  ['PWM_MAIN_TIM0', -3, 6], ['PWM_MAIN_FUNC1', 101, 6], ['PWM_MAIN_FUNC2', 102, 6],
  ['PWM_MAIN_FUNC3', 103, 6], ['PWM_MAIN_FUNC4', 104, 6],
  ['CA_ROTOR_COUNT', 4, 6], ['CA_ROTOR0_PX', 0.15, 9], ['CA_ROTOR0_PY', 0.22, 9], ['CA_ROTOR0_KM', 0.05, 9],
  ['THR_MDL_FAC', 0.3, 9],
  // System / MAVLink
  ['MAV_SYS_ID', 1, 6], ['MAV_COMP_ID', 1, 6], ['MAV_TYPE', 2, 6], ['MAV_PROTO_VER', 2, 6],
  ['MAV_0_CONFIG', 101, 6], ['MAV_0_MODE', 0, 6], ['MAV_0_RATE', 1200, 6], ['MAV_0_RADIO_CTL', 1, 6], ['MAV_0_FORWARD', 1, 6],
  ['MAV_1_CONFIG', 102, 6], ['MAV_1_MODE', 2, 6], ['MAV_1_RATE', 0, 6], ['MAV_1_RADIO_CTL', 0, 6], ['MAV_1_FORWARD', 0, 6],
  ['GPS_1_CONFIG', 201, 6], ['GPS_1_PROTOCOL', 1, 6], ['GPS_2_CONFIG', 0, 6], ['GPS_2_PROTOCOL', 0, 6],
  ['SER_GPS1_BAUD', 0, 6], ['SER_GPS2_BAUD', 0, 6],
  ['SER_TEL1_BAUD', 57600, 6], ['SER_TEL2_BAUD', 921600, 6], ['SYS_AUTOSTART', 4001, 6], ['SYS_HAS_MAG', 1, 6],
  ['SDLOG_MODE', 0, 6], ['SDLOG_PROFILE', 1, 6], ['PASSTHRU_EN', 0, 6],
]

function seedParams() {
  const store = useParameterStore.getState()
  const total = DEMO_PARAMS.length
  const params: ParamData[] = DEMO_PARAMS.map(([id, value, type], index) => ({
    id, value, type, param_count: total, param_index: index,
  }))
  store.addParams(params)
  store.setParamComplete(total)
}

function seedStatusLogs() {
  const t = useTelemetryStore.getState()
  // Oldest first - addStatusLog prepends, so the last call shows on top.
  t.addStatusLog(6, 'Ready for takeoff!')
  t.addStatusLog(6, 'ARMED by RC switch')
  t.addStatusLog(6, 'Takeoff detected')
  t.addStatusLog(6, 'RTL: return alt 60 m above home')
  t.addStatusLog(4, 'GPS jamming state noise detected, monitoring')
  t.addStatusLog(6, 'Mission #3 uploaded: 14 waypoints')
  t.addStatusLog(5, 'Battery 78% remaining, est. 11 min flight time')
  t.addStatusLog(6, 'EKF2 IMU0-1 in-flight yaw alignment complete')
  t.addStatusLog(6, 'Switched to POSITION mode')
}

function seedStatics() {
  const t = useTelemetryStore.getState()
  t.setAutopilotVersion({
    boardId: 56,
    boardName: 'Pixhawk 6C',
    firmwareVersion: '1.15.2',
    firmwareLabel: 'PX4 v1.15.2',
    vendorId: 0x3162,
    productId: 0x0058,
    family: 'px4',
    vehicleClass: 'copter',
  })
  // Pre-select a few variables for the dashboard custom data board so the
  // showcase does not render an empty card (user picks are left untouched).
  try {
    if (!localStorage.getItem(dashboardCustomVarsStorageKey)) {
      localStorage.setItem(dashboardCustomVarsStorageKey, JSON.stringify([
        'Vehicle.groundSpeed',
        'Vehicle.altitudeRelative',
        'Vehicle.throttlePct',
        'Battery0.voltage',
        'Battery0.current',
        'Gps.count',
        'EstimatorStatus.velRatio',
        'FIRMWARE.firmwareVersion',
      ]))
    }
  } catch { /* storage unavailable - the card just stays empty */ }
}
function seedEscConfigurator() {
  const sessionId = 'demo-esc-session'
  const store = useEscStore.getState()
  store.applySession({
    state: 'active',
    sessionId,
    mode: 'ardupilot_passthrough',
    ownerClientId: 'demo-readonly-owner',
    safetyConfirmed: true,
    escCount: 4,
    activeJobId: null,
    recoverUntil: null,
    reason: null,
    capabilities: { read: true, write: false },
  })
  const devices = Array.from({ length: 4 }, (_, index) => ({
    index,
    interfaceMode: 4,
    firmwareKind: 'am32' as const,
    firmwareName: 'AM32_MICOAIR_80',
    firmwareVersion: '2.17',
    mcuSignature: 0x1f06,
    mcuName: 'STM32F051',
    bootloaderVersion: '13',
    layoutRevision: 3,
    writable: false,
    reason: 'not_validated' as const,
  }))
  store.applyDevices(sessionId, devices)
  const rawBase64 = btoa(String.fromCharCode(...new Uint8Array(0xb8)))
  devices.forEach((device) => store.applySettings({
    sessionId,
    escIndex: device.index,
    firmwareKind: 'am32',
    layoutRevision: 3,
    writable: false,
    rawBase64,
    values: {
      disableStickCalibration: 0,
      protocol: 0,
      motorDirection: device.index % 2,
      bidirectional: 0,
      stuckRotorProtection: 1,
      stallProtection: 1,
      hallSensors: 0,
      intervalTelemetry: 1,
      complementaryPwm: 1,
      autoTimingAdvance: 0,
      pwmType: 1,
      timingAdvance: 14.0625,
      startupPower: 100,
      motorKv: 3300,
      motorPoles: 14,
      beeperVolume: 5,
      pwmFrequency: 48,
      rampRate: 16,
      minimumDutyCycle: 4,
      lowVoltageCutoff: 1,
      temperatureLimit: 120,
      currentLimit: 80,
      lowVoltageThreshold: 3.2,
      absoluteVoltageThreshold: 12,
      currentP: 100,
      currentI: 20,
      currentD: 100,
      sinusoidalStartup: 1,
      sineModeRange: 15,
      sineModePower: 6,
      carReverseBraking: 0,
      brakeOnStop: 0,
      brakeStrength: 10,
      runningBrakeLevel: 10,
      activeBrakePower: 0,
      servoLowThreshold: 1006,
      servoHighThreshold: 2006,
      servoNeutral: 1502,
      servoDeadBand: 50,
    },
  }))
}


let tick = 0

function pushFastTelemetry() {
  const t = useTelemetryStore.getState()
  const s = useSensorStore.getState()
  const time = tick * 0.1 // seconds
  tick += 1

  // Gentle coordinated flight: shallow banked turn with small oscillations.
  const roll = (6.5 * Math.sin(time * 0.6) + 1.2 * Math.sin(time * 2.3)) * deg
  const pitch = (-3.2 + 1.8 * Math.sin(time * 0.45 + 1.1)) * deg
  const yawDeg = (218 + time * 1.6) % 360
  t.setAttitude({
    roll, pitch, yaw: yawDeg * deg,
    rollspeed: 0.11 * Math.cos(time * 0.6),
    pitchspeed: 0.05 * Math.cos(time * 0.45),
    yawspeed: 1.6 * deg,
    time_boot_ms: 842_000 + tick * 100,
  })

  t.setVfrHud({
    airspeed: 12.6 + 0.5 * Math.sin(time * 0.8),
    groundspeed: 12.1 + 0.4 * Math.sin(time * 0.7 + 0.4),
    alt: 132.6 + 0.6 * Math.sin(time * 0.3),
    climb: 1.2 * Math.sin(time * 0.35),
    heading: Math.round(yawDeg),
    throttle: Math.round(54 + 4 * Math.sin(time * 0.9)),
  })

  // High-rate IMU streams for the waveform page (normalized SI units).
  const imuBase = {
    units: 'normalized' as const,
    xacc: 0.42 * Math.sin(time * 2.1),
    yacc: 0.31 * Math.sin(time * 1.7 + 0.8),
    zacc: -9.81 + 0.18 * Math.sin(time * 3.2),
    xgyro: 0.11 * Math.cos(time * 0.6),
    ygyro: 0.05 * Math.cos(time * 0.45),
    zgyro: 0.028,
    xmag: 214 + 4 * Math.sin(time * 0.5),
    ymag: -41 + 3 * Math.cos(time * 0.4),
    zmag: 428,
  }
  s.setImu({ ...imuBase, temperature: 41.6 }, 0, 'SCALED_IMU')
  s.setImu({
    ...imuBase,
    xacc: imuBase.xacc * 0.97,
    zacc: imuBase.zacc + 0.04,
    temperature: 39.8,
  }, 1, 'SCALED_IMU')

  // RC sticks: mostly centered with slow pilot corrections; throttle mid-high.
  const rc = (center: number, amp: number, freq: number, phase = 0) =>
    Math.round(center + amp * Math.sin(time * freq + phase))
  t.setRcChannels({
    ch1: rc(1500, 42, 0.6),           // roll
    ch2: rc(1492, 30, 0.45, 1.1),     // pitch
    ch3: rc(1545, 18, 0.9),           // throttle
    ch4: rc(1502, 14, 0.3, 2.0),      // yaw
    ch5: 1934, ch6: 1096, ch7: 1514, ch8: 1096,
    ch9: 1514, ch10: 1096, ch11: 1934, ch12: 1514,
    ch13: 1096, ch14: 1096, ch15: 1096, ch16: 1096,
    rssi: 64,
  })

  // Quad outputs hover around 1500 us and mirror the roll/pitch corrections.
  const base = 1520 + 25 * Math.sin(time * 0.9)
  const dRoll = 38 * Math.sin(time * 0.6)
  const dPitch = 26 * Math.sin(time * 0.45 + 1.1)
  t.setMotorOutputs({
    time_usec: (842_000 + tick * 100) * 1000,
    port: 0,
    outputs: [
      Math.round(base + dRoll - dPitch),
      Math.round(base - dRoll + dPitch),
      Math.round(base + dRoll + dPitch),
      Math.round(base - dRoll - dPitch),
      null, null, null, null,
    ],
  })
}

function pushSlowTelemetry() {
  const t = useTelemetryStore.getState()
  const s = useSensorStore.getState()
  const conn = useConnectionStore.getState()
  const time = tick * 0.1

  // Keep the UI convinced the transport + vehicle are live. The port/type are
  // deliberately synthetic markers, not a plausible real device.
  conn.setConnectionSnapshot({
    status: 'connected', transportOpen: true, vehicleReady: true, rawSessionActive: false,
    safetyEpoch: 1, safetyAuthorityId: '00000000-0000-4000-8000-000000000001',
    port: 'DEMO', type: 'synthetic', baudRate: 57600, canControl: false,
  })
  // Keep the synthetic vehicle fully populated for preview while making every
  // normal control gate resolve to read-only.
  conn.setLinkStats({
    rxBps: Math.round(11840 + 900 * Math.sin(time * 0.5)),
    txBps: Math.round(486 + 60 * Math.sin(time * 0.8)),
    crcErrors: 3,
    crcErrorsPerSec: 0,
    rxPackets: 68_412 + tick * 6,
    txPackets: 3_205 + tick,
    rxSequenceLost: 12,
    rxDuplicates: 0,
    rxOutOfOrder: 0,
    rejectedPackets: 0,
    garbageBytes: 128,
    protocolVersion: 2,
  })

  t.setStatus({
    armed: true,
    mode: 'Position',
    modeId: 3,
    failsafe: 'safe',
    systemStatus: 4,
    // Demo showcases the PX4 quadrotor profile.
    identity: { autopilotId: 12, vehicleTypeId: 2, family: 'px4', vehicleClass: 'copter' },
  })

  // Slow orbit around the launch point (Zurich Irchel, PX4 SITL default).
  const lat = 47.397742 + 0.00042 * Math.sin(time * 0.02)
  const lon = 8.545594 + 0.00061 * Math.cos(time * 0.02)
  t.setGps({
    fix_type: 4, lat, lon, alt: 540.2,
    eph: 0.68, epv: 1.12,
    vel: 12.1 + 0.4 * Math.sin(time * 0.7),
    cog: (218 + time * 1.6) % 360,
    satellites_visible: 21,
  })
  t.setGlobalPosition({
    lat, lon, alt: 540.2,
    relative_alt: 48.7 + 0.6 * Math.sin(time * 0.3),
    vx: 8.6, vy: -8.4, vz: -0.3,
    hdg: (218 + time * 1.6) % 360,
  })

  const remaining = Math.round(Math.max(20, 78 - tick * 0.0004))
  t.setBattery({
    id: 0,
    voltage: 15.92 + 0.05 * Math.sin(time * 0.4),
    cell_voltages: [3.982, 3.976, 3.99, 3.968],
    current: 14.6 + 1.8 * Math.sin(time * 0.9),
    remaining,
    consumed_mah: 812 + tick * 0.4,
  })
  t.setSysStatus({
    voltageBattery: 15.92,
    currentBattery: 14.6,
    batteryRemaining: remaining,
    cpuLoad: Math.round(38 + 6 * Math.sin(time * 0.6)),
    sensorsPresent: 0x3f_ff_ff,
    sensorsEnabled: 0x3f_ff_ff,
    sensorsHealth: 0x3f_ff_ff,
    sensorsHealthy: true,
    preflightCheck: true,
    unhealthySensorMask: 0,
    unhealthySensors: [],
  })

  t.setEkfStatus({
    health_flags: 0x01ff,
    innovation_vel: 0.062 + 0.02 * Math.abs(Math.sin(time * 0.5)),
    innovation_pos: 0.084 + 0.02 * Math.abs(Math.sin(time * 0.4)),
    innovation_hgt: 0.041 + 0.01 * Math.abs(Math.sin(time * 0.6)),
    innovation_mag: 0.118 + 0.03 * Math.abs(Math.sin(time * 0.3)),
    gps_check_fail_flags: null,
  })

  s.setBaro({
    press_abs: 1004.6 - 0.02 * Math.sin(time * 0.3),
    press_diff: 0.94,
    temperature: 43.2,
    altitude: 132.6 + 0.6 * Math.sin(time * 0.3),
  })

  const groundDist = 48.7 + 0.6 * Math.sin(time * 0.3)
  s.setDistanceSensor({
    current_distance: Math.round(groundDist * 10), // cm-style raw reading
    min_distance: 4, max_distance: 1200,
    signal_quality: 94, type: 0, id: 0, orientation: 25,
  })
  s.setOpticalFlow({
    source: 'OPTICAL_FLOW_RAD',
    integration_time_us: 32_000,
    integrated_x_rad: 0.0042 * Math.sin(time * 1.1),
    integrated_y_rad: 0.0038 * Math.cos(time * 0.9),
    integrated_xgyro_rad: 0.0011,
    integrated_ygyro_rad: -0.0008,
    integrated_zgyro_rad: 0.0003,
    temperature_c: 38.5,
    time_delta_distance_us: 12_000,
    distance_m: groundDist,
    flow_x: 0, flow_y: 0, flow_comp_m_x: 0, flow_comp_m_y: 0,
    quality: 182,
    ground_distance: groundDist,
    sensor_id: 0,
  })
  s.setSensorHealth('gps', 'ok')
  s.setSensorHealth('battery', 'ok')
}

let started = false
let activeCleanup: (() => void) | null = null

export function startDemoMode(): () => void {
  if (activeCleanup) return activeCleanup
  started = true
  console.log('[Demo] Synthetic telemetry enabled - no flight controller is connected')
  // Local calibration simulation: intercept calibration client messages so
  // they drive the calibrationStore without a Worker. Registered only here.
  const calibrationDemo = createCalibrationDemo({
    applySnapshot: (snapshot) => useCalibrationStore.getState().applySnapshot(snapshot),
    family: () =>
      useTelemetryStore.getState().vehicleIdentity?.family === 'ardupilot' ? 'ardupilot' : 'px4',
    ownerClientId: () => 'demo-client',
  })
  setDemoRuntimeCommandInterceptor((msg) => calibrationDemo.handleRuntimeCommand(msg))
  seedParams()
  seedStatics()
  seedEscConfigurator()
  seedStatusLogs()
  pushFastTelemetry()
  pushSlowTelemetry()
  const fastInterval = window.setInterval(pushFastTelemetry, 100)
  const slowInterval = window.setInterval(pushSlowTelemetry, 500)
  activeCleanup = () => {
    window.clearInterval(fastInterval)
    window.clearInterval(slowInterval)
    calibrationDemo.stop()
    setDemoRuntimeCommandInterceptor(null)
    started = false
    activeCleanup = null
  }
  return activeCleanup
}
