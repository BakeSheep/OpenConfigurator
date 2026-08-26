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

## 飞行器设置

| 功能 | PX4 | ArduCopter | 其他 ArduPilot / 未识别固件 | 验证状态 |
| --- | --- | --- | --- | --- |
| 机架 | `SYS_AUTOSTART`、`SYS_AUTOCONFIG`，确认回读后重启 | `FRAME_CLASS`、`FRAME_TYPE`，确认回读后提示重启 | 只读 | 软件与硬件无关测试通过；HIL 待验证 |
| 遥控器 | 通道映射、端点、中点、反向与通道数 | 通道映射、端点、中点与固件实际提供的反向参数 | 只读 | 状态机与参数事务测试通过；拆桨实机待验证 |
| 飞行模式 | 六档模式与固件提供的专用功能开关 | 六档模式、Simple/Super Simple 与辅助功能 | 只读 | 软件支持；HIL 档位验证待完成 |
| 电源/电池 | 按 `BATn_SOURCE` 发现多电池 | `BATT_`、`BATT2_…BATT9_`、`BATTA_…` | 只读 | 软件支持；双电池倍率实测待完成 |
| 核心安全 | 电池、RC/摇杆、数传、RTL、降落 | 电池、GCS、RC/油门、EKF、RTL、解锁检查 | 只读 | 软件支持；主动失联 HIL 待完成 |

配置写入必须同时满足飞控就绪、已识别且受支持、持有控制权、明确上锁、目标参数真实存在且没有冲突会话。每次参数写入都以匹配的 `PARAM_VALUE` 回读为准；多参数事务在失败时停止并尽力回滚，`COMMAND_ACK` 本身不被当作物理状态或参数生效的证明。

当前配置页明确不包含相机/云台、围栏、避障、PX4 ESC PWM 校准、UAVCAN 执行器分配以及 ArduPlane/Rover/Sub 写入。行为与参数来源见 [VEHICLE-CONFIG-SOURCES.md](VEHICLE-CONFIG-SOURCES.md)。

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

## 连接与链路（桌面 Chromium）

连接兼容性状态按“软件实现 / 自动化测试 / 实机 HIL”区分：

| 平台 / 链路 | 软件实现 | 自动化测试 | 实机 HIL |
| --- | --- | --- | --- |
| 桌面 Chromium Web Serial USB CDC / USB-UART | 已实现：只列出已授权端口，用户选择后打开 | `WebSerialTransport` 与 UI 测试通过 | 待重新验证 |
| 桌面 Chromium Web Serial Bluetooth Classic SPP | 已实现：标签页内有界重连 | `WebSerialTransport` 测试通过 | 待重新验证 |
| 端口权限与生命周期 | 已实现：`getPorts()` 不打开端口，`requestPort()` 需要用户手势，显式断开关闭读写 | Web Serial 测试通过 | 待重新验证 |
| Linux BLE GATT | 不在当前 Web Serial 路径 | 无 | 不支持 |

## 验证边界

自动化测试覆盖 PX4/ArduPilot/未知参数命名、固定状态分组、飞控能力矩阵、配置字段可见性、机架目录、模式档位计算、参数事务、遥控器校准状态机、Shell 探测与输入输出、协议边界，以及 Web Serial 端口生命周期和 Bluetooth SPP 有界重连。尚未列入实机矩阵的飞控板、固件、浏览器和操作系统组合不构成 HIL 兼容性承诺；发布前仍应在拆桨台架上验证目标组合。
