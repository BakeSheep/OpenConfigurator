import { EventEmitter } from 'events'
import type { PortInfo } from '../../shared/types'
import {
  BluetoothDiscoveryError,
  discoverBluetoothQuick,
  parseLinuxRfcommPath,
  parseLinuxSppPath,
  resolveLinuxSppChannel,
  type BluetoothPortRecord,
  type BluetoothQuickDependencies,
  type TargetedSppDependencies,
} from './discovery/bluetoothDiscovery'

export { parseLinuxRfcommPath, parseLinuxSppPath }
export type { BluetoothPortRecord } from './discovery/bluetoothDiscovery'

export interface BluetoothDiscoveryDependencies {
  platform?: NodeJS.Platform
  listPorts?: () => Promise<BluetoothPortRecord[]>
  windowsDeviceNames?: () => Promise<Map<string, string>>
  linuxPairedDevices?: () => Promise<BluetoothPortRecord[]>
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

const getBluetoothAddress = (port: BluetoothPortRecord): string | undefined =>
  port.bluetoothAddress?.toUpperCase()
  ?? port.pnpId?.match(/&0&([0-9a-f]{12})_c/i)?.[1]?.toUpperCase()

const parseBtVidPid = (port: BluetoothPortRecord): { vid?: string; pid?: string } => {
  const pnpId = port.pnpId ?? ''
  const vid = pnpId.match(/_vid&([0-9a-f]+)/i)?.[1] ?? port.vendorId
  const pid = pnpId.match(/_pid&([0-9a-f]+)/i)?.[1] ?? port.productId
  return { vid: normalizeHexId(vid), pid: normalizeHexId(pid) }
}

const isIncomingWindowsPort = (port: BluetoothPortRecord): boolean =>
  /_localmfg&0000/i.test(port.pnpId ?? '')

const pathsEqual = (a: string, b: string, platform: NodeJS.Platform): boolean =>
  platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b

// Bluetooth SPP connection - Windows uses virtual COM ports; Linux connects
// through user-space RFCOMM endpoints resolved for the selected device only.
export class BluetoothConnection extends EventEmitter {
  private _connected = false

  get connected() {
    return this._connected
  }

  /**
   * Quick discovery (plan §Phase 2): reads cached paired-device identity only.
   * Linux no longer runs `sdptool` during listing; offline paired devices
   * stay visible so the operator can power them on and connect.
   */
  static async scanDevices(dependencies: BluetoothDiscoveryDependencies = {}): Promise<PortInfo[]> {
    return discoverBluetoothQuick(toQuickDependencies(dependencies))
  }

