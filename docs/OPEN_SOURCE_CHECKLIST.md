# 开源发布检查清单

此清单用于仓库首次公开或发布首个 tag 前的最终检查。

## 必须由维护者决定

- [x] 已选择 MIT License，并添加根目录 `LICENSE` 与 `package.json` 许可证声明。
- [ ] 确认所有代码、图标、字体、截图、名称和设计素材都有权公开与再分发。
- [ ] 确认项目名、logo 及“MicoAir-style”等描述不会造成官方隶属或商标混淆。
- [ ] 确定安全报告私密渠道，并在 `SECURITY.md` 中加入可用邮箱或 GitHub Private Vulnerability Reporting 状态。
- [ ] 确定首个版本号、支持范围和维护者名单。

## 仓库卫生

- [ ] 检查默认分支完整历史中是否含 token、MAVLink signing key、私钥、个人信息或飞行日志；仅扫描当前文件不够。
- [ ] 确认 `.env`、日志、构建目录和本机配置已被 `.gitignore` 排除。
- [x] `package.json` 使用 npm 合法名称 `open-configurator`，公开品牌为 OpenConfigurator。
- [ ] 删除或改写内部路径、临时计划、过时截图与仅对维护者有意义的说明。
- [ ] 检查依赖许可证与第三方 NOTICE 要求。
- [ ] 运行 `git diff --check`，并确认工作区没有误提交的生成文件。

## 自动化验证

```bash
npm ci
npm run typecheck
npm run test:server
npm run test:protocol
npm run build
npm audit --omit=dev --audit-level=high
```

- [ ] 上述命令全部通过并记录 Node.js/操作系统版本。
- [ ] 从空目录按 README 的 clone → install → dev 流程验证一次。
- [ ] 验证生产 `npm start`、SPA fallback、API JSON 404 和干净关闭。
- [x] 建立 Windows / Linux CI（typecheck、server tests、build）。仓库维护者仍需在托管平台启用 required check 分支保护。

## 硬件在环（HIL）

公开记录格式与 PX4/平台/连接目标矩阵见 [COMPATIBILITY.md](COMPATIBILITY.md)。没有实机证据的组合必须保持“待验证”。

- [ ] Windows USB 串口：连接、断开、拔插、重连、参数完整下载。
- [ ] Windows Bluetooth SPP：区分 incoming/outgoing COM，断链与长时间重连。
- [ ] 至少补充 Linux serial/rfcomm 与 macOS `cu.*` 的实机结果，或明确标注未验证平台。
- [ ] MAVLink v1-only、v2 unsigned、v2 signed 与 require-signed 互通。
- [ ] 多飞控/多组件场景下目标锁定、ACK 与遥测过滤。
- [ ] 参数写入回显、失败、超时、取消与重连恢复。
- [ ] 拆桨条件下验证电机启动、单电机/顺序测试与 stop-all。
- [ ] 受控环境验证解锁/上锁、起飞/降落/RTL、模式切换和手柄人工停用。
- [ ] 远程部署验证 TLS/WSS、Origin、token、代理日志脱敏和断网行为。

## 发布内容

- [ ] README 中加入当前版本真实截图或演示视频。
- [ ] 更新 `CHANGELOG.md`，从 Unreleased 移动到版本与日期。
- [ ] 创建带说明的 tag/release，列出 breaking changes、已知限制和硬件验证范围。
- [ ] 明确标注 pre-release，除非已达到维护者定义的稳定标准。
- [ ] 发布后验证 Issue、PR、安全报告与贡献链接可用。
