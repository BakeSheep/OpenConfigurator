# Windows / Linux 飞控连接兼容性优化计划

## 1. 背景与结论

OpenConfigurator 当前使用 React 前端、REST/单一 WebSocket 和本机 Node.js 服务。Node.js 服务拥有串口、Bluetooth SPP、MAVLink、控制者租约、链路生命周期与 ESC 会话。这个边界必须保留：浏览器不直接解析 MAVLink，不直接取得安全关键写操作的最终授权，也不因为界面显示“已连接”就绕过 `transportOpen → vehicleReady → controller lease`。

当前 Windows 路径已经具备虚拟 COM 过滤、Bluetooth incoming/outgoing 端口区分、硬件身份重匹配、背压、心跳确认与蓝牙重连。主要差距集中在 Linux：

- 连接弹窗打开时同时等待 USB 和完整 BlueZ/SPP 扫描，离线蓝牙设备可把 USB 发现拖慢数秒。
- Linux 串口列表包含大量 `/dev/ttyS*`，缺少 `/dev/serial/by-id`、USB serial number 等稳定身份和排序依据。
- Linux SPP 扫描会为每个已配对设备串行执行 `sdptool`；设备离线或不响应时既造成等待，又从候选列表消失。
- 当前只支持经典蓝牙 SPP/RFCOMM，没有 MicoAir Configurator 所使用的 BLE GATT 路径。
- 普通 USB 掉线不会自动恢复；只有明确的飞控重启窗口会重新打开串口。
- 桌面打包只覆盖 Windows x64，并显式排除 Linux `serialport` native prebuild。

本计划优先修复“发现快、选得准、断线可恢复、错误可行动”，再增加 Linux BLE GATT 和 Linux 桌面发行。不会直接复制参考站的前端 MAVLink 架构，也不会用 VID/PID 猜测多个相同设备。

## 2. 目标与非目标

### 2.1 目标

1. USB 设备发现不再等待 Bluetooth 扫描，Linux 首屏快速显示有意义的候选设备。
2. 串口预设在 Windows COM 号变化、Linux tty 编号变化和飞控重启后能够基于稳定身份安全恢复。
3. Bluetooth 快速发现只读取缓存身份；只对用户选中的设备执行可能阻塞的 SDP/GATT 连接。
4. Linux 支持 MicoAir BLE GATT profile，同时保留通用 SPP/RFCOMM 路径。
5. 普通 USB/SPP 物理掉线进入有界重连，重连后重新建立 parser、目标、心跳与安全代次。
6. Windows 现有行为不退化；Windows Bluetooth incoming COM 继续被排除。
7. 提供可安装、可诊断的 Linux 桌面构建或清晰的本地服务安装路径。
8. 建立 Windows/Linux 自动化测试、SITL 和拆桨 HIL 验证矩阵。

### 2.2 非目标

- 不把 MAVLink codec、目标选择、controller lease 或安全关键写授权迁移到浏览器。
- 不允许页面把任意路径直接提升为受信任的串口设备。
- 不把 `COMMAND_ACK`、native port open 或 BLE GATT connected 当作飞控物理就绪。
- 不承诺 macOS、Android、iOS 或 Firefox/Safari 的连接支持；这些需要独立产品决策。
- 不在本计划中扩展 ESC 固件烧录、启动音或其他 ESC 能力。
- 不自动修改用户的系统组、udev、Bluetooth 配对或操作系统安全设置。

## 3. 目标架构

```text
ConnectDialog / connectionStore
          │
          ├─ GET /api/connections/scan?kind=serial&scope=recommended
          ├─ GET /api/connections/scan?kind=serial&scope=all
          └─ GET /api/connections/scan?kind=bluetooth&scope=quick
                         │
                         ▼
              ConnectionDiscoveryService
               ├─ SerialDiscovery
               ├─ WindowsSppDiscovery
               ├─ BluezQuickDiscovery
               └─ discovery cache / cancellation

POST /api/connections/connect
          │
          ▼
   ConnectionManager
     ├─ SerialWorker ── SerialConnection
     └─ BluetoothWorker
          ├─ SerialConnection (Windows COM / /dev/rfcomm)
          ├─ LinuxRfcommConnection
          └─ LinuxBleGattConnection
                         │
                         ▼
        transportOpen → MAVLink heartbeat → vehicleReady
        → recognized target/capability → controller lease
```

