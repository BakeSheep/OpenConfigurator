import { EventEmitter } from 'events'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { PortInfo } from '../../shared/types'

const execFileAsync = promisify(execFile)
const FLIGHT_CONTROLLER_NAME = /(micoair|pixhawk|cubepilot|cube\s*orange|px4|flight\s*controller|飞控)/i

// Bluetooth SPP connection - uses serialport with BT COM port on Windows
// On Windows, paired BT SPP devices appear as serial ports
export class BluetoothConnection extends EventEmitter {
  private _connected = false

  get connected() {
    return this._connected
  }

  static async scanDevices(): Promise<PortInfo[]> {
    // On Windows, Bluetooth SPP devices appear as serial ports
    // We filter by common BT identifiers
    const { SerialPort } = await import('serialport')
    const ports = await SerialPort.list()
    const deviceNames = await this.getWindowsBluetoothDeviceNames()
    const isRemoteIdentified = (pnpId = '') => /_vid&[0-9a-f]+_pid&[0-9a-f]+/i.test(pnpId)
    const getAddress = (pnpId = '') => pnpId.match(/&0&([0-9a-f]{12})_c/i)?.[1]?.toLowerCase()
    const score = (port: (typeof ports)[number]) => {
      const address = getAddress(port.pnpId)
      const name = address ? deviceNames.get(address) : undefined
      return (name && FLIGHT_CONTROLLER_NAME.test(name) ? 100 : 0) + (isRemoteIdentified(port.pnpId) ? 10 : 0)
    }
    return ports
      .filter((p) => {
        const mfg = (p.manufacturer || '').toLowerCase()
        const pnp = (p.pnpId || '').toLowerCase()
        return (
          mfg.includes('bluetooth') ||
          mfg.includes('bt') ||
          pnp.includes('bluetooth') ||
          pnp.includes('bt') ||
          mfg.includes('hci') ||
          pnp.includes('bthenum')
        )
      })
      // LOCALMFG&0000 is the generic local-radio placeholder commonly exposed
      // for incoming SPP services; it cannot initiate a device connection.
      .filter((p) => !/_localmfg&0000/i.test(p.pnpId || ''))
      // Prefer ports whose Bluetooth device name looks like a flight controller.
      // VID/PID alone is not sufficient: headsets can publish the same generic
      // chipset identifiers and were previously selected ahead of MicoAir.
      .sort((a, b) => score(b) - score(a))
      .map((p) => {
        const bluetoothAddress = getAddress(p.pnpId)
        const friendlyName = bluetoothAddress ? deviceNames.get(bluetoothAddress) : undefined
        return {
          path: p.path,
          manufacturer: p.manufacturer,
          friendlyName,
          bluetoothAddress,
          recommended: !!friendlyName && FLIGHT_CONTROLLER_NAME.test(friendlyName),
          productId: p.productId,
          vendorId: p.vendorId,
          pnpId: p.pnpId,
        }
      })
  }

  /** Read paired device names and addresses from the Windows Bluetooth registry. */
  private static async getWindowsBluetoothDeviceNames(): Promise<Map<string, string>> {
    const names = new Map<string, string>()
    if (process.platform !== 'win32') return names

    try {
      const registryPath = 'HKLM\\SYSTEM\\CurrentControlSet\\Services\\BTHPORT\\Parameters\\Devices'
      const { stdout } = await execFileAsync('reg.exe', ['query', registryPath, '/s'], {
        windowsHide: true,
        encoding: 'utf8',
      })
      let currentAddress: string | null = null
      for (const line of stdout.split(/\r?\n/)) {
        if (/^HKEY_/i.test(line)) {
          currentAddress = line.match(/\\devices\\([0-9a-f]{12})\s*$/i)?.[1]?.toLowerCase() || null
          continue
        }
        if (!currentAddress) continue
        const hex = line.match(/^\s*Name\s+REG_BINARY\s+([0-9a-f]+)\s*$/i)?.[1]
        if (!hex) continue
        const name = Buffer.from(hex, 'hex').toString('utf8').replace(/\0/g, '').trim()
        if (name) names.set(currentAddress, name)
      }
    } catch (error) {
      console.warn('[Bluetooth] Unable to resolve paired device names:', error)
    }
    return names
  }

