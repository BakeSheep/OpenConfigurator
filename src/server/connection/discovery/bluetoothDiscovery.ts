import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import type {
  ConnectionErrorCode,
  PortInfo,
} from '../../../shared/types'

/**
 * Bluetooth candidate discovery (connection compatibility plan §Phase 2).
 *
 * Quick discovery only reads local caches (`bluetoothctl devices Paired` and
 * per-device `bluetoothctl info`, which reads BlueZ's cached record without
 * contacting the device) and never runs `sdptool`. Blocking SDP resolution
 * happens exclusively for the one address the operator selected to connect.
 */

const execFileAsync = promisify(execFile)

export const FLIGHT_CONTROLLER_NAME = /(micoair|pixhawk|cubepilot|cube\s*orange|px4|flight\s*controller|飞控)/i
export const SPP_SERVICE_UUID = '00001101-0000-1000-8000-00805f9b34fb'
const WINDOWS_SPP_SERVICE_ID = '1101'
const DEFAULT_QUICK_DEADLINE_MS = 1200
const DEFAULT_LIST_TIMEOUT_MS = 1000
const DEFAULT_INFO_TIMEOUT_MS = 700
const DEFAULT_SDP_TIMEOUT_MS = 8000
const CHANNEL_CACHE_TTL_MS = 10 * 60 * 1000

export interface CommandResult {
  stdout: string
  stderr: string
}

export interface CommandRunnerOptions {
  timeoutMs: number
}

export type CommandRunner = (
  file: string,
  args: readonly string[],
  options: CommandRunnerOptions,
) => Promise<CommandResult>

export const defaultCommandRunner: CommandRunner = async (file, args, options) => {
  const { stdout, stderr } = await execFileAsync(file, args, {
    encoding: 'utf8',
    timeout: options.timeoutMs,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  })
  return { stdout, stderr }
}

/** Failure carrying a stable, localizable code from the plan's §4.4 table. */
export class BluetoothDiscoveryError extends Error {
  constructor(
    message: string,
    readonly code: ConnectionErrorCode,
  ) {
    super(message)
    this.name = 'BluetoothDiscoveryError'
  }
}

export interface BluetoothPortRecord {
  path: string
  manufacturer?: string
  friendlyName?: string
  bluetoothAddress?: string
  bluetoothChannel?: number
  bluetoothServiceClassId?: string
  productId?: string
  vendorId?: string
  pnpId?: string
}

export interface BluetoothQuickDependencies {
  platform?: NodeJS.Platform
  runCommand?: CommandRunner
  listPorts?: () => Promise<BluetoothPortRecord[]>
  windowsDeviceNames?: () => Promise<Map<string, string>>
  monotonicNow?: () => number
  quickDeadlineMs?: number
  /**
   * Test/legacy escape hatch: return paired-device records directly instead
   * of shelling out to bluetoothctl. Production code must rely on the
   * injectable `runCommand` so timeout/cancel/tool-missing paths stay covered.
   */
  linuxPairedDevices?: () => Promise<BluetoothPortRecord[]>
}

const normalizeAddress = (value?: string): string | undefined => {
  if (!value) return undefined
  const address = value.toLowerCase().replace(/[^0-9a-f]/g, '')
  return address.length === 12 ? address : undefined
}

export const formatBluetoothAddress = (compact: string): string =>
  compact.match(/.{2}/g)!.join(':').toUpperCase()

const linuxSppPath = (address: string): string =>
  `bt-spp://${normalizeAddress(address)}`

export const linuxRfcommPath = (address: string, channel: number): string =>
  `bt-rfcomm://${normalizeAddress(address)}/${channel}`

export function parseLinuxSppPath(path: string): string | null {
  const compact = normalizeAddress(path.match(/^bt-spp:\/\/([0-9a-f:]+)$/i)?.[1])
  return compact ? formatBluetoothAddress(compact) : null
}

export function parseLinuxRfcommPath(path: string): { address: string; channel: number } | null {
  const match = path.match(/^bt-rfcomm:\/\/([0-9a-f:]+)\/(\d{1,2})$/i)
  if (!match) return null
  const channel = Number(match[2])
  if (!Number.isInteger(channel) || channel < 1 || channel > 30) return null
  const compact = normalizeAddress(match[1])
  return compact ? { address: formatBluetoothAddress(compact), channel } : null
}

