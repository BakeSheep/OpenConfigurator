# OpenConfigurator

<p align="center">
  <img src="public/favicon.svg" width="88" alt="OpenConfigurator logo" />
</p>

<p align="center">
  面向 PX4 与 ArduPilot 的现代化飞控配置站。
</p>

<p align="center">
  <a href="https://bakesheep.github.io/OpenConfigurator/"><b>在线使用</b></a> ·
  <a href="README.en.md">English</a> ·
  <a href="docs/ARCHITECTURE.md">架构</a>
</p>

> [!WARNING]
> OpenConfigurator 仍处于预发布阶段，不是经过认证的航空安全系统。连接电机或 ESC 控制前必须拆除全部螺旋桨，并在受控环境中完成实机验证。

<p align="center">
  <img src="docs/screenshots/dashboard.zh.jpg" alt="OpenConfigurator 主界面演示" />
</p>

## 主要功能

- **总览**：实时遥测、连接状态与飞行命令，状态一目了然。
- **机架与校准**：机架选择、传感器设置、校准向导、电源与安全配置。
- **动力系统**：电机映射与测试、AM32 ESC 参数配置。
- **遥控输入**：接收机与摇杆的通道监测、映射和配置。
- **调参与诊断**：参数浏览与比对、PID、EKF 状态、消息、NSH 终端与实时波形。
- **飞行日志**：ULog / DataFlash 传输下载与本地离线分析。

## 支持范围

- PX4：连接、遥测、参数、调参、校准、飞行操作、ULog、NSH 终端与 ESC 路径。
- ArduPilot：ArduCopter 是安全关键写操作的适配目标；其他已识别机型保留通用显示与 DataFlash 日志，未适配写操作保持关闭。
- AM32 ESC 参数：ArduPilot raw passthrough、PX4 `SERIAL_CONTROL`、19200 波特直连三条路径；不提供固件刷写。

飞控类型只根据 HEARTBEAT 识别。安全关键操作会在本地 Worker 中重新检查连接、目标、机型能力、armed 状态和 safety epoch；`COMMAND_ACK` 本身不被视为物理状态成功。

详细边界见 [飞控配置兼容性](docs/FLIGHT-CONTROLLER-COMPATIBILITY.md)、[ESC 兼容性](docs/ESC-COMPATIBILITY.md) 和 [HIL 清单](docs/HIL-CHECKLIST.md)。

## 本地开发与贡献

环境要求、启动方式、常用命令、架构与部署说明见 [CONTRIBUTING.md](CONTRIBUTING.md)，详细设计约束见 [架构文档](docs/ARCHITECTURE.md)。

OpenConfigurator 采用 [MIT License](LICENSE)。
