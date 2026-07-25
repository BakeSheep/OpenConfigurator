import { EventEmitter } from 'events'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { PortInfo } from '../../shared/types'

const execFileAsync = promisify(execFile)
const FLIGHT_CONTROLLER_NAME = /(micoair|pixhawk|cubepilot|cube\s*orange|px4|flight\s*controller|飞控)/i
const WINDOWS_SPP_SERVICE_ID = '1101'

export interface BluetoothPortRecord {
  path: string
  manufacturer?: string
  productId?: string
  vendorId?: string
  pnpId?: string
}

export interface BluetoothDiscoveryDependencies {
  platform?: NodeJS.Platform
  listPorts?: () => Promise<BluetoothPortRecord[]>
  windowsDeviceNames?: () => Promise<Map<string, string>>
}

export interface BluetoothPortSelector {
  vendorId?: string
  productId?: string
  bluetoothServiceClassId?: string
  bluetoothAddress?: string
  label?: string
}

export type BluetoothPortResolutionCode = 'AMBIGUOUS' | 'IDENTITY_MISMATCH'

export class BluetoothPortResolutionError extends Error {
  constructor(
    message: string,
    readonly code: BluetoothPortResolutionCode,
    readonly candidates: string[],
  ) {
    super(message)
    this.name = 'BluetoothPortResolutionError'
  }
}

const normalizeHexId = (value?: string): string | undefined => {
  if (!value) return undefined
  const hex = value.trim().toLowerCase().replace(/^0x/, '')
  if (!/^[0-9a-f]+$/.test(hex)) return undefined
  return hex.replace(/^0+(?=[0-9a-f])/, '') || '0'
}

const normalizeAddress = (value?: string): string | undefined => {
  if (!value) return undefined
  const address = value.toLowerCase().replace(/[^0-9a-f]/g, '')
  return address.length === 12 ? address : undefined
}

const normalizeServiceId = (value?: string): string | undefined => {
  if (!value) return undefined
  const raw = value.trim().toLowerCase()
  const text = raw.match(/^\{([^{}]+)\}$/)?.[1] ?? raw
  const short = text.match(/^(?:0x)?([0-9a-f]{4})$/)?.[1]
    ?? text.match(/^0000([0-9a-f]{4})-/)?.[1]
  return short ? normalizeHexId(short) : undefined
}

const getBluetoothAddress = (pnpId = ''): string | undefined =>
  pnpId.match(/&0&([0-9a-f]{12})_c/i)?.[1]?.toLowerCase()

const parseBtVidPid = (port: BluetoothPortRecord): { vid?: string; pid?: string } => {
  const pnpId = port.pnpId ?? ''
  const vid = pnpId.match(/_vid&([0-9a-f]+)/i)?.[1] ?? port.vendorId
  const pid = pnpId.match(/_pid&([0-9a-f]+)/i)?.[1] ?? port.productId
  return { vid: normalizeHexId(vid), pid: normalizeHexId(pid) }
}

const isIncomingWindowsPort = (port: BluetoothPortRecord): boolean =>
  /_localmfg&0000/i.test(port.pnpId ?? '')

const isUnsupportedIncomingPort = (
  port: BluetoothPortRecord,
  platform: NodeJS.Platform,
): boolean =>
  isIncomingWindowsPort(port)
  || (platform === 'darwin' && /bluetooth-incoming-port/i.test(port.path))

const isWindowsSppPort = (port: BluetoothPortRecord, serviceId = WINDOWS_SPP_SERVICE_ID): boolean => {
  const pnp = (port.pnpId ?? '').toLowerCase()
  return pnp.includes('bthenum') && pnp.includes(serviceId.padStart(8, '0'))
}

const isPlatformBluetoothPort = (
  port: BluetoothPortRecord,
  platform: NodeJS.Platform,
  serviceId = WINDOWS_SPP_SERVICE_ID,
): boolean => {
  const path = port.path.toLowerCase()
  const metadata = `${port.manufacturer ?? ''} ${port.pnpId ?? ''}`.toLowerCase()
  if (platform === 'win32') {
    return isWindowsSppPort(port, serviceId)
      || (metadata.includes('bluetooth') && !isIncomingWindowsPort(port))
  }
  if (platform === 'linux') {
    return /^\/dev\/rfcomm\d+$/i.test(port.path)
      || /\/dev\/serial\/by-id\/.*(?:bluetooth|rfcomm|spp)/i.test(port.path)
      || /\b(?:bluetooth|rfcomm|bluez)\b/i.test(metadata)
  }
  if (platform === 'darwin') {
    return /^\/dev\/cu\..*(?:bluetooth|\bbt\b|spp)/i.test(path)
      || /\b(?:bluetooth|iobluetooth|spp)\b/i.test(metadata)
  }
  return /\b(?:bluetooth|rfcomm|spp)\b/i.test(`${path} ${metadata}`)
}

