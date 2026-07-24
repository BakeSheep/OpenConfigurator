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
| 前端框架 | React 18 + TypeScript + Vite 8 |
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
    ↕ MAVLink v2 协议
PX4 飞控 (USB Serial / Bluetooth SPP)
```

## 启动方式

```bash
cd c:\Users\28951\Documents\Qoder\2026-07-19\chat-1\px4-web-gcs

# 安装依赖
npm install

# 开发模式（前后端同时启动）
npm run dev

# 单独启动后端
npm run dev:server

# 单独启动前端
npm run dev:web

# 生产构建
npm run build

# 生产运行（单一 localhost:3000）
npm start
```

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
│   │   ├── connection/
│   │   │   ├── ConnectionManager.ts   # 统一连接管理
│   │   │   ├── SerialConnection.ts    # USB 串口
│   │   │   └── BluetoothConnection.ts # 蓝牙 SPP
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
- Vite 代理配置在 `vite.config.ts`，开发时 `/api` 和 `/ws` 代理到 3000 端口
- 手柄控制需用户手动启用（勾选"启用手柄控制"），防止误操作
- 电机测试需先勾选安全确认（"已移除螺旋桨"）
- 解锁操作需二次点击确认（3 秒超时自动取消）