### 3.1 架构原则

- `ConnectionDiscoveryService` 只发现、分类和解析设备，不拥有活动连接。
- `ConnectionManager` 继续是活动连接、物理代次和状态发布的唯一入口。
- 每次底层 transport 重新打开都创建新的 transport generation；MAVLink codec、序列号、target、缓存遥测和安全确认必须随代次重置。
- 发现结果携带稳定身份证据，连接时由服务端重新解析并核对，不能只相信浏览器提交的显示路径。
- 快速发现不得执行会主动连接远端设备的操作。`sdptool`、GATT service discovery 等慢操作只在连接用户明确选中的设备时发生。
- 设备身份不唯一时 fail closed，并要求用户重新选择；不得回退到“当前只有一个端口”。

## 4. 数据合同与 API 变更

### 4.1 扩展共享设备类型

在 `src/shared/types.ts` 中用可判别类型替换仅依赖 `path` 的扁平 `PortInfo`，或在兼容期先增加以下字段：

```ts
type ConnectionTransport =
  | 'serial'
  | 'bluetooth-spp'
  | 'bluetooth-ble'

interface PortInfo {
  deviceId: string
  transport: ConnectionTransport
  path: string
  stablePath?: string
  displayName?: string
  manufacturer?: string
  vendorId?: string
  productId?: string
  serialNumber?: string
  usbLocationId?: string
  pnpId?: string
  bluetoothAddress?: string
  bluetoothChannel?: number
  bluetoothServiceClassId?: string
  availability?: 'available' | 'paired' | 'offline' | 'unknown'
  recommended?: boolean
  requiresDeepResolution?: boolean
}
```

要求：

- `deviceId` 是当前服务进程生成的 opaque identifier，连接请求优先携带它。
- `path` 仍用于显示、诊断和兼容旧预设，但连接前必须由服务端重新核对身份。
- Linux 优先把 `/dev/serial/by-id` 放入 `stablePath`，`path` 可保留当前真实 tty。
- Windows 保留 `pnpId`、Bluetooth address 和 service UUID 匹配规则。
- BLE 候选不得伪装成 serial/SPP；transport 必须显式区分。

### 4.2 扫描 API

将当前一次性扫描全部 transport 的接口改为：

```http
GET /api/connections/scan?kind=serial&scope=recommended
GET /api/connections/scan?kind=serial&scope=all
GET /api/connections/scan?kind=bluetooth&scope=quick
```

响应：

```ts
interface ConnectionScanResponse {
  success: true
  data: {
    kind: 'serial' | 'bluetooth'
    scope: 'recommended' | 'all' | 'quick'
    scanGeneration: number
    cached: boolean
    devices: PortInfo[]
    warnings: ConnectionDiscoveryWarning[]
  }
}
```

规则：

- `serial/recommended` 不启动任何 Bluetooth 命令。
- `bluetooth/quick` 不运行 `sdptool search`，只读取系统已知的配对、UUID、名称和地址。
- `scope=all` 只用于串口“显示全部设备”，允许出现 `ttyS*`，但仍要稳定排序。
- 扫描请求设置服务端截止时间；浏览器关闭弹窗或切换类型时取消前端请求并忽略旧 generation。
- 首版可以继续使用普通 REST，不为扫描另开 WebSocket。只有在发现结果需要持续流式更新时才另立 RFC。

### 4.3 连接请求

`ConnectionConfig` 增加 `deviceId`、`transport` 和稳定身份字段。服务端连接前：

1. 根据 `deviceId` 读取最近扫描候选。
2. 重新执行目标 transport 的轻量解析。
3. 对比 address、serialNumber、VID/PID、stablePath 或 PnP identity。
4. 多个候选同时匹配时返回 `IDENTITY_AMBIGUOUS`。
5. 候选消失时返回 `DEVICE_NOT_FOUND`，不连接到同一路径上身份不同的新设备。

