import assert from 'node:assert/strict'
import test from 'node:test'
import {
  BluetoothDiscoveryError,
  discoverBluetoothQuick,
  invalidateSppChannel,
  parseLinuxRfcommPath,
  parseLinuxSppPath,
  resolveLinuxSppChannel,
  type CommandRunner,
} from './bluetoothDiscovery'

const ADDRESS = '08:FA:D1:17:69:49'

interface RunnerCall {
  file: string
  args: readonly string[]
}

function recordingRunner(
  handle: (call: RunnerCall) => string | Error | { stdout: string; stderr?: string },
): { runner: CommandRunner; calls: RunnerCall[] } {
  const calls: RunnerCall[] = []
  const runner: CommandRunner = async (file, args) => {
    calls.push({ file, args: [...args] })
    const result = handle({ file, args: [...args] })
    if (result instanceof Error) throw result
    if (typeof result === 'string') return { stdout: result, stderr: '' }
    return { stdout: result.stdout, stderr: result.stderr ?? '' }
  }
  return { runner, calls }
}

const pairedListing = (name = 'MicoAir743v2-94296') =>
  `Device ${ADDRESS} ${name}\nDevice 00:11:22:33:44:55 Some Headset\n`

const deviceInfo = (options: { paired?: boolean; spp?: boolean } = {}) =>
  [
    `Name: MicoAir743v2-94296`,
    `Alias: MicoAir743v2-94296`,
    `Paired: ${options.paired ?? true ? 'yes' : 'no'}`,
    ...(options.spp ?? true
      ? ['UUID: Serial Port (00001101-0000-1000-8000-00805f9b34fb)']
      : []),
  ].join('\n')

test('quick scan reads paired list and cached info without ever contacting devices', async () => {
  const { runner, calls } = recordingRunner((call) => {
    if (call.args[0] === 'devices') return pairedListing()
    if (call.args[0] === 'info') return deviceInfo()
    throw new Error(`unexpected command: ${call.file} ${call.args.join(' ')}`)
  })

  const devices = await discoverBluetoothQuick({
    platform: 'linux',
    runCommand: runner,
    monotonicNow: () => 0,
  })

  assert.equal(devices.length, 2)
  const micoair = devices[0]
  assert.equal(micoair.transport, 'bluetooth-spp')
  assert.equal(micoair.bluetoothAddress, ADDRESS.toUpperCase())
  assert.equal(micoair.availability, 'paired')
  assert.equal(micoair.requiresDeepResolution, true)
  assert.equal(micoair.bluetoothChannel, undefined)
  assert.equal(micoair.bluetoothServiceClassId, '0x1101')
  assert.equal(micoair.recommended, true)
  assert.ok(micoair.deviceId?.startsWith('bt-spp:'))

  const commands = calls.map((call) => `${call.file} ${call.args[0]}`)
  assert.ok(commands.every((command) => !command.includes('sdptool')))
  assert.equal(calls.filter((call) => call.file === 'sdptool').length, 0)
})

test('offline paired device stays visible; unknown SPP cache never fabricates a channel', async () => {
  const { runner } = recordingRunner((call) => {
    if (call.args[0] === 'devices') return pairedListing('MicoAir743v2-94296')
    if (call.args[0] === 'info') return deviceInfo({ spp: false })
    throw new Error('unexpected')
  })

  const devices = await discoverBluetoothQuick({
    platform: 'linux',
    runCommand: runner,
    monotonicNow: () => 0,
  })

  const offline = devices.find((device) => device.bluetoothAddress === ADDRESS.toUpperCase())
  assert.ok(offline, 'paired device must not disappear from quick list')
  assert.equal(offline.availability, 'paired')
  assert.equal(offline.bluetoothServiceClassId, undefined)
  assert.equal(offline.bluetoothChannel, undefined)
})

