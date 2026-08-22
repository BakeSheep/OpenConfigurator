# 自动调参整合实施计划

## 目标

在现有 PID 调参工作区中增加有所有权、可恢复、可验证的自动调参会话。首版支持 PX4 多旋翼和 ArduCopter 多旋翼；固定翼、VTOL、ArduPlane 和传统直升机继续保持不可用。

## 实施

1. 定义分栈 capability、自动调参快照与专用 WebSocket 消息，禁止浏览器经通用命令发送 `MAV_CMD_DO_AUTOTUNE_ENABLE`。
2. 实现服务端 `AutotuneSessionManager`，绑定目标、controller lease 和 safety epoch，并与 ESC、校准、参数同步互斥。
3. PX4 适配器每秒轮询命令 212，只使用飞控返回的 ACK 进度。
4. ArduCopter 适配器通过模式 15 启动，使用 HEARTBEAT 和官方 `AutoTune:` 状态文本跟踪运行、测试、保存与放弃。
5. 在 `/tuning/pid` 中提供“手动调参 / 自动调参”切换，只展示必要状态、安全确认、主操作、结果和参数差异。

## 安全边界

- 启动前重新验证目标、心跳、控制权、safety epoch、机型、模式和解锁状态。
- 不提供自动解锁或自动起飞。
- 会话期间禁止参数写入、ESC、校准、日志传输和浏览器摇杆输入。
- Land、RTL、紧急上锁和遥控器模式切换始终可用。
- 浏览器断线不会自动改变飞行模式。
- 界面分开表达“飞控完成”、“参数已保存”和“实飞品质未验证”。

## 验证

- 覆盖分栈能力矩阵、消息校验、ACK 乱序/重复/丢失、状态文本分支、断线恢复、目标切换、多客户端竞争和服务互斥。
- 运行 `npm run typecheck`、`npm run test:server`、`npm run test:protocol`、`npm run build` 和相关 Playwright 用例。
- PX4 与 ArduCopter 先通过 SITL，再进行拆桨协议验证与受控场地试飞。无实机证据时标记为实验性功能。

## 完成标准

- PX4 和 ArduCopter 使用独立适配器，不交叉发送命令或参数。
- ACK 接受不被当作物理调参成功。
- 参数保存有飞控状态和回读证据。
- 所有安全退出路径保持可用，未适配机型保持只读。