const isCommandMissing = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false
  const code = (error as NodeJS.ErrnoException).code
  return code === 'ENOENT' || /not found|无法找到|command not found/i.test(error.message)
}

const isTimeout = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false
  const processError = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null }
  return processError.code === 'ETIMEDOUT'
    // Node's execFile timeout commonly reports code=null, killed=true and
    // SIGTERM with a generic "Command failed" message.
    || (processError.killed === true && processError.signal === 'SIGTERM')
    || /timed?[- ]out|超时/i.test(error.message)
}

// ---------------------------------------------------------------------------
// Linux quick discovery (cached reads only, bounded deadline)
// ---------------------------------------------------------------------------

interface LinuxPairedDevice {
  address: string
  name: string
  sppCached: boolean
}

async function listLinuxPairedDevices(
  runCommand: CommandRunner,
  deadlineRemaining: () => number,
): Promise<LinuxPairedDevice[]> {
  let output: CommandResult
  try {
    output = await runCommand('bluetoothctl', ['devices', 'Paired'], {
      timeoutMs: Math.max(200, Math.min(DEFAULT_LIST_TIMEOUT_MS, deadlineRemaining())),
    })
  } catch (error) {
    if (isCommandMissing(error)) {
      throw new BluetoothDiscoveryError(
        '未找到 bluetoothctl，无法枚举已配对蓝牙设备。请安装 bluez 包。',
        'BLUETOOTH_TOOL_MISSING',
      )
    }
    throw error
  }
  if (/no default controller available/i.test(output.stdout + output.stderr)) {
    throw new BluetoothDiscoveryError(
      '蓝牙适配器不可用（无默认控制器）。请插入/开启蓝牙适配器或启动 bluetooth 服务。',
      'BLUETOOTH_ADAPTER_UNAVAILABLE',
    )
  }
  return [...output.stdout.matchAll(/^Device\s+([0-9a-f:]{17})\s+(.+)$/gim)]
    .map(([, address, name]) => ({
      address: address.toUpperCase(),
      name: name.trim(),
      sppCached: false,
    }))
}

async function readLinuxDeviceInfo(
  runCommand: CommandRunner,
  address: string,
  timeoutMs: number,
): Promise<string | null> {
  try {
    const { stdout } = await runCommand('bluetoothctl', ['info', address], { timeoutMs })
    return stdout
  } catch {
    // `info` reads a local cache but can still fail transiently; the device
    // stays listed with unknown capabilities rather than disappearing.
    return null
  }
}

