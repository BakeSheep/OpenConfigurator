# 参与 OpenConfigurator 开发

感谢你愿意改进 OpenConfigurator。飞控软件的错误可能造成设备损坏或人身风险，因此本项目对安全边界、回归测试和能力描述的真实性有较高要求。

## 开始之前

1. 搜索现有 Issue，避免重复工作。
2. 较大的功能、协议变更或 UI 重构请先创建讨论 Issue，说明目标、边界和验证方式。
3. 安全漏洞不要公开披露，请按 [SECURITY.md](SECURITY.md) 提交。
4. 阅读 [架构文档](docs/ARCHITECTURE.md)；涉及敏感区域时同时阅读 `HANDOVER.md`。

## 本地开发

```bash
npm install
npm run dev
```

提交前至少执行：

```bash
npm run typecheck
npm run test:server
npm run build
```

如只改动文档，可不运行完整测试，但需要检查 Markdown 链接、示例命令和术语是否与当前代码一致。

## 分支与提交

- 从最新主分支创建短生命周期分支，例如 `fix/bluetooth-reconnect` 或 `docs/deployment`。
- 一个提交尽量只表达一个逻辑变更，使用清晰的祈使句提交标题。
- 不要提交 `.env`、token、签名密钥、串口调试日志、飞行日志或任何可识别设备/人员的信息。
- 不要顺手格式化或重写与目标无关的文件。

## 架构约束

- `src/shared/` 是前后端唯一共享表面，必须保持框架无关。
- 前端和后端不能互相跨目录导入，只能通过 shared 类型与网络协议协作。
- 页面与组件不能另建 WebSocket；唯一连接由 `useWebSocket` 管理。
- 新增协议消息时，需要同步更新 shared union、前端 dispatch 与后端 emit/handler。
- MAVLink framing、CRC 和 signing 必须经过 `src/server/mavlink/codec.ts`。
- React RAF/interval 回调应稳定挂载，通过 ref 读取最新状态。
- UI 使用 `src/web/index.css` 中的主题变量和现有 `.mc-*` 组件类。

## 安全关键变更

以下修改必须在 PR 中写明风险分析、失败模式和验证证据：

- 解锁、上锁、起飞、降落、RTL 或模式切换
- 电机/执行器测试、RC override 或游戏手柄输入
- MAVLink 解析、签名、目标选择、命令 ACK 或参数写入
- 串口/蓝牙连接、重连、背压、控制者租约或远程鉴权

不得删除或弱化以下保护：电机测试的“已拆桨”确认、解锁确认、手柄手动启用、单控制者租约和服务端运行时校验。如果确有必要改变保护，必须先通过维护者的设计讨论。

真实硬件测试应按[兼容性与硬件验证矩阵](docs/COMPATIBILITY.md)记录飞控型号、PX4 版本、操作系统、连接类型、波特率、测试步骤和结果。日志在上传前必须脱敏。尚未做硬件测试时，请明确写出“未做”，不要用单元测试代替硬件结论。

## Pull Request 清单

- [ ] 变更范围单一，未包含无关文件
- [ ] 新行为有测试或说明了无法自动化测试的原因
- [ ] `npm run typecheck` 通过
- [ ] `npm run test:server` 通过（适用时）
- [ ] `npm run build` 通过（适用时）
- [ ] 用户可见变化已更新 README、文档或变更记录
- [ ] 没有提交密钥、个人信息、设备标识或敏感日志
- [ ] 安全关键变更包含风险与硬件验证说明

参与本项目即表示你同意遵守 [行为准则](CODE_OF_CONDUCT.md)。