保留直接路径模式仅供明确的高级/开发入口，并继续通过运行时校验和服务端 allowlist 限制到平台串口设备节点。

### 4.4 错误分类

增加稳定、可本地化的错误码，禁止 UI 依赖英文原生错误字符串：

| 错误码 | 含义 | UI 下一步 |
|---|---|---|
| `SERIAL_PERMISSION_DENIED` | Linux 设备权限不足 | 显示设备 owner/group 和重新登录提示 |
| `SERIAL_BUSY` | 端口被其他程序占用 | 关闭 QGC/终端/其他实例后重试 |
| `SERIAL_NOT_FOUND` | 设备已拔出或路径变化 | 重新扫描当前类型 |
| `SERIAL_OPEN_TIMEOUT` | 驱动打开未完成 | 检查设备、线缆后重试 |
| `IDENTITY_AMBIGUOUS` | 多个设备共享同一身份 | 要求用户重新选择，不自动猜测 |
| `BLUETOOTH_ADAPTER_UNAVAILABLE` | BlueZ/适配器不可用 | 打开适配器或启动 Bluetooth 服务 |
| `BLUETOOTH_TOOL_MISSING` | SPP 运行时缺失 | 显示需要安装的系统包 |
| `BLUETOOTH_DEVICE_NOT_PAIRED` | SPP 设备未配对 | 在系统设置完成配对 |
| `BLUETOOTH_DEVICE_OFFLINE` | 已配对但设备当前不可达 | 给设备上电后重试 |
| `BLUETOOTH_SPP_CHANNEL_UNRESOLVED` | 选中设备的 SDP 失败 | 检查 SPP 服务或改用 BLE |
| `BLUETOOTH_GATT_PROFILE_UNSUPPORTED` | GATT 服务/特征不匹配 | 显示支持的设备范围 |
| `BLUEZ_DBUS_RUNTIME_MISSING` | Linux GATT/RFCOMM D-Bus 依赖缺失 | 安装依赖后重启应用 |
| `VEHICLE_HEARTBEAT_TIMEOUT` | transport 已开但没有合法飞控心跳 | 检查波特率/设备类型/固件 |

## 5. 分阶段实施

### Phase 0：基线、可观测性与回归护栏

### 工作项

- 为串口扫描、Bluetooth quick scan、deep resolution、native open、首个合法心跳记录 monotonic duration。
- 日志只记录 transport、错误码、耗时和脱敏后的设备标识；不记录完整遥测、授权令牌或用户文件路径。
- 为扫描结果增加 generation，避免旧请求覆盖新列表。
- 固化当前 Windows incoming/outgoing COM、Bluetooth address、VID/PID 和 fail-closed 测试。
- 将本次 Linux 实测基线记录到测试/发布说明：串口约 0.56 秒；完整 Bluetooth SPP 扫描约 7.5 秒且离线 MicoAir 候选丢失。该数字是环境基线，不作为跨机器固定门槛。

### 涉及文件

- `src/server/connection/ConnectionManager.ts`
- `src/server/connection/BluetoothConnection.ts`
- `src/server/index.ts`
- `src/shared/types.ts`
- `src/web/stores/connectionStore.ts`
- 对应 `*.test.ts`

### 退出条件

- 能分别观察 serial scan、Bluetooth quick scan 和 selected-device resolution 的耗时与错误码。
- Windows 现有连接测试无退化。

### Phase 1：拆分扫描并优化 Linux USB 设备列表

### 服务端

1. 新增 `ConnectionDiscoveryService`，拆出串口与 Bluetooth discovery。
2. `ConnectionManager.scanPorts()` 不再是 UI 扫描入口；逐步迁移为按 kind 调用。
3. Linux 串口发现：
   - 读取 `SerialPort.list()` 的 `serialNumber`、VID/PID、manufacturer、pnpId/location 信息。
   - 读取 `/dev/serial/by-id` 并解析到当前 tty，优先以 by-id 作为 stable path。
   - 推荐列表包含 `ttyACM*`、`ttyUSB*`、`rfcomm*` 和具有 USB/PnP 身份的端口。
   - `/dev/ttyS*`、无身份平台 UART 默认放入 `scope=all`。
   - 对同一真实设备去重，避免 by-id 和 tty 同时出现两行。
