import type { ConnectionConfig, PortInfo } from '../../shared/types'

export interface ConnectionPreset {
  id: string
  name: string
  type: 'serial' | 'bluetooth'
  port: string
  baudRate: number
  protocol?: 'auto' | 'v1' | 'v2'
  vendorId?: string
  productId?: string
  deviceId?: string
  transport?: ConnectionConfig['transport']
  stablePath?: string
  serialNumber?: string
  bluetoothAddress?: string
  bluetoothChannel?: number
  bluetoothServiceClassId?: string
  enableGamepad?: boolean
}

export const CONNECTION_PRESETS_KEY = 'oc-connection-presets'

export function loadConnectionPresets(): ConnectionPreset[] {
  try {
    const raw = localStorage.getItem(CONNECTION_PRESETS_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (!Array.isArray(parsed)) return []
      return parsed.map((preset: ConnectionPreset) => {
        if (preset.type !== 'bluetooth' || preset.bluetoothServiceClassId) return preset
        const legacyService = preset.port.match(/Bluetooth SPP\s+(0x[0-9a-f]{4})/i)?.[1]
        return legacyService ? { ...preset, bluetoothServiceClassId: legacyService } : preset
      })
    }
  } catch { /* ignore unavailable or malformed browser storage */ }
  return []
}

export function saveConnectionPresets(presets: ConnectionPreset[]): void {
  try { localStorage.setItem(CONNECTION_PRESETS_KEY, JSON.stringify(presets)) } catch { /* ignore */ }
}

export function connectionPresetEnablesGamepad(preset: ConnectionPreset): boolean {
  return preset.enableGamepad === true
}

export function connectionConfigFromPreset(preset: ConnectionPreset): ConnectionConfig {
  return {
    type: preset.type,
    port: preset.port,
    baudRate: preset.baudRate,
    ...(preset.vendorId ? { vendorId: preset.vendorId } : {}),
    ...(preset.productId ? { productId: preset.productId } : {}),
    ...(preset.deviceId ? { deviceId: preset.deviceId } : {}),
    ...(preset.transport ? { transport: preset.transport } : {}),
    ...(preset.stablePath ? { stablePath: preset.stablePath } : {}),
    ...(preset.serialNumber ? { serialNumber: preset.serialNumber } : {}),
    ...(preset.bluetoothAddress ? { bluetoothAddress: preset.bluetoothAddress } : {}),
    ...(preset.bluetoothChannel ? { bluetoothChannel: preset.bluetoothChannel } : {}),
    ...(preset.bluetoothServiceClassId
      ? { bluetoothServiceClassId: preset.bluetoothServiceClassId }
      : {}),
  }
}

export function updateConnectionPresetGamepadPreference(
  presets: ConnectionPreset[],
  presetId: string,
  enableGamepad: boolean,
): ConnectionPreset[] {
  if (!presets.some((preset) => preset.id === presetId)) return presets
  return presets.map((preset) => preset.id === presetId
    ? { ...preset, enableGamepad }
    : preset)
}

function canonicalUsbId(value: string | undefined): string | null {
  if (!value) return null
  const parsed = Number.parseInt(value.replace(/^0x/i, ''), 16)
  return Number.isFinite(parsed) ? parsed.toString(16).toUpperCase().padStart(4, '0') : null
}

function enrichSerialPreset(preset: ConnectionPreset, port: PortInfo): ConnectionPreset {
  return {
    ...preset,
    port: port.path,
    name: port.manufacturer ? `${port.path} (${port.manufacturer})` : port.path,
    ...(port.vendorId ? { vendorId: canonicalUsbId(port.vendorId) ?? port.vendorId } : {}),
    ...(port.productId ? { productId: canonicalUsbId(port.productId) ?? port.productId } : {}),
    ...(port.deviceId ? { deviceId: port.deviceId } : {}),
    ...(port.transport ? { transport: port.transport } : {}),
    ...(port.stablePath ? { stablePath: port.stablePath } : {}),
    ...(port.serialNumber ? { serialNumber: port.serialNumber } : {}),
  }
}

function normalizeBluetoothAddress(value: string | undefined): string | null {
  if (!value) return null
  const compact = value.replace(/[^0-9a-f]/gi, '').toUpperCase()
  return compact.length === 12 ? compact : null
}

function normalizeBluetoothService(value: string | undefined): string | null {
  if (!value) return null
  const short = value.match(/^(?:0x)?([0-9a-f]{4})$/i)?.[1]
    ?? value.match(/^0000([0-9a-f]{4})-/i)?.[1]
  return short?.toUpperCase() ?? null
}

function enrichBluetoothPreset(preset: ConnectionPreset, port: PortInfo): ConnectionPreset {
  return {
    ...preset,
    port: port.path,
    name: port.friendlyName || port.manufacturer || preset.name || port.path,
    ...(port.bluetoothAddress ? { bluetoothAddress: port.bluetoothAddress } : {}),
    ...(port.bluetoothChannel ? { bluetoothChannel: port.bluetoothChannel } : {}),
    ...(port.bluetoothServiceClassId
      ? { bluetoothServiceClassId: port.bluetoothServiceClassId }
      : {}),
    ...(port.vendorId ? { vendorId: canonicalUsbId(port.vendorId) ?? port.vendorId } : {}),
    ...(port.productId ? { productId: canonicalUsbId(port.productId) ?? port.productId } : {}),
    ...(port.deviceId ? { deviceId: port.deviceId } : {}),
  }
}