  /**
   * Find a Bluetooth SPP COM port that matches the identifiers returned by
   * the browser-side Web Serial chooser (navigator.serial.requestPort).
   *
   * On Windows, each paired BT SPP device creates TWO COM ports:
   *   - "incoming"  : pnpId has _LOCALMFG&0000 (cannot be opened for I/O)
   *   - "outgoing"  : pnpId has _VID&<hex>_PID&<hex> (the usable one)
   * We prefer outgoing ports and avoid the incoming ones.
   *
   * The {00001101-...} UUID is the SPP service class.
   * serialport's PortInfo.vendorId/productId are only populated for USB
   * ports, so for BT ports we parse VID/PID out of the pnpId instead.
   */
  static async findPortByIds(opts: {
    vendorId?: string
    productId?: string
    bluetoothServiceClassId?: string
    label?: string
  }): Promise<string | null> {
    const { SerialPort } = await import('serialport')
    const ports = await SerialPort.list()

    // The UI now sends the scanned COM path whenever possible. This is both
    // deterministic and works for Bluetooth adapters which expose no VID/PID.
    const direct = ports.find((p) => p.path.toLowerCase() === opts.label?.toLowerCase())
    if (direct && !/_localmfg&0000/i.test(direct.pnpId || '')) return direct.path

    const normalize = (v?: string) => (v ? v.toLowerCase().replace(/^0x/, '') : undefined)
    const vid = normalize(opts.vendorId)
    const pid = normalize(opts.productId)

    // Helper: extract VID/PID embedded in a BT pnpId string.
    // Matches e.g. "_VID&000105D6_PID&000A" -> { vid: "105d6", pid: "000a" }
    const parseBtVidPid = (pnpId: string): { vid?: string; pid?: string } => {
      if (!pnpId) return {}
      const lower = pnpId.toLowerCase()
      const vidMatch = lower.match(/_vid&0*([0-9a-f]+)/)
      const pidMatch = lower.match(/_pid&0*([0-9a-f]+)/)
      return {
        vid: vidMatch ? vidMatch[1] : undefined,
        pid: pidMatch ? pidMatch[1] : undefined,
      }
    }

    const isBtSppPort = (p: any) => {
      const pnp = (p.pnpId || '').toLowerCase()
      return pnp.includes('bthenum') && pnp.includes('00001101')
    }
    // Outgoing port = has _VID&_PID in pnpId (device's own IDs).
    // Incoming port = has _LOCALMFG&0000 (placeholder, not openable for I/O).
    const isOutgoing = (p: any) => /_vid&[0-9a-f]+_pid&[0-9a-f]+/i.test(p.pnpId || '')

    const btPorts = ports.filter(isBtSppPort)

    // 1. Match by embedded VID + PID in pnpId (most reliable for the real device)
    if (vid && pid) {
      const match = btPorts.find((p) => {
        const { vid: pVid, pid: pPid } = parseBtVidPid(p.pnpId || '')
        return pVid === vid && pPid === pid
      })
      if (match) return match.path
    }

    // 2. Match by VID only
    if (vid) {
      const match = btPorts.find((p) => {
        const { vid: pVid } = parseBtVidPid(p.pnpId || '')
        return pVid === vid
      })
      if (match) return match.path
    }

    // 3. Prefer any outgoing BT SPP port (has device VID/PID)
    const outgoing = btPorts.find((p) => isOutgoing(p))
    if (outgoing) return outgoing.path

    // 4. Match by label substring
    if (opts.label) {
      const lbl = opts.label.toLowerCase()
      const match = btPorts.find((p) => {
        const mfg = (p.manufacturer || '').toLowerCase()
        const pnp = (p.pnpId || '').toLowerCase()
        return mfg.includes(lbl) || pnp.includes(lbl)
      })
      if (match) return match.path
    }

    // 5. Last resort: first usable BT SPP port. Incoming ports are deliberately
    // excluded because they cannot be used to initiate a flight-controller link.
    const usable = btPorts.find((p) => !/_localmfg&0000/i.test(p.pnpId || ''))
    return usable?.path || null
  }

  setConnected(val: boolean) {
    this._connected = val
    if (val) this.emit('connected')
    else this.emit('disconnected')
  }
}
