# 纯浏览器本地运行时架构

## 系统边界

```text
HTTPS static host
        │ HTML / JS / CSS / bundled assets
        ▼
Browser tab
  ├─ React + Zustand
  ├─ WebSerialTransport ── navigator.serial ── local FC / ESC
  ├─ Dedicated Worker
  │   ├─ RuntimeCommand validation and safety authority
  │   ├─ MAVLink codec / signing / target selection
  │   ├─ parameters / calibration / terminal / flight commands
  │   ├─ MAVLink FTP / DataFlash
  │   └─ AM32 ESC sessions
  └─ OPFS temporary artifacts
```

静态服务器不参与设备连接，也没有应用 REST、WebSocket、账号或共享状态。每个浏览器标签页是完全独立的控制域；所有飞控数据都停留在用户设备。

## 目录职责

| 路径 | 职责 |
|---|---|
| `src/shared/` | 框架无关的 `RuntimeCommand` / `RuntimeEvent`、vehicle profile、常量、结构化日志合同和 ESC layout |
| `src/web/` | React UI、唯一的 `useLocalRuntime` 分发、Zustand stores、Web Serial 主线程传输与日志分析 |
| `src/local-runtime/` | Worker 编排、运行时校验、MAVLink、FTP/DataFlash、校准、终端、飞行命令与 ESC 服务 |
| `Dockerfile` / `nginx.conf` | 静态构建和只读站点容器；没有设备或业务接口 |

`src/web/` 不直接导入 Worker 实现。跨线程只通过 `src/shared/localRuntime.ts` 中的消息合同和 transferable `ArrayBuffer` 通信。

## 连接生命周期

1. 页面加载时调用 `navigator.serial.getPorts()`，只展示已授权设备，不打开端口。
2. 新授权必须由用户点击触发 `requestPort()`。
3. 主线程打开串口，管理读取、优先级写队列、背压、取消和波特率切换。
4. 字节以 transferable `ArrayBuffer` 传入 Worker。Worker 为每次物理连接创建新的 parser、发送序列、协议探测和链路统计。
5. Bluetooth SPP 只在当前标签页仍处于活动连接会话时进行有界重连；显式断开会永久终止本次重连。
6. 显式断开先请求 Worker 在有界时间内停止电机测试、释放手动控制、关闭终端并退出 ESC 会话，再关闭浏览器串口。

`transportOpen` 不等于 `vehicleReady`。页面的 `canControl` 仅表示当前标签页持有打开的本地端口。

## 数据和命令流

```text
serial bytes → WebSerialTransport → transferable ArrayBuffer
→ Worker codec → target filter → RuntimeEvent
→ useLocalRuntime → Zustand → React
```

```text
user confirmation → RuntimeCommand → Worker runtime validation
→ live connection + target + capability + armed state + safety epoch
→ MAVLink / ESC transaction → ACK + read-back or observed state
```

本地 Worker 生成 `safetyAuthorityId` 和单调递增的 `safetyEpoch`。目标、连接或本地安全边界改变时，旧确认立即失效。安全关键操作不能只根据 `COMMAND_ACK` 宣告物理状态成功；参数与 ESC 写入需要匹配回显或完整读回，飞行状态需要相应遥测转换。

## MAVLink codec

`src/local-runtime/mavlink/codec.ts` 是 framing、CRC、dialect lookup、signing、重放保护、parser 状态、序列号和序列化的唯一实现入口。

- 协议数据使用浏览器可用的字节数组和 `DataView` 语义。
- `mavlink-mappings` 提供消息定义；`@noble/hashes` 提供 MAVLink 2 signing 哈希。
- signing 密钥只通过连接高级设置传入 Worker，绝不写入 localStorage、sessionStorage、日志或预设。

## 日志 artifact

ULog 与 DataFlash 下载写入 OPFS 临时 artifact：

- 单文件硬上限 512 MiB。
- 创建前使用 `navigator.storage.estimate()` 检查配额并至少保留 64 MiB 余量。
- 支持随机偏移写入和乱序块恢复。
- 最多保留 5 个完成 artifact；消费、断开、淘汰或启动清理时删除。
- 保存与分析从本地 Blob 读取，不发送网络请求。

不支持 OPFS 的测试或受限环境使用相同语义的内存回退，但生产支持边界仍是桌面 Chromium。

## 设备发现与恢复

- 端口列表只读取浏览器已经授权的 `navigator.serial.getPorts()`，不会在列举时打开或占用端口。
- 新端口必须由用户手势触发 `navigator.serial.requestPort()`。保存的预设只保存设备描述和标签，不绕过浏览器权限；无法可靠匹配时必须重新选择。
- 主线程 `WebSerialTransport` 管理原生串口的打开、读取、优先级写队列、背压和关闭；Worker 只接收 transferable 字节并负责协议与安全生命周期。
- Bluetooth Classic SPP 仅在当前标签页活动会话内进行有界重连；显式断开会取消重连。重开只代表 transport 恢复，仍需新的合法 autopilot `HEARTBEAT` 才能进入 `vehicleReady`，旧的目标绑定确认和 ESC 会话不会自动恢复。
- USB 串口不会静默自动重连。Linux BLE GATT 不属于当前 Web Serial 路径，未实现。

## ESC 会话

- ArduPilot passthrough 暂停普通 MAVLink，再切换到 MSP/4-way 原始字节流。
- PX4 通过 MAVLink `SERIAL_CONTROL` 建立 ESC 字节通道。
- Direct 模式使用以 19200 波特打开的本地单线适配器。
- ESC 会话隔离不兼容的 MAVLink 写操作；连接、目标、armed 状态或 safety epoch 改变会使旧会话失效。
- AM32 参数写入从原始 EEPROM 副本打补丁，保留未知字节并整块读回比对。

## 隐私和部署不变量

- 生产构建不包含应用 API、WebSocket 端点、第三方字体、地图图块、统计或后台同步。
- 生产 CSP 是 `connect-src 'none'`，Worker、样式、图片和脚本均由同源静态资源提供。
- 部署服务器只接受静态 GET/HEAD。公网入口必须提供 HTTPS，才能获得 Web Serial 所需的安全上下文。
- 用户偏好和非敏感连接预设可保存在本机；遥测与参数仅属于当前页面会话。
- Demo 只用于开发截图和 UI 测试，正式 Pages 与容器构建均运行真实浏览器直连版本。
- 自动化测试不替代 HIL；实机验收项目记录在 [HIL-CHECKLIST.md](HIL-CHECKLIST.md)。