const pathsEqual = (a: string, b: string, platform: NodeJS.Platform): boolean =>
  platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b

// Bluetooth SPP connection - Windows uses virtual COM ports; Linux/macOS
// support is best-effort through explicitly enumerated serial device paths.
export class BluetoothConnection extends EventEmitter {
  private _connected = false

  get connected() {
    return this._connected
  }

  static async scanDevices(dependencies: BluetoothDiscoveryDependencies = {}): Promise<PortInfo[]> {
    const platform = dependencies.platform ?? process.platform
    const ports = await this.listPorts(dependencies)
    const serviceId = WINDOWS_SPP_SERVICE_ID
    const deviceNames = platform === 'win32'
      ? await (dependencies.windowsDeviceNames?.() ?? this.getWindowsBluetoothDeviceNames())
      : new Map<string, string>()
    const score = (port: BluetoothPortRecord) => {
      const address = getBluetoothAddress(port.pnpId)
      const name = address ? deviceNames.get(address) : undefined
      const { vid, pid } = parseBtVidPid(port)
      return (name && FLIGHT_CONTROLLER_NAME.test(name) ? 100 : 0) + (vid && pid ? 10 : 0)
    }

    return ports
      .filter((port) => isPlatformBluetoothPort(port, platform, serviceId))
      .filter((port) => !isUnsupportedIncomingPort(port, platform))
      .sort((a, b) => score(b) - score(a))
      .map((port) => {
        const bluetoothAddress = getBluetoothAddress(port.pnpId)
        const friendlyName = bluetoothAddress ? deviceNames.get(bluetoothAddress) : undefined
        return {
          path: port.path,
          manufacturer: port.manufacturer,
          friendlyName,
          bluetoothAddress,
          recommended: !!friendlyName && FLIGHT_CONTROLLER_NAME.test(friendlyName),
          productId: port.productId,
          vendorId: port.vendorId,
          pnpId: port.pnpId,
        }
      })
  }