4. Windows 串口继续显示 COM path，并保留 PnP metadata；不改变 incoming Bluetooth 排除逻辑。

### 前端

1. 打开弹窗只请求当前默认 tab 的扫描。
2. 切换 USB/Bluetooth 时才请求对应类型；不复用另一类型的 loading 状态。
3. USB 推荐列表完成后立即可操作；“显示全部端口”按需请求 `scope=all`。
4. 显示名称采用：友好名 → manufacturer + serial suffix → stable path → platform path。
5. 列表只有一个高置信候选时允许默认选中，但不自动发起连接。
6. 扫描失败不清空上一次仍然有效的候选；标记为可能过期并提供一次重试。

### 测试

- Bluetooth discovery 永久挂起时，serial endpoint 仍独立完成。
- 32 个 `ttyS*` 不进入 recommended 列表。
- `/dev/serial/by-id` 与 `/dev/ttyACM0` 被合并为一个设备。
- 两个相同 VID/PID、不同 serialNumber 的设备保持可区分。
- 旧扫描 generation 不能覆盖新扫描。
- Playwright 覆盖弹窗打开、tab 切换、全部端口、扫描失败和键盘操作。

### 退出条件

- Linux USB 推荐结果 P95 小于 1 秒。
- Bluetooth 不可用或离线时，USB 连接入口没有额外等待。
- Windows COM 列表、预设与连接行为保持不变。

### Phase 2：重构 Linux SPP 快速发现与定向解析

### 快速发现

- `bluetoothctl devices Paired` 或 BlueZ ObjectManager 只读取已配对设备。
- 使用缓存 `UUID` 判断是否可能支持 SPP，但即使设备离线也保留候选，标记 `availability`。
- 不在列表扫描阶段调用 `sdptool`。
- 对 Bluetooth quick result 设置短 TTL；适配器/配对状态变化时失效。

### 连接选中设备

1. 用户提交带 Bluetooth address 的候选。
2. 后端只对这个地址进行 targeted info/SDP resolution。
3. 如果已有近期有效 channel cache，先尝试缓存；连接失败后只刷新一次 SDP。
4. channel 解析成功后生成 `bt-rfcomm://ADDRESS/channel`，交给现有 `LinuxRfcommConnection`。
5. `BluetoothWorker` 保留现有有界重连、心跳确认、terminal reason 与 teardown 序列化。
6. 配对、适配器和系统依赖错误映射为稳定错误码。

### 取消与超时

- quick scan 截止时间不超过 1.5 秒；超时可返回已获得的候选和 warning。
- selected-device SDP 可以使用较长截止时间，但必须可由用户取消。
- 取消后必须终止子进程、清理 provisional link，并且不触发误导性的自动重连。

### 测试

- 已配对但离线的 MicoAir 仍出现在 quick list。
- quick scan 绝不调用 SDP runner。
- 只对选中地址执行 SDP。
- 多个 SPP 设备不会因 service-only identity 误选。
- SDP 超时、进程退出、适配器关闭和配对删除均有确定错误码。
- 取消连接能在 300ms 内进入取消状态，随后迟到回调不改变连接状态。

### 退出条件

- Linux Bluetooth quick list P95 小于 1.5 秒。
- 离线设备不会消失；连接时给出可行动错误。
- USB 扫描完全不启动 `bluetoothctl` 或 `sdptool`。

### Phase 3：增加 Linux BLE GATT transport

### 支持范围

首版只声明以下已知 profile，其他 GATT 设备保持不支持：

| Profile | Service | 写入特征 | 通知特征 |
|---|---|---|---|
| MicoAir | `fca10001-7ace-46b3-8e5d-32f6b4c8a1e9` | `fca10002-7ace-46b3-8e5d-32f6b4c8a1e9` | `fca10003-7ace-46b3-8e5d-32f6b4c8a1e9` |
| FFF0 单特征 | `0000fff0-0000-1000-8000-00805f9b34fb` | `FFF1` | `FFF1` |
| FFF0 分离特征 | 同上 | `FFF3` | `FFF2` |

