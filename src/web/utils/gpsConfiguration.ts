import type { ParamData } from '../../shared/types'
import { ardupilotSerialPorts, type ArduPilotSerialPort } from './parameterProfiles'

export type NumericOption = readonly [number, string]

// PX4 main parameter reference: GPS_n_CONFIG is both the enable switch and
// the serial-port assignment. Keeping one authoritative value avoids a UI
// toggle drifting away from the port selected in the flight controller.
export const PX4_GPS_PORT_OPTIONS: ReadonlyArray<NumericOption> = [
  [0, 'Disabled'],
  [6, 'UART 6'],
  [101, 'TELEM 1'],
  [102, 'TELEM 2'],
  [103, 'TELEM 3'],
  [104, 'TELEM/SERIAL 4'],
  [201, 'GPS 1'],
  [202, 'GPS 2'],
  [203, 'GPS 3'],
  [300, 'Radio Controller'],
  [301, 'WiFi Port'],
  [401, 'EXT 2'],
]

export const PX4_GPS_PROTOCOL_OPTIONS: ReadonlyArray<NumericOption> = [
  [0, 'Auto detect'],
  [1, 'u-blox'],
  [2, 'MTK'],
  [3, 'Ashtech / Trimble'],
  [4, 'Emlid Reach'],
  [5, 'Femtomes'],
  [6, 'NMEA (generic)'],
]

export const PX4_GPS_BAUD_OPTIONS: ReadonlyArray<NumericOption> = [
  [0, 'Auto'],
  [4800, '4800 8N1'],
  [9600, '9600 8N1'],
  [19200, '19200 8N1'],
  [38400, '38400 8N1'],
  [57600, '57600 8N1'],
  [115200, '115200 8N1'],
  [230400, '230400 8N1'],
  [460800, '460800 8N1'],
  [500000, '500000 8N1'],
  [921600, '921600 8N1'],
  [1000000, '1000000 8N1'],
  [1500000, '1500000 8N1'],
  [2000000, '2000000 8N1'],
  [3000000, '3000000 8N1'],
]

const PX4_BAUD_PARAM_BY_PORT: Readonly<Record<number, string>> = {
  6: 'SER_URT6_BAUD',
  101: 'SER_TEL1_BAUD',
  102: 'SER_TEL2_BAUD',
  103: 'SER_TEL3_BAUD',
  104: 'SER_TEL4_BAUD',
  201: 'SER_GPS1_BAUD',
  202: 'SER_GPS2_BAUD',
  203: 'SER_GPS3_BAUD',
  300: 'SER_RC_BAUD',
  401: 'SER_EXT2_BAUD',
}

export const px4GpsDefaultPort = (instance: 1 | 2): number => instance === 1 ? 201 : 202

export const px4GpsBaudParam = (port: number | null | undefined): string | null =>
  port == null ? null : PX4_BAUD_PARAM_BY_PORT[Math.round(port)] ?? null

// ArduPilot 4.6+ names. The legacy aliases remain readable so the UI also
// works against pre-4.6 parameter sets without guessing the firmware stack.
const ARDUPILOT_GPS_TYPE_PARAMS = {
  1: ['GPS1_TYPE', 'GPS_TYPE'],
  2: ['GPS2_TYPE', 'GPS_TYPE2'],
} as const

export const ARDUPILOT_GPS_TYPE_OPTIONS: ReadonlyArray<NumericOption> = [
  [0, 'None'],
  [1, 'Auto'],
  [2, 'u-blox'],
  [5, 'NMEA'],
  [6, 'SiRF'],
  [7, 'HIL'],
  [8, 'SwiftNav'],
  [9, 'DroneCAN'],
  [10, 'Septentrio (SBF)'],
  [11, 'Trimble (GSOF)'],
  [13, 'ERB'],
  [14, 'MAVLink'],
  [15, 'NOVA'],
  [16, 'Hemisphere NMEA'],
  [17, 'u-blox Moving Base'],
  [18, 'u-blox Moving Rover'],
  [19, 'MSP'],
  [20, 'AllyStar'],
  [21, 'External AHRS'],
  [22, 'DroneCAN Moving Base'],
  [23, 'DroneCAN Moving Rover'],
  [24, 'Unicore NMEA'],
  [25, 'Unicore Moving Baseline'],
  [26, 'Septentrio Dual Antenna'],
]

export const ARDUPILOT_GPS_AUTO_CONFIG_OPTIONS: ReadonlyArray<NumericOption> = [
  [0, 'Disabled'],
  [1, 'Serial GPS only'],
  [2, 'Serial + DroneCAN'],
  [3, 'Clear unmanaged u-blox config'],
]

export function ardupilotGpsTypeParam(
  params: Map<string, ParamData>,
  instance: 1 | 2,
): ParamData | undefined {
  return ARDUPILOT_GPS_TYPE_PARAMS[instance]
    .map((id) => params.get(id))
    .find((param): param is ParamData => param !== undefined)
}

// These types are supplied by simulation, CAN, MAVLink, MSP, or an external
// AHRS and therefore do not consume one of ArduPilot's SERIALx GPS slots.
const ARDUPILOT_NONSERIAL_GPS_TYPES = new Set([0, 7, 9, 14, 19, 21, 22, 23])

export const ardupilotGpsNeedsSerial = (type: number | null | undefined): boolean =>
  type != null && !ARDUPILOT_NONSERIAL_GPS_TYPES.has(Math.round(type))

/**
 * ArduPilot assigns GPS1/GPS2 to the first/second logical SERIALx port whose
 * protocol is 5 (GPS). This is deliberately derived instead of assuming the
 * common SERIAL3/SERIAL4 board defaults.
 */
export function ardupilotGpsSerialPort(
  params: Map<string, ParamData>,
  instance: 1 | 2,
): ArduPilotSerialPort | null {
  const gpsPorts = ardupilotSerialPorts(params)
    .filter((port) => Math.round(params.get(port.protocolParam)?.value ?? Number.NaN) === 5)
  return gpsPorts[instance - 1] ?? null
}
