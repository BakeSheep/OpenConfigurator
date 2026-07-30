# 参与 OpenConfigurator 开发

飞控与 ESC 软件的错误可能造成设备损坏或人身风险。提交改动时请准确描述已实现范围、失败模式和验证证据，不要把单元测试写成实机结论。

## 开发流程

```bash
npm install
npm run dev
npm run typecheck
npm run test:server
npm run build
```

只修改文档时可不运行完整测试，但必须检查链接、命令和能力描述。协议相关改动还应运行 `npm run test:protocol`。

## 代码约束

- `src/shared/` 是前后端唯一共享表面，且必须保持框架无关。
- 前端与后端不能跨目录导入；页面不能创建额外 WebSocket。
- 新增网络消息时同步更新 shared union、运行时校验、服务端处理、前端 dispatch 与测试。
- MAVLink framing、CRC 与 signing 只经过 `src/server/mavlink/codec.ts`。
- 飞控差异必须经 vehicle profile 与 capability gate 处理，未知机型默认只读。
- UI 使用 `src/web/index.css` 的主题变量和现有 `.mc-*` 组件类。

## 安全关键变更

解锁、飞行命令、电机/ESC、RC override、参数写入、MAVLink、连接生命周期、控制者租约和远程鉴权的改动，必须说明风险、回退路径、自动化测试及实机验证状态。不得弱化拆桨确认、解锁确认、手柄手动启用、单控制者租约或服务端校验。

ESC 新增硬件支持时同步更新 [兼容性矩阵](docs/ESC-COMPATIBILITY.md)和[协议来源](docs/ESC-PROTOCOL-SOURCES.md)。真实硬件日志必须先脱敏。

## 提交检查

- [ ] 变更范围单一，无无关格式化或密钥、设备标识、未脱敏日志
- [ ] 新行为有测试，或说明无法自动化验证的原因
- [ ] 类型检查与相关测试通过
- [ ] 用户可见能力及限制已更新 README
- [ ] 安全关键变更包含风险和 HIL 状态

漏洞请按 [SECURITY.md](SECURITY.md) 私密报告。参与项目即表示同意 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。