这些 UUID 来自参考实现，需要在合入前以设备厂商文档或受控抓包/HIL 证据确认，并记录到 `docs/FLIGHT-CONTROLLER-COMPATIBILITY.md`。没有证据时标记 experimental。

### 服务端组件

- 新增 `LinuxBleGattConnection.ts`，实现现有 managed link 所需的 `connect`、`disconnect`、`write`、`data`、`error`、`disconnected` 和背压语义。
- BlueZ D-Bus bridge 负责：
  - 按 address 连接选中设备；
  - discover service/characteristics；
  - 选择 write-without-response 或 write-with-response；
  - 启动 notification/indication；
  - 将 notification 原样送入 MAVLink codec；
  - 在断开时使旧 characteristic 句柄失效。
- 默认以保守 ATT payload 分片，首版 Linux 使用 20 bytes；确认 MTU 后才允许提高。
- 写入沿用有界队列和 priority，不允许普通遥测阻塞 critical stop/disarm traffic。
- BLE transport open 后仍需经过合法 autopilot HEARTBEAT 才能 `vehicleReady=true`。

### 运行时选择

- `BluetoothWorker` 按候选的显式 `transport` 选择 SPP 或 BLE；不得在 SPP 失败后静默切换 BLE。
- 如果同一物理设备同时暴露 SPP 和 BLE，UI 显示两个明确选项或一个设备下的两个连接方式。
- 首版保留用户选择；后续只有 HIL 数据证明某路径明显更优时才增加“推荐”标记。

### 平台边界

- Linux 首版使用 BlueZ D-Bus。
- Windows 继续使用已验证的 SPP 虚拟 COM。Windows BLE 需要独立 RFC，不能通过浏览器 relay 绕过后端连接所有权。
- Linux D-Bus 实现优先复用已审查的进程隔离模式；若引入 Node D-Bus 依赖，必须先完成维护性、native binding、Electron 打包和安全审计。

### 测试

- profile/characteristic 选择、notification、分片写、partial write、backpressure。
- GATT disconnect、service missing、特征属性错误、notification 启动失败。
- 用户取消和设备掉线后的 late notification 必须被 generation 丢弃。
- transport open 无 HEARTBEAT 时不能开放任何飞控写操作。
- BLE 上的参数同步、日志传输和 PX4/ArduPilot telemetry 速率需要单独测量；受限链路不能沿用 USB 并发配置。

### 退出条件

- MicoAir BLE 拆桨 HIL 能稳定完成连接、参数读取、基础设置回读和连续遥测。
- 重复连接/断开 50 次无句柄、listener、timer 或 D-Bus profile 泄漏。
- 未识别 GATT profile 明确拒绝，不进入假连接状态。

### Phase 4：普通串口自动重连与统一恢复语义

### SerialWorker

新增与 `BluetoothWorker` 对称的 `SerialWorker`，负责：

- 保存连接时确认过的稳定身份。
- 监听 native close/error，立即降低 `vehicleReady` 和 `transportOpen`。
- 有界重试重新发现同一设备；路径变化时更新 resolved path。
- 每次 reopen 发布新的 transport generation，并等待新 HEARTBEAT。
- 显式 disconnect、设备身份冲突、权限错误和 deterministic resolution error 立即终止重连。

### 重连策略

建议默认值：

| 场景 | 尝试 | 间隔/窗口 |
|---|---:|---|
| 普通 USB 掉线 | 5 次 | 1s、2s、3s、5s、5s |
| 已确认的飞控重启 | 至少 12 次 | 在约 45s grace 内持续重试 |
| Bluetooth SPP | 保留当前 10 次指数退避 | 最大间隔 15s |
| BLE GATT | 首版 5 次 | 每次重新 discover characteristics |

规则：

