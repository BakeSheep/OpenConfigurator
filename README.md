# OpenConfigurator

<p align="center">
  <img src="public/favicon.svg" width="88" alt="OpenConfigurator logo" />
</p>

<p align="center">
  面向 PX4 与 ArduPilot 的纯浏览器、本地数据飞控配置与地面站。
</p>

<p align="center">
  <a href="https://bakesheep.github.io/OpenConfigurator/"><b>在线使用</b></a> ·
  <a href="README.en.md">English</a> ·
  <a href="docs/ARCHITECTURE.md">架构</a>
</p>

> [!WARNING]
> OpenConfigurator 仍处于预发布阶段，不是经过认证的航空安全系统。连接电机或 ESC 控制前必须拆除全部螺旋桨，并在受控环境中完成实机验证。

## 隐私与部署模型

OpenConfigurator 是静态 SPA。部署服务器只分发 HTML、JavaScript、CSS 和本地资源；浏览器通过 Web Serial 直接连接当前电脑上的飞控。MAVLink 字节、遥测、参数、校准状态、日志和分析结果均在当前浏览器标签页中处理，不会上传到部署服务器。

- 每个标签页独立拥有一个本机串口和本地 Dedicated Worker，不提供账号、共享控制或跨浏览器会话。
- 串口选择必须由用户点击触发。刷新后只列出浏览器已经授权的设备，不会自动打开或占用端口。
- 日志下载先写入本机 OPFS 临时区，用户主动保存或分析后即消费；断开、淘汰或下次启动清理遗留 artifact。
- MAVLink signing 密钥只保存在当前连接的内存中，断开或刷新即清除，不写入浏览器存储。
- 生产 CSP 使用 `connect-src 'none'`。项目不加载第三方字体、地图图块、统计、遥测、REST 或 WebSocket。

多人可同时访问同一个 HTTPS 部署地址，各自连接本机飞控；服务器只能看到普通静态资源 GET。

## 支持范围

- 桌面 Chromium 浏览器；Web Serial 需要 HTTPS 安全上下文或 localhost。
- PX4：连接、遥测、参数、调参、校准、飞行操作、ULog、NSH 终端与 ESC 路径。
- ArduPilot：ArduCopter 是安全关键写操作的适配目标；其他已识别机型保留通用显示与 DataFlash 日志，未适配写操作保持关闭。
- AM32 ESC 参数：ArduPilot raw passthrough、PX4 `SERIAL_CONTROL`、19200 波特直连三条路径；不提供固件刷写。
- Firefox、Safari、移动浏览器、自动连接和 Electron 桌面包不在本次支持范围。

飞控类型只根据 HEARTBEAT 识别。安全关键操作会在本地 Worker 中重新检查连接、目标、机型能力、armed 状态和 safety epoch；`COMMAND_ACK` 本身不被视为物理状态成功。

详细边界见 [飞控配置兼容性](docs/FLIGHT-CONTROLLER-COMPATIBILITY.md)、[ESC 兼容性](docs/ESC-COMPATIBILITY.md) 和 [HIL 清单](docs/HIL-CHECKLIST.md)。

## 本地开发

要求 Node.js `>=22.12.0` 与 npm。Node 只用于开发、测试和构建，不参与生产运行。

Linux 串口访问权限：普通用户需要加入串口设备属组（Debian/Ubuntu 为 `dialout`，Arch 为 `uucp`，以设备 `ls -l /dev/ttyACM0` 显示的组为准），加入后需重新登录。权限不足时连接错误会直接显示该设备的属主与组。BLE GATT 连接尚未实现。

```bash
git clone https://github.com/BakeSheep/OpenConfigurator.git
cd OpenConfigurator
npm install
npm run dev
```

打开 <http://localhost:5173>，点击连接按钮后由浏览器显示原生设备选择器。开发环境可用 <http://localhost:5173/?demo=1> 查看只读合成数据。

常用命令：

| 命令 | 用途 |
|---|---|
| `npm run dev` | 启动 Vite 开发服务器 |
| `npm run typecheck` | TypeScript 类型检查 |
| `npm run test:runtime` | 本地 Worker、Web Serial、artifact 与协议测试 |
| `npm run test:protocol` | MAVLink、日志传输、校准和 ESC 协议测试 |
| `npm run test:ui` | Playwright UI 与无障碍回归 |
| `npm run build` | 生成通用静态 `dist/` |
| `npm start` | 本地预览生产构建 |

## 生产部署

```bash
npm run build
docker build -t openconfigurator .
docker run --rm -p 8080:8080 openconfigurator
```

`dist/` 可部署到任意静态站点。公网必须由反向代理、CDN 或托管平台提供 HTTPS；单纯 HTTP 公网地址无法使用 Web Serial。随仓库提供的 Nginx 镜像只提供静态文件和安全响应头，不含应用 API。


## 架构

```text
HTTPS static host
        │ static GET only
        ▼
React SPA ── Web Serial ── local flight controller
    │
    └─ Dedicated Worker
       ├─ MAVLink codec / signing / target and safety gates
       ├─ parameters / calibration / terminal / flight commands
       ├─ FTP / DataFlash ── OPFS temporary artifacts
       └─ AM32 ESC sessions
```

- `src/shared/`：框架无关的 RuntimeCommand/RuntimeEvent、vehicle profile、协议常量和 ESC layout。
- `src/web/`：React 工作区、Web Serial 主线程传输、根级 `useLocalRuntime` 和 Zustand stores。
- `src/local-runtime/`：Dedicated Worker、MAVLink、日志传输、校准、终端和 ESC 服务。

更多设计约束见 [架构文档](docs/ARCHITECTURE.md)。OpenConfigurator 采用 [MIT License](LICENSE)，与 PX4、ArduPilot、MAVLink、MicoAir 或 QGroundControl 官方项目没有隶属关系。