test('quick scan keeps the device when per-device info times out', async () => {
  const { runner, calls } = recordingRunner((call) => {
    if (call.args[0] === 'devices') return pairedListing()
    if (call.args[0] === 'info') {
      const error = new Error('Command timed out') as NodeJS.ErrnoException
      error.code = 'ETIMEDOUT'
      throw error
    }
    throw new Error('unexpected')
  })

  const devices = await discoverBluetoothQuick({
    platform: 'linux',
    runCommand: runner,
    monotonicNow: () => 0,
  })

  assert.equal(devices.length, 2)
  const micoair = devices[0]
  assert.equal(micoair.displayName, 'MicoAir743v2-94296')
  assert.equal(micoair.requiresDeepResolution, true)
  assert.ok(calls.some((call) => call.file === 'bluetoothctl'))
})

test('missing bluetoothctl and unavailable adapter map to stable error codes', async () => {
  const missing = recordingRunner(() => {
    const error = new Error('spawn bluetoothctl ENOENT') as NodeJS.ErrnoException
    error.code = 'ENOENT'
    throw error
  })
  await assert.rejects(
    discoverBluetoothQuick({ platform: 'linux', runCommand: missing.runner, monotonicNow: () => 0 }),
    (error: unknown) =>
      error instanceof BluetoothDiscoveryError
      && error.code === 'BLUETOOTH_TOOL_MISSING',
  )

  const offline = recordingRunner(() => 'There is no default controller available')
  await assert.rejects(
    discoverBluetoothQuick({ platform: 'linux', runCommand: offline.runner, monotonicNow: () => 0 }),
    (error: unknown) =>
      error instanceof BluetoothDiscoveryError
      && error.code === 'BLUETOOTH_ADAPTER_UNAVAILABLE',
  )
})

test('manual rfcomm nodes merge into quick candidates without addresses twice', async () => {
  const { runner } = recordingRunner((call) => {
    if (call.args[0] === 'devices') return pairedListing()
    if (call.args[0] === 'info') return deviceInfo()
    throw new Error('unexpected')
  })

  const devices = await discoverBluetoothQuick({
    platform: 'linux',
    runCommand: runner,
    monotonicNow: () => 0,
    listPorts: async () => [{ path: '/dev/rfcomm0', bluetoothAddress: ADDRESS }],
  })

  const addresses = devices.map((device) => device.bluetoothAddress)
  assert.equal(addresses.filter((address) => address === ADDRESS.toUpperCase()).length, 1)
})

test('targeted resolution runs SDP only for the selected address and caches the channel', async () => {
  const { runner, calls } = recordingRunner((call) => {
    if (call.args[0] === 'info') return deviceInfo()
    if (call.file === 'sdptool') {
      assert.deepEqual(call.args.slice(0, 3), ['search', '--bdaddr', ADDRESS])
      return 'Service Name: Serial Port\nChannel: 3\n'
    }
    throw new Error('unexpected')
  })
  const monotonicNow = (() => {
    let now = 0
    return () => (now += 100)
  })()

  invalidateSppChannel(ADDRESS)
  const first = await resolveLinuxSppChannel(ADDRESS, { runCommand: runner, monotonicNow })
  assert.equal(first.path, `bt-rfcomm://${ADDRESS.toLowerCase().replace(/:/g, '')}/3`)
  assert.equal(first.channel, 3)
  assert.equal(first.fromCache, false)

  const second = await resolveLinuxSppChannel(ADDRESS, { runCommand: runner, monotonicNow })
  assert.equal(second.fromCache, true)
  assert.equal(
    calls.filter((call) => call.file === 'sdptool').length,
    1,
    'fresh cache must avoid a second SDP query',
  )

  invalidateSppChannel(ADDRESS)
  const third = await resolveLinuxSppChannel(ADDRESS, { runCommand: runner, monotonicNow, forceRefresh: true })
  assert.equal(third.fromCache, false)
})