- 普通掉线和预期重启共享一个 worker 状态机，避免两套 timer 竞争。
- VID/PID 只能缩小候选范围；有多个同型号设备时必须结合 serialNumber、stablePath、address 或用户选择。
- 重连成功只表示 transport 恢复。必须收到新代次的合法 autopilot HEARTBEAT 后才恢复 `vehicleReady`。
- 不自动恢复 target-bound destructive confirmations、RC override enablement、ESC safety confirmation 或旧 controller lease。
- 活动 ESC raw session 发生物理掉线时终止，不自动恢复或续写。

### UI

- 显示 `reconnecting (attempt/max)`、目标设备和上次错误。
- 提供立即取消重连/断开。
- 重连结束后区分“链路已恢复”和“飞控已重新识别”。
- identity ambiguous 或 permission denied 时直接进入 error，显示一个主要恢复动作。

### 测试

- `/dev/ttyACM0 → /dev/ttyACM1`、COM7 → COM9 的身份恢复。
- 两个相同 VID/PID 设备并存时拒绝猜测。
- 预期重启与普通掉线不会安装重复 timer。
- 显式 disconnect 可立即取消 opening/discovery/backoff。
- reconnect 期间旧 parser 数据、旧 heartbeat 和旧确认不能泄漏到新代次。
- raw ESC session 掉线后保持终止。

### 退出条件

- 设备重新出现后 8 秒内恢复 transport，随后以新 HEARTBEAT 恢复 vehicle readiness。
- 所有安全状态随物理代次正确失效。

### Phase 5：Linux 发行、权限诊断与用户文档

### 打包

- 增加 `dist:linux` 和 `dist:linux:dir`，首版目标为 AppImage；如提供 deb，则明确系统依赖。
- Linux 构建必须包含并解包当前架构的 `@serialport/bindings-cpp/prebuilds/linux-*`。
- 在 Linux CI runner 上构建和 smoke test，不使用 Windows 主机交叉打包 native module。
- `npmRebuild`、asar unpack 和 Electron ABI 由 smoke test 验证，不只检查文件存在。

### 系统依赖

- 启动时只读检查 BlueZ、D-Bus 和 Python bridge/Node D-Bus runtime。
- 对 AppImage 无法捆绑的系统服务给出清晰诊断，不尝试自动安装。
- deb 可以声明经过验证的最低依赖，例如 `bluez`、`python3-dbus`、`python3-gi`；最终依赖以实现选择为准。

### 串口权限

- 捕获 `EACCES/EPERM` 后读取设备 owner/group，告诉用户需要加入的实际组；不同发行版可能是 `dialout`、`uucp` 等。
- 不提供宽泛 `MODE=0666` udev rule。
- 如未来提供 vendor-specific udev rule，只覆盖经过验证的 VID/PID，并单独进行安全审查。

### 文档

- README 增加 Windows/Linux 安装、支持 transport、权限和依赖说明。
- `docs/FLIGHT-CONTROLLER-COMPATIBILITY.md` 增加按 OS/transport/hardware 的 HIL 状态。
- `docs/ARCHITECTURE.md` 更新 discovery service、SerialWorker 和 BLE GATT 路径。
- 发布说明明确区分“软件实现”“SITL/自动化通过”“具体硬件 HIL 通过”。

### 退出条件

- AppImage 在干净 Ubuntu LTS 环境完成启动、串口枚举和连接 smoke test。
- 缺少权限/BlueZ 依赖时应用不崩溃，并提供可执行的恢复提示。

## 6. 前端交互规格

连接弹窗顺序固定为：当前状态 → 连接方式 → 设备候选 → 波特率/高级设置 → 错误或阻塞原因 → 主操作。

### USB

- 打开弹窗后立即显示结构，设备列表独立 loading。
- 推荐设备优先显示名称、稳定身份后缀和当前 path。
- “显示全部端口”是次要操作；`ttyS*` 不污染默认列表。
- native USB CDC 可以标注“波特率通常不影响 USB CDC”；USB-UART 仍显示实际波特率意义。
- 连接按钮旁显示选中目标；不能只显示泛化的“USB 设备”。

### Bluetooth

