# PX4 Web GCS 项目交接文档

## 项目概述

基于 Web 的 PX4 飞控地面站（GCS），UI 完全复刻 MicoAir Configurator 风格，功能对标 QGroundControl。支持通过 USB 串口/蓝牙连接 PX4 飞控，完成传感器校准、参数配置、电机测试、游戏手柄遥控、解锁起飞等操作。

## 项目路径

```
c:\Users\28951\Documents\Qoder\2026-07-19\chat-1\px4-web-gcs
```

## 技术栈

| 层级 | 技术 |
|------|------|
| 前端框架 | React 19 + TypeScript + Vite 8 |
| UI 样式 | Tailwind CSS 4（深色主题，MicoAir 风格） |
| 3D 可视化 | Three.js + @react-three/fiber |
| 实时曲线 | Recharts |
| 状态管理 | Zustand |
| 路由 | React Router (HashRouter) |
| 后端 | Node.js + Express 5 + ws (WebSocket) |
| 串口通信 | serialport |
| MAVLink | node-mavlink（v1/v2 解析+序列化），由 src/server/mavlink/codec.ts 封装 |
| 手柄输入 | Web Gamepad API |

## 架构

```
浏览器 (React SPA, localhost:5173)
    ↕ WebSocket + REST API
Node.js 后端 (localhost:3000)
    ↕ MAVLink v1/v2 协议（自动协商，可选 v2 签名）
PX4 飞控 (USB Serial / Bluetooth SPP)
```

## 启动方式

```bash
cd <SkyLab 仓库目录>

# Node.js ^20.19.0 或 >=22.12.0

# 安装依赖
npm install

# 开发模式（前后端同时启动）
npm run dev

# 单独启动后端
npm run dev:server

# 单独启动前端
npm run dev:web

# 生产构建
# 会先执行严格 TypeScript 类型检查，再构建前端
npm run build

# 生产运行（单一 localhost:3000）
npm start

# 后端回归测试（自动使用随机端口，不访问真实串口）
npm run test:server

# MAVLink 协议专项测试
npm run test:protocol
```

`tsx` 是生产运行时依赖，因此 `npm ci --omit=dev && npm start` 也能启动后端。

## 后端网络与安全边界

后端默认只监听 `127.0.0.1:3000`，保留现有 localhost 零配置工作流。浏览器请求只接受以下本机 Origin：

- `http://localhost:5173` / `http://127.0.0.1:5173`（Vite 开发服务器）
- 当前后端端口上的 `localhost` / `127.0.0.1` / `[::1]` Origin
- `SKYLAB_ALLOWED_ORIGINS` 显式配置的额外 Origin

没有 `Origin` 的请求仅在对端 socket 本身来自 loopback 时接受。远程绑定必须同时显式开启并提供至少 32 字节的 token：

```powershell
$env:HOST = '0.0.0.0'
$env:SKYLAB_ALLOW_REMOTE = 'true'
$env:SKYLAB_AUTH_TOKEN = 'replace-with-a-random-token-at-least-32-bytes'
$env:SKYLAB_ALLOWED_ORIGINS = 'https://gcs.example.com'
npm start
```

REST 使用 `Authorization: Bearer <token>`（也兼容 `X-SkyLab-Token`）。浏览器 WebSocket 无法设置 Authorization header，因此远程模式兼容 `/ws?token=<token>`；服务端不会记录带 token 的 URL。生产代理仍应使用 HTTPS/WSS，并避免在代理访问日志中记录查询参数。

当某个 WebSocket 客户端持有 controller lease 时，REST `connect` / `disconnect` 还必须携带该客户端 `hello.restControlToken` 对应的 `X-SkyLab-Control-Token`。该令牌每次 WebSocket 建连随机生成、仅发给该客户端；没有活跃控制者时仍保留原有 REST 兼容行为。响应统一带 CSP、禁止嵌入、`nosniff`、无 referrer、受限 Permissions Policy 等安全头，API 响应禁用缓存。