/** Quick Bluetooth scan: reads cached identity only, never contacts devices. */
export async function discoverBluetoothQuick(
  dependencies: BluetoothQuickDependencies = {},
): Promise<PortInfo[]> {
  const platform = dependencies.platform ?? process.platform
  const runCommand = dependencies.runCommand ?? defaultCommandRunner
  const now = dependencies.monotonicNow ?? (() => performance.now())
  const deadline = now() + (dependencies.quickDeadlineMs ?? DEFAULT_QUICK_DEADLINE_MS)
  const remaining = () => Math.max(0, deadline - now())

  if (platform === 'win32' || platform === 'darwin') {
    return discoverWindowsSppPorts(dependencies)
  }
  if (platform !== 'linux') return []

  const discovered: PortInfo[] = []
  if (dependencies.linuxPairedDevices) {
    const records = await dependencies.linuxPairedDevices()
    discovered.push(...records.map((record) => ({
      path: record.path,
      transport: 'bluetooth-spp' as const,
      deviceId: `bt-spp:${createHash('sha256')
        .update(normalizeAddress(record.bluetoothAddress) ?? record.path)
        .digest('hex').slice(0, 16)}`,
      displayName: record.friendlyName ?? record.path,
      friendlyName: record.friendlyName,
      manufacturer: record.manufacturer,
      bluetoothAddress: record.bluetoothAddress?.toUpperCase(),
      bluetoothChannel: record.bluetoothChannel,
      bluetoothServiceClassId: record.bluetoothServiceClassId,
      productId: record.productId,
      vendorId: record.vendorId,
      pnpId: record.pnpId,
      availability: 'paired' as const,
      requiresDeepResolution: !record.bluetoothChannel,
      recommended: !!record.friendlyName && FLIGHT_CONTROLLER_NAME.test(record.friendlyName),
    })))
  } else {
    const devices = await listLinuxPairedDevices(runCommand, remaining)
    for (const device of devices) {
      let info: string | null = null
      if (remaining() >= 150) {
        info = await readLinuxDeviceInfo(runCommand, device.address, Math.min(DEFAULT_INFO_TIMEOUT_MS, remaining()))
      }
      const paired = info ? /^\s*Paired:\s*yes\s*$/im.test(info) : null
      if (paired === false) continue
      const sppCached = info ? info.includes(SPP_SERVICE_UUID) : false
      const name = info?.match(/^\s*(?:Name|Alias):\s*(.+)$/im)?.[1]?.trim() ?? device.name
      const compact = normalizeAddress(device.address)!
      discovered.push({
        path: linuxSppPath(device.address),
        transport: 'bluetooth-spp',
        deviceId: `bt-spp:${createHash('sha256').update(compact).digest('hex').slice(0, 16)}`,
        displayName: name,
        friendlyName: name !== device.address ? name : undefined,
        manufacturer: 'BlueZ',
        bluetoothAddress: device.address,
        // The SPP service id is only claimed when BlueZ already cached it; the
        // RFCOMM channel is never fabricated here.
        ...(sppCached ? { bluetoothServiceClassId: '0x1101' } : {}),
        availability: 'paired',
        requiresDeepResolution: true,
        recommended: FLIGHT_CONTROLLER_NAME.test(name),
      })
    }
  }

  // Manually bound RFCOMM nodes (/dev/rfcommN) stay selectable like before.
  const bound = await listLinuxRfcommNodes(dependencies.listPorts)
  const knownAddresses = new Set(discovered.map((device) => device.bluetoothAddress?.toUpperCase()))
  for (const port of bound) {
    if (port.bluetoothAddress && knownAddresses.has(port.bluetoothAddress.toUpperCase())) continue
    discovered.push({
      path: port.path,
      transport: 'bluetooth-spp',
      deviceId: `bt-spp:${createHash('sha256')
        .update(port.bluetoothAddress ?? port.path)
        .digest('hex').slice(0, 16)}`,
      displayName: port.friendlyName ?? port.path,
      friendlyName: port.friendlyName,
      manufacturer: port.manufacturer,
      bluetoothAddress: port.bluetoothAddress,
      bluetoothChannel: port.bluetoothChannel,
      bluetoothServiceClassId: port.bluetoothServiceClassId,
      pnpId: port.pnpId,
      availability: 'available',
      requiresDeepResolution: false,
      recommended: !!port.friendlyName && FLIGHT_CONTROLLER_NAME.test(port.friendlyName),
    })
  }
  return discovered
}

async function listLinuxRfcommNodes(
  listPorts?: () => Promise<BluetoothPortRecord[]>,
): Promise<BluetoothPortRecord[]> {
  const list = listPorts
    ?? (async () => {
      try {
        const { SerialPort } = await import('serialport')
        return SerialPort.list() as unknown as BluetoothPortRecord[]
      } catch {
        return []
      }
    })
  const ports = await list()
  return ports.filter((port) => /^\/dev\/rfcomm\d+$/.test(port.path))
}

// ---------------------------------------------------------------------------
// Windows SPP discovery (virtual COM ports from SerialPort.list)
// ---------------------------------------------------------------------------

const isIncomingWindowsPort = (port: BluetoothPortRecord): boolean =>
  /_localmfg&0000/i.test(port.pnpId ?? '')

const isWindowsSppPort = (port: BluetoothPortRecord): boolean => {
  const pnp = (port.pnpId ?? '').toLowerCase()
  return pnp.includes('bthenum') && pnp.includes(WINDOWS_SPP_SERVICE_ID.padStart(8, '0'))
}

