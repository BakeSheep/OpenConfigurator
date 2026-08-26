# 参与 OpenConfigurator 开发

飞控与 ESC 软件的错误可能造成设备损坏或人身风险。

## 环境要求

- Node.js `>=22.12.0` 与 npm。Node 只用于开发、测试和构建，不参与生产运行。
- Linux 串口访问权限：普通用户需要加入串口设备属组（Debian/Ubuntu 为 `dialout`，Arch 为 `uucp`，以设备 `ls -l /dev/ttyACM0` 显示的组为准），加入后需重新登录。权限不足时连接错误会直接显示该设备的属主与组。BLE GATT 连接尚未实现。

## 本地开发

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

只修改文档时可不运行完整测试，但必须检查链接、命令和能力描述。协议相关改动还应运行 `npm run test:protocol`。

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

更多设计约束见 [架构文档](docs/ARCHITECTURE.md)。

## 代码约束

- `src/shared/` 是页面主线程与 Dedicated Worker 的唯一共享表面，且必须保持框架无关。
- Worker 不得导入 `src/web/`；页面不能创建额外 Worker 或绕过统一 Web Serial transport。
- 新增跨线程消息时同步更新 runtime union、Worker 校验/处理、前端 dispatch 与测试。
- MAVLink framing、CRC 与 signing 只经过 `src/local-runtime/mavlink/codec.ts`。
- 生产构建不得新增业务上行；静态站点 CSP 必须保持 `connect-src 'none'`。
- 飞控差异必须经 vehicle profile 与 capability gate 处理，未知机型默认只读。
- UI 使用 `src/web/index.css` 的主题变量和现有 `.mc-*` 组件类。

## 安全关键变更

解锁、飞行命令、电机/ESC、RC override、参数写入、MAVLink、连接生命周期和本地安全 epoch 的改动，必须说明风险、回退路径、自动化测试及实机验证状态。不得弱化拆桨确认、解锁确认、手柄手动启用或 Worker 运行时校验。

ESC 新增硬件支持时同步更新 [兼容性矩阵](docs/ESC-COMPATIBILITY.md)和[协议来源](docs/ESC-PROTOCOL-SOURCES.md)。真实硬件日志必须先脱敏。

## 生产部署

```bash
npm run build
docker build -t openconfigurator .
docker run --rm -p 8080:8080 openconfigurator
```

`dist/` 可部署到任意静态站点。公网必须由反向代理、CDN 或托管平台提供 HTTPS；单纯 HTTP 公网地址无法使用 Web Serial。随仓库提供的 Nginx 镜像只提供静态文件和安全响应头，不含应用 API。