| 环境变量 | 默认值 | 说明 |
|---|---:|---|
| `HOST` | `127.0.0.1` | 非 loopback 值必须开启远程模式 |
| `PORT` | `3000` | 1–65535 |
| `SKYLAB_ALLOW_REMOTE` | `false` | 仅接受 `true/false` 或 `1/0` |
| `SKYLAB_AUTH_TOKEN` | — | 远程模式必需，32–512 字节 |
| `SKYLAB_ALLOWED_ORIGINS` | — | 逗号分隔的精确 HTTP(S) Origin |
| `SKYLAB_WS_MAX_PAYLOAD` | `16384` | WS 入站消息上限，范围 1–64 KiB |
| `SKYLAB_WS_MAX_CLIENTS` | `8` | WS 客户端上限，范围 1–64 |

MAVLink wire 兼容和签名配置：

| 环境变量 | 默认值 | 说明 |
|---|---:|---|
| `MAVLINK_PROTOCOL` | `auto` | `auto` / `v1` / `v2`；auto 从 v1 起步，收到 v2 或能力确认后升级 |
| `MAVLINK_SIGNING_KEY` | — | 64 位 hex 的 32-byte key，或由 node-mavlink 通过 SHA-256 派生的口令；配置后强制使用 v2 出站签名 |
| `MAVLINK_SIGNING_LINK_ID` | `0` | MAVLink2 signing link ID，0–255 |
| `MAVLINK_SIGNING_REQUIRE` | `false` | `true` / `1` 时拒绝未签名入站帧；必须同时配置 signing key |

## WebSocket 边界协议

- 建连后先发送 `hello`，包含协议版本、客户端 ID、REST 控制令牌、能力列表和 payload 上限；随后发送完整 `connection` 快照。旧客户端会忽略未知消息，原有 `connected` 字段继续保留。
- `connection` 同时包含 `status`、`transportOpen`、`vehicleReady` 和结构化错误，避免把“串口已打开”误认为“飞控已就绪”。
- 所有入站 JSON 都做运行时校验；未知类型、越界/非有限数值和错误字段通过 `client_error` 返回，不再只写服务端日志。
- 首个有效的飞控变更消息自动取得 30 秒 controller lease；参数下载也会取得 lease，因为下载期间会临时改变飞控 telemetry stream profile。其他客户端保持只读。控制消息会续租，持有者可发送 `{ "type": "release_control" }` 主动释放，断线或物理连接状态变化也会释放。
- 同一时刻只允许一个参数下载 generation；并发刷新优先返回 `param_sync_conflict`，批次/完成消息携带 generation。发起者断线、连接变化、超时或服务关闭会主动取消 bridge 下载并恢复正常 telemetry profile。
- 正向电机测试要求 `propsRemoved: true`、电机号 1–12、油门 0–100、持续时间 0–30 秒；`throttle: 0, duration: 0` 的紧急停止无需安全确认。
- `MAV_CMD_ACTUATOR_TEST` 的 ACK 不携带电机实例，无法安全对应并发请求。服务端会为每次安全校验并成功入队的请求发送 `motor_test_status: sent_unconfirmed`；原始 ACK 仍作为不关联广播。停止命令走 critical 队列，不等待其他 ACK。
- 通用 `command` 禁止绕过专用流程发送 motor/actuator/servo 和内部 stream/request 命令。解锁/上锁要求 `safetyConfirmation: "arm" | "disarm"` 且禁止 force-arm magic；起飞要求 `safetyConfirmation: "takeoff"` 和 0.5–500 米高度。
- WS 限制消息大小、连接数和消息速率，拒绝二进制消息；ping/pong 会清理失活客户端，硬背压会立即终止慢连接。
- 远程模式的未知 5xx 响应只返回稳定错误码与通用文案；底层驱动路径和内部错误仅写服务端日志。

SIGINT/SIGTERM 使用幂等关闭流程：停止 HTTP/upgrade、终止 WS、清理批处理与心跳、销毁 MAVLink bridge、等待连接管理器释放串口，并在有界超时后强制关闭网络句柄。若内部清理超过期限，信号处理器保留最终强制退出计时器并以非零状态退出，不会因“网络已关闭”误判为全部清理完成。