async function discoverWindowsSppPorts(
  dependencies: BluetoothQuickDependencies,
): Promise<PortInfo[]> {
  const platform = dependencies.platform ?? process.platform
  const listPorts = dependencies.listPorts
    ?? (async () => {
      const { SerialPort } = await import('serialport')
      return SerialPort.list() as unknown as BluetoothPortRecord[]
    })

  const ports = await listPorts()
  if (platform === 'darwin') {
    return ports
      .filter((port) => {
        const path = port.path.toLowerCase()
        const metadata = `${port.manufacturer ?? ''} ${port.pnpId ?? ''}`.toLowerCase()
        if (/bluetooth-incoming-port/i.test(path)) return false
        return /^\/dev\/cu\..*(?:bluetooth|\bbt\b|spp)/i.test(path)
          || /\b(?:bluetooth|iobluetooth|spp)\b/i.test(metadata)
      })
      .map((port) => ({
        path: port.path,
        transport: 'bluetooth-spp' as const,
        deviceId: `bt-spp:${createHash('sha256').update(port.path).digest('hex').slice(0, 16)}`,
        manufacturer: port.manufacturer,
        friendlyName: port.friendlyName,
        displayName: port.friendlyName ?? port.path,
        bluetoothAddress: port.bluetoothAddress,
        bluetoothChannel: port.bluetoothChannel,
        bluetoothServiceClassId: port.bluetoothServiceClassId,
        productId: port.productId,
        vendorId: port.vendorId,
        pnpId: port.pnpId,
        availability: 'available' as const,
        requiresDeepResolution: false,
        recommended: !!port.friendlyName && FLIGHT_CONTROLLER_NAME.test(port.friendlyName),
      }))
  }

  const deviceNames = await (dependencies.windowsDeviceNames
    ?? readWindowsBluetoothDeviceNames)()
  return ports
    .filter((port) => {
      if (isIncomingWindowsPort(port)) return false
      if (isWindowsSppPort(port)) return true
      const metadata = `${port.manufacturer ?? ''} ${port.pnpId ?? ''}`.toLowerCase()
      return metadata.includes('bluetooth')
    })
    .map((port) => {
      const bluetoothAddress = port.bluetoothAddress
        ?? port.pnpId?.match(/&0&([0-9a-f]{12})_c/i)?.[1]?.toUpperCase()
      const friendlyName = port.friendlyName
        ?? (bluetoothAddress ? deviceNames.get(bluetoothAddress.toLowerCase()) : undefined)
      const vid = port.pnpId?.match(/_vid&([0-9a-f]+)/i)?.[1] ?? port.vendorId
      const pid = port.pnpId?.match(/_pid&([0-9a-f]+)/i)?.[1] ?? port.productId
      return {
        path: port.path,
        transport: 'bluetooth-spp' as const,
        deviceId: `bt-spp-com:${createHash('sha256')
          .update([bluetoothAddress ?? '', port.pnpId ?? '', port.path].join('|'))
          .digest('hex').slice(0, 16)}`,
        manufacturer: port.manufacturer,
        friendlyName,
        displayName: friendlyName ?? port.path,
        bluetoothAddress,
        bluetoothChannel: port.bluetoothChannel,
        bluetoothServiceClassId: port.bluetoothServiceClassId,
        productId: pid,
        vendorId: vid,
        pnpId: port.pnpId,
        availability: 'available' as const,
        requiresDeepResolution: false,
        recommended: !!friendlyName && FLIGHT_CONTROLLER_NAME.test(friendlyName),
      }
    })
    .sort((a, b) => Number(b.recommended) - Number(a.recommended))
}

// ---------------------------------------------------------------------------
// Windows Bluetooth registry names
// ---------------------------------------------------------------------------

