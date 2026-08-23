import type {
  ConnectionConfig,
  ConnectionDiscoveryWarning,
  ConnectionErrorCode,
  ConnectionScanKind,
  ConnectionScanResult,
  ConnectionScanScope,
  PortInfo,
} from '../../shared/types'
import {
  discoverSerialDevices,
  stableSerialDeviceId,
  type SerialDiscoveryDependencies,
} from './discovery/serialDiscovery'
import { discoverBluetoothQuick } from './discovery/bluetoothDiscovery'

/**
 * Owns device discovery only (plan §3.1): it classifies and resolves device
 * candidates but never opens connections. ConnectionManager stays the single
 * entry point for active links.
 */

export class ConnectionResolutionError extends Error {
  constructor(
    message: string,
    readonly code: ConnectionErrorCode,
  ) {
    super(message)
    this.name = 'ConnectionResolutionError'
  }
}

export interface ConnectionDiscoveryOptions {
  serialDependencies?: SerialDiscoveryDependencies
  bluetoothDependencies?: Parameters<typeof discoverBluetoothQuick>[0]
  monotonicNow?: () => number
  log?: (message: string, meta?: Record<string, unknown>) => void
  serialCacheTtlMs?: number
  bluetoothCacheTtlMs?: number
}

interface CacheEntry {
  devices: PortInfo[]
  warnings: ConnectionDiscoveryWarning[]
  expiresAt: number
}

const DEFAULT_SERIAL_CACHE_TTL_MS = 2500
const DEFAULT_BLUETOOTH_CACHE_TTL_MS = 3000

function normalizeScope(kind: ConnectionScanKind, scope: string | undefined): ConnectionScanScope {
  if (kind === 'serial') return scope === 'all' ? 'all' : 'recommended'
  return 'quick'
}

export class ConnectionDiscoveryService {
  private scanGeneration = 0
  private readonly cache = new Map<string, CacheEntry>()
  private readonly monotonicNow: () => number
  private readonly log: NonNullable<ConnectionDiscoveryOptions['log']>
  private readonly serialCacheTtlMs: number
  private readonly bluetoothCacheTtlMs: number
  private readonly serialDependencies: SerialDiscoveryDependencies
  private readonly bluetoothDependencies: NonNullable<ConnectionDiscoveryOptions['bluetoothDependencies']>

  constructor(options: ConnectionDiscoveryOptions = {}) {
    this.monotonicNow = options.monotonicNow ?? (() => performance.now())
    this.log = options.log ?? ((message, meta) => console.info(message, meta ?? ''))
    this.serialCacheTtlMs = options.serialCacheTtlMs ?? DEFAULT_SERIAL_CACHE_TTL_MS
    this.bluetoothCacheTtlMs = options.bluetoothCacheTtlMs ?? DEFAULT_BLUETOOTH_CACHE_TTL_MS
    this.serialDependencies = options.serialDependencies ?? {}
    this.bluetoothDependencies = options.bluetoothDependencies ?? {}
  }

  async scan(
    kind: ConnectionScanKind,
    scope?: string,
  ): Promise<ConnectionScanResult> {
    const normalizedScope = normalizeScope(kind, scope)
    const generation = ++this.scanGeneration
    const cacheKey = `${kind}:${normalizedScope}`
    const cached = this.cache.get(cacheKey)
    if (cached && cached.expiresAt > this.monotonicNow()) {
      this.log('[Discovery] scan served from cache', { kind, scope: normalizedScope, generation, count: cached.devices.length })
      return {
        kind,
        scope: normalizedScope,
        scanGeneration: generation,
        cached: true,
        devices: cached.devices,
        warnings: cached.warnings,
      }
    }

    const startedAt = this.monotonicNow()
    let devices: PortInfo[]
    let warnings: ConnectionDiscoveryWarning[] = []
    if (kind === 'serial') {
      const discovered = await discoverSerialDevices(this.serialDependencies)
      devices = normalizedScope === 'all' ? discovered.all : discovered.recommended
    } else {
      try {
        devices = await discoverBluetoothQuick(this.bluetoothDependencies)
      } catch (error) {
        // Bluetooth being unavailable must never block or fail the dialog;
        // surface it as an actionable warning with an empty candidate list.
        devices = []
        warnings = [warningFromError(error)]
      }
    }

    const durationMs = Math.round(this.monotonicNow() - startedAt)
    const ttl = kind === 'serial' ? this.serialCacheTtlMs : this.bluetoothCacheTtlMs
    this.cache.set(cacheKey, {
      devices,
      warnings,
      expiresAt: this.monotonicNow() + ttl,
    })
    this.log('[Discovery] scan completed', {
      kind,
      scope: normalizedScope,
      generation,
      durationMs,
      count: devices.length,
    })
    return {
      kind,
      scope: normalizedScope,
      scanGeneration: generation,
      cached: false,
      devices,
      warnings,
    }
  }