- SPP 与 BLE 明确区分，避免把 BLE 叫作“兼容模式串口”。
- 已配对但离线设备仍可见，并显示“上电后连接”。
- 搜索/解析选中设备时允许取消。
- 缺少 BlueZ runtime、未配对、设备离线、profile 不支持各自只有一个主要恢复动作。

### 状态

- `transportOpen`：显示链路已打开，但飞控尚未就绪。
- `vehicleReady`：显示已识别飞控和目标。
- `reconnecting`：显示尝试次数、目标和最近错误。
- 所有连接相关编辑性文案同步提供中文和英文。

## 7. 验证矩阵

### 7.1 自动化测试

每个阶段至少运行：

```bash
npm run typecheck
npm run test:server
npm run test:protocol
npm run build
npm run test:ui
```

新增测试类别：

- discovery：分类型扫描、排序、去重、稳定 identity、缓存、取消、generation。
- platform parsing：Windows PnP、Linux by-id、BlueZ paired/info、SDP 输出。
- lifecycle：open/close/error、late callback、disconnect during open、backpressure。
- reconnect：path change、identity ambiguity、expected reboot、ordinary drop。
- BLE：profile discovery、notification、分片写、断线重新 discover。
- UI：独立 loading、advanced ports、错误恢复、重连显示、键盘与读屏。

外部命令必须通过可注入 runner 测试，不能只 mock 最终的 `linuxPairedDevices()`；需要覆盖 timeout、signal、partial stdout、工具缺失和取消。

### 7.2 SITL

- PX4 SITL 和 ArduCopter SITL 通过虚拟串口或 TCP-to-serial bridge 验证新 generation 和 heartbeat readiness。
- 验证参数同步、target selection、controller lease 和 expected reboot 恢复。
- SITL 不替代 USB 枚举、BlueZ、GATT 和驱动层 HIL。

### 7.3 拆桨 HIL

| OS | 设备/链路 | 必测场景 |
|---|---|---|
| Windows 10/11 x64 | Pixhawk/PX4 USB CDC | 冷连接、重启、拔插、COM 号变化 |
| Windows 10/11 x64 | ArduPilot USB CDC | 参数读取、写回、日志、重启 |
| Windows 10/11 x64 | MicoAir/通用 SPP | incoming/outgoing COM、掉线重连 |
| Ubuntu 22.04/24.04 | ttyACM | by-id、权限不足、拔插重枚举 |
| Ubuntu 22.04/24.04 | CP210x/CH340 ttyUSB | 波特率、占用、两相同适配器 |
| Ubuntu 22.04/24.04 | MicoAir SPP | 配对、离线、SDP、重连 |
| Ubuntu 22.04/24.04 | MicoAir BLE | profile、MTU 分片、通知、掉线 |
| Debian 12 或 Fedora 当前稳定版 | 至少一条 USB + 一条 Bluetooth | 发行版组权限和 BlueZ 差异 |

每个组合至少验证：

- 连续连接/断开 20 次；BLE/RFCOMM 专项 50 次。
- 启动前设备未插入，弹窗打开后再插入。
- 连接后拔插、飞控软件重启、主机休眠/唤醒。
- 端口被 QGC/终端占用。
- 两个同 VID/PID 设备同时存在。
- 参数同步和基础遥测持续 15 分钟。
- props removed、RC override、arming、ESC 会话等安全门不因重连恢复旧确认。

## 8. 性能与可靠性验收指标

| 指标 | 目标 |
|---|---:|
| 连接弹窗结构可见 | < 100ms |
| Linux serial recommended 扫描 P95 | < 1s |
| Windows serial 扫描 P95 | < 1s |
| Linux Bluetooth quick 扫描 P95 | < 1.5s |
| Bluetooth 故障对 USB 扫描增加的等待 | 0ms（独立请求） |
| 用户取消扫描/连接后 UI 进入取消状态 | < 300ms |
| USB 重新插入后 transport 恢复 | < 8s，身份唯一时 |
| 物理掉线后 `vehicleReady=false` | 下一次同步状态发布周期内 |
| 重复连接/断开泄漏 | 0 个活动 timer/listener/child process |
| 错误可行动率 | 已分类连接错误 100% 有一个主要恢复动作 |