  /**
   * Resolve the port for a connect request. On Linux this performs the
   * targeted (blocking) SDP resolution for the one selected address only.
   */
  static async findPortByIds(
    selector: BluetoothPortSelector,
    dependencies: BluetoothDiscoveryDependencies & { targetedDependencies?: TargetedSppDependencies } = {},
  ): Promise<string | null> {
    const platform = dependencies.platform ?? process.platform
    const quick = await discoverBluetoothQuick(toQuickDependencies(dependencies))
    const ports: BluetoothPortRecord[] = quick.map((device) => ({
      path: device.path,
      manufacturer: device.manufacturer,
      friendlyName: device.friendlyName,
      bluetoothAddress: device.bluetoothAddress,
      bluetoothChannel: device.bluetoothChannel,
      bluetoothServiceClassId: device.bluetoothServiceClassId,
      productId: device.productId,
      vendorId: device.vendorId,
      pnpId: device.pnpId,
    }))

    const requestedServiceValue = normalizeServiceId(selector.bluetoothServiceClassId)
    if (selector.bluetoothServiceClassId && !requestedServiceValue) {
      throw new BluetoothPortResolutionError(
        `蓝牙服务标识 "${selector.bluetoothServiceClassId}" 格式无效。`,
        'IDENTITY_MISMATCH',
        [],
      )
    }
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

    // A Linux quick-scan candidate (bt-spp:// pseudo path) or an explicit
    // address both narrow resolution to exactly one device before any
    // blocking SDP work happens.
    const labelAddress = platform === 'linux' && selector.label
      ? parseLinuxSppPath(selector.label)
      : null
    const targetAddress = selector.bluetoothAddress?.toUpperCase() ?? labelAddress

    if (platform === 'linux' && targetAddress) {
      const resolved = await this.linuxPathForAddress(targetAddress, selector, quick, dependencies)
      if (resolved !== undefined) return resolved
    }

    const usable = ports.filter((port) => !isIncomingWindowsPort(port))

    if (selector.label) {
      const direct = ports.filter((port) =>
        pathsEqual(port.path, selector.label!, platform),
      )
      const exact = this.uniqueMatch(direct, `精确路径 "${selector.label}"`)
      if (exact) {
        this.assertRequestedIdentity(exact, selector)
        // An exact path (bound rfcomm node, COM port) is openable as-is.
        return exact.path
      }
    }

    if (requestedAddress) {
      const addressMatch = this.uniqueMatch(
        usable.filter((port) =>
          normalizeAddress(getBluetoothAddress(port)) === normalizeAddress(selector.bluetoothAddress)),
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

    if (platform === 'linux' && selector.bluetoothServiceClassId) {
      const serviceMatch = this.uniqueMatch(
        usable.filter((port) => normalizeServiceId(port.bluetoothServiceClassId) === requestedServiceValue),
        `SPP 服务 ${selector.bluetoothServiceClassId}`,
      )
      if (serviceMatch) {
        const address = getBluetoothAddress(serviceMatch)
        if (address) {
          const resolved = await this.linuxPathForAddress(address, selector, quick, dependencies)
          if (resolved !== undefined) return resolved
        }
      }
      return null
    }

    if (selector.label) {
      const label = selector.label.trim().toLowerCase()
      const labelMatches = usable.filter((port) => {
        const haystack = `${port.path} ${port.friendlyName ?? ''} ${port.bluetoothAddress ?? ''} ${port.manufacturer ?? ''} ${port.pnpId ?? ''}`.toLowerCase()
        return label.length >= 3 && haystack.includes(label)
      })
      const labelMatch = this.uniqueMatch(labelMatches, `标签 "${selector.label}"`)
      if (labelMatch) {
        if (platform === 'linux') {
          const address = getBluetoothAddress(labelMatch)
          if (address) {
            const resolved = await this.linuxPathForAddress(address, selector, quick, dependencies)
            if (resolved !== undefined) return resolved
          }
        }
        return labelMatch.path
      }
    }

    // A connection request always carries an explicit path/label or stable
    // identity. Never fall back to an unrelated "only currently visible" port.
    return null
  }

  /**
   * Resolve one Linux device to an openable path. A quick-scan candidate that
   * already carries an RFCOMM channel is used directly; otherwise the
   * targeted (blocking) SDP resolution runs for exactly this address.
   * Returns undefined when the address has no usable candidate here.
   */
  private static async linuxPathForAddress(
    address: string,
    selector: BluetoothPortSelector,
    quick: PortInfo[],
    dependencies: { targetedDependencies?: TargetedSppDependencies },
  ): Promise<string | undefined> {
    const requested = normalizeAddress(address)
    if (!requested) {
      throw new BluetoothPortResolutionError(
        `蓝牙地址 "${address}" 格式无效。`,
        'IDENTITY_MISMATCH',
        [],
      )
    }
    const channeled = quick.find((device) =>
      normalizeAddress(device.bluetoothAddress) === requested
      && typeof device.bluetoothChannel === 'number')
    if (channeled) {
      this.assertRequestedIdentity(
        {
          path: channeled.path,
          bluetoothAddress: channeled.bluetoothAddress,
          vendorId: channeled.vendorId,
          productId: channeled.productId,
        },
        selector,
      )
      return channeled.path
    }
    return (await resolveLinuxSppChannel(address, dependencies.targetedDependencies)).path
  }

  setConnected(value: boolean) {
    this._connected = value
    if (value) this.emit('connected')
    else this.emit('disconnected')
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
    const actualAddress = normalizeAddress(getBluetoothAddress(port))
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
}

function toQuickDependencies(
  dependencies: BluetoothDiscoveryDependencies,
): BluetoothQuickDependencies {
  return {
    ...(dependencies.platform !== undefined ? { platform: dependencies.platform } : {}),
    ...(dependencies.listPorts ? { listPorts: dependencies.listPorts } : {}),
    ...(dependencies.windowsDeviceNames
      ? { windowsDeviceNames: dependencies.windowsDeviceNames }
      : {}),
    ...(dependencies.linuxPairedDevices
      ? { linuxPairedDevices: dependencies.linuxPairedDevices }
      : {}),
  }
}

export { BluetoothDiscoveryError, resolveLinuxSppChannel }
