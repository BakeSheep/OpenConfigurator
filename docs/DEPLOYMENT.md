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
