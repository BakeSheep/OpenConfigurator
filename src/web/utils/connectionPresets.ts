import type { PortInfo } from '../../shared/types'

export interface ConnectionPreset {
  id: string
  name: string
  type: 'serial' | 'bluetooth'
  port: string
  baudRate: number
  vendorId?: string
  productId?: string
}

export const CONNECTION_PRESETS_KEY = 'oc-connection-presets'

export function loadConnectionPresets(): ConnectionPreset[] {
  try {
    const raw = localStorage.getItem(CONNECTION_PRESETS_KEY)
    if (raw) return JSON.parse(raw)
  } catch { /* ignore unavailable or malformed browser storage */ }
  return []
}

export function saveConnectionPresets(presets: ConnectionPreset[]): void {
  try { localStorage.setItem(CONNECTION_PRESETS_KEY, JSON.stringify(presets)) } catch { /* ignore */ }
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
  }
}

/** Resolve a saved USB device after Windows assigns it a different COM number. */
export function resolveSerialPreset(
  preset: ConnectionPreset,
  ports: PortInfo[],
): ConnectionPreset | null {
  if (preset.type !== 'serial') return preset

  const identifiedUsbPorts = ports.filter((port) => port.vendorId && port.productId)
  const presetVendorId = canonicalUsbId(preset.vendorId)
  const presetProductId = canonicalUsbId(preset.productId)

  if (presetVendorId && presetProductId) {
    const matches = identifiedUsbPorts.filter((port) =>
      canonicalUsbId(port.vendorId) === presetVendorId
      && canonicalUsbId(port.productId) === presetProductId
    )
    if (matches.length === 1) return enrichSerialPreset(preset, matches[0])

    // Identical adapters cannot be distinguished by VID/PID alone. Retain the
    // saved path only when the device currently on it has the expected identity.
    const matchingPath = matches.find((port) =>
      port.path.toUpperCase() === preset.port.toUpperCase()
    )
    return matchingPath ? enrichSerialPreset(preset, matchingPath) : null
  }

  // Legacy presets have no identity. Keep an existing path, or migrate only
  // when exactly one identified USB serial device exists; otherwise fail closed.
  const samePath = ports.find((port) => port.path.toUpperCase() === preset.port.toUpperCase())
  if (samePath) return enrichSerialPreset(preset, samePath)
  return identifiedUsbPorts.length === 1
    ? enrichSerialPreset(preset, identifiedUsbPorts[0])
    : null
}

export function samePresetDevice(a: ConnectionPreset, b: ConnectionPreset): boolean {
  if (a.type !== b.type) return false
  if (a.type === 'bluetooth') return a.port.toUpperCase() === b.port.toUpperCase()
  const aVendor = canonicalUsbId(a.vendorId)
  const aProduct = canonicalUsbId(a.productId)
  const bVendor = canonicalUsbId(b.vendorId)
  const bProduct = canonicalUsbId(b.productId)
  if (aVendor && aProduct && bVendor && bProduct) {
    return aVendor === bVendor && aProduct === bProduct
  }
  return a.port.toUpperCase() === b.port.toUpperCase()
}