## 目录结构

```
px4-web-gcs/
├── index.html                    # 入口 HTML
├── package.json                  # 依赖与脚本
├── vite.config.ts                # Vite 配置（含 API 代理）
├── tsconfig.json                 # TypeScript 配置
├── src/
│   ├── shared/                   # 前后端共享
│   │   ├── types.ts             # MAVLink 消息类型、WS 协议定义
│   │   └── constants.ts         # 命令 ID、PX4 模式、EKF 参数名
│   ├── server/                   # Node.js 后端
│   │   ├── index.ts             # Express + WebSocket 服务入口
│   │   ├── validation.ts        # HTTP/WS/环境变量运行时校验
│   │   ├── connection/
│   │   │   ├── ConnectionManager.ts   # 统一连接管理
│   │   │   ├── SerialConnection.ts    # USB 串口
│   │   │   ├── BluetoothConnection.ts # 蓝牙 SPP 发现与单链路连接
│   │   │   └── BluetoothWorker.ts     # 可取消的蓝牙重连与 readiness 状态机
│   │   └── mavlink/
│   │       ├── codec.ts               # node-mavlink 封装（decode/serialize + REGISTRY）
│   │       └── MavlinkBridge.ts       # 消息处理 + WS 桥接
│   └── web/                      # React 前端
│       ├── main.tsx             # React 入口
│       ├── App.tsx              # 路由 + 布局
│       ├── index.css            # 全局样式（MicoAir 深色主题）
│       ├── hooks/
│       │   └── useWebSocket.ts  # WebSocket 连接 + 消息分发
│       ├── stores/              # Zustand 状态
│       │   ├── connectionStore.ts
│       │   ├── telemetryStore.ts
│       │   ├── sensorStore.ts
│       │   ├── parameterStore.ts
│       │   └── gamepadStore.ts
│       ├── components/
│       │   ├── layout/
│       │   │   ├── Sidebar.tsx  # 窄图标侧边栏（SVG 图标）
│       │   │   └── Header.tsx   # 顶部状态栏
│       │   ├── telemetry/
│       │   │   ├── AttitudeIndicator.tsx  # 3D 姿态（Three.js）
│       │   │   └── RealtimeChart.tsx      # 实时曲线（Recharts）
│       │   └── ekf/
│       │       └── EkfFusionPanel.tsx     # EKF 融合配置
│       └── pages/               # 8 个功能页面
│           ├── ConnectionPage.tsx    # 连接管理
│           ├── DashboardPage.tsx     # 仪表盘 + 传感器监控
│           ├── SensorPage.tsx        # 传感器校准（引导式）
│           ├── ParameterPage.tsx     # 参数管理
│           ├── MotorPage.tsx         # 电机测试
│           ├── ReceiverPage.tsx      # 遥控器校准
│           ├── JoystickPage.tsx      # 游戏手柄
│           └── FlightControlPage.tsx # 飞行控制
```

## 功能清单

| 模块 | 功能 | 状态 |
|------|------|------|
| 连接管理 | USB 串口 + 蓝牙 SPP，端口扫描/连接/断开 | 已完成 |
| MAVLink 通信 | v1/v2 解析（node-mavlink）、CRC 校验、心跳、命令发送 | 已完成 |
| 仪表盘 | 3D 姿态、飞行数据卡片、传感器实时监控 | 已完成 |
| 传感器监控 | IMU/磁力计/气压计/光流/测距/GPS | 已完成 |
| EKF 融合配置 | GPS/Baro/Mag/OF/RNG/EV 开关 + 高度源 | 已完成 |
| 传感器校准 | 加速度计6面/陀螺仪/磁力计/气压计/ESC/遥控器 | 已完成 |
| 参数管理 | 下载/搜索/分组/编辑/导出 | 已完成 |
| 电机测试 | 可视化布局 + 单电机/顺序测试 + 安全机制 | 已完成 |
| 手柄控制 | Web Gamepad API + 死区/Expo + MANUAL_CONTROL 20Hz | 已完成 |
| 飞行控制 | 解锁/上锁/起飞/降落/RTL/模式切换/飞行前检查 | 已完成 |
| 实时曲线 | 高度/电压/速度多通道 | 已完成 |

