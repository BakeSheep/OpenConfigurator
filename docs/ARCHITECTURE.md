# 架构

## 系统边界

```text
Browser / React / Zustand
          │ REST + one WebSocket
          ▼
Express + ws + runtime validation
          │
          ├─ controller lease
          ├─ MavlinkBridge ── codec ── serial/Bluetooth ── PX4 / ArduPilot
          ├─ MAVLink FTP / DataFlash log transfer
          └─ EscService ── passthrough / SERIAL_CONTROL / direct serial ── ESC
```

浏览器不解析 MAVLink，也不直接拥有系统串口。Node.js 服务负责目标选择、协议校验、命令事务、控制权和连接生命周期；前端只消费 `src/shared/types.ts` 定义的消息。

## 目录职责

| 路径 | 职责 |
|---|---|
| `src/shared/` | 纯 TypeScript 类型、WS union、vehicle profile、常量与 ESC layout |
| `src/web/` | 四个工作区、组件、单一 WS dispatch、Zustand stores 与日志分析 worker |
| `src/shared/logs/` | PX4 ULog / ArduPilot DataFlash 的语言无关结构化日志合同、流式 envelope 与安全 JSON 编码 |
| `src/server/index.ts` | HTTP/WS、鉴权、Origin、限流、控制者租约与服务编排 |
| `src/server/connection/` | 串口/蓝牙发现、生命周期、重连与背压 |
| `src/server/mavlink/` | codec、MAVLink bridge、FTP 与 DataFlash 传输 |
| `src/server/esc/` | ESC 会话、传输适配、MSP/4-way、发现与 AM32 参数服务 |

## 飞控 profile

`src/shared/vehicleProfiles.ts` 只根据 HEARTBEAT 的 `autopilot` 与 `type` 分类 `family` 和 `vehicleClass`。模式、命令编码、参数页面、日志格式与写能力都从该 profile 派生。

- PX4 使用现有完整能力集。
- ArduCopter 使用 ArduPilot 模式、参数、`MAV_CMD_DO_MOTOR_TEST` 与 DataFlash。
- 其他 ArduPilot 机型和未知飞控保留通用显示能力，安全关键写操作默认关闭。

参数名、STATUSTEXT 或历史状态不得用来授权某个飞控栈的写操作。

## 数据流与状态

```text
serial bytes → per-connection codec session → target filter
→ semantic ServerMessage → useWebSocket → Zustand → React
```

```text
user confirmation → ClientMessage → runtime validation
→ vehicle capability + vehicleReady + controller lease
→ MAVLink/ESC operation → ACK/read-back/state observation
```

连接状态依次为 native handle → `transportOpen` → `vehicleReady` → controller lease。每次物理重连都创建新的 parser、协议探测、发送序列和链路统计。

## 设备发现与恢复（连接兼容性计划）

`ConnectionDiscoveryService` 只负责发现、分类和身份解析，不拥有活动连接；`ConnectionManager` 仍是活动链路、物理代次与状态发布的唯一入口。

- 扫描 API 按 transport 拆分：`GET /api/connections/scan?kind=serial&scope=recommended|all` 与 `kind=bluetooth&scope=quick`。一次扫描绝不等待另一种 transport；无参数的旧端点保留为 deprecated 组合响应。
- Linux 串口发现合并 `/dev/serial/by-id` 与当前 tty 为单个设备（`stablePath`、`deviceId`），`ttyS*` 等平台 UART 只出现在 `scope=all`；Windows 保持 COM + PnP 行为并继续排除 incoming Bluetooth 端口。
- Bluetooth quick discovery 只读本地缓存（`bluetoothctl devices Paired` + `bluetoothctl info`），绝不运行 `sdptool`；已配对但离线的设备保留在列表中并标记 `availability`。阻塞的 SDP 通道解析只对用户选中的一个地址执行（`resolveLinuxSppChannel`），带 TTL channel 缓存。
- 连接请求携带 `deviceId` 时，服务端在打开端口前重新解析并核对身份；身份缺失或歧义分别返回 `DEVICE_NOT_FOUND` / `IDENTITY_AMBIGUOUS`，不会回退到"当前唯一端口"。仅路径的旧请求保留直接路径模式。
- 原生打开失败映射为稳定错误码（`SERIAL_PERMISSION_DENIED` 附带设备属主/组、`SERIAL_BUSY`、`SERIAL_NOT_FOUND`、`SERIAL_OPEN_TIMEOUT` 等，见 `src/shared/types.ts` 的 `ConnectionErrorCode`）。
- 串口自动重连（feature flag `serialAutoReconnect`，env `OPENCONF_SERIAL_AUTO_RECONNECT`）：`SerialWorker` 与 `BluetoothWorker` 暴露同一事件协议，普通 USB 掉线进入有界重试（默认 5 次：1/2/3/5/5s），每次重试都按稳定身份重新解析路径；已确认的飞控重启与普通掉线共享这一个状态机，并在默认 ~45s 宽限窗口内持续重试（至少 12 次）。`IDENTITY_AMBIGUOUS` 立即终止，不猜测。重开只代表 transport 恢复，`vehicleReady` 仍需新一代次的合法 autopilot HEARTBEAT；target-bound 确认、RC override、ESC raw 会话不会自动恢复。
- Linux BLE GATT transport 未实现，保留 experimental/未完成状态，未经 HIL 证据不会宣称支持。

## ESC 会话

- ArduPilot passthrough 暂停普通 MAVLink 并切换到 MSP/4-way 原始字节流。
- PX4 通过 MAVLink `SERIAL_CONTROL` 建立 ESC 字节通道。
- Direct 模式复用已按 19200 波特打开的 USB 单线适配器。
- 会话 pin 控制者租约并隔离其他写命令；断开后仅允许原所有者在窗口内 reclaim。
- AM32 写入从原始 EEPROM 副本打补丁，保留未知字节，随后整块读回比对。

## 不变量

- `src/shared/` 是唯一共享表面；前后端不能互相导入。
- `useWebSocket` 是浏览器唯一 socket owner。
- MAVLink framing、CRC、dialect、signing 与序列号只由 `codec.ts` 管理。
- UI 确认之外，服务端仍验证输入、目标、能力、控制权和会话冲突。
- WS 驱动的持久状态进入 store；RAF/interval 回调稳定挂载。
- 自动化测试不替代 HIL，文档必须区分软件支持与硬件验证。

新增协议消息时通常需要更新 shared union、运行时校验、服务端 handler/emit、`useWebSocket` dispatch、store 与回归测试。
