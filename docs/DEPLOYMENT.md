# 部署与配置

## 本机模式（推荐）

SkyLab 默认监听 `127.0.0.1:3000`，不需要 token：

```bash
npm ci
npm run build
npm start
```

访问 <http://localhost:3000>。串口由运行 Node.js 的同一台机器访问，因此容器化部署需要额外映射设备，不是当前推荐路径。

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---:|---|
| `HOST` | `127.0.0.1` | 监听地址；非 loopback 必须开启远程模式 |
| `PORT` | `3000` | 服务端口，范围 1–65535 |
| `SKYLAB_ALLOW_REMOTE` | `false` | 只接受 `true/false` 或 `1/0` |
| `SKYLAB_AUTH_TOKEN` | — | 远程模式必需，32–512 字节可打印 ASCII |
| `SKYLAB_ALLOWED_ORIGINS` | — | 逗号分隔的精确 HTTP(S) Origin |
| `SKYLAB_WS_MAX_PAYLOAD` | `16384` | WS 入站上限，范围 1–64 KiB |
| `SKYLAB_WS_MAX_CLIENTS` | `8` | WS 最大客户端数，范围 1–64 |
| `MAVLINK_PROTOCOL` | `auto` | `auto`、`v1` 或 `v2` |
| `MAVLINK_SIGNING_KEY` | — | 64 位 hex 的 32-byte key，或用于派生 key 的口令 |
| `MAVLINK_SIGNING_LINK_ID` | `0` | signing link ID，范围 0–255 |
| `MAVLINK_SIGNING_REQUIRE` | `false` | 启用后拒绝未签名入站帧，必须同时配置 signing key |

复制 `.env.example` 仅用于查看示例；当前启动脚本不会自动加载 `.env`。请通过操作系统、进程管理器或容器编排工具注入变量。

## 远程模式

> [!CAUTION]
> 远程飞控会扩大攻击面和链路故障面。优先使用本机模式；不要将 Node.js 端口直接暴露到互联网。

PowerShell 示例：

```powershell
$env:HOST = '0.0.0.0'
$env:SKYLAB_ALLOW_REMOTE = 'true'
$env:SKYLAB_AUTH_TOKEN = '<至少 32 字节的随机 token>'
$env:SKYLAB_ALLOWED_ORIGINS = 'https://gcs.example.com'
npm start
```

Bash 示例：

```bash
HOST=0.0.0.0 \
SKYLAB_ALLOW_REMOTE=true \
SKYLAB_AUTH_TOKEN='<at-least-32-byte-random-token>' \
SKYLAB_ALLOWED_ORIGINS='https://gcs.example.com' \
npm start
```

REST 使用 `Authorization: Bearer <token>`，也兼容 `X-SkyLab-Token`。浏览器 WebSocket 使用 `/ws?token=<token>`，因此反向代理访问日志必须删除或屏蔽查询参数。

### 反向代理要求

- 只对外开放 HTTPS，WebSocket 使用 WSS。
- 正确转发 `Upgrade`、`Connection`、`Host` 与原始 `Origin`。
- 不要把任意 Origin 改写成受信任 Origin。
- 不记录 WS URL 查询参数或 Authorization header。
- 对管理网络使用防火墙、VPN 或零信任访问控制；应用 token 不是完整网络边界。
- 设置合理的请求体、连接、空闲超时和速率限制，但不要破坏长连接心跳。

## MAVLink signing

开启 signing 后，出站协议强制使用 MAVLink 2。`MAVLINK_SIGNING_REQUIRE=true` 会拒绝未签名入站帧，错误配置可能让飞控永久处于“端口打开但未就绪”状态。部署前应分别验证：

1. MAVLink v1-only 设备（不启用 signing）。
2. MAVLink v2 未签名设备。
3. MAVLink v2 签名设备。
4. require-signed 模式下的合法、未签名、错误 key 和 replay 输入。

不要把 signing key 写入仓库、Issue、日志或截图。

## 生产检查

```bash
npm ci
npm run typecheck
npm run test:server
npm run build
npm audit --omit=dev --audit-level=high
```

真实设备发布前还应完成 [开源发布清单](OPEN_SOURCE_CHECKLIST.md) 中的硬件验证。
