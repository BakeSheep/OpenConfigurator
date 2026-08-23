import { createHash } from 'node:crypto'
import { resolve as resolvePath } from 'node:path'
import type { PortInfo } from '../../../shared/types'

/**
 * Platform-aware serial candidate classification (connection compatibility
 * plan §Phase 1). Discovery only reads and classifies; it never opens ports.
 *
 * Linux: `/dev/serial/by-id/*` symlinks are resolved to their current tty and
 * merged into one device so a USB flight controller never appears twice.
 * Platform UARTs (`ttyS*`, `ttyHS*`, …) stay out of the recommended scope and
 * only appear behind the explicit "show all ports" request.
 * Windows: every COM port from SerialPort.list stays recommended with its PnP
 * metadata, matching the pre-existing behavior.
 */

export interface SerialPortRecord {
  path: string
  manufacturer?: string
  friendlyName?: string
  serialNumber?: string
  productId?: string
  vendorId?: string
  pnpId?: string
  locationId?: number | string
}

export interface SerialDiscoveryDependencies {
  platform?: NodeJS.Platform
  listPorts?: () => Promise<SerialPortRecord[]>
  readByIdDirectory?: () => Promise<Map<string, string>>
}

const LINUX_RECOMMENDED_PATH = /^\/dev\/(?:ttyACM\d+|ttyUSB\d+|rfcomm\d+)$/
const LINUX_PLATFORM_UART = /^\/dev\/tty(?:S\d+|HS\d+|MAX\d+|UL\d+|FIQ\d+)$/

const normalizeHexId = (value?: string): string | undefined => {
  if (!value) return undefined
  const hex = value.trim().toLowerCase().replace(/^0x/, '')
  return /^[0-9a-f]+$/.test(hex) ? hex.replace(/^0+(?=[0-9a-f])/, '') || '0' : undefined
}

interface IdentityFields {
  vendorId?: string
  productId?: string
  serialNumber?: string
  pnpId?: string
  locationId?: number | string
  usbLocationId?: string
}

const hasUsbIdentity = (device: IdentityFields): boolean =>
  !!device.vendorId
  || !!device.productId
  || !!device.serialNumber
  || !!device.pnpId
  || !!device.locationId
  || !!device.usbLocationId

const scoreSerialDevice = (device: PortInfo): number => {
  let score = 0
  if (device.stablePath) score += 40
  if (device.serialNumber) score += 30
  if (LINUX_RECOMMENDED_PATH.test(device.path)) score += 20
  if (device.vendorId && device.productId) score += 10
  return score
}

const compareSerialDevices = (a: PortInfo, b: PortInfo): number =>
  scoreSerialDevice(b) - scoreSerialDevice(a) || a.path.localeCompare(b.path)

const hashIdentity = (input: string): string =>
  createHash('sha256').update(input).digest('hex').slice(0, 16)

/**
 * Opaque per-process device id. Built from the strongest stable identity
 * available; the raw path participates only when the device exposes no USB /
 * PnP identity at all, so two identical adapters stay distinguishable while a
 * single re-enumerating device keeps its id.
 */
export function stableSerialDeviceId(device: PortInfo): string {
  // Pick one stable namespace instead of hashing every optional field. Device
  // metadata is commonly incomplete during re-enumeration (for example a
  // by-id alias appears before SerialPort.list reports serialNumber); adding
  // that metadata later must not change the id of the same physical device.
  const identity = device.stablePath
    ? ['stable-path', device.stablePath]
    : device.pnpId
      ? ['pnp', device.pnpId]
      : device.serialNumber
        ? [
          'usb-serial',
          device.serialNumber,
          normalizeHexId(device.vendorId) ?? '',
          normalizeHexId(device.productId) ?? '',
        ]
        : device.usbLocationId
          ? [
            'usb-location',
            device.usbLocationId,
            normalizeHexId(device.vendorId) ?? '',
            normalizeHexId(device.productId) ?? '',
          ]
          : ['path', device.path]
  return `serial:${hashIdentity(identity.join('|'))}`
}

/**
 * Build the by-id → current-tty map from `/dev/serial/by-id`. Injected in
 * tests; returns an empty map when the directory does not exist.
 */
