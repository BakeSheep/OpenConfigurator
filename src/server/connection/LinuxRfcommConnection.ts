import { EventEmitter } from 'node:events'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { parseLinuxRfcommPath } from './BluetoothConnection'
import type { SerialWritePriority, SerialWriteQueueTag } from './SerialConnection'

const OPEN_MARKER = '__OPENCONFIGURATOR_RFCOMM_OPEN__'
const DEFAULT_CLOSE_TIMEOUT_MS = 5000
const DEFAULT_MAX_QUEUED_BYTES = 256 * 1024
const DEFAULT_MAX_QUEUED_FRAMES = 512

// Node does not expose BlueZ's Profile1 file descriptor transport. This small
// bridge registers a temporary SPP client profile over the system D-Bus and
// pumps the descriptor BlueZ authorizes. No /dev/rfcomm node or root access is
// required; device selection, safety validation, and reconnect ownership stay
// in the Node process.
const RFCOMM_BRIDGE = String.raw`
import os
import select
import selectors
import sys
import threading

try:
    import dbus
    import dbus.service
    from dbus.mainloop.glib import DBusGMainLoop
    from gi.repository import GLib
except Exception as error:
    sys.stderr.write("BLUEZ_PYTHON_RUNTIME_MISSING: %s\n" % error)
    raise SystemExit(70)

address = sys.argv[1]
channel = int(sys.argv[2])
service_uuid = "00001101-0000-1000-8000-00805f9b34fb"
profile_path = "/io/github/bakesheep/OpenConfigurator/SPP"
main_loop = None

def stop_loop():
    if main_loop is not None:
        main_loop.quit()
    return False

# os.write may accept only part of a stream chunk under backpressure.
def write_all(fd, data):
    remaining = memoryview(data)
    while remaining:
        try:
            written = os.write(fd, remaining)
        except InterruptedError:
            continue
        except BlockingIOError:
            select.select([], [fd], [])
            continue
        if written <= 0:
            raise BrokenPipeError("write returned zero bytes")
        remaining = remaining[written:]

class Profile(dbus.service.Object):
    def __init__(self, bus):
        super().__init__(bus, profile_path)
        self.fd = None

    @dbus.service.method("org.bluez.Profile1", in_signature="", out_signature="")
    def Release(self):
        GLib.idle_add(stop_loop)

    @dbus.service.method("org.bluez.Profile1", in_signature="", out_signature="")
    def Cancel(self):
        GLib.idle_add(stop_loop)

    @dbus.service.method("org.bluez.Profile1", in_signature="oha{sv}", out_signature="")
    def NewConnection(self, _device, fd, _properties):
        self.fd = fd.take()
        sys.stderr.write("${OPEN_MARKER}\n")
        sys.stderr.flush()
        threading.Thread(target=self.pump, daemon=True).start()

    @dbus.service.method("org.bluez.Profile1", in_signature="o", out_signature="")
    def RequestDisconnection(self, _device):
        self.close_fd()

    def close_fd(self):
        if self.fd is None:
            return
        try:
            os.close(self.fd)
        except OSError:
            pass
        self.fd = None

    def pump(self):
        descriptor = self.fd
        selector = selectors.DefaultSelector()
        try:
            selector.register(descriptor, selectors.EVENT_READ)
            selector.register(sys.stdin.fileno(), selectors.EVENT_READ)
            while True:
                for key, _ in selector.select():
                    if key.fileobj == descriptor:
                        data = os.read(descriptor, 65536)
                        if not data:
                            return
                        write_all(sys.stdout.fileno(), data)
                    else:
                        data = os.read(sys.stdin.fileno(), 65536)
                        if not data:
                            return
                        write_all(descriptor, data)
        finally:
            selector.close()
            self.close_fd()
            GLib.idle_add(stop_loop)

def connect_error(error):
    sys.stderr.write("BLUEZ_CONNECT_ERROR: %s\n" % error)
    sys.stderr.flush()
    GLib.idle_add(stop_loop)

DBusGMainLoop(set_as_default=True)
bus = dbus.SystemBus()
objects = dbus.Interface(
    bus.get_object("org.bluez", "/"),
    "org.freedesktop.DBus.ObjectManager",
).GetManagedObjects()
device_path = None
for path, interfaces in objects.items():
    properties = interfaces.get("org.bluez.Device1")
    if properties and str(properties.get("Address", "")).upper() == address.upper():
        device_path = path
        break
if device_path is None:
    sys.stderr.write("BLUEZ_DEVICE_NOT_FOUND: %s\n" % address)
    raise SystemExit(69)

profile = Profile(bus)
manager = dbus.Interface(
    bus.get_object("org.bluez", "/org/bluez"),
    "org.bluez.ProfileManager1",
)
manager.RegisterProfile(profile_path, service_uuid, {
    "Name": "OpenConfigurator SPP",
    "Role": "client",
    "Channel": dbus.UInt16(channel),
    "RequireAuthentication": dbus.Boolean(True),
    "RequireAuthorization": dbus.Boolean(False),
    "AutoConnect": dbus.Boolean(False),
})
device = dbus.Interface(bus.get_object("org.bluez", device_path), "org.bluez.Device1")
main_loop = GLib.MainLoop()
device.ConnectProfile(
    service_uuid,
    reply_handler=lambda: None,
    error_handler=connect_error,
)
try:
    main_loop.run()
finally:
    profile.close_fd()
    try:
        manager.UnregisterProfile(profile_path)
    except Exception:
        pass
`