性能门槛通过受控测试环境测量；真实 HIL 记录 P50/P95 和最大值，不以单次截图代替数据。

## 9. 安全与兼容性不变量

- native open、RFCOMM open 或 GATT connected 都不是 `vehicleReady`。
- 每次物理重连使旧 target、旧 telemetry、旧参数草稿、旧确认和 safety epoch 失效。
- 自动重连不自动解锁、不恢复 RC override、不恢复 ESC raw session。
- 设备 identity ambiguous 时终止，不猜测。
- BLE notification 和串口 late data 必须带 generation 过滤。
- critical 写入继续优先于普通队列，并保留有界背压。
- 未识别栈和未实现 ArduPilot vehicle class 保持只读。
- 连接 UI 的 enabled 状态不构成授权；服务端仍在发送前复核目标、能力、控制权和安全状态。

## 10. 发布、迁移与回滚

### 10.1 迁移

- 旧串口预设首次使用时尝试补充 serialNumber/stablePath；只有唯一匹配才自动升级。
- 旧 Bluetooth 预设优先用 address 升级；只有 service UUID 的预设要求用户重新选择。
- 预设 schema 增加版本号，升级失败保留原记录但标记需要重新绑定。
- API 兼容期可保留旧 `/scan`，内部转调两个新扫描并标记 deprecated；前端迁移完成后删除。

### 10.2 Feature flags

- `connectionDiscoveryV2`：Phase 1/2。
- `serialAutoReconnect`：Phase 4。
- `linuxBleGattExperimental`：Phase 3，默认只在已验证构建启用。

flag 必须由构建/服务端配置控制，不能让普通浏览器绕过硬件兼容矩阵。

### 10.3 回滚

- discovery v2 可回退到旧 serial scan，但不得重新把 Bluetooth 阻塞放回 USB 默认路径。
- BLE experimental 失败时只禁用 BLE transport，保留 USB/SPP。
- 自动重连出现身份或安全问题时可关闭 `serialAutoReconnect`，显式连接仍可用。
- 预设升级采用复制后替换，保留旧 schema 数据直到新版本稳定。

## 11. 工作量与依赖顺序

以下是工程量级，不是交付承诺：

| 阶段 | 预计 | 依赖 |
|---|---:|---|
| Phase 0 基线与可观测性 | 1–2 人日 | 无 |
| Phase 1 扫描拆分与 USB 列表 | 3–4 人日 | Phase 0 |
| Phase 2 SPP 快速发现 | 3–4 人日 | Phase 1 |
| Phase 3 Linux BLE GATT | 5–8 人日 + HIL | Phase 0/2、硬件证据 |
| Phase 4 串口统一重连 | 4–6 人日 + HIL | Phase 1 |
| Phase 5 Linux 发行与文档 | 3–5 人日 | Phase 1，BLE 依赖选择 |

推荐关键路径：`0 → 1 → 2 → 4 → 5`。Phase 3 可在 Phase 2 后并行开发，但没有真实 MicoAir 硬件证据时不得宣称稳定支持。

## 12. 完成定义

只有同时满足以下条件，计划才算完成：

- Windows/Linux USB 扫描和连接达到性能目标，Bluetooth 故障不阻塞 USB。
- Linux 默认列表不再充斥 `ttyS*`，稳定 identity 能安全处理路径变化。
- SPP quick discovery 可展示已配对离线设备，SDP 只作用于用户选中的目标。
- 普通 USB 掉线和飞控重启使用统一、有界、generation-safe 的恢复状态机。
- Linux BLE GATT 通过列出的 profile 单元测试与拆桨 HIL，或明确保留 experimental/未完成状态。
- Windows incoming/outgoing COM、安全门、背压和 controller lease 无回归。
- Linux 构建包含正确 native binding，缺少权限/BlueZ 依赖时给出可行动提示。
- `typecheck`、server/protocol/UI 测试、build、SITL 和目标 HIL 矩阵都有保存的结果。
- `ARCHITECTURE.md`、README 和兼容性文档与实际实现一致，不把硬件无关测试描述成 HIL 支持。
