# 部署与配置

## 本机模式

服务默认监听 `127.0.0.1:3000`，无需 token：

```bash
npm ci
npm run build
npm start
```

访问 <http://localhost:3000>。串口必须能被运行 Node.js 的用户访问。

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---:|---|
| `HOST` | `127.0.0.1` | 非 loopback 地址必须启用远程模式 |
| `PORT` | `3000` | 1–65535 |
| `SKYLAB_ALLOW_REMOTE` | `false` | 仅接受 `true/false` 或 `1/0` |
| `SKYLAB_AUTH_TOKEN` | — | 远程模式必需，32–512 字节可打印 ASCII |
| `SKYLAB_ALLOWED_ORIGINS` | — | 逗号分隔的精确 HTTP(S) Origin |
| `SKYLAB_WS_MAX_PAYLOAD` | `16384` | 1–65536 字节 |
| `SKYLAB_WS_MAX_CLIENTS` | `8` | 1–64 |
| `MAVLINK_PROTOCOL` | `auto` | `auto`、`v1` 或 `v2` |
| `MAVLINK_SIGNING_KEY` | — | 64 位 hex key 或派生口令 |
| `MAVLINK_SIGNING_LINK_ID` | `0` | 0–255 |
| `MAVLINK_SIGNING_REQUIRE` | `false` | 拒绝未签名入站帧 |

`SKYLAB_*` 是早期兼容名称。程序不会自动加载 `.env`；请通过操作系统或进程管理器注入变量。

## 远程模式

> [!CAUTION]
> 不要把 Node.js 端口直接暴露到互联网。优先使用本机模式。

远程部署必须同时满足：

- `SKYLAB_ALLOW_REMOTE=true`
- 至少 32 字节随机 token 与精确 Origin 白名单
- HTTPS/WSS 反向代理，正确转发 WebSocket Upgrade 和原始 Origin
- 管理网络的防火墙、VPN 或零信任访问控制
- 代理日志隐藏 Authorization 与 `/ws?token=` 查询参数

REST 使用 `Authorization: Bearer <token>`；WebSocket 使用 `/ws?token=<token>`。应用 token 不能替代网络隔离或主机加固。

## GitHub Pages 在线演示

`https://bakesheep.github.io/OpenConfigurator/` 是一个纯静态、只读的前端预览：没有 Node.js 后端，所有数据均为合成数据，不创建 WebSocket、不调用 REST，也不能连接真实设备或执行写操作。

部署由 `.github/workflows/pages.yml` 完成：每次 push 到 `main`（或手动 `workflow_dispatch`）时构建并发布 `dist/`。Pages 专用构建通过两个环境变量与本地生产构建隔离：

| 变量 | Pages 取值 | 说明 |
|---|---|---|
| `VITE_APP_MODE` | `demo` | 构建时固化只读演示模式；生产构建不设置此变量，`?demo=1` 仅在 dev 构建生效 |
| `VITE_BASE_PATH` | `/OpenConfigurator/` | Vite base；本地 `npm run build` 不设置时仍为 `/` |

本地验证 Pages 构建（PowerShell）：

```powershell
$env:VITE_APP_MODE='demo'
$env:VITE_BASE_PATH='/OpenConfigurator/'
npm run build:pages
Remove-Item Env:VITE_APP_MODE
Remove-Item Env:VITE_BASE_PATH
```

一次性仓库设置：仓库管理员需在 GitHub **Settings → Pages → Build and deployment** 中将 Source 选为 **GitHub Actions**，否则 workflow 无法发布。

## MAVLink signing

配置 signing 后出站强制使用 MAVLink 2。`MAVLINK_SIGNING_REQUIRE=true` 会拒绝未签名帧，错误 key 会造成“串口已打开但飞控未就绪”。部署前分别验证 v1-only、v2 未签名、v2 签名以及 require-signed 的合法/非法输入。不要提交或记录 signing key。

## 发布检查

```bash
npm ci
npm run typecheck
npm run test:server
npm run build
npm audit --omit=dev --audit-level=high
```

涉及飞行控制、串口、蓝牙、MAVLink 或 ESC 的版本还必须完成目标硬件 HIL；测试结果应写明设备、固件、连接方式和未覆盖项。