  static async findPortByIds(
    selector: BluetoothPortSelector,
    dependencies: BluetoothDiscoveryDependencies = {},
  ): Promise<string | null> {
    const platform = dependencies.platform ?? process.platform
    const ports = await this.listPorts(dependencies)
    const requestedServiceValue = normalizeServiceId(selector.bluetoothServiceClassId)
    if (selector.bluetoothServiceClassId && !requestedServiceValue) {
      throw new BluetoothPortResolutionError(
        `蓝牙服务标识 "${selector.bluetoothServiceClassId}" 格式无效。`,
        'IDENTITY_MISMATCH',
        [],
      )
    }
    const requestedService = requestedServiceValue ?? WINDOWS_SPP_SERVICE_ID
    const requestedAddress = normalizeAddress(selector.bluetoothAddress)
    if (selector.bluetoothAddress && !requestedAddress) {
      throw new BluetoothPortResolutionError(
        `蓝牙地址 "${selector.bluetoothAddress}" 格式无效。`,
        'IDENTITY_MISMATCH',
        [],
      )
    }
    const requestedVid = normalizeHexId(selector.vendorId)
    if (selector.vendorId && !requestedVid) {
      throw new BluetoothPortResolutionError(
        `VID "${selector.vendorId}" 格式无效。`,
        'IDENTITY_MISMATCH',
        [],
      )
    }
    const requestedPid = normalizeHexId(selector.productId)
    if (selector.productId && !requestedPid) {
      throw new BluetoothPortResolutionError(
        `PID "${selector.productId}" 格式无效。`,
        'IDENTITY_MISMATCH',
        [],
      )
    }
    const usable = ports.filter((port) =>
      !isUnsupportedIncomingPort(port, platform)
      && isPlatformBluetoothPort(port, platform, requestedService)
    )

    if (selector.label) {
      const direct = ports.filter((port) =>
        !isUnsupportedIncomingPort(port, platform)
        && pathsEqual(port.path, selector.label!, platform)
      )
      const exact = this.uniqueMatch(direct, `精确路径 "${selector.label}"`)
      if (exact) {
        this.assertRequestedIdentity(exact, selector)
        return exact.path
      }
    }

    if (requestedAddress) {
      const addressMatch = this.uniqueMatch(
        usable.filter((port) => getBluetoothAddress(port.pnpId) === requestedAddress),
        `蓝牙地址 ${selector.bluetoothAddress}`,
      )
      if (addressMatch) this.assertRequestedIdentity(addressMatch, selector)
      return addressMatch?.path ?? null
    }

    if (requestedVid && requestedPid) {
      const identityMatch = this.uniqueMatch(
        usable.filter((port) => {
          const { vid, pid } = parseBtVidPid(port)
          return vid === requestedVid && pid === requestedPid
        }),
        `VID:PID ${selector.vendorId}:${selector.productId}`,
      )
      return identityMatch?.path ?? null
    }

    if (requestedVid && !requestedPid) {
      const vendorMatch = this.uniqueMatch(
        usable.filter((port) => parseBtVidPid(port).vid === requestedVid),
        `VID ${selector.vendorId}`,
      )
      return vendorMatch?.path ?? null
    }

    if (requestedPid && !requestedVid) {
      const productMatch = this.uniqueMatch(
        usable.filter((port) => parseBtVidPid(port).pid === requestedPid),
        `PID ${selector.productId}`,
      )
      return productMatch?.path ?? null
    }

    if (selector.label) {
      const label = selector.label.trim().toLowerCase()
      const labelMatches = usable.filter((port) => {
        const haystack = `${port.path} ${port.manufacturer ?? ''} ${port.pnpId ?? ''}`.toLowerCase()
        return label.length >= 3 && haystack.includes(label)
      })
      const labelMatch = this.uniqueMatch(labelMatches, `标签 "${selector.label}"`)
      if (labelMatch) return labelMatch.path
    }

    // A connection request always carries an explicit path/label or stable
    // identity. Never fall back to an unrelated "only currently visible" port.
    return null
  }

  setConnected(value: boolean) {
    this._connected = value
    if (value) this.emit('connected')
    else this.emit('disconnected')
  }

  private static async listPorts(
    dependencies: BluetoothDiscoveryDependencies,
  ): Promise<BluetoothPortRecord[]> {
    if (dependencies.listPorts) return dependencies.listPorts()
    const { SerialPort } = await import('serialport')
    return SerialPort.list()
  }

  private static uniqueMatch(
    matches: BluetoothPortRecord[],
    selectorDescription: string,
  ): BluetoothPortRecord | null {
    if (matches.length === 0) return null
    if (matches.length === 1) return matches[0]
    throw new BluetoothPortResolutionError(
      `${selectorDescription} 匹配到多个端口，已拒绝自动选择：${matches.map((port) => port.path).join(', ')}`,
      'AMBIGUOUS',
      matches.map((port) => port.path),
    )
  }

  private static assertRequestedIdentity(
    port: BluetoothPortRecord,
    selector: BluetoothPortSelector,
  ): void {
    const requestedAddress = normalizeAddress(selector.bluetoothAddress)
    const actualAddress = getBluetoothAddress(port.pnpId)
    if (requestedAddress && actualAddress !== requestedAddress) {
      throw new BluetoothPortResolutionError(
        `端口 ${port.path} 的蓝牙地址与请求不一致。`,
        'IDENTITY_MISMATCH',
        [port.path],
      )
    }

    const requestedVid = normalizeHexId(selector.vendorId)
    const requestedPid = normalizeHexId(selector.productId)
    const actual = parseBtVidPid(port)
    const vidMismatch = !!requestedVid && requestedVid !== actual.vid
    const pidMismatch = !!requestedPid && requestedPid !== actual.pid
    if (vidMismatch || pidMismatch) {
      throw new BluetoothPortResolutionError(
        `端口 ${port.path} 的 VID/PID 与请求不一致。`,
        'IDENTITY_MISMATCH',
        [port.path],
      )
    }
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
        timeout: 3000,
        maxBuffer: 1024 * 1024,
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
}