test('targeted resolution failure modes map to stable codes', async () => {
  const info = deviceInfo()
  const notPaired = recordingRunner((call) => {
    if (call.args[0] === 'info') return deviceInfo({ paired: false })
    throw new Error('unexpected')
  })
  invalidateSppChannel(ADDRESS)
  await assert.rejects(
    resolveLinuxSppChannel(ADDRESS, { runCommand: notPaired.runner, monotonicNow: () => 0 }),
    (error: unknown) =>
      error instanceof BluetoothDiscoveryError && error.code === 'BLUETOOTH_DEVICE_NOT_PAIRED',
  )

  const sdpMissing = recordingRunner((call) => {
    if (call.args[0] === 'info') return info
    const error = new Error('spawn sdptool ENOENT') as NodeJS.ErrnoException
    error.code = 'ENOENT'
    throw error
  })
  invalidateSppChannel(ADDRESS)
  await assert.rejects(
    resolveLinuxSppChannel(ADDRESS, { runCommand: sdpMissing.runner, monotonicNow: () => 0 }),
    (error: unknown) =>
      error instanceof BluetoothDiscoveryError && error.code === 'BLUETOOTH_TOOL_MISSING',
  )

  const offline = recordingRunner((call) => {
    if (call.args[0] === 'info') return info
    const error = new Error('Command failed: sdptool') as NodeJS.ErrnoException & {
      killed: boolean
      signal: string
    }
    error.killed = true
    error.signal = 'SIGTERM'
    throw error
  })
  invalidateSppChannel(ADDRESS)
  await assert.rejects(
    resolveLinuxSppChannel(ADDRESS, { runCommand: offline.runner, monotonicNow: () => 0 }),
    (error: unknown) =>
      error instanceof BluetoothDiscoveryError && error.code === 'BLUETOOTH_DEVICE_OFFLINE',
  )

  const noChannel = recordingRunner((call) => {
    if (call.args[0] === 'info') return info
    if (call.file === 'sdptool') return 'Service Name: something else\n'
    throw new Error('unexpected')
  })
  invalidateSppChannel(ADDRESS)
  await assert.rejects(
    resolveLinuxSppChannel(ADDRESS, { runCommand: noChannel.runner, monotonicNow: () => 0 }),
    (error: unknown) =>
      error instanceof BluetoothDiscoveryError
      && error.code === 'BLUETOOTH_SPP_CHANNEL_UNRESOLVED',
  )
})

test('bt-spp pseudo paths and bt-rfcomm paths parse to addresses', () => {
  assert.equal(parseLinuxSppPath('bt-spp://08fad1176949'), ADDRESS)
  assert.equal(parseLinuxSppPath('bt-rfcomm://08fad1176949/1'), null)
  assert.deepEqual(parseLinuxRfcommPath('bt-rfcomm://08fad1176949/3'), {
    address: ADDRESS,
    channel: 3,
  })
  assert.equal(parseLinuxRfcommPath('bt-rfcomm://08fad1176949/0'), null)
})

test('Windows quick scan keeps outgoing SPP COM ports and drops incoming ones', async () => {
  const outgoing = {
    path: 'COM7',
    manufacturer: 'Microsoft Bluetooth',
    pnpId: 'BTHENUM\\{00001101-0000-1000-8000-00805F9B34FB}_VID&0001_PID&000A\\7&ABC&0&001122334455_C',
  }
  const incoming = {
    path: 'COM8',
    manufacturer: 'Microsoft Bluetooth',
    pnpId: 'BTHENUM\\DEV_001122334455\\7&ABC&0&001122334455_C\\_LOCALMFG&0000',
  }
  const devices = await discoverBluetoothQuick({
    platform: 'win32',
    listPorts: async () => [outgoing, incoming],
    windowsDeviceNames: async () => new Map(),
  })

  assert.equal(devices.length, 1)
  assert.equal(devices[0].path, 'COM7')
  assert.equal(devices[0].transport, 'bluetooth-spp')
  assert.equal(devices[0].bluetoothAddress, '001122334455')
  assert.equal(devices[0].availability, 'available')
})
