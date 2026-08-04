# 飞控配置界面兼容性

本文区分“界面具有安全兜底”“协议路径已实现”和“具体硬件/固件已实机验证”。前两项不能替代 HIL 验证，也不表示每个飞控都会发布每一种遥测量。

## 参数界面

| 组合 | 读取与展示 | 写入 |
| --- | --- | --- |
| PX4，各机型与版本 | 飞控通过 MAVLink 返回的每个参数都有分组、标题和说明；未知参数使用保守兜底说明 | 按现有 PX4 能力矩阵开放，并保留类型校验和回读确认 |
| ArduCopter，各版本 | 同上；`RC1/RC2`、`SERIAL1/2`、`COMPASS1/2` 等实例参数会归并到同一功能组 | 按现有 ArduCopter 能力矩阵开放 |
| ArduPlane/Rover/Sub/Tracker | 同样完整分组、搜索、说明和导出 | 当前保持只读，尚未完成各机型写入语义验证 |
| 未识别飞控或未来新增参数 | 仍显示通用分组与保守说明，不根据参数名推断飞控栈 | 禁止写入 |

分组和注释的兼容契约只保证“每一项都有可理解的展示”。精确范围、枚举、默认值和重启要求仍由当前飞控固件定义；本地兜底说明不会冒充对应固件的权威参数元数据。

## 状态界面

状态页固定提供 20 个标准分组、192 个标准变量，以及 OpenConfigurator 的链路、固件、传感器和消息诊断分组。目录不依赖板卡型号或固件版本，因此即使某条 MAVLink 消息未实现、未启用或尚未收到，分组仍存在，相应值显示 `--`。

PX4 与 ArduPilot 对同一状态可能使用不同消息或发布频率。界面只填充实际收到并成功解码的数据，不用参数名或旧值猜测状态。变化高亮同样只基于真实接收值。

## 交互终端

| 固件 | 结果 | 原因 |
| --- | --- | --- |
| PX4，包含 MAVLink Shell 的构建 | 支持 | 使用 `SERIAL_CONTROL_DEV_SHELL` 连接 NSH；必须收到飞控回包后才显示“已连接” |
| PX4 裁剪/自定义构建、未包含 Shell 的板卡 | 自动判定不可用 | 2.5 秒内无 Shell 回包即退出独占通道并提示当前构建不支持，避免假连接 |
| 当前 ArduPilot 官方固件 | 不支持交互 Shell | ArduPilot 已淘汰旧 CLI，当前没有可与 PX4 NSH 等价、跨板卡可用的 MAVLink Shell |
| 很早期 ArduPilot/APM 的直连串口 CLI | 不支持 | 这是旧硬件/旧固件的直接串口模式，不是当前 MAVLink Shell；接管端口会破坏正在使用的 MAVLink 连接 |

MAVLink 公共协议定义了 `SERIAL_CONTROL_DEV_SHELL=10`，但枚举存在不代表每个飞控栈或固件构建实现了 Shell。PX4 官方文档明确提供 MAVLink Shell；ArduPilot 官方文档明确说明旧 CLI 已被逐步移除。因此不能安全承诺“所有 AP/PX4 板卡和版本的终端都可用”，项目会展示真实能力而不是模拟成功。

官方依据：

- [MAVLink SERIAL_CONTROL 与 DEV_SHELL](https://mavlink.io/en/messages/common.html#SERIAL_CONTROL)
- [PX4 MAVLink Shell](https://docs.px4.io/main/en/debug/mavlink_shell.html)
- [PX4 Consoles/Shells](https://docs.px4.io/main/en/debug/consoles.html)
- [ArduPilot 旧 CLI 状态](https://ardupilot.org/dev/docs/using-the-command-line-interface.html)

## 验证边界

自动化测试覆盖 PX4/ArduPilot/未知参数命名、固定状态分组、飞控能力矩阵、Shell 探测与输入输出，以及协议边界。尚未列入实机矩阵的飞控板和固件版本不构成 HIL 兼容性承诺；发布前仍应在拆桨台架上验证目标组合。