/** Read paired device names and addresses from the Windows Bluetooth registry. */
async function readWindowsBluetoothDeviceNames(): Promise<Map<string, string>> {
  const names = new Map<string, string>()
  if ((process.platform as NodeJS.Platform) !== 'win32') return names
  try {
    const { stdout } = await execFileAsync(
      'reg.exe',
      ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Services\\BTHPORT\\Parameters\\Devices', '/s'],
      { windowsHide: true, encoding: 'utf8', timeout: 3000, maxBuffer: 1024 * 1024 },
    )
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

// ---------------------------------------------------------------------------
// Targeted SPP resolution (only the operator-selected address)
// ---------------------------------------------------------------------------

interface CachedChannel {
  channel: number
  expiresAt: number
}

const channelCache = new Map<string, CachedChannel>()

export function invalidateSppChannel(address: string): void {
  channelCache.delete(normalizeAddress(address) ?? '')
}

function cachedChannel(address: string, now: number): number | null {
  const compact = normalizeAddress(address)
  if (!compact) return null
  const cached = channelCache.get(compact)
  if (!cached) return null
  if (cached.expiresAt <= now) {
    channelCache.delete(compact)
    return null
  }
  return cached.channel
}

interface ParsedDeviceInfo {
  paired: boolean
  sppUuidCached: boolean
  name: string | null
}

function parseLinuxDeviceInfo(info: string): ParsedDeviceInfo {
  return {
    paired: /^\s*Paired:\s*yes\s*$/im.test(info),
    sppUuidCached: info.includes(SPP_SERVICE_UUID),
    name: info.match(/^\s*(?:Name|Alias):\s*(.+)$/im)?.[1]?.trim() ?? null,
  }
}

export interface TargetedSppDependencies {
  runCommand?: CommandRunner
  monotonicNow?: () => number
  sdpTimeoutMs?: number
  forceRefresh?: boolean
}

/**
 * Resolve the RFCOMM channel for one selected Bluetooth address. Runs at most
 * one `bluetoothctl info` and one `sdptool search`; a fresh cached channel is
 * preferred and the caller invalidates it after a failed open.
 */
export async function resolveLinuxSppChannel(
  address: string,
  dependencies: TargetedSppDependencies = {},
): Promise<{ path: string; channel: number; fromCache: boolean }> {
  const runCommand = dependencies.runCommand ?? defaultCommandRunner
  const now = dependencies.monotonicNow ?? (() => performance.now())
  const compact = normalizeAddress(address)
  if (!compact) {
    throw new BluetoothDiscoveryError(
      `蓝牙地址 "${address}" 格式无效。`,
      'BLUETOOTH_DEVICE_NOT_PAIRED',
    )
  }
  const canonical = formatBluetoothAddress(compact)

  if (!dependencies.forceRefresh) {
    const channel = cachedChannel(canonical, now())
    if (channel !== null) {
      return { path: linuxRfcommPath(canonical, channel), channel, fromCache: true }
    }
  }

  let info: ParsedDeviceInfo
  try {
    const { stdout } = await runCommand('bluetoothctl', ['info', canonical], {
      timeoutMs: 2000,
    })
    info = parseLinuxDeviceInfo(stdout)
  } catch (error) {
    if (isCommandMissing(error)) {
      throw new BluetoothDiscoveryError(
        '未找到 bluetoothctl。请安装 bluez 包后重试。',
        'BLUETOOTH_TOOL_MISSING',
      )
    }
    throw new BluetoothDiscoveryError(
      `读取蓝牙设备 ${canonical} 信息失败：${error instanceof Error ? error.message : String(error)}`,
      'BLUETOOTH_ADAPTER_UNAVAILABLE',
    )
  }

  if (!info.paired) {
    throw new BluetoothDiscoveryError(
      `蓝牙设备 ${canonical} 未配对。请先在系统蓝牙设置中完成配对。`,
      'BLUETOOTH_DEVICE_NOT_PAIRED',
    )
  }

  let channel: number | null = null
  try {
    const { stdout } = await runCommand(
      'sdptool',
      ['search', '--bdaddr', canonical, 'SP'],
      { timeoutMs: dependencies.sdpTimeoutMs ?? DEFAULT_SDP_TIMEOUT_MS },
    )
    const parsed = Number(stdout.match(/^\s*Channel:\s*(\d+)\s*$/im)?.[1])
    if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 30) channel = parsed
  } catch (error) {
    if (isCommandMissing(error)) {
      throw new BluetoothDiscoveryError(
        '未找到 sdptool。请安装 bluez-compat/BlueZ 工具包后重试，或改用其他连接方式。',
        'BLUETOOTH_TOOL_MISSING',
      )
    }
    if (isTimeout(error)) {
      throw new BluetoothDiscoveryError(
        `蓝牙设备 ${canonical} 无响应（SDP 超时）。请确认设备已上电并在可达范围内。`,
        'BLUETOOTH_DEVICE_OFFLINE',
      )
    }
    throw new BluetoothDiscoveryError(
      `查询蓝牙设备 ${canonical} 的 SPP 通道失败：${error instanceof Error ? error.message : String(error)}`,
      'BLUETOOTH_SPP_CHANNEL_UNRESOLVED',
    )
  }

  if (channel === null) {
    throw new BluetoothDiscoveryError(
      `蓝牙设备 ${canonical} 未提供 SPP 串口服务，或通道解析失败。请确认固件启用 SPP，或改用其他连接方式。`,
      'BLUETOOTH_SPP_CHANNEL_UNRESOLVED',
    )
  }

  channelCache.set(compact, { channel, expiresAt: now() + CHANNEL_CACHE_TTL_MS })
  return { path: linuxRfcommPath(canonical, channel), channel, fromCache: false }
}