interface QueuedFrame {
  frame: Buffer
  priority: SerialWritePriority
  queueTag?: SerialWriteQueueTag
}

export interface LinuxRfcommConnectionOptions {
  processFactory?: (address: string, channel: number) => ChildProcessWithoutNullStreams
  closeTimeoutMs?: number
  maxQueuedBytes?: number
  maxQueuedFrames?: number
}

export class LinuxRfcommConnection extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null
  private _connected = false
  private intentionalClose = true
  private stderr = ''
  private waitingForDrain = false
  private writeQueue: QueuedFrame[] = []
  private queuedBytes = 0
  private connectSettled = false
  private resolveConnect: (() => void) | null = null
  private rejectConnect: ((error: Error) => void) | null = null
  private disconnectPromise: Promise<void> | null = null

  private readonly processFactory: NonNullable<LinuxRfcommConnectionOptions['processFactory']>
  private readonly closeTimeoutMs: number
  private readonly maxQueuedBytes: number
  private readonly maxQueuedFrames: number

  constructor(options: LinuxRfcommConnectionOptions = {}) {
    super()
    this.processFactory = options.processFactory ?? ((address, channel) => spawn(
      'python3',
      ['-u', '-c', RFCOMM_BRIDGE, address, String(channel)],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    ))
    this.closeTimeoutMs = options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS
    this.maxQueuedBytes = options.maxQueuedBytes ?? DEFAULT_MAX_QUEUED_BYTES
    this.maxQueuedFrames = options.maxQueuedFrames ?? DEFAULT_MAX_QUEUED_FRAMES
  }

  static supports(path: string): boolean {
    return parseLinuxRfcommPath(path) !== null
  }

  get connected(): boolean {
    return this._connected
  }

  async connect(path: string, _baudRate: number, timeoutMs = 20000): Promise<void> {
    if (this.child) throw new Error('Linux 蓝牙 RFCOMM 连接已在进行或已打开。')
    const target = parseLinuxRfcommPath(path)
    if (!target) throw new Error(`无效的 Linux 蓝牙 RFCOMM 地址：${path}`)

    this.intentionalClose = false
    this.connectSettled = false
    this.stderr = ''
    const child = this.processFactory(target.address, target.channel)
    this.child = child
    child.stdout.on('data', (data: Buffer) => {
      if (child === this.child && this._connected) this.emit('data', Buffer.from(data))
    })
    child.stderr.on('data', (data: Buffer) => this.handleStderr(child, data))
    child.stdin.on('drain', () => this.handleDrain(child))
    child.on('error', (error) => this.handleProcessFailure(child, error))
    child.on('exit', (code, signal) => {
      const details = this.stderr.trim()
      this.handleProcessFailure(
        child,
        new Error(details || `Linux 蓝牙 RFCOMM 进程已退出（${signal ?? code ?? 'unknown'}）。`),
      )
    })

    const connected = new Promise<void>((resolve, reject) => {
      this.resolveConnect = resolve
      this.rejectConnect = reject
    })
    const timer = setTimeout(() => {
      if (child !== this.child || this.connectSettled) return
      this.settleConnect(new Error(
        `连接蓝牙设备 ${target.address} 超时（${Math.round(timeoutMs / 1000)}s）。`
        + ' 请确认飞控蓝牙模块已上电且未被其他软件占用。',
      ))
      child.kill('SIGTERM')
    }, timeoutMs)
    try {
      await connected
    } finally {
      clearTimeout(timer)
    }
  }

  async disconnect(timeoutMs = this.closeTimeoutMs): Promise<void> {
    if (this.disconnectPromise) return this.disconnectPromise
    const child = this.child
    this.intentionalClose = true
    this._connected = false
    this.clearWriteQueue()
    if (!child) return
    if (!this.connectSettled) this.settleConnect(new Error('Linux 蓝牙 RFCOMM 连接已取消。'))

    const closed = new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve()
        return
      }
      child.once('exit', () => resolve())
      child.kill('SIGTERM')
    })
    const work = this.withTimeout(closed, timeoutMs).catch((error) => {
      child.kill('SIGKILL')
      throw error
    }).finally(() => {
      if (this.child === child) this.child = null
    })
    this.disconnectPromise = work
    try {
      await work
    } finally {
      this.disconnectPromise = null
    }
  }

  write(
    data: Buffer,
    priority: SerialWritePriority = 'normal',
    queueTag?: SerialWriteQueueTag,
  ): boolean {
    const child = this.child
    if (!child || !this._connected || child.stdin.destroyed) return false
    const frame = Buffer.from(data)
    if (this.waitingForDrain || this.writeQueue.length > 0) {
      return this.enqueueFrame(frame, priority, queueTag)
    }
    return this.writeFrame(child, frame)
  }

  cancelQueuedWrites(queueTag: SerialWriteQueueTag): number {
    let removed = 0
    this.writeQueue = this.writeQueue.filter((queued) => {
      if (queued.queueTag !== queueTag) return true
      this.queuedBytes -= queued.frame.length
      removed += 1
      return false
    })
    return removed
  }

  private handleStderr(child: ChildProcessWithoutNullStreams, data: Buffer): void {
    if (child !== this.child) return
    this.stderr += data.toString('utf8')
    const markerIndex = this.stderr.indexOf(OPEN_MARKER)
    if (markerIndex < 0 || this.connectSettled) return
    this.stderr = `${this.stderr.slice(0, markerIndex)}${this.stderr.slice(markerIndex + OPEN_MARKER.length)}`
    this._connected = true
    this.settleConnect()
    this.emit('connected')
  }

  private handleProcessFailure(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (child !== this.child) return
    const wasConnected = this._connected
    const failure = this.translateProcessError(error)
    this._connected = false
    this.clearWriteQueue()
    if (!this.connectSettled) this.settleConnect(failure)
    this.child = null
    if (wasConnected && !this.intentionalClose) this.emit('error', failure)
  }

  private translateProcessError(error: Error): Error {
    if (/ENOENT|python3|BLUEZ_PYTHON_RUNTIME_MISSING/i.test(error.message)) {
      return new Error('Linux 蓝牙直连需要 Python 3、dbus-python 与 PyGObject 运行时。')
    }
    if (/NotPermitted|AccessDenied|permission denied/i.test(error.message)) {
      return new Error('BlueZ 拒绝注册蓝牙 SPP 客户端。请检查系统蓝牙策略与当前用户权限。')
    }
    if (/br-connection-key-missing|AuthenticationFailed/i.test(error.message)) {
      return new Error('蓝牙配对密钥已失效。请在系统蓝牙设置中删除该设备，重新配对后再连接。')
    }
    if (/Connection refused|ConnectionAttemptFailed|br-connection-refused/i.test(error.message)) {
      return new Error('蓝牙设备拒绝 SPP 连接。请确认模块未被其他软件占用，必要时删除设备后重新配对。')
    }
    if (/BLUEZ_DEVICE_NOT_FOUND/i.test(error.message)) {
      return new Error('BlueZ 中未找到所选设备。请在系统蓝牙设置中重新配对后刷新。')
    }
    return error
  }

  private settleConnect(error?: Error): void {
    if (this.connectSettled) return
    this.connectSettled = true
    const resolve = this.resolveConnect
    const reject = this.rejectConnect
    this.resolveConnect = null
    this.rejectConnect = null
    if (error) reject?.(error)
    else resolve?.()
  }

  private writeFrame(child: ChildProcessWithoutNullStreams, frame: Buffer): boolean {
    try {
      const flowing = child.stdin.write(frame, (error) => {
        if (error) {
          if (!this.intentionalClose) this.emit('error', error)
          return
        }
        this.emit('dataSent', frame.length)
      })
      this.waitingForDrain = !flowing
      return true
    } catch (error) {
      if (!this.intentionalClose) this.emit('error', error instanceof Error ? error : new Error(String(error)))
      return false
    }
  }

  private enqueueFrame(
    frame: Buffer,
    priority: SerialWritePriority,
    queueTag?: SerialWriteQueueTag,
  ): boolean {
    // Keep the same safety ordering and eviction policy as SerialConnection.
    if (frame.length > this.maxQueuedBytes || this.maxQueuedFrames < 1) {
      this.emitWriteOverflow(frame.length, priority, priority, false)
      return false
    }

    while (
      this.writeQueue.length >= this.maxQueuedFrames
      || this.queuedBytes + frame.length > this.maxQueuedBytes
    ) {
      const incomingRank = this.priorityRank(priority)
      let victimIndex = -1
      for (let index = this.writeQueue.length - 1; index >= 0; index -= 1) {
        if (this.priorityRank(this.writeQueue[index].priority) < incomingRank) {
          victimIndex = index
          break
        }
      }
      if (victimIndex < 0) {
        this.emitWriteOverflow(frame.length, priority, priority, false)
        return false
      }
      const [victim] = this.writeQueue.splice(victimIndex, 1)
      this.queuedBytes -= victim.frame.length
      this.emitWriteOverflow(victim.frame.length, victim.priority, priority, true)
    }

    const incomingRank = this.priorityRank(priority)
    const insertAt = this.writeQueue.findIndex(
      (queued) => this.priorityRank(queued.priority) < incomingRank,
    )
    const queued = { frame, priority, ...(queueTag ? { queueTag } : {}) }
    if (insertAt < 0) this.writeQueue.push(queued)
    else this.writeQueue.splice(insertAt, 0, queued)
    this.queuedBytes += frame.length
    return true
  }

  private handleDrain(child: ChildProcessWithoutNullStreams): void {
    if (child !== this.child) return
    this.waitingForDrain = false
    while (!this.waitingForDrain && this.writeQueue.length > 0 && this._connected) {
      const queued = this.writeQueue.shift()!
      this.queuedBytes -= queued.frame.length
      this.writeFrame(child, queued.frame)
    }
  }

  private clearWriteQueue(): void {
    this.waitingForDrain = false
    this.writeQueue = []
    this.queuedBytes = 0
  }

  private priorityRank(priority: SerialWritePriority): number {
    if (priority === 'critical') return 2
    if (priority === 'high') return 1
    return 0
  }

  private emitWriteOverflow(
    droppedBytes: number,
    droppedPriority: SerialWritePriority,
    incomingPriority: SerialWritePriority,
    evicted: boolean,
  ): void {
    this.emit('overflow', {
      droppedBytes,
      queuedBytes: this.queuedBytes,
      queuedFrames: this.writeQueue.length,
      maxQueuedBytes: this.maxQueuedBytes,
      maxQueuedFrames: this.maxQueuedFrames,
      droppedPriority,
      incomingPriority,
      evicted,
    })
  }

  private withTimeout(promise: Promise<void>, timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(
        `关闭 Linux 蓝牙 RFCOMM 连接超时（${Math.round(timeoutMs / 1000)}s）。`,
      )), timeoutMs)
      promise.then(
        () => { clearTimeout(timer); resolve() },
        (error) => { clearTimeout(timer); reject(error) },
      )
    })
  }
}
