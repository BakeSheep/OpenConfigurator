# SkyLab

<p align="center">
  <img src="public/favicon.svg" width="88" alt="SkyLab logo" />
</p>

<p align="center">
  面向 PX4 的本地优先 Web 地面站：在浏览器中完成连接、监控、配置、调参与基础飞行操作。
</p>

<p align="center">
  <a href="README.en.md">English</a> ·
  <a href="docs/ARCHITECTURE.md">架构</a> ·
  <a href="docs/DEPLOYMENT.md">部署</a> ·
  <a href="CONTRIBUTING.md">参与贡献</a> ·
  <a href="SECURITY.md">安全策略</a>
</p>

> [!WARNING]
> SkyLab 仍处于早期阶段，不是经过认证的航空安全系统。连接真实飞行器前请先拆除螺旋桨，在受控环境中完成硬件在环测试，并始终保留人工接管能力。使用者须自行承担飞行与设备安全责任。

## 项目简介

SkyLab 是一个基于浏览器的 PX4 地面控制站（GCS）。React 单页应用通过 REST 与单一 WebSocket 连接本机 Node.js 服务，服务再通过 USB 串口或 Bluetooth SPP 与飞控交换 MAVLink v1/v2 数据。

项目采用本地优先的安全边界：服务默认只监听 `127.0.0.1`；远程访问必须显式启用并配置鉴权。飞行控制、电机测试与手柄控制均保留独立的用户确认或启用步骤。

## 已实现能力

- USB 串口与 Bluetooth SPP 扫描、连接、断线恢复和状态诊断
- MAVLink v1/v2 自动协商、可选 MAVLink 2 signing、目标飞控选择与链路统计
- 姿态、GPS、电池、IMU、气压计、光流、测距和 EKF 实时遥测
- PX4 参数下载、搜索、分组、修改、回显确认与导出
- 传感器监控与基础校准命令、EKF 融合设置、PID 调参
- 执行器映射、电机测试、RC 通道监控和游戏手柄输入
- 解锁、上锁、起飞、降落、返航和飞行模式切换
- 多客户端只读观察与单控制者租约，REST/WS 运行时输入校验
- 深色/浅色主题与响应式四工作区界面

尚未完成的能力见 [路线图](docs/ROADMAP.md)。

## 界面与工作区

SkyLab 将功能收敛为四个一级工作区：

| 工作区 | 内容 |
|---|---|
| 总览 | 姿态、飞行状态、关键遥测和系统健康 |
| 飞行操作 | 飞行前检查、模式切换及带安全确认的飞行命令 |
| 飞行器设置 | 机架、传感器、执行器、接收机、手柄和端口设置 |
| 调参与诊断 | 参数、PID、EKF、实时波形和 MAVLink 消息 |

> 项目暂未提交稳定版界面截图。发布首个公开版本前，请按 [开源发布清单](docs/OPEN_SOURCE_CHECKLIST.md) 补充真实截图或演示视频。

## 快速开始

### 环境要求

- Node.js `^20.19.0` 或 `>=22.12.0`
- npm（随 Node.js 安装）
- PX4 飞控与可用的 USB 数据线，或已配对的 Bluetooth SPP 设备
- 推荐 Chrome / Edge 89+；浏览器设备选择器依赖 Web Serial，且仅在 HTTPS 或 localhost 下可用

### 开发模式

```bash
git clone https://github.com/BakeSheep/SkyLab.git
cd SkyLab
npm install
npm run dev
```

打开 <http://localhost:5173>。Vite 会把 `/api` 和 `/ws` 代理到本机 `3000` 端口。

### 本地生产模式

```bash
npm ci
npm run build
npm start
```

打开 <http://localhost:3000>。生产服务由 Node.js 直接提供 `dist/` 中的前端文件。

### 常用命令

| 命令 | 用途 |
|---|---|
| `npm run dev` | 同时启动前端与后端开发服务 |
| `npm run dev:web` | 仅启动 Vite 前端 |
| `npm run dev:server` | 仅启动后端并监听源码变化 |
| `npm run typecheck` | 严格 TypeScript 类型检查 |
| `npm run test:server` | 运行全部后端回归测试，无需真实串口 |
| `npm run test:protocol` | 运行 MAVLink 协议专项测试 |
| `npm run build` | 类型检查并生成生产前端 |
| `npm start` | 启动生产服务 |

## 架构概览

```text
React SPA (:5173 开发 / :3000 生产)
        │ REST + 单一 WebSocket
        ▼
Node.js / Express / ws (:3000)
        │ MAVLink v1/v2
        ▼
USB Serial 或 Bluetooth SPP
        │
        ▼
PX4 Flight Controller
```

- `src/shared/`：前后端唯一共享边界，包含消息协议、类型和常量
- `src/web/`：React SPA、Zustand stores、遥测组件和功能页面
- `src/server/`：HTTP/WS 服务、连接生命周期与 MAVLink bridge
- `src/server/mavlink/codec.ts`：唯一 MAVLink framing、CRC 与 signing 入口

设计约束与数据流详见 [架构文档](docs/ARCHITECTURE.md)。

## 配置与远程访问

默认配置无需 `.env` 文件。可复制 [.env.example](.env.example) 查看所有服务端与 MAVLink 选项。

远程模式不会因设置 `HOST=0.0.0.0` 自动开启；还必须同时配置 `SKYLAB_ALLOW_REMOTE=true`、至少 32 字节的随机 token 和精确的允许 Origin。公开网络部署必须使用 HTTPS/WSS 反向代理。完整说明见 [部署指南](docs/DEPLOYMENT.md)。

## 安全操作底线

- 电机测试前必须拆除全部螺旋桨，并在界面中明确确认。
- 解锁需要二次点击或完整拖拽确认；不要移除或绕过这些保护。
- 手柄 RC override 默认关闭，必须由操作者手动启用。
- `transportOpen` 只代表串口已打开；只有 `vehicleReady` 才代表已收到目标飞控的有效心跳。
- 自动化测试通过不等于真实飞行验证通过。真实硬件验证项目见 [开源发布清单](docs/OPEN_SOURCE_CHECKLIST.md)。

安全漏洞请不要直接创建公开 Issue，请阅读 [SECURITY.md](SECURITY.md)。

## 参与贡献

欢迎提交 Bug、兼容性报告、文档和代码改进。开始前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md) 与 [行为准则](CODE_OF_CONDUCT.md)。涉及 MAVLink、连接生命周期、飞行控制、电机或手柄的修改，需要相应回归测试与硬件验证说明。

## 项目状态与许可

SkyLab 当前处于 **pre-release** 阶段，API、协议和界面可能变化。

本仓库尚未选定开源许可证，因此在许可证文件加入之前，代码默认保留全部权利，不能视为已完成开源发布。维护者应在公开发布前从 MIT、Apache-2.0、GPL-3.0 等方案中明确选择；参见 [开源发布清单](docs/OPEN_SOURCE_CHECKLIST.md)。

## 致谢

SkyLab 构建于 [PX4](https://px4.io/)、[MAVLink](https://mavlink.io/)、React、three.js、node-mavlink 及其他开源项目之上。SkyLab 与 PX4、MAVLink、MicoAir 或 QGroundControl 官方项目没有隶属关系；相关名称与商标归各自权利人所有。
