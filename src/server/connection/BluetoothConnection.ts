import { EventEmitter } from 'events'
import type { PortInfo } from '../../shared/types'

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
    return ports
      .filter((p) => {
        const mfg = (p.manufacturer || '').toLowerCase()
        const pnp = (p.pnpId || '').toLowerCase()
        return (
          mfg.includes('bluetooth') ||
          mfg.includes('bt') ||
          pnp.includes('bluetooth') ||
          pnp.includes('bt') ||
          mfg.includes('hci')
        )
      })
      .map((p) => ({
        path: p.path,
        manufacturer: p.manufacturer,
        productId: p.productId,
        vendorId: p.vendorId,
        pnpId: p.pnpId,
      }))
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

    // 5. Last resort: first BT SPP port (even if incoming - may fail to open)
    return btPorts.length > 0 ? btPorts[0].path : null
  }

  setConnected(val: boolean) {
    this._connected = val
    if (val) this.emit('connected')
    else this.emit('disconnected')
  }
}