  /** Legacy combined entry kept for the deprecated no-parameter `/scan`. */
  async scanAll(): Promise<{ serial: PortInfo[]; bluetooth: PortInfo[]; warnings: ConnectionDiscoveryWarning[] }> {
    const [serial, bluetooth] = await Promise.all([
      this.scan('serial', 'recommended'),
      this.scan('bluetooth', 'quick'),
    ])
    return { serial: serial.devices, bluetooth: bluetooth.devices, warnings: bluetooth.warnings }
  }

  /** Invalidate cached scan results (adapter state changed, after connect…). */
  invalidate(): void {
    this.cache.clear()
  }

  /**
   * Re-resolve a serial connection request against the current device list
   * (plan §4.3). Fails closed when the identity is missing or ambiguous
   * instead of connecting to a different device on the same path.
   */
  async resolveSerialTarget(config: ConnectionConfig): Promise<{
    path: string
    identity: PortInfo | null
  }> {
    if (
      config.type !== 'serial'
      || (!config.deviceId && !config.stablePath && !config.serialNumber)
    ) {
      // Legacy/direct path mode: no identity claims to verify.
      return { path: config.port, identity: null }
    }

    const discovered = await discoverSerialDevices(this.serialDependencies)
    const candidates = discovered.all

    const matchesRequestedIdentity = (device: PortInfo): boolean => {
      if (config.stablePath && device.stablePath !== config.stablePath) return false
      if (config.serialNumber && device.serialNumber !== config.serialNumber) return false
      return !!(config.stablePath || config.serialNumber)
    }
    const directIdMatches = config.deviceId
      ? candidates.filter((device) =>
        device.deviceId === config.deviceId || stableSerialDeviceId(device) === config.deviceId)
      : []
    // Older discovery builds used a composite hash that could change when
    // metadata became richer. A supplied stablePath/serialNumber may recover
    // that request, but only when all supplied identity evidence agrees.
    const matches = directIdMatches.length > 0
      ? directIdMatches
      : candidates.filter(matchesRequestedIdentity)

    const uniquePaths = new Set(matches.map((device) => device.path))
    if (uniquePaths.size === 0) {
      throw new ConnectionResolutionError(
        `目标设备（${config.stablePath ?? config.port}）当前不存在或已拔出。请重新扫描并选择设备。`,
        'DEVICE_NOT_FOUND',
      )
    }
    if (uniquePaths.size > 1) {
      throw new ConnectionResolutionError(
        `多个设备匹配同一身份（${[...uniquePaths].join(', ')}）。请重新扫描并明确选择一个设备。`,
        'IDENTITY_AMBIGUOUS',
      )
    }

    const match = matches[0]
    const conflicts: string[] = []
    if (config.serialNumber && deviceSerial(match) !== config.serialNumber) {
      conflicts.push('serialNumber')
    }
    if (config.stablePath && match.stablePath !== config.stablePath) conflicts.push('stablePath')
    if (config.vendorId && normalizeHex(match.vendorId) !== normalizeHex(config.vendorId)) {
      conflicts.push('vendorId')
    }
    if (config.productId && normalizeHex(match.productId) !== normalizeHex(config.productId)) {
      conflicts.push('productId')
    }
    if (conflicts.length > 0) {
      throw new ConnectionResolutionError(
        `设备身份与请求不一致（${conflicts.join(', ')}）：${match.path} 可能不是原来选择的设备。请重新扫描并选择。`,
        'IDENTITY_AMBIGUOUS',
      )
    }
    return { path: match.path, identity: match }
  }
}

const deviceSerial = (device: PortInfo): string | undefined => device.serialNumber

const normalizeHex = (value?: string): string | undefined => {
  if (!value) return undefined
  const hex = value.trim().toLowerCase().replace(/^0x/, '')
  return /^[0-9a-f]+$/.test(hex) ? hex : undefined
}

function warningFromError(error: unknown): ConnectionDiscoveryWarning {
  if (error instanceof ConnectionResolutionError) {
    return { code: error.code, message: error.message }
  }
  const code = (error as { code?: unknown })?.code
  if (typeof code === 'string') {
    return { code, message: error instanceof Error ? error.message : String(error) }
  }
  return {
    code: 'BLUETOOTH_ADAPTER_UNAVAILABLE',
    message: error instanceof Error ? error.message : String(error),
  }
}