async function readLinuxByIdDirectory(): Promise<Map<string, string>> {
  const { readdir, readlink } = await import('node:fs/promises')
  const byId = new Map<string, string>()
  try {
    const entries = await readdir('/dev/serial/by-id')
    for (const entry of entries) {
      try {
        const target = await readlink(`/dev/serial/by-id/${entry}`)
        const devPath = resolvePath('/dev/serial/by-id', target)
        if (/^\/dev\/(?:tty\w+|rfcomm\d+)$/.test(devPath)) {
          byId.set(`/dev/serial/by-id/${entry}`, devPath)
        }
      } catch {
        // A dangling or unreadable symlink must not break the whole listing.
      }
    }
  } catch {
    // No /dev/serial/by-id (no USB serial devices or unsupported platform).
  }
  return byId
}

export interface SerialDiscoveryResult {
  recommended: PortInfo[]
  all: PortInfo[]
}

export async function discoverSerialDevices(
  dependencies: SerialDiscoveryDependencies = {},
): Promise<SerialDiscoveryResult> {
  const platform = dependencies.platform ?? process.platform
  const listPorts = dependencies.listPorts
    ?? (async () => {
      const { SerialPort } = await import('serialport')
      return SerialPort.list() as unknown as SerialPortRecord[]
    })
  const readByIdDirectory = dependencies.readByIdDirectory ?? readLinuxByIdDirectory

  const records = await listPorts()
  const byId = platform === 'linux' ? await readByIdDirectory() : new Map<string, string>()

  // Current tty path → preferred by-id stable path.
  const stableByPath = new Map<string, string>()
  for (const [stablePath, devPath] of byId) {
    if (!stableByPath.has(devPath)) stableByPath.set(devPath, stablePath)
  }

  const merged = new Map<string, PortInfo>()
  const mergeDevice = (device: PortInfo): void => {
    const existing = merged.get(device.path)
    if (!existing) {
      merged.set(device.path, device)
      return
    }
    merged.set(device.path, {
      ...existing,
      ...Object.fromEntries(Object.entries(device).filter(([, value]) => value !== undefined)),
    })
  }

  for (const record of records) {
    mergeDevice(toSerialPortInfo(record, stableByPath.get(record.path)))
  }

  // A by-id alias whose tty is momentarily missing from SerialPort.list
  // (re-enumeration race) still surfaces so recovery can observe it.
  const knownPaths = new Set(records.map((record) => record.path))
  for (const [stablePath, devPath] of byId) {
    if (!knownPaths.has(devPath)) {
      mergeDevice({ path: devPath, stablePath, transport: 'serial' })
    }
  }

  const devices = [...merged.values()]
    .map((device) => ({
      ...device,
      deviceId: stableSerialDeviceId(device),
      displayName: serialDisplayName(device),
    }))
    .sort(compareSerialDevices)

  const recommendedPaths = new Set(
    devices
      .filter((device) =>
        platform === 'linux'
          ? LINUX_RECOMMENDED_PATH.test(device.path) || hasUsbIdentity(device)
          : true,
      )
      .map((device) => device.path),
  )

  return {
    recommended: devices
      .filter((device) => recommendedPaths.has(device.path))
      .map((device) => ({ ...device, recommended: true })),
    all: devices.map((device) => ({
      ...device,
      recommended: recommendedPaths.has(device.path),
    })),
  }
}

function toSerialPortInfo(record: SerialPortRecord, stablePath?: string): PortInfo {
  return {
    path: record.path,
    manufacturer: record.manufacturer,
    friendlyName: record.friendlyName,
    serialNumber: record.serialNumber,
    productId: record.productId,
    vendorId: record.vendorId,
    pnpId: record.pnpId,
    ...(record.locationId !== undefined && record.locationId !== null
      ? { usbLocationId: String(record.locationId) }
      : {}),
    ...(stablePath ? { stablePath } : {}),
    transport: 'serial',
  }
}

/**
 * Display priority per plan §Phase 1: friendly name → manufacturer + serial
 * suffix → stable path → platform path.
 */
export function serialDisplayName(device: PortInfo): string {
  if (device.friendlyName) return device.friendlyName
  if (device.manufacturer) {
    const suffix = device.serialNumber ? ` …${device.serialNumber.slice(-4)}` : ''
    return `${device.manufacturer}${suffix}`
  }
  if (device.stablePath) return device.stablePath.split('/').pop() ?? device.stablePath
  return device.path
}

/**
 * True when the port is a plain Linux platform UART (no hotplug identity),
 * which the recommended scope hides behind "show all ports".
 */
export function isLinuxPlatformUart(path: string): boolean {
  return LINUX_PLATFORM_UART.test(path)
}