/** Resolve a saved USB device after Windows assigns it a different COM number. */
export function resolveSerialPreset(
  preset: ConnectionPreset,
  ports: PortInfo[],
): ConnectionPreset | null {
  if (preset.type !== 'serial') return preset

  // Browser-local ids from older previews were persisted without a lifecycle
  // identity and can silently refer to a different identical VID/PID device
  // after reload. Force an explicit browser picker for those legacy presets.
  if (/^local-port-\d+$/.test(preset.port) && !preset.deviceId) return null

  if (preset.deviceId) {
    const matches = ports.filter((port) => port.deviceId === preset.deviceId)
    if (matches.length === 1) return enrichSerialPreset(preset, matches[0])
    if (matches.length > 1) return null
    // A newer discovery pass may have selected a stronger identity namespace.
    // Continue only when the preset also carries independently verifiable
    // stable evidence; deviceId-only requests must never fall back to VID/PID.
    if (!preset.stablePath && !preset.serialNumber) return null
  }
  if (preset.stablePath) {
    const matches = ports.filter((port) => port.stablePath === preset.stablePath)
    return matches.length === 1 ? enrichSerialPreset(preset, matches[0]) : null
  }
  if (preset.serialNumber) {
    const presetVendorId = canonicalUsbId(preset.vendorId)
    const presetProductId = canonicalUsbId(preset.productId)
    const matches = ports.filter((port) =>
      port.serialNumber === preset.serialNumber
      && (!presetVendorId || canonicalUsbId(port.vendorId) === presetVendorId)
      && (!presetProductId || canonicalUsbId(port.productId) === presetProductId))
    return matches.length === 1 ? enrichSerialPreset(preset, matches[0]) : null
  }

  const identifiedUsbPorts = ports.filter((port) => port.vendorId && port.productId)
  const presetVendorId = canonicalUsbId(preset.vendorId)
  const presetProductId = canonicalUsbId(preset.productId)

  if (presetVendorId && presetProductId) {
    const matches = identifiedUsbPorts.filter((port) =>
      canonicalUsbId(port.vendorId) === presetVendorId
      && canonicalUsbId(port.productId) === presetProductId
    )
    // VID/PID-only presets do not prove physical identity. They remain usable
    // only while the expected device is still on the saved path; COM/tty
    // renumbering requires one explicit rescan so the preset can be upgraded.
    const matchingPath = matches.find((port) =>
      port.path.toUpperCase() === preset.port.toUpperCase()
    )
    return matchingPath ? enrichSerialPreset(preset, matchingPath) : null
  }

  // Legacy presets have no physical identity. Keep an existing path, but never
  // migrate to the only visible USB device: it may be another identical FC.
  const samePath = ports.find((port) => port.path.toUpperCase() === preset.port.toUpperCase())
  if (samePath) return enrichSerialPreset(preset, samePath)
  return null
}

/** Resolve a saved Bluetooth device to the current SPP endpoint without guessing. */
export function resolveBluetoothPreset(
  preset: ConnectionPreset,
  ports: PortInfo[],
): ConnectionPreset | null {
  if (preset.type !== 'bluetooth') return preset

  if (/^local-port-\d+$/.test(preset.port) && !preset.deviceId) return null

  if (preset.deviceId) {
    const matches = ports.filter((port) => port.deviceId === preset.deviceId)
    if (matches.length === 1) return enrichBluetoothPreset(preset, matches[0])
    if (matches.length > 1) return null
    // Web Serial does not expose a stable Bluetooth address. A descriptor
    // from a previous page lifecycle must not fall back to its reused path or
    // generic SPP service class.
    if (!preset.bluetoothAddress) return null
  }

  const requestedAddress = normalizeBluetoothAddress(preset.bluetoothAddress)
  if (requestedAddress) {
    const matches = ports.filter((port) =>
      normalizeBluetoothAddress(port.bluetoothAddress) === requestedAddress)
    return matches.length === 1 ? enrichBluetoothPreset(preset, matches[0]) : null
  }

  const samePath = ports.filter((port) => port.path.toUpperCase() === preset.port.toUpperCase())
  if (samePath.length === 1) return enrichBluetoothPreset(preset, samePath[0])

  const requestedService = normalizeBluetoothService(preset.bluetoothServiceClassId)
  if (requestedService) {
    const matches = ports.filter((port) =>
      normalizeBluetoothService(port.bluetoothServiceClassId) === requestedService)
    return matches.length === 1 ? enrichBluetoothPreset(preset, matches[0]) : null
  }
  return null
}

export function samePresetDevice(a: ConnectionPreset, b: ConnectionPreset): boolean {
  if (a.type !== b.type) return false
  if (a.type === 'bluetooth') {
    if (a.deviceId && b.deviceId) return a.deviceId === b.deviceId
    const aAddress = normalizeBluetoothAddress(a.bluetoothAddress)
    const bAddress = normalizeBluetoothAddress(b.bluetoothAddress)
    if (aAddress && bAddress) return aAddress === bAddress
    return a.port.toUpperCase() === b.port.toUpperCase()
  }
  if (a.deviceId && b.deviceId) return a.deviceId === b.deviceId
  if (a.stablePath && b.stablePath) return a.stablePath === b.stablePath
  if (a.serialNumber && b.serialNumber) {
    return a.serialNumber === b.serialNumber
      && canonicalUsbId(a.vendorId) === canonicalUsbId(b.vendorId)
      && canonicalUsbId(a.productId) === canonicalUsbId(b.productId)
  }
  const aVendor = canonicalUsbId(a.vendorId)
  const aProduct = canonicalUsbId(a.productId)
  const bVendor = canonicalUsbId(b.vendorId)
  const bProduct = canonicalUsbId(b.productId)
  if (aVendor && aProduct && bVendor && bProduct) {
    return aVendor === bVendor && aProduct === bProduct
  }
  return a.port.toUpperCase() === b.port.toUpperCase()
}