## 关键 MAVLink 消息

| 消息 | ID | 用途 |
|------|-----|------|
| HEARTBEAT | #0 | 心跳/解锁状态/模式 |
| ATTITUDE | #30 | 姿态角 |
| GPS_RAW_INT | #24 | GPS 数据 |
| SCALED_IMU | #26 | IMU 数据 |
| SCALED_PRESSURE | #29 | 气压计 |
| OPTICAL_FLOW_RAD | #106 | 光流 |
| DISTANCE_SENSOR | #132 | 测距 |
| ESTIMATOR_STATUS | #230 | EKF 状态 |
| PARAM_VALUE | #22 | 参数值 |
| MANUAL_CONTROL | #69 | 游戏手柄 MAVLink 手动输入 |
| COMMAND_LONG | #76 | 命令发送 |

## 待完善事项

1. **UDP 连接支持**：当前仅支持串口，需添加 UDP 连接以支持 SITL 仿真器测试
2. **3D 姿态指示器优化**：可加载真实无人机 3D 模型（.glb）
3. **迷你地图**：Leaflet 地图显示 GPS 轨迹（依赖已安装，页面未集成）
4. **数据日志**：飞行数据记录与回放
5. **固件刷写**：通过 Web 刷写 PX4 固件
6. **任务规划**：航点编辑与上传
7. **多语言**：当前为中文，可扩展 i18n

## UI 设计规范（MicoAir 风格）

- 背景色：`#0f1117`（主）/ `#1c1f2b`（卡片）/ `#12141c`（侧边栏/输入框）
- 边框色：`#2a2e3d`
- 强调色：`#38bdf8`（sky-400）
- 成功色：`#34d399`（emerald-400）
- 警告色：`#fbbf24`（amber-400）
- 危险色：`#f87171`（red-400）
- 圆角：卡片 `rounded-2xl`，按钮 `rounded-xl`
- 侧边栏：68px 宽，SVG 线性图标，激活项左侧 3px 指示条
- 顶部栏：44px 高，显示连接/模式/电池/GPS

## 注意事项

- 后端使用 Express 5，通配符路由语法为 `/{*splat}`（非 `*`）
- 未知 `/api/*` 始终返回结构化 JSON 404；SPA fallback 只处理接受 HTML 的非 API GET
- `src/server/mavlink/codec.ts` 是唯一 MAVLink framing/CRC/signing 入口；每条物理连接使用独立 codec session，禁止跨重连复用 parser 或 TX sequence
- signing replay watermark 会跨 parser/物理连接 reset 保留；新 source 的首个签名包还必须在本地 signing timestamp 一分钟窗口内，旧录制包不能借重连重新生效
- `transportOpen` 只表示底层串口已打开，`vehicleReady` 必须由已选目标的合法 HEARTBEAT 建立；发送飞行控制请求时必须以后者为准
- disconnect 会在进入串行操作队列前立即取消 provisional 串口/蓝牙解析；成功断开后再发布一次已清空 config/error/reconnect 元数据的最终快照
- 串口背压队列分 `critical` / `high` / `normal`：紧急上锁和电机停止可淘汰普通积压，GCS heartbeat 与用户命令优先于参数/手柄流量，同优先级内保持 FIFO
- 同一 MAVLink command ID 同时只允许一个可关联事务；超时后进入 uncertain/quarantine，迟到 ACK 不会错误归属给后续 requestId
- Vite 代理配置在 `vite.config.ts`，开发时 `/api` 和 `/ws` 代理到 3000 端口
- 手柄控制需用户手动启用（勾选"启用手柄控制"），防止误操作
- 电机测试需先勾选安全确认（"已移除螺旋桨"）
- 解锁操作需二次点击确认（3 秒超时自动取消）
