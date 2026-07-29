# OpenConfigurator 路线图

## 近期：多飞控适配

- ✅ ArduPilot 识别与 ArduCopter 4.7 适配（模式、机架、执行器、电机测试 209、PID/EKF/串口/朝向参数、能力门控）；见 `docs/ARDUPILOT.md`。
- ArduPlane / Rover / Sub / Tracker 写操作（当前为显式只读）。
- ArduPilot DataFlash `.BIN` 下载与分析（LOG_REQUEST_* 服务，待评估解析器）。
- ArduPilot 罗盘校准（`DO_START_MAG_CAL` 多步交互）。

## 中期：可用性与连接能力

- UDP 连接与 PX4/ArduPilot SITL 支持
- 地图、GPS 轨迹和基础任务规划
- 飞行数据记录、导出与离线回放
- 多语言与无障碍体验
- 大型参数表同步性能、取消和恢复体验优化
- 更完整的遥控器校准流程

## 长期：生态与高级工具

- 安全的固件管理与升级工作流
- 航点任务编辑、校验、上传和下载
- 插件化仪表与诊断面板
- 可复用的协议兼容测试工具与硬件实验室矩阵

## 当前非目标

- 不宣称替代经过大量实机验证的成熟 GCS。
- 不在缺少纵深防御的情况下提供互联网直连飞控。
- 不为演示效果绕过电机、解锁、手柄或控制权保护。
- 不把尚未接入的按钮、页面或静态数据描述为已实现功能。

提出新方向前请先阅读 [CONTRIBUTING.md](../CONTRIBUTING.md)，并在 Issue 中说明使用场景、风险和验证计划。
