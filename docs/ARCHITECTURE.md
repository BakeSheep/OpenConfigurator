# SkyLab 架构

## 系统边界

```text
┌──────────────────────────────────────────────┐
│ Browser                                      │
│ React SPA → pages/components → Zustand stores│
│                       ▲                      │
│                 useWebSocket                 │
└───────────────────────┼──────────────────────┘
                        │ REST + WebSocket
┌───────────────────────┼──────────────────────┐
│ Node.js server        ▼                      │
│ Express / ws → validation → MavlinkBridge    │
│                              ↕ codec session │
│                    ConnectionManager         │
└───────────────────────────────┼──────────────┘
                                │ Serial bytes
                     USB Serial │ Bluetooth SPP
                                ▼
                       PX4 flight controller
```

浏览器不直接解析 MAVLink。Node.js 服务持有操作系统串口，负责协议校验、目标选择、命令事务、控制权和连接生命周期；前端只消费 `src/shared/types.ts` 定义的网络消息。

## 目录职责

| 路径 | 职责 |
|---|---|
| `src/shared/` | 前后端共享的纯 TypeScript 类型、协议 union 与 MAVLink/PX4 常量 |
| `src/web/` | React SPA、页面、组件、WebSocket 分发与 Zustand stores |
| `src/server/index.ts` | HTTP/WS 边界、鉴权、Origin、限流、控制者租约和进程关闭 |
| `src/server/validation.ts` | REST、WS 与服务环境变量的运行时校验 |
| `src/server/connection/` | USB/Bluetooth 发现、串口生命周期、重连和背压 |
| `src/server/mavlink/codec.ts` | MAVLink v1/v2 framing、CRC、signing、parser session 与序列号 |
| `src/server/mavlink/MavlinkBridge.ts` | 目标飞控、遥测转换、参数同步和命令事务 |

## 数据流

入站遥测：

```text
serial bytes → connection generation → codec splitter/parser
→ CRC/signature validation → selected-target filter
→ semantic conversion → ServerMessage → WebSocket
→ useWebSocket dispatch → Zustand store → React view
```

出站控制：

```text
user safety interaction → ClientMessage → runtime validation
→ controller lease / vehicleReady check → command transaction
→ node-mavlink serialization → prioritized serial queue → PX4
→ COMMAND_ACK or protocol-specific confirmation → requesting client
```

## 关键不变量

### 单一共享表面

服务端不得导入 `src/web/`，前端不得导入 `src/server/`。两端共用的内容必须进入无框架依赖的 `src/shared/`。

### 单一 WebSocket

`useWebSocket` 在应用层挂载并拥有唯一浏览器连接。页面与组件从 stores 读取状态，通过共享发送函数发出消息，不能自行创建 socket。

### 连接状态分层

```text
native handle → transportOpen → vehicleReady → controller lease
```

`transportOpen` 只表示底层端口可用；`vehicleReady` 必须由目标 autopilot 的有效 HEARTBEAT 建立。飞控变更消息还需要当前客户端持有 controller lease。

### 每条物理连接独立 codec session

parser、发送序列、协议版本探测和统计不能跨重连复用。MAVLink framing、CRC 与 signing 只允许经 `codec.ts` 处理，禁止重新维护手工 offset 或 CRC_EXTRA 表。

### 危险操作纵深防御

UI 确认不是唯一安全边界。服务端还会验证消息类型、范围、目标就绪状态和控制权，并禁止通用 command 绕过电机/执行器等专用流程。

## 扩展协议

新增一类 WebSocket 消息通常需要同时完成：

1. 在 `src/shared/types.ts` 扩展 `ClientMessage` 或 `ServerMessage` union。
2. 在 `src/server/validation.ts` 添加入站运行时校验（适用时）。
3. 在 `MavlinkBridge` 或 `src/server/index.ts` 实现处理与 emit。
4. 在 `useWebSocket.handleMessage` 中分发服务端消息。
5. 将 WS 驱动的持久状态放入 Zustand store，而不是页面局部 state。
6. 增加协议或服务边界回归测试。

## 测试分层

- `*.test.ts`：连接状态机、蓝牙识别、串口边界和 HTTP/WS 生命周期
- `MavlinkBridge.test.ts`：framing、签名、目标选择、命令、参数和遥测语义
- `npm run typecheck`：共享 union、前后端 dispatch 与严格 TypeScript 约束
- `npm run build`：前端生产构建和静态资源集成
- HIL：真实 PX4、USB/Bluetooth、签名互通及所有安全关键操作

自动化测试不替代 HIL。建议的硬件验证矩阵见 [OPEN_SOURCE_CHECKLIST.md](OPEN_SOURCE_CHECKLIST.md)。
